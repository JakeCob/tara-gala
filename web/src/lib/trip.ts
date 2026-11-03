// TG-52 trip sessions: one secret link for the whole trip, holding its itinerary, wallet and hotel. Like a wallet, the
// link is the key (no accounts), and this phone remembers the trips it has opened.

import { API_URL, savedAnswer } from "./api.ts";
import type { Guide, Mark } from "./guide.ts";
import { SLUG_PATTERN } from "./itinerary.ts";
import type { Attendee, Rsvp } from "./people.ts";
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
  invite_slug?: string | null; // TG-58 PR 2
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

export type TripFailure = "offline" | "not_found" | "rate_limited" | "server" | "rejected";
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
};

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
