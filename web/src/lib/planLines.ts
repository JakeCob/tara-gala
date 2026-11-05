// TG-61: the words for a plan change. The server sends each change as a ChangeLine {word, day, text}; the phone writes
// the sentences (review S8), with its own level numbers only for a change it made itself (ux.md §3.1).

import { formatTime } from "./api.ts";

export type ChangeLine = { word: string; day: number | null; text: string; part?: "stop" | "ripple" };
export type PlanVersion = { seq: number; source: "copy" | "hand" | "chat" | "undo"; changes: ChangeLine[]; created_at: string };
/** SessionOut.plan_edits: the copy's newest version and its last five, newest first. Null before the first edit. */
export type PlanEdits = { seq: number; versions: PlanVersion[] };

/** What this phone just did, for the edit bar's line. */
export type Done =
  | { kind: "add"; after: string | null; day: number }
  | { kind: "replace" }
  | { kind: "edit"; key: string }
  | { kind: "move"; day: number }
  | { kind: "nudge"; dir: "earlier" | "later" }
  | { kind: "remove" }
  | { kind: "bus"; from: string; to: string }
  | { kind: "list"; what: "budget" | "todo" | "sources" | "pick" }
  | { kind: "chat" }
  | { kind: "undo"; redo: boolean; undone: PlanVersion | null };

const MINE_FOR_MS = 10 * 60_000; // ux.md §3.2: Undo asks first after this, or for another phone's change
const LISTS = { budget: "Changed the budget.", todo: "Changed the to-do list.", sources: "Changed the sources.", pick: "Changed the choices." } as const;

const manila = (iso: string, opts: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleString("en-US", { timeZone: "Asia/Manila", ...opts });
const clock = (iso: string) => manila(iso, { hour: "numeric", minute: "2-digit" });
const dayOf = (iso: string) => manila(iso, { month: "short", day: "numeric" });
const manilaDate = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
const world = (l: ChangeLine) => (l.day === null ? "" : ` (World ${l.day})`);

/** How many changes a version holds past its first sentence: the lines after it, and the server's own "and N more". */
function moreThan(lines: ChangeLine[], used: number): number {
  const more = lines.find((l) => l.word === "More");
  const counted = lines.filter((l) => l.word !== "More").length - used;
  return Math.max(0, counted) + (more ? Number(more.text.match(/\d+/)?.[0] ?? 0) : 0);
}
const andMore = (n: number) => (n ? ` And ${n} more change${n === 1 ? "" : "s"}.` : "");
const pair = (lines: ChangeLine[]) => ({ out: lines.find((l) => l.word === "Out"), in: lines.find((l) => l.word === "In") });

/** The edit bar's line after this phone's own change (ux.md §3.1), with this phone's level numbers. */
export function resultLine(lines: ChangeLine[], done: Done, levelOf: (key: string) => string | null, opts: { firstCopy?: boolean } = {}): string {
  const first = lines.find((l) => l.word !== "More");
  const text = first?.text ?? "";
  let said: string;
  let used = 1;
  switch (done.kind) {
    case "add": {
      const added = lines.find((l) => l.word === "New") ?? first;
      const after = done.after && levelOf(done.after);
      said = after ? `Added ${added?.text ?? ""} after Level ${after}.` : `Added ${added?.text ?? ""} at the start of World ${done.day}.`;
      break;
    }
    case "replace": {
      const p = pair(lines);
      said = `${p.out?.text ?? ""} is now ${p.in?.text ?? text}.`;
      used = p.out && p.in ? 2 : 1;
      break;
    }
    case "edit":
      said = `Changed Level ${levelOf(done.key) ?? ""}.`;
      break;
    case "move":
      said = `Moved ${text} to World ${done.day}.`;
      break;
    case "nudge":
      said = `Moved ${text} ${done.dir}.`;
      break;
    case "remove":
      said = `Removed ${text}. Undo brings it back.`;
      break;
    case "bus":
      said = `Swapped the ${formatTime(done.from)} bus for the ${formatTime(done.to)}.`;
      break;
    case "list":
      said = LISTS[done.what];
      break;
    case "chat":
      return "Applied the chatbot's change.";
    case "undo":
      return `${done.redo ? "Put back" : "Undid"}: ${done.undone ? summaryOf(done.undone) : "the last change"}.`;
  }
  const copy = opts.firstCopy ? " This trip now has its own copy of the plan. The shared plan's link doesn't change." : "";
  return said + andMore(moreThan(lines, used)) + copy;
}

/** A version in a few words, with its World and no level number: positions move after later changes (ux.md §3.1). */
export function summaryOf(v: PlanVersion): string {
  const l = v.changes.find((c) => c.word !== "More");
  const said = ((): string => {
    if (!l) return "Changed the plan";
    switch (l.word) {
      case "New":
        return `Added ${l.text}${world(l)}`;
      case "Out":
      case "In": {
        const p = pair(v.changes);
        return `${p.out?.text ?? ""} is now ${p.in?.text ?? ""}${world(l)}`;
      }
      case "Moved":
      case "Earlier":
      case "Later":
        return `Moved ${l.text}${world(l)}`;
      case "Dropped":
        return `Removed ${l.text}${world(l)}`;
      case "Bus":
        return `Swapped a bus: ${l.text}`;
      case "Budget":
        return "Changed the budget";
      case "To-do":
        return "Changed the to-do list";
      case "Sources":
        return "Changed the sources";
      case "Copied":
        return "Copied the plan";
      default:
        return `Changed ${l.text}${world(l)}`;
    }
  })();
  return v.source === "chat" ? `Chatbot: ${said}` : said;
}

/** A line in Changes: the Manila time today, the date before that. */
export function historyLine(v: PlanVersion, today: string): string {
  return `${manilaDate(v.created_at) === today ? clock(v.created_at) : dayOf(v.created_at)} · ${summaryOf(v)}`;
}

/** Another phone's change, above the World tabs (ux.md §6). */
export function justChanged(v: PlanVersion): string {
  return `The plan just changed: ${summaryOf(v)}.`;
}

/** What changes, in a proposal: a bold word, the World, the text. The server's More is a plain line. */
export function changeRows(lines: ChangeLine[]): { word: string | null; text: string }[] {
  return lines.map((l) => (l.word === "More" ? { word: null, text: l.text } : { word: l.word, text: l.day === null ? l.text : `World ${l.day}, ${l.text}` }));
}

/** Undo's honest name: right after an undo, the next tap puts the change back. */
export function undoLabel(edits: PlanEdits | null | undefined): "Undo" | "Redo" {
  return edits?.versions[0]?.source === "undo" ? "Redo" : "Undo";
}

/** The confirm before undoing a change that may be another phone's, or this phone's from a while ago. Null: no confirm. */
export function undoConfirm(edits: PlanEdits | null | undefined, mine: ReadonlyMap<number, number>, now: number): string | null {
  const v = edits?.versions[0];
  if (!v) return null;
  const at = mine.get(v.seq);
  if (at !== undefined && now - at <= MINE_FOR_MS) return null;
  return `Undo the last change? "${summaryOf(v)}", at ${clock(v.created_at)}, maybe from another phone.`;
}

/** Under the guide's summary once the trip has its own copy (ux.md §2). */
export function copyLine(edited: boolean, edits: PlanEdits | null | undefined): string | null {
  if (!edited) return null;
  const at = edits?.versions[0]?.created_at;
  return at ? `Your group's own copy of the plan, last changed ${dayOf(at)}, ${clock(at)}.` : "Your group's own copy of the plan.";
}
