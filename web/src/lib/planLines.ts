// TG-61: the words for a plan change. The server sends each change as a ChangeLine {word, day, text}; the phone writes
// the sentences (review S8), with its own level numbers only for a change it made itself (ux.md §3.1).

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

const todo = (): never => {
  throw new Error("TG-61: not built yet");
};
export const resultLine = (_lines: ChangeLine[], _done: Done, _levelOf: (key: string) => string | null, _opts: { firstCopy?: boolean } = {}): string => todo();
export const summaryOf = (_v: PlanVersion): string => todo();
export const historyLine = (_v: PlanVersion, _today: string): string => todo();
export const justChanged = (_v: PlanVersion): string => todo();
export const changeRows = (_lines: ChangeLine[]): { word: string | null; text: string }[] => todo();
export const undoLabel = (_edits: PlanEdits | null | undefined): "Undo" | "Redo" => todo();
export const undoConfirm = (_edits: PlanEdits | null | undefined, _mine: ReadonlyMap<number, number>, _now: number): string | null => todo();
export const copyLine = (_edited: boolean, _edits: PlanEdits | null | undefined): string | null => todo();
