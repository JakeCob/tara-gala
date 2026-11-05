// TG-52 trip sessions: one secret link for the whole trip, holding its itinerary, wallet and hotel. Like a wallet, the
// link is the key (no accounts), and this phone remembers the trips it has opened.

import { API_URL, savedAnswer } from "./api.ts";
import type { Guide, Mark } from "./guide.ts";
import { type Itinerary, SLUG_PATTERN } from "./itinerary.ts";
import type { Attendee, Rsvp } from "./people.ts";
import { type ChatAnswer, type ChatIn, chatAnswer } from "./chat.ts";
import type { GuideIn, Suggestion } from "./planEdit.ts";
import type { ChangeLine, PlanEdits } from "./planLines.ts";
import { WALLET_SLUG } from "./wallet.ts";

export const TRIP_SLUG = /^[0-9a-f]{32}$/; // the API's SLUG, 128 random bits in hex
export const MAX_DAYS = 30; // the API's cap

export type Hotel = {
  name: string;
  address: string;
  check_in: string | null; // Manila wall time, "2026-11-06T14:00:00"
  check_out: string | null;
  booking_ref: string;
  notes: string;
};
export type FileKind = "ticket" | "payout_qr" | "hotel_proof" | "photo" | "avatar";
/** A file the party shares on the trip (PR 2): its bytes come from fileUrl(). */
export type TripFile = {
  id: string;
  kind: FileKind;
  label: string;
  member_id: string | null;
  content_type: string;
  bytes: number;
  delete_after: string | null;
  row_key: string | null; // a photo's checklist row ("d2-05")
  attendee_id: string | null; // whose picture an avatar is (TG-58)
  created_at: string;
};
export const MAX_FILE_BYTES = 5 * 1024 * 1024; // the API's cap
export const MAX_SHARED_TICKETS = 30;

export type Trip = {
  share_slug: string;
  name: string;
  start_date: string;
  return_date: string;
  created_at: string;
  itinerary_slug: string | null;
  wallet: { share_slug: string; name: string } | null;
  hotel: Hotel | null;
  files: TripFile[];
  marks: Mark[]; // PR 3: the shared checklist's ticks and the picks
  attendees?: Attendee[]; // TG-58: absent on a saved copy from before it, so read it through peopleOf
  invite_slug?: string | null; // TG-58 PR 2: the limited invite link, null until someone turns it on
  plan_edits?: PlanEdits | null; // TG-61: the copy's newest versions; absent on a saved copy from before it
  places?: TripPlace[]; // TG-61: the places this group pinned from a link
};

/** TG-61: a place only this trip has, pinned by the server from a Google Maps link. Never verified. */
export type TripPlace = { id: string; name: string; lat: number; lng: number; maps_url: string; created_at: string; pin_source?: PinSource | null };
/** Round 5: where a link's pin came from: the link itself, the address in it (check it), or the group's pasted pin. */
export type PinSource = "link" | "address" | "typed";
/** The plan a change is worked out from: the copy's slug and version, or the shared plan's slug and 0. */
export type PlanBase = { itinerary_slug: string; seq: number };
/** A save's answer: the whole new plan, from the same transaction (review M1), and the server's lines for it. */
export type PlanSaved = { itinerary: Itinerary; changes: ChangeLine[] };
export type SuggestIn = {
  base: PlanBase;
  at: { replace: string } | { after: string } | { first_of_day: number } | { anywhere: true };
  /** pin: the coordinates the group pasted, as typed (round 5); only next to a link. The server parses them */
  place: { spot_id: string } | { trip_place_id: string } | { link: string; pin?: string };
};

// ---------------------------------------------------------------- pure

/** The slug in a pasted link or a bare slug: ".../i/<slug>" for a plan, ".../w/<slug>" for a wallet. */
export function slugFromLink(raw: string, kind: "itinerary" | "wallet"): string | null {
  const text = raw.trim();
  const letter = kind === "itinerary" ? "i" : "w";
  const fromPath = text.match(new RegExp(`/${letter}/([^/?#\\s]+)`))?.[1];
  const slug = fromPath ?? (/^[^/?#\s]+$/.test(text) ? text : null);
  if (!slug) return null;
  const ok = kind === "itinerary" ? SLUG_PATTERN.test(slug) : WALLET_SLUG.test(slug);
  return ok ? slug : null;
}

/** "Thu, Nov 6 – Sat, Nov 8", or one day. Dates are plain calendar days, so no time zone is involved. */
export function datesLine(start: string, back: string): string {
  const f = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  };
  return start === back ? f(start) : `${f(start)} – ${f(back)}`;
}

/** The first problem with a trip's name and dates, or null. The API checks the same rules. */
export function tripProblem(name: string, start: string, back: string): string | null {
  if (!name.trim()) return "Give the trip a name.";
  if (name.trim().length > 40) return "Keep the trip name to 40 letters or fewer.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(back)) return "Pick when you leave and when you come home.";
  if (back < start) return "The trip home can't be before you leave.";
  const days = (Date.parse(back) - Date.parse(start)) / 86_400_000;
  if (days > MAX_DAYS) return `A trip can be up to ${MAX_DAYS} days.`;
  return null;
}

/** "Thu, Nov 6, 2:00 PM" for a hotel time, read as Manila wall time. */
export function hotelTime(local: string | null): string | null {
  if (!local) return null;
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi)).toLocaleString("en-PH", {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC",
  });
}

/** Google Maps search for the hotel, by its name and address as typed (never our data). */
export function hotelMapsUrl(h: Pick<Hotel, "name" | "address">): string {
  const query = [h.name, h.address].map((x) => x.trim()).filter(Boolean).join(", ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/** A datetime-local input's value ("2026-11-06T14:00") as the API's wall time, or null when empty. */
export function toWallTime(input: string): string | null {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input) ? `${input}:00` : null;
}

/** The API's wall time as a datetime-local input's value. */
export function toInput(wall: string | null): string {
  return wall?.slice(0, 16) ?? "";
}

// ---------------------------------------------------------------- API

export type TripFailure = "offline" | "not_found" | "rate_limited" | "server" | "rejected" | "clash";
/** `savedAt`: the service worker answered with its copy, not the API; this is when that copy's GET left (ms). */
export type TripResult = { ok: true; trip: Trip; savedAt?: number } | { ok: false; why: TripFailure; detail?: string };
export type TripLoad = { state: "loading" } | { state: "ready"; trip: Trip } | { state: "error"; why: TripFailure };

/** How new an answer is: when its GET left, since it can't hold anything later. The worker and the page share a clock. */
export function answerFrom(r: TripResult, left: number): number {
  return (r.ok && r.savedAt) || left;
}

/**
 * TG-54: what a GET's answer does to the screen. `overtaken`: it's older than the trip showing, so it would take a tick
 * back off the map. The trip on screen stays, and a later answer brings anything newer. A saved copy is judged the same
 * way: on slow signal it's how other phones' ticks arrive.
 */
export function afterGet(prev: TripLoad, r: TripResult, slug: string, overtaken: boolean): TripLoad {
  const showing = prev.state === "ready" && prev.trip.share_slug === slug;
  if (showing && overtaken) return prev;
  if (r.ok) return { state: "ready", trip: r.trip };
  return prev.state === "ready" && r.why === "offline" ? prev : { state: "error", why: r.why }; // offline with a copy on screen: keep showing it; the offline banner says so
}

/** TG-57: a saved copy only fills an empty screen. Anything already there, even an error, came from a later answer. */
export function afterSaved(prev: TripLoad, trip: Trip): TripLoad {
  return prev.state === "loading" ? { state: "ready", trip } : prev;
}

/** A plan's guide as this page holds it. `failed`: no signal and no copy, so the next poll tries again. */
export type PlanGuide = { plan: string; guide: Guide | null; failed?: boolean };

/** TG-57: a saved guide or a failed fetch fills a gap, so neither replaces an answer already held for this plan. */
export function fillGuide(prev: PlanGuide | null, next: PlanGuide): PlanGuide {
  return prev?.plan === next.plan && !prev.failed ? prev : next;
}

/** What the map's place on the page holds: its guide, a frame while the guide is on its way, or nothing. */
export function mapSlot(plan: string | null, held: PlanGuide | null): Guide | "frame" | null {
  if (!plan) return null;
  return held?.plan === plan ? held.guide : "frame";
}

const DETAIL: Record<string, string> = {
  itinerary_not_found: "That plan link doesn't work. Copy it again from the plan's Share button.",
  wallet_not_found: "That wallet link doesn't work. Copy it again from the wallet.",
  name_mismatch: "That isn't the trip's name. Type it exactly to delete the trip.",
  not_an_image: "That file isn't a picture. Use a photo or screenshot (PNG, JPEG, WebP or GIF).",
  too_big: "That picture is too big to share (over 5 MB). Take a screenshot of it instead.",
  bad_label: "Give the ticket a short name, up to 40 letters.",
  too_many_tickets: "This trip already holds 30 tickets. Remove some first.",
  too_many_photos: "This trip already holds 300 photos. Delete some first.",
  bad_row_key: "That level isn't in this trip's plan. Refresh and try again.",
  unknown_member: "That person isn't in this trip's wallet. Refresh and try again.",
  unknown_key: "That row isn't in this trip's plan any more. Refresh and try again.",
  no_guide: "This trip's plan has no checklist.",
  name_taken: "Someone on the list already has that name.",
  party_full: "The list is full: it holds up to 30 people.",
  unknown_attendee: "That person isn't on the list any more. Refresh and try again.",
  no_wallet: "This trip has no wallet to copy names from.",
};

/** One plain sentence for a failed call. */
export function tripFailureMessage(r: { why: TripFailure; detail?: string }): string {
  switch (r.why) {
    case "offline":
      return "No signal, so this wasn't saved. Try again when you're back online.";
    case "not_found":
      return "This trip link doesn't work. Check it with whoever shared it.";
    case "rate_limited":
      return "Too many changes at once. Wait a minute, then try again.";
    case "server":
      return "The server had a problem. Try again in a minute.";
    default:
      return (r.detail && DETAIL[r.detail]) || "That didn't save. Check the details and try again.";
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

async function call(path: string, init?: { method: Method; body?: unknown; raw?: Blob }): Promise<TripResult | { ok: true; trip: null }> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      cache: "no-store",
      method: init?.method ?? "GET",
      headers: init?.raw ? { "content-type": init.raw.type } : init?.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: init?.raw ?? (init?.body !== undefined ? JSON.stringify(init.body) : undefined),
    });
  } catch {
    return { ok: false, why: "offline" };
  }
  if (res.status === 204) return { ok: true, trip: null };
  if (res.ok) {
    const trip = (await res.json()) as Trip;
    const savedAt = Date.parse(res.headers.get("x-tg-saved-at") ?? "");
    return Number.isNaN(savedAt) ? { ok: true, trip } : { ok: true, trip, savedAt };
  }
  if (res.status === 404) return { ok: false, why: "not_found" };
  if (res.status === 429) return { ok: false, why: "rate_limited" };
  if (res.status >= 500) return { ok: false, why: "server" };
  const body = await res.json().catch(() => null);
  return { ok: false, why: "rejected", detail: typeof body?.detail === "string" ? body.detail : undefined };
}

const at = (slug: string) => `/sessions/${encodeURIComponent(slug)}`;
const attendee = (slug: string, id: string) => `${at(slug)}/attendees/${encodeURIComponent(id)}`;
const one = (p: Promise<TripResult | { ok: true; trip: null }>) => p as Promise<TripResult>;

/** The worker's saved copy of this trip, for the screen to show while the GET is out (TG-57). */
export async function savedTrip(slug: string, store?: Parameters<typeof savedAnswer>[1]): Promise<{ trip: Trip; savedAt: number } | null> {
  const saved = await savedAnswer<Trip>(`${API_URL}${at(slug)}`, store);
  return saved?.body.share_slug === slug ? { trip: saved.body, savedAt: saved.savedAt } : null;
}

/** TG-61: an answer that isn't the trip. A clash carries the newer plan's slug and version. */
/** need_pin (round 5) carries the name read from the link, or null, for the pin step's Name field. */
export type Answer<T> = { ok: true; body: T } | { ok: false; why: TripFailure; detail?: string; clash?: PlanBase; name?: string | null };

/** A call whose answer isn't the trip (TG-61's plan routes). The same failures as call, plus the clash. */
async function ask<T>(path: string, init: { method: Method; body: unknown }): Promise<Answer<T>> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { cache: "no-store", method: init.method, headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) });
  } catch {
    return { ok: false, why: "offline" };
  }
  if (res.ok) return { ok: true, body: (await res.json()) as T };
  if (res.status === 404) return { ok: false, why: "not_found" };
  if (res.status === 429) return { ok: false, why: "rate_limited" };
  if (res.status >= 500) return { ok: false, why: "server" };
  const body = await res.json().catch(() => null);
  const detail = typeof body?.detail === "string" ? body.detail : undefined;
  if (res.status === 409 && detail === "plan_changed") {
    return { ok: false, why: "clash", detail, clash: { itinerary_slug: String(body.itinerary_slug), seq: Number(body.seq) } };
  }
  if (detail === "need_pin") return { ok: false, why: "rejected", detail, name: typeof body?.name === "string" ? body.name : null };
  return { ok: false, why: "rejected", detail };
}
/** TG-61 PR 2: one question to the chatbot. Every answer, the limits' 429s included, is read by chatAnswer */
async function askChat(path: string, body: ChatIn): Promise<ChatAnswer> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { cache: "no-store", method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    return { ok: false, why: "offline" };
  }
  return chatAnswer(res.status, await res.json().catch(() => null));
}

export const tripApi = {
  create: (name: string, start_date: string, return_date: string) =>
    one(call("/sessions", { method: "POST", body: { name, start_date, return_date } })),
  get: (slug: string) => one(call(at(slug))),
  update: (slug: string, body: { name?: string; start_date?: string; return_date?: string }) =>
    one(call(at(slug), { method: "PATCH", body })),
  attachItinerary: (slug: string, share_slug: string) => one(call(`${at(slug)}/itinerary`, { method: "PUT", body: { share_slug } })),
  detachItinerary: (slug: string) => one(call(`${at(slug)}/itinerary`, { method: "DELETE" })),
  attachWallet: (slug: string, share_slug: string) => one(call(`${at(slug)}/wallet`, { method: "PUT", body: { share_slug } })),
  detachWallet: (slug: string) => one(call(`${at(slug)}/wallet`, { method: "DELETE" })),
  setHotel: (slug: string, hotel: Hotel) => one(call(`${at(slug)}/hotel`, { method: "PUT", body: hotel })),
  removeHotel: (slug: string) => one(call(`${at(slug)}/hotel`, { method: "DELETE" })),
  remove: (slug: string, name: string) => call(at(slug), { method: "DELETE", body: { name } }),
  /** Uploads one picture as the raw body; the rest rides in the query (no multipart). */
  addFile: (slug: string, kind: FileKind, picture: Blob, opts: { label?: string; member_id?: string; row_key?: string; attendee_id?: string } = {}) => {
    const q = new URLSearchParams({ kind });
    if (opts.label) q.set("label", opts.label);
    if (opts.member_id) q.set("member_id", opts.member_id);
    if (opts.row_key) q.set("row_key", opts.row_key);
    if (opts.attendee_id) q.set("attendee_id", opts.attendee_id);
    return one(call(`${at(slug)}/files?${q}`, { method: "POST", raw: picture }));
  },
  /** Tick a row or to-do ("done"), or make a pick ("B"); anyone can, in any order */
  mark: (slug: string, key: string, value: string) =>
    one(call(`${at(slug)}/marks/${encodeURIComponent(key)}`, { method: "PUT", body: { value } })),
  unmark: (slug: string, key: string) => one(call(`${at(slug)}/marks/${encodeURIComponent(key)}`, { method: "DELETE" })),
  deleteFile: (slug: string, id: string) => one(call(`${at(slug)}/files/${encodeURIComponent(id)}`, { method: "DELETE" })),
  addAttendee: (slug: string, name: string) => one(call(`${at(slug)}/attendees`, { method: "POST", body: { name } })),
  /** Copies the attached wallet's names once; nothing links them afterwards */
  copyWalletNames: (slug: string) => one(call(`${at(slug)}/attendees/from-wallet`, { method: "POST" })),
  setAnswer: (slug: string, id: string, rsvp: Rsvp) => one(call(attendee(slug, id), { method: "PATCH", body: { rsvp } })),
  removeAttendee: (slug: string, id: string) => one(call(attendee(slug, id), { method: "DELETE" })),
  /** With no `at`, the server's time, and a second tap keeps the first. `at` is a correction, as Manila wall time */
  arrive: (slug: string, id: string, at?: string) => one(call(`${attendee(slug, id)}/arrival`, { method: "PUT", body: at ? { at } : {} })),
  clearArrival: (slug: string, id: string) => one(call(`${attendee(slug, id)}/arrival`, { method: "DELETE" })),
  /** TG-58 PR 2: turns on the invite link; a second call keeps the same one */
  startInvite: (slug: string) => one(call(`${at(slug)}/invite`, { method: "PUT" })),
  /** The invite link stops working; startInvite then makes a new one */
  stopInvite: (slug: string) => one(call(`${at(slug)}/invite`, { method: "DELETE" })),
  /** TG-61: the whole new guide, worked out from `base`. A 409 means another phone saved first: nothing was written */
  savePlan: (slug: string, base: PlanBase, guide: GuideIn, source: "hand" | "chat") => ask<PlanSaved>(`${at(slug)}/plan`, { method: "PUT", body: { base, guide, source } }),
  /** Undoes the newest version, or puts back the change an undo took out */
  undoPlan: (slug: string, base: PlanBase) => ask<PlanSaved>(`${at(slug)}/plan/undo`, { method: "POST", body: { base } }),
  /** A proposal for one stop; saves nothing */
  suggest: (slug: string, body: SuggestIn) => ask<Suggestion>(`${at(slug)}/plan/suggest`, { method: "POST", body }),
  /** The server reads the link itself; the phone never sends a pin */
  addPlace: (slug: string, body: { link: string; name: string; pin?: string }) => ask<TripPlace>(`${at(slug)}/places`, { method: "POST", body }),
  /** TG-61 PR 2: a proposal at most; saves nothing. Apply is savePlan with the proposal's own base and source "chat" */
  chat: (slug: string, body: ChatIn) => askChat(`${at(slug)}/plan/chat`, body),
};

const PLAN_DETAIL: Record<string, string> = {
  unknown_key: "That stop isn't in the plan any more. Check the map, then try again.",
  unknown_place: "That place isn't on Tara Gala any more. Pick another one.",
  no_change: "That's how the plan is already, so nothing changed.",
  nothing_to_undo: "Nothing to undo yet.",
  cannot_undo: "That change can't be undone: a place in it isn't on Tara Gala any more.",
  option_picked: "The group picked that choice. Unpick it first.",
  bus_table_changed: "Buses can only be swapped here, not added or taken out.",
  unknown_trip: "That bus isn't on the schedule any more. Pick another one.",
  trip_inactive: "That bus isn't on the schedule any more. Pick another one.",
  trip_not_running: "That bus doesn't run on that day. Pick another one.",
  wrong_direction: "That bus goes the other way. Pick another one.",
  too_many_rows: "This plan already has as many stops as it can hold.",
  too_many_versions: "This plan has been changed as many times as it can hold.",
  bad_plan: "That change doesn't fit the plan. Check it and try again.",
  too_big: "That change is too big to save. Try a smaller one.",
  link_unreadable: "We couldn't read that link. Open the place in Google Maps, tap Share, and copy the link again.",
  need_pin: "That link has no pin we can read. In Google Maps, press and hold the place, copy the numbers that show up, and paste them here.",
  bad_pin: "Those numbers aren't a pin. Paste two numbers, like 16.4138, 120.5964.",
  link_not_maps: "That isn't a Google Maps link. Paste one, or type a place name.",
  too_many_places: "This trip already has 100 places of its own, the most it can hold.",
  bad_place: "Give the place a name of 1 to 80 letters.",
};

/** A plan call's outcome for a log line: yes, a failure kind, or a code we know. Never the server's free text. */
export function planOutcome(r: { ok: true } | { ok: false; why: TripFailure; detail?: string }): string {
  if (r.ok) return "yes";
  return r.why === "rejected" ? (r.detail && PLAN_DETAIL[r.detail] ? r.detail : "other") : r.why;
}

/** One plain sentence for a failed plan call (ux.md §4.3, §6). */
export function planFailureMessage(r: { why: TripFailure; detail?: string }): string {
  if (r.why === "clash") return "Someone just changed the plan, so your change wasn't saved.";
  if (r.why === "rejected" && r.detail && PLAN_DETAIL[r.detail]) return PLAN_DETAIL[r.detail];
  return tripFailureMessage(r);
}

export const fileUrl = (slug: string, id: string) => `${API_URL}${at(slug)}/files/${encodeURIComponent(id)}`;

const FILES_IN_MEMORY = 60; // about 18 MB of photos: a few Album pages, so reopening one downloads nothing
const fetched = new Map<string, Promise<Blob | null>>(); // a file's bytes never change for its id

/** A shared file's picture, or null. A CORS fetch (not an <img>), so the service worker can keep it for offline. */
export function fetchFile(slug: string, id: string): Promise<Blob | null> {
  const known = fetched.get(id);
  if (known) return known;
  const got = (async () => {
    try {
      const res = await fetch(fileUrl(slug, id));
      return res.ok ? await res.blob() : null;
    } catch {
      return null;
    }
  })();
  fetched.set(id, got);
  void got.then((blob) => blob || fetched.delete(id)); // offline or gone: try again next time
  for (const oldest of fetched.keys()) {
    if (fetched.size <= FILES_IN_MEMORY) break;
    fetched.delete(oldest);
  }
  return got;
}

/** "Deleted from the trip on Sun, Nov 22": when a ticket or QR leaves the server. */
export function deleteLine(day: string | null): string {
  return day ? `Deleted from the trip after ${datesLine(day, day)}` : "";
}

// ---------------------------------------------------------------- what this phone remembers

/** A trip this phone has opened. wallet_slug lets a wallet page find the trip that holds its payout QRs. */
export type KnownTrip = { slug: string; name: string; start_date: string; wallet_slug?: string | null };
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
const KEY = "tg-trips";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // some private modes throw on access
  }
}

/** The raw stored list, for useSyncExternalStore: a string compares stable between renders, a parsed list doesn't. */
export function knownTripsRaw(): string | null {
  try {
    return storage()?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
}

export function knownTrips(store: Storage | null = storage()): KnownTrip[] {
  try {
    const raw = JSON.parse(store?.getItem(KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (t): t is KnownTrip =>
        !!t && typeof t.slug === "string" && TRIP_SLUG.test(t.slug) && typeof t.name === "string" && typeof t.start_date === "string" &&
        (t.wallet_slug === undefined || t.wallet_slug === null || (typeof t.wallet_slug === "string" && WALLET_SLUG.test(t.wallet_slug))),
    );
  } catch {
    return [];
  }
}

/** knownTrips() over a raw string from knownTripsRaw(). */
export function parseKnownTrips(raw: string | null): KnownTrip[] {
  return knownTrips({ getItem: () => raw, setItem: () => {} });
}

/** Adds or updates one trip, most recent first. */
export function rememberTrip(entry: KnownTrip, store: Storage | null = storage()): KnownTrip[] {
  const next = [entry, ...knownTrips(store).filter((t) => t.slug !== entry.slug)].slice(0, 20);
  try {
    store?.setItem(KEY, JSON.stringify(next));
  } catch {
    // full or blocked: the trip still works, this phone just won't list it
  }
  return next;
}

/** Drops one trip from this phone's list (after it's deleted, or its link stops working). */
export function forgetTrip(slug: string, store: Storage | null = storage()): KnownTrip[] {
  const next = knownTrips(store).filter((t) => t.slug !== slug);
  try {
    store?.setItem(KEY, JSON.stringify(next));
  } catch {
    // as above
  }
  return next;
}
