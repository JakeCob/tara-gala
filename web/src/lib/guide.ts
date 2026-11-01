// TG-52: an itinerary's guide (api/app/guide.py): the day tables, bus tables, sunrise pick, budget, to-do and sources
// around the checked plan. On a trip it's the shared checklist and progress map: anyone ticks any row, and the party
// stands at the latest-ticked row that has a place.

import type { Trip } from "./api.ts";
import type { SpriteName } from "./sprites.ts";
import { placeSprite } from "./sprites.ts";

export type GuidePlace = { kind: "spot" | "terminal"; id: string; name: string | null; category: string | null; lodging: boolean };
export type Condition = { pick: string; is: string };
export type GuideRow = {
  key: string;
  time: string;
  plan: string;
  note: string;
  place: GuidePlace | null;
  bus: "outbound" | "return" | null;
  show_if: Condition | null;
  hide_if: Condition | null;
};
export type PickOption = { id: string; label: string; leave: string; what: string; place: GuidePlace | null };
export type GuideDay = {
  day: number;
  title: string;
  intro: string;
  pick: { key: string; title: string; options: PickOption[] } | null;
  rows: GuideRow[];
  tips: string[];
};
export type BusRow = { trip_id: string; date: string; trip: Trip | null; note: string; booked: boolean };
export type BusTable = { title: string; intro: string; buses: BusRow[]; tips: string[] };
export type Guide = {
  title: string;
  summary: string;
  lodging: GuidePlace | null;
  getting_there: BusTable;
  days: GuideDay[];
  getting_home: BusTable;
  budget: { summary: string; rows: { item: string; estimate: string }[]; excluded: string };
  todo: { key: string; text: string; done: boolean }[];
  sources: { label: string; url: string | null }[];
};

/** The trip's ticks and picks, by key (api SessionOut.marks). */
export type Mark = { key: string; value: string; updated_at: string };

export const rowMark = (row: Pick<GuideRow, "key">) => `row:${row.key}`;
export const todoMark = (todo: { key: string }) => `todo:${todo.key.replace(/^todo-/, "")}`;
export const pickMark = (pickKey: string) => `pick:${pickKey}`;

export function marksByKey(marks: readonly Mark[]): Map<string, Mark> {
  return new Map(marks.map((m) => [m.key, m]));
}

/** Whether a row shows for the picks so far. Before a pick, every option's rows show (each says which option). */
export function rowShows(row: GuideRow, picks: ReadonlyMap<string, Mark>): boolean {
  const chosen = (c: Condition) => picks.get(pickMark(c.pick))?.value;
  if (row.show_if && chosen(row.show_if) !== undefined && chosen(row.show_if) !== row.show_if.is) return false;
  if (row.hide_if && chosen(row.hide_if) === row.hide_if.is) return false;
  return true;
}

/** The ticked row with a place that was ticked last: where the party is now. Null before any such tick. */
export function whereNow(guide: Guide, marks: readonly Mark[]): { day: number; key: string } | null {
  const byKey = marksByKey(marks);
  const rows = new Map(guide.days.flatMap((d) => d.rows.filter((r) => r.place && rowShows(r, byKey)).map((r) => [rowMark(r), { day: d.day, key: r.key }] as const)));
  let best: { day: number; key: string; at: string } | null = null;
  for (const m of marks) {
    const row = rows.get(m.key);
    if (row && m.value === "done" && (!best || m.updated_at >= best.at)) best = { ...row, at: m.updated_at };
  }
  return best && { day: best.day, key: best.key };
}

/** The map icon for a row's place: the hotel, a bus terminal, or the spot's kind. */
export function placeIcon(place: GuidePlace | null): SpriteName | null {
  if (!place) return null;
  if (place.lodging) return "place-lodging";
  if (place.kind === "terminal") return "place-terminal";
  return placeSprite(place.category ?? "other");
}

/** "Day 2: 4 of 7 done", counting only the rows that show. */
export function dayProgress(day: GuideDay, marks: ReadonlyMap<string, Mark>): { done: number; total: number } {
  const rows = day.rows.filter((r) => rowShows(r, marks));
  return { done: rows.filter((r) => marks.get(rowMark(r))?.value === "done").length, total: rows.length };
}
