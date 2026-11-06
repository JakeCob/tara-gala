// TG-61: the words for a plan change. The server sends each change as a ChangeLine {word, day, text}; the phone writes
// the sentences (review S8), with its own level numbers only for a change it made itself (ux.md §3.1).

import { formatTime, formatVerified } from "./api.ts";
import { type BusWarning, type Guide, type LegOut, type Mark, marksByKey, rowShows } from "./guide.ts";
import type { Fit } from "./planEdit.ts";

export type ChangeLine = { word: string; day: number | null; text: string; part?: "stop" | "ripple" };
export type PlanVersion = { seq: number; source: "copy" | "hand" | "chat" | "undo"; changes: ChangeLine[]; created_at: string };
/** SessionOut.plan_edits: the copy's newest version and its last five, newest first. Null before the first edit. */
export type PlanEdits = { seq: number; versions: PlanVersion[] };

/** What this phone just did, for the edit bar's line. */
export type Done =
  | { kind: "add"; after: string | null; day: number; world?: boolean } // world: a fit, which may be on another day than the map
  | { kind: "replace" }
  | { kind: "edit"; key: string }
  | { kind: "move"; day: number }
  | { kind: "nudge"; dir: "earlier" | "later" }
  | { kind: "remove" }
  | { kind: "bus"; from: string | null; to: string }
  | { kind: "list"; what: "budget" | "todo" | "sources" | "pick" }
  | { kind: "chat" }
  | { kind: "undo"; redo: boolean; undone: PlanVersion | null };

const MINE_FOR_MS = 10 * 60_000; // ux.md §3.2: Undo asks first after this, or for another phone's change

const manila = (iso: string, opts: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleString("en-US", { timeZone: "Asia/Manila", ...opts });
const clock = (iso: string) => manila(iso, { hour: "numeric", minute: "2-digit" });
const dayOf = (iso: string) => manila(iso, { month: "short", day: "numeric" });
const manilaDate = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });

/** The bar's line: a lead for what happened, then the first change line, then its tails. Structured, so the line's word
 * can be bold (F13 FINAL, ux.md §3.1). */
export type Said = { lead: string; line: ChangeLine | null; tail: string };

/** One display everywhere (F13 FINAL): the word in bold, " · World N" when there's a day, then " · <text>" verbatim. The
 * server's text is never put inside a sentence. More is a plain line, and version 0 reads "Copied the plan". */
export function lineParts(l: ChangeLine): { word: string | null; rest: string } {
  if (l.word === "More") return { word: null, rest: l.text };
  if (l.word === "Copied") return { word: null, rest: `Copied ${l.text}` };
  return { word: l.word, rest: `${l.day === null ? "" : ` · World ${l.day}`} · ${l.text}` };
}

/** The same line as plain text, for a confirm (which can't be bold) and for tests. */
export function linePlain(l: ChangeLine): string {
  const p = lineParts(l);
  return `${p.word ?? ""}${p.rest}`;
}

/** A status as plain text: a Said, or a plain line like "Saving...". */
export const saidPlain = (s: Said | string) => (typeof s === "string" ? s : `${s.lead}${s.line ? linePlain(s.line) : ""}${s.tail}`);

/** What changes, in a proposal: the same display. */
export const changeRows = (lines: ChangeLine[]) => lines.map(lineParts);

const firstOf = (lines: ChangeLine[]) => lines.find((l) => l.word !== "More") ?? null;

/** How many changes a version holds past its first line: the lines after it, not counting More, plus More's own number. */
function moreThan(lines: ChangeLine[]): number {
  const more = lines.find((l) => l.word === "More");
  return Math.max(0, lines.filter((l) => l.word !== "More").length - 1) + (more ? Number(more.text.match(/\d+/)?.[0] ?? 0) : 0);
}
const LEADS = { save: "Saved: ", undo: "Undid: ", redo: "Put back: ", chat: "Applied the chatbot's change: " } as const;
export type SaidHow = keyof typeof LEADS;

/** The edit bar after this phone's change. No level numbers: positions move after later changes. */
export function barSaid(lines: ChangeLine[], how: SaidHow, opts: { firstCopy?: boolean } = {}): Said {
  const first = firstOf(lines);
  const n = moreThan(lines);
  const tail = [
    ".",
    n ? ` And ${n} more change${n === 1 ? "" : "s"}.` : "",
    first?.word === "Dropped" ? " Undo brings it back." : "",
    opts.firstCopy ? " This trip now has its own copy of the plan. The shared plan's link doesn't change." : "",
  ].join("");
  return { lead: LEADS[how], line: first, tail };
}

/** A row in Changes: when, then the version's first line. A chatbot version says so. */
export function historyRow(v: PlanVersion, today: string): { at: string; lead: string; line: ChangeLine | null } {
  return { at: manilaDate(v.created_at) === today ? clock(v.created_at) : dayOf(v.created_at), lead: v.source === "chat" ? "Chatbot: " : "", line: firstOf(v.changes) };
}

/** Another phone's change, above the World tabs (ux.md §6). */
export function justChanged(v: PlanVersion): Said {
  return { lead: "The plan just changed: ", line: firstOf(v.changes), tail: "." };
}

/** Undo's honest name: right after an undo, the next tap puts the change back. */
export function undoLabel(edits: PlanEdits | null | undefined): "Undo" | "Redo" {
  // e2e W-6: a redo is saved as an undo too, so count the run: an odd run of undos reads Redo, an even one Undo
  const versions = edits?.versions ?? [];
  let run = 0;
  while (run < versions.length && versions[run].source === "undo") run++;
  return run % 2 === 1 ? "Redo" : "Undo";
}

/** The confirm before undoing a change that may be another phone's, or this phone's from a while ago. Null: no confirm. */
export function undoConfirm(edits: PlanEdits | null | undefined, mine: ReadonlyMap<number, number>, now: number): string | null {
  const v = edits?.versions[0];
  if (!v) return null;
  const at = mine.get(v.seq);
  if (at !== undefined && now - at <= MINE_FOR_MS) return null;
  const first = firstOf(v.changes);
  return `Undo the last change? ${first ? linePlain(first) : "The newest change"}. It was saved at ${clock(v.created_at)}, maybe from another phone.`;
}

/** Under the guide's summary once the trip has its own copy (ux.md §2). */
export function copyLine(edited: boolean, edits: PlanEdits | null | undefined, changedAt?: string | null): string | null {
  if (!edited) return null;
  const at = edits?.versions[0]?.created_at ?? changedAt; // the /i/ page has no session: W-7, the plan's own changed_at
  return at ? `Your group's own copy of the plan, last changed ${dayOf(at)}, ${clock(at)}.` : "Your group's own copy of the plan.";
}

const peso = (n: number) => `₱${n.toLocaleString("en-PH", { maximumFractionDigits: 0 })}`;
const mode = (m: string) => m.charAt(0).toUpperCase() + m.slice(1);

/** How to get there (ux.md §4.4): a route on file with its trust line, or an estimate, which never has a fare (D1). */
export function legLines(leg: LegOut): { line: string; note: string } {
  if (leg.kind === "estimate") {
    const far = leg.km < 1 ? `${Math.round(leg.km * 1000)} m` : `${leg.km} km`;
    return { line: `${mode(leg.mode)}, about ${leg.minutes} min, ${far}`, note: "An estimate from the distance, not a route on file. A jeep may go there: ask a local." };
  }
  const sign = leg.signboard ? `, ${leg.signboard} signboard` : "";
  const lo = leg.fare_min_php;
  const hi = leg.fare_max_php;
  const fare = lo == null ? "" : ` · ${hi == null || hi === lo ? peso(lo) : `${peso(lo)}–${hi.toLocaleString("en-PH")}`}`;
  const minutes = leg.minutes == null ? "" : `, about ${leg.minutes} min`;
  return { line: `${mode(leg.mode)}${sign}${minutes}${fare}`, note: `${formatVerified(leg.last_verified_at)} · Fares and routes change. Confirm with the driver or a local before you ride.` };
}

/** The far warning: rounded to 10 km over 100 km, else to the km (review nit 2). */
export function farLine(km: number): string {
  const shown = km > 100 ? Math.round(km / 10) * 10 : Math.round(km);
  return `This is about ${shown} km from Baguio. Add it anyway?`;
}

/** The confirm before a stop is removed (ux.md §4.7): its tick and photos are hidden, not deleted. */
export function removeConfirm(plan: string, world: number, ticked: boolean, photos: number): string {
  const parts = [ticked ? "tick" : "", photos === 1 ? "1 photo" : photos > 1 ? `${photos} photos` : ""].filter(Boolean); // e2e W-5: always counted
  const ask = `Remove ${plan} from World ${world}?`;
  if (!parts.length) return `${ask} Undo brings it back.`;
  const many = parts.length > 1 || photos > 1;
  return `${ask} Its ${parts.join(" and ")} ${many ? "are" : "is"} hidden, not deleted. Undo brings ${many ? "them" : "it"} back.`;
}

/** A bus row's warning (ux.md §7). The date is a plain calendar day. */
export function busWarningLine(warning: BusWarning, date: string): string {
  if (warning !== "not_running") return "This bus isn't on the schedule any more.";
  const [y, m, d] = date.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  return `This bus isn't on the schedule for ${day} any more.`;
}

/** The one notice above the World tabs. */
export const busNotice = (n: number) => (n === 1 ? "A bus in this plan isn't on the schedule any more." : `${n} buses in this plan aren't on the schedule any more.`);

/** A row's level on the map ("2-3"): its place among the day's rows that show for the picks. */
export function levelLabel(guide: Pick<Guide, "days">, marks: readonly Mark[], key: string): string | null {
  const picks = marksByKey(marks);
  for (const d of guide.days) {
    const i = d.rows.filter((r) => rowShows(r, picks)).findIndex((r) => r.key === key);
    if (i >= 0) return `${d.day}-${i + 1}`;
  }
  return null;
}

// ---------------------------------------------------------------- where does it fit? (ux.md §4.8)

const STAY = 60; // spots have no visit_minutes yet, so the server's stay is an hour (options.md §5.4)
export const NO_FIT = "No free slot for it on this plan. Choose the day yourself, and the later stops can move to make room.";

/** Guide §7's durations: 45 min, 1 h, 1 h 30 min. */
export function duration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
}
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const hhmmOf = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const distance = (km: number) => (km < 1 ? `${Math.max(100, Math.round(km * 10) * 100)} m` : `${km.toFixed(1)} km`);
const listed = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** A fit card's lines (ux.md §4.8). Stops are named by their plan text, as their level numbers change once it's in. */
export function fitLines(fit: Fit, row: (key: string) => { plan: string; time: string; place: string | null } | null) {
  const start = minutesOf(fit.time);
  const travel = !fit.leg
    ? "No travel estimate: one of the places has no pin."
    : fit.leg.kind === "estimate"
      ? `${legLines(fit.leg).line} (estimate)`
      : `${legLines(fit.leg).line} · ${formatVerified(fit.leg.last_verified_at)}`;
  const drops = fit.ripple.filter((r) => "drop" in r).map((r) => row(r.key)?.plan ?? "a stop");
  const shifts = fit.ripple.filter((r): r is { key: string; time: string } => "time" in r);
  const was = shifts[0] && row(shifts[0].key)?.time;
  const by = was ? minutesOf(shifts[0].time) - minutesOf(was) : 0;
  const moves = drops.length
    ? `Drops ${listed(drops)}.`
    : shifts.length
      ? `Moves ${shifts.length} later stop${shifts.length === 1 ? "" : "s"}${by > 0 ? ` ${duration(by)} later` : ""}.`
      : "Nothing else moves.";
  const r = fit.reason;
  const near = r.near_km == null ? null : r.kind === "near_hotel" ? `Near your hotel (${distance(r.near_km)}).`
    : r.kind === "near_stops" && r.near_key ? `Near ${row(r.near_key)?.place ?? row(r.near_key)?.plan ?? "a stop"} (${distance(r.near_km)}).` : null;
  const free = r.free_min > 0 ? `${duration(r.free_min)} free there.` : r.free_min < 0 ? `The day runs ${duration(-r.free_min)} over.` : null;
  const why = [near, free].filter(Boolean).join(" ") || null;
  const c = fit.condition;
  return {
    when: `World ${fit.day} · ${formatTime(fit.time)} to ${formatTime(hhmmOf(start + STAY))}`,
    slot: `After ${row(fit.after)?.plan ?? "a stop"}`,
    travel,
    moves,
    why,
    chip: c ? `${c.kind === "show_if" ? "Only if" : "Not if"} the group picks ${c.is}` : null,
  };
}

/** Under the cards: how they were ranked, and that an estimate is one. */
export function fitFooter(fits: readonly Fit[], pinned: boolean): string[] {
  if (!pinned) return ["Ranked by free time only: this place has no pin."];
  const ranked = "Ranked by how close it is to the stops around it, and by free time that day.";
  return fits.some((f) => f.leg?.kind === "estimate") ? [ranked, "Estimates come from the distance, not routes on file."] : [ranked];
}

// ---------------------------------------------------------------- round 5: links with no pin (ux.md §4.3)

/** The line under a link's chip: where its pin came from. An address pin links to itself, so the group can check it. */
export function pinLine(s: { pin_source?: "link" | "address" | "typed" | null; lat: number | null; lng: number | null; km_from_baguio: number | null }):
  { lead: string; link: string | null; href: string | null; rest: string } | null {
  if (!s.pin_source) return null;
  const km = s.km_from_baguio != null ? `, about ${Math.round(s.km_from_baguio)} km from Baguio` : "";
  if (s.pin_source === "address" && s.lat != null && s.lng != null) {
    return { lead: "Pin from the address, ", link: "check it on Google Maps", href: `https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lng}`, rest: "" };
  }
  return { lead: s.pin_source === "typed" ? `Pin you pasted${km}.` : `Pinned from your link${km}.`, link: null, href: null, rest: "" };
}

// ---------------------------------------------------------------- tg-build7's e2e findings (W-1, W-8, W-9)

/** e2e W-1: a plan on screen that's newer than the last one, so another phone's change is said. The first plan the page
 * opens with is no news; the first copy after a shared plan (a null seq) is. */
export function newerPlan(before: { slug: string; seq: number | null } | undefined, now: { slug: string; seq: number | null }): boolean {
  if (!before || now.seq === null) return false;
  return before.slug !== now.slug ? before.seq === null || now.seq > before.seq : now.seq > (before.seq ?? -1);
}

/** e2e W-8: a terminal's town, as ux §7 names it ("Cubao"): the name without its operator's, when it starts with it. */
export function town(terminal: string, operator: string): string {
  return terminal.startsWith(`${operator} `) ? terminal.slice(operator.length + 1) : terminal;
}

/** e2e W-9 (ux §7): after a swap, the booked bus row's note may name the old bus. Said until a later version changes that
 * row (a line with its plan text). Read from the last five versions, so it ends once the swap scrolls out of them. */
export function busChangedLine(edits: PlanEdits | null | undefined, rowPlan: string): string | null {
  const versions = edits?.versions ?? [];
  const swap = versions.findIndex((v) => v.changes.some((l) => l.word === "Bus"));
  if (swap < 0) return null;
  if (versions.slice(0, swap).some((v) => v.changes.some((l) => l.word !== "More" && l.text === rowPlan))) return null;
  return `The bus changed on ${dayOf(versions[swap].created_at)}. Check this note.`;
}
