// The share page /i/[slug] (TG-23): its data types and pure helpers. Plain module with type-only imports,
// so Node's type stripping runs it in tests. Copy is from tickets/TG-23/ux.md.
import type { Trip } from "./api.ts";
import type { LastMileLeg, Spot } from "./lastMile.ts";

export type PartyMember = { type: string; name: string | null };
export type PlanIssue = { code: string; path: string; message: string };
export type BusLegOut = { trip_id: string; date: string; trip: Trip | null };
export type StopOut = {
  spot_id: string;
  arrive: string;
  leave: string;
  spot: Spot | null;
  last_mile_route_id: string;
  leg: LastMileLeg | null;
};
export type DayOut = { day: number; date: string | null; stops: StopOut[] };
export type Itinerary = {
  share_slug: string;
  premade: boolean;
  trip_date: string;
  return_date: string | null;
  party: PartyMember[];
  budget_php: number | null;
  vibe: string | null;
  created_at: string;
  outbound: BusLegOut;
  return: BusLegOut;
  days: DayOut[];
  plan: unknown;
  issues: PlanIssue[];
};

// Same pattern as SLUG in api/app/itineraries.py (a test compares them). An invalid slug shows the 404
// without a request.
export const SLUG_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

export function isValidSlug(s: string): boolean {
  return SLUG_PATTERN.test(s);
}

export function shareUrl(origin: string, slug: string): string {
  return `${origin}/i/${encodeURIComponent(slug)}`;
}

// --- sharing: Web Share, then the clipboard, then a field to copy by hand ---------------------------------

export type ShareMethod = "share" | "copy" | "manual";
export type ShareOutcome = "done" | "silent" | "copied" | "manual";
export type SharePayload = { title: string; text: string; url: string };
export type ShareDeps = { share?: (p: SharePayload) => Promise<void>; writeText?: (s: string) => Promise<void> };
export type NavigatorLike = { share?: unknown; clipboard?: { writeText?: unknown } };

export function shareMethod(env: { share: boolean; clipboard: boolean }): ShareMethod {
  if (env.share) return "share";
  return env.clipboard ? "copy" : "manual";
}

/** What to do after a share or copy attempt: a cancelled share sheet is silent, other share errors copy. */
export function nextShareStep(method: ShareMethod, error: { name: string } | null): "done" | "silent" | "copy" | "manual" {
  if (method === "share") {
    if (error === null) return "done";
    return error.name === "AbortError" ? "silent" : "copy";
  }
  if (method === "copy") return error === null ? "done" : "manual";
  return "manual";
}

/** The browser APIs runShare may use, bound to their owners, or undefined when the browser lacks them. */
export function shareDeps(nav: NavigatorLike): ShareDeps {
  const clip = nav.clipboard;
  return {
    share: typeof nav.share === "function" ? (nav.share as (p: SharePayload) => Promise<void>).bind(nav) : undefined,
    writeText:
      clip && typeof clip.writeText === "function"
        ? (clip.writeText as (s: string) => Promise<void>).bind(clip)
        : undefined,
  };
}

/** One Share tap: try Web Share, fall back to copying the link, then to the manual field. Never throws. */
export async function runShare(deps: ShareDeps, payload: SharePayload): Promise<ShareOutcome> {
  let method = shareMethod({ share: !!deps.share, clipboard: !!deps.writeText });
  if (method === "share") {
    try {
      await deps.share!(payload);
      return "done";
    } catch (e) {
      // DOMException (AbortError, NotAllowedError) isn't always an Error subclass, so read its name directly
      const name = typeof e === "object" && e !== null && "name" in e ? String(e.name) : "Error";
      const step = nextShareStep("share", { name });
      if (step === "silent") return "silent";
      method = deps.writeText ? "copy" : "manual";
    }
  }
  if (method === "copy") {
    try {
      await deps.writeText!(payload.url);
      return "copied";
    } catch {
      return "manual";
    }
  }
  return "manual";
}

// --- copy helpers (ux.md section 4) -----------------------------------------------------------------------

// The same rules as TG-15's partySummary in lib/party.ts (a test compares them), without its picker-only
// "Party is full" sentence. Re-done here because lib modules don't import each other at runtime.
const NOUNS: readonly (readonly [string, string, string])[] = [
  ["adult", "adult", "adults"],
  ["student", "student", "students"],
  ["senior", "senior", "seniors"],
  ["pwd", "PWD", "PWD"],
  ["child", "child", "children"],
  ["other", "other", "others"],
];
const KNOWN = new Set(["adult", "student", "senior", "pwd", "child"]);

export function partySummary(p: readonly { type: string }[]): string {
  if (p.length === 0) return "No passengers.";
  const n = new Map<string, number>();
  for (const x of p) {
    const key = KNOWN.has(x.type) ? x.type : "other";
    n.set(key, (n.get(key) ?? 0) + 1);
  }
  const parts = NOUNS.filter(([key]) => n.has(key)).map(([key, one, many]) => {
    const k = n.get(key) ?? 0;
    return `${k} ${k === 1 ? one : many}`;
  });
  return `Party of ${p.length}: ${parts.join(", ")}.`;
}

/** "Ana", "Ana and Ben", "Ana, Ben and Cora" (no Oxford comma); blank names skipped, "" when none. */
export function joinNames(p: readonly PartyMember[]): string {
  const names = p.map((m) => (m.name ?? "").trim()).filter(Boolean);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// formatTravelDate's rule (lib/direction.ts; a test compares them): the date-only string as UTC, so the
// device's time zone can't shift the day
function travelDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** "Fri, Nov 6 – Sun, Nov 8", "From Fri, Nov 6", or one date when both are the same. */
export function dateRange(from: string, to: string | null): string {
  if (!to) return `From ${travelDate(from)}`;
  if (to === from) return travelDate(from);
  return `${travelDate(from)} – ${travelDate(to)}`;
}

/** Share-sheet text: the dates only. Never names, budget or vibe, which would land in a chat in plain view. */
export function shareText(from: string, to: string | null): string {
  return `Our Baguio trip, ${dateRange(from, to)}`;
}

export function dayHeading(d: DayOut): string {
  return d.date ? `Day ${d.day} · ${travelDate(d.date)}` : `Day ${d.day}`;
}

/** "₱6,000" or "₱6,000.50"; null stays null so the line is left out, never "₱0". */
export function formatPeso(n: number | null): string | null {
  if (n == null) return null;
  const whole = Number.isInteger(n);
  return `₱${n.toLocaleString("en-PH", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** The issues at a path or inside it: "days[0].stops[1]" matches its leg and times, not stops[10]. */
export function issuesFor(path: string, issues: readonly PlanIssue[]): PlanIssue[] {
  return issues.filter((i) => i.path === path || i.path.startsWith(`${path}.`) || i.path.startsWith(`${path}[`));
}

const NOTICES: Record<string, string> = {
  trip_inactive: "This bus is no longer on our schedule. Check with the operator before you go.",
  trip_not_running: "Our schedule doesn't show this bus on this date anymore. Check with the operator.",
  wrong_date: "Our schedule doesn't show this bus on this date anymore. Check with the operator.",
  unknown_trip: "This bus is no longer in our list.",
  unknown_spot: "No longer in our list",
  unknown_leg: "Directions to this stop are no longer in our list.",
  leg_wrong_start: "This ride may not match the stop anymore. Check the route before you go.",
  leg_wrong_end: "This ride may not match the stop anymore. Check the route before you go.",
  closed: "This place may be closed on this day. Check before you go.",
};

/** The card line for an issue code. The validator's own message is never shown: it has ids in it. */
export function issueNotice(code: string): string {
  return Object.hasOwn(NOTICES, code) ? NOTICES[code] : "This part of the plan may be out of date.";
}
