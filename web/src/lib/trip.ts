// TG-52 trip sessions: one secret link for the whole trip, holding its itinerary, wallet and hotel. Like a wallet, the
// link is the key (no accounts), and this phone remembers the trips it has opened.

import { API_URL } from "./api.ts";
import { SLUG_PATTERN } from "./itinerary.ts";
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
export type FileKind = "ticket" | "payout_qr" | "hotel_proof" | "photo";
/** A file the party shares on the trip (PR 2): its bytes come from fileUrl(). */
export type TripFile = {
  id: string;
  kind: FileKind;
  label: string;
  member_id: string | null;
  content_type: string;
  bytes: number;
  delete_after: string | null;
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
export type TripResult = { ok: true; trip: Trip } | { ok: false; why: TripFailure; detail?: string };

const DETAIL: Record<string, string> = {
  itinerary_not_found: "That plan link doesn't work. Copy it again from the plan's Share button.",
  wallet_not_found: "That wallet link doesn't work. Copy it again from the wallet.",
  name_mismatch: "That isn't the trip's name. Type it exactly to delete the trip.",
  not_an_image: "That file isn't a picture. Use a photo or screenshot (PNG, JPEG, WebP or GIF).",
  too_big: "That picture is too big to share (over 5 MB). Take a screenshot of it instead.",
  bad_label: "Give the ticket a short name, up to 40 letters.",
  too_many_tickets: "This trip already holds 30 tickets. Remove some first.",
  unknown_member: "That person isn't in this trip's wallet. Refresh and try again.",
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
  if (res.ok) return { ok: true, trip: (await res.json()) as Trip };
  if (res.status === 404) return { ok: false, why: "not_found" };
  if (res.status === 429) return { ok: false, why: "rate_limited" };
  if (res.status >= 500) return { ok: false, why: "server" };
  const body = await res.json().catch(() => null);
  return { ok: false, why: "rejected", detail: typeof body?.detail === "string" ? body.detail : undefined };
}

const at = (slug: string) => `/sessions/${encodeURIComponent(slug)}`;
const one = (p: Promise<TripResult | { ok: true; trip: null }>) => p as Promise<TripResult>;

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
  addFile: (slug: string, kind: Exclude<FileKind, "photo">, picture: Blob, opts: { label?: string; member_id?: string } = {}) => {
    const q = new URLSearchParams({ kind });
    if (opts.label) q.set("label", opts.label);
    if (opts.member_id) q.set("member_id", opts.member_id);
    return one(call(`${at(slug)}/files?${q}`, { method: "POST", raw: picture }));
  },
  deleteFile: (slug: string, id: string) => one(call(`${at(slug)}/files/${encodeURIComponent(id)}`, { method: "DELETE" })),
};

export const fileUrl = (slug: string, id: string) => `${API_URL}${at(slug)}/files/${encodeURIComponent(id)}`;

/** A shared file's picture, or null. A CORS fetch (not an <img>), so the service worker can keep it for offline. */
export async function fetchFile(slug: string, id: string): Promise<Blob | null> {
  try {
    const res = await fetch(fileUrl(slug, id));
    return res.ok ? await res.blob() : null;
  } catch {
    return null;
  }
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
