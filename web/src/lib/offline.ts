// Offline/stale banner logic (TG-27): the reducer behind OfflineBanner, its copy, and the service worker's
// message contract. Pure TS with no imports at all so `node --test` can run it with type stripping.

export type DataSource = "network" | "cache" | "none";
export type SwDataMessage = { type: "tg-sw:data"; source: DataSource; savedAt: string | null; url: string };

// Must equal TG_SW.MSG_DATA and TG_SW.MSG_SKIP_WAITING in public/sw.js (swStrategy.test.ts checks)
export const MSG_DATA = "tg-sw:data";
export const MSG_SKIP_WAITING = "SKIP_WAITING";

/** One API path answered from the cache on this screen (TG-46: the landing makes two GETs). */
export type CachedPath = { path: string; savedAt: string | null };
export type BannerState = {
  kind: "none" | "cached" | "miss";
  savedAt: string | null;
  online: boolean;
  backOnline: boolean;
  /** Present only when non-empty, so the URL-less states read as before */
  cached?: CachedPath[];
};
export type BannerEvent =
  | { type: "data"; source: DataSource; savedAt: string | null; url?: string }
  | { type: "online" }
  | { type: "offline" }
  | { type: "reset"; online: boolean };
export type Variant = "A" | "B" | "C" | "D";

const SOURCES: DataSource[] = ["network", "cache", "none"];
const SEP = " · ";

export function initialBanner(online: boolean): BannerState {
  return { kind: "none", savedAt: null, online, backOnline: false };
}

// Answers that only add to a screen, never its own data: /terminals upgrades directions links and falls back to the
// trip's own fields, so a miss there (on a saved itinerary, offline) mustn't read as "nothing saved" (TG-27 Part B)
const SUPPLEMENTARY = /^\/terminals$/; // the whole pathname: not an itinerary slugged "terminals"

function supplementary(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return SUPPLEMENTARY.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function pathOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

function oldest(list: CachedPath[]): string | null {
  return list.slice(1).reduce((at, c) => olderOf(at, c.savedAt), list[0].savedAt);
}

/** The state with exactly these cached paths: the key is left off when there are none. */
function withCached(s: BannerState, list: CachedPath[]): BannerState {
  const base = { kind: s.kind, savedAt: s.savedAt, online: s.online, backOnline: s.backOnline };
  return list.length ? { ...base, cached: list } : base;
}

// One screen can show several API answers (TG-46: the landing's trips search and ready-made list). Each answer speaks
// for its own path, so a fresh or missing one doesn't hide another path still on screen from the cache. An answer
// without a URL speaks for the whole screen, as before.
function onData(s: BannerState, e: Extract<BannerEvent, { type: "data" }>): BannerState {
  const path = pathOf(e.url);
  const others = path === null ? [] : (s.cached ?? []).filter((c) => c.path !== path);
  if (e.source === "cache") {
    // Several cached answers on one screen: show the oldest. A cached state with no paths came from URL-less answers.
    const earlier = s.kind === "cached" && (path === null || !s.cached) ? s.savedAt : undefined;
    const list = path === null ? [] : [...others, { path, savedAt: e.savedAt }];
    const own = list.length ? oldest(list) : e.savedAt;
    const savedAt = earlier === undefined ? own : olderOf(earlier, own);
    return withCached({ ...s, kind: "cached", savedAt, backOnline: false }, list);
  }
  if (others.length) return withCached({ ...s, kind: "cached", savedAt: oldest(others) }, others);
  if (e.source === "network") return withCached({ ...s, kind: "none", savedAt: null, backOnline: false }, []);
  return withCached({ ...s, kind: "miss" }, []);
}

/** The banner follows the data (was the last API answer served from the cache?), not just navigator.onLine. */
export function bannerReducer(s: BannerState, e: BannerEvent): BannerState {
  switch (e.type) {
    case "data":
      return supplementary(e.url) ? s : onData(s, e);
    case "online":
      return { ...s, online: true, backOnline: s.kind === "cached" && !s.online };
    case "offline":
      return { ...s, online: false, backOnline: false };
    case "reset":
      return initialBanner(e.online);
  }
}

export function bannerVariant(s: BannerState): Variant | null {
  if (s.kind === "miss") return s.online ? null : "C";
  if (s.kind === "cached") {
    if (!s.online) return "A";
    return s.backOnline ? "D" : "B";
  }
  return null;
}

/** ux.md's four strings. `lead` is shown bold; lead + rest is the whole banner. */
export function bannerText(v: Variant, savedAt: string | null): { lead: string; rest: string } {
  const formatted = formatSavedAt(savedAt);
  const saved = formatted ? `saved ${formatted}` : "saved time unknown";
  switch (v) {
    case "A":
      return { lead: "Offline", rest: `${SEP}${saved}${SEP}schedules may have changed` };
    case "B":
      return { lead: "Can't reach the server", rest: `${SEP}${saved}${SEP}schedules may have changed` };
    case "C":
      return { lead: "Offline", rest: `${SEP}searching needs a connection` };
    case "D":
      return { lead: "Back online", rest: `${SEP}${saved}${SEP}search again for the latest times` };
  }
}

const parse = (iso: string | null) => (iso ? Date.parse(iso) : NaN);

/** "Oct 30, 9:12 PM" in Manila time, no year; "" when the time is missing or unreadable. */
export function formatSavedAt(iso: string | null): string {
  const ms = parse(iso);
  if (Number.isNaN(ms)) return "";
  const date = new Date(ms);
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "Asia/Manila" });
  // h23 parts, not Intl's 12-hour output: browsers put a narrow no-break space before "PM"
  const hhmm = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "Asia/Manila",
  }).format(date);
  return `${day}, ${to12Hour(hhmm)}`;
}

// Copy of formatTime in api.ts (plain-module rule: no import of api.ts), so the spacing matches the trip cards
function to12Hour(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** The earlier of two saved-at times; null when either is unknown, so the banner never claims a newer time. */
export function olderOf(a: string | null, b: string | null): string | null {
  const ta = parse(a);
  const tb = parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return ta <= tb ? a : b;
}

/** A well-formed data message from the service worker, or null. Copies only the known fields. */
export function parseSwMessage(data: unknown): SwDataMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.type !== MSG_DATA || !SOURCES.includes(d.source as DataSource)) return null;
  if (d.savedAt !== null && typeof d.savedAt !== "string") return null;
  if (typeof d.url !== "string") return null;
  return { type: MSG_DATA, source: d.source as DataSource, savedAt: d.savedAt, url: d.url };
}
