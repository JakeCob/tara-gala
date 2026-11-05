// TG-61: the hand editor's pure helpers. The phone sends the whole new guide on every save, in its stored shape
// (options.md §3.1), worked out from the plan on screen. The server mints every key: a new row, to-do or choice goes up
// with key (or id) null, and a key the phone sends must already be in the plan it was worked out from. Nothing here
// calls fetch, and no helper changes the guide it's given.

import type { Condition, Guide, LegOut } from "./guide.ts";

export type PlaceIn = { spot_id: string } | { terminal_id: string } | { trip_place_id: string };
export type LegIn = { last_mile_route_id: string } | { estimate: { mode: "walk" | "taxi"; minutes: number; km: number } };
/** The stored shape (api GuideIn): what the server checks and saves. Absent means none, as in the stored plan. */
export type RowIn = {
  key: string | null;
  time: string;
  plan: string;
  note: string;
  place?: PlaceIn;
  bus?: "outbound" | "return";
  show_if?: Condition;
  hide_if?: Condition;
  leg?: LegIn;
};
export type OptionIn = { id: string | null; label: string; leave: string; what: string; place?: PlaceIn };
export type DayIn = { day: number; title: string; intro: string; pick?: { key: string; title: string; options: OptionIn[] }; rows: RowIn[]; tips: string[] };
export type BusRowIn = { trip_id: string; date: string; note: string; booked: boolean };
export type BusTableIn = { title: string; intro: string; buses: BusRowIn[]; tips: string[] };
export type GuideIn = {
  title: string;
  summary: string;
  lodging?: PlaceIn;
  getting_there: BusTableIn;
  days: DayIn[];
  getting_home: BusTableIn;
  budget: { summary: string; rows: { item: string; estimate: string }[]; excluded: string };
  todo: { key: string | null; text: string; done: boolean }[];
  sources: { label: string; url?: string }[];
};

/** POST /plan/suggest's answer (options.md §5.1). Nothing is saved until Apply. */
export type Suggestion = {
  name: string | null;
  lat: number | null;
  lng: number | null;
  maps_url: string | null;
  km_from_baguio: number | null;
  far: boolean;
  time: string;
  leg: LegOut | null;
  ripple: ({ key: string; time: string } | { key: string; drop: true })[];
  notes: string[];
  changes: { word: string; day: number | null; text: string; part?: "stop" | "ripple" }[];
};
/** Where a stop goes: in place of a row, after one, first on a day, or a row moved to the end of another day. */
export type At = { replace: string } | { after: string } | { first_of_day: number } | { move: string; day: number };
export type NewRow = { time: string; plan: string; note: string; place?: PlaceIn | null };

const todo = (): never => {
  throw new Error("TG-61: not built yet");
};
export const toStored = (_guide: Guide): GuideIn => todo();
export const legIn = (_leg: LegOut): LegIn => todo();
export const addRow = (_g: GuideIn, _at: { after: string } | { end_of_day: number } | { first_of_day: number }, _row: NewRow): GuideIn => todo();
export const removeRow = (_g: GuideIn, _key: string): GuideIn | null => todo();
export const moveRow = (_g: GuideIn, _key: string, _day: number, _afterKey: string | null): GuideIn | null => todo();
export const nudgeRow = (_g: GuideIn, _key: string, _dir: -1 | 1, _shows?: (row: RowIn) => boolean): GuideIn | null => todo();
export const setRow = (_g: GuideIn, _key: string, _parts: { time?: string; plan?: string; note?: string }): GuideIn => todo();
export const replacePlace = (_g: GuideIn, _key: string, _to: { place: PlaceIn | null; plan: string; leg?: LegIn }): GuideIn => todo();
export const applySuggestion = (_g: GuideIn, _at: At, _s: Suggestion, _picked: { place: PlaceIn | null; plan: string; time: string; ripple: boolean }): GuideIn => todo();
export const swapBus = (_g: GuideIn, _table: "getting_there" | "getting_home", _index: number, _tripId: string): GuideIn => todo();
export const editTodo = (_g: GuideIn, _op: { add: string } | { set: string; text: string } | { remove: string }): GuideIn => todo();
export const editBudget = (
  _g: GuideIn,
  _op: { add: { item: string; estimate: string } } | { set: number; row: { item: string; estimate: string } } | { remove: number } | { summary: string } | { excluded: string },
): GuideIn => todo();
export const editSources = (_g: GuideIn, _op: { add: { label: string; url: string | null } } | { set: number; source: { label: string; url: string | null } } | { remove: number }): GuideIn => todo();
export const editPickOption = (
  _g: GuideIn,
  _day: number,
  _op: { add: { label: string; leave: string; what: string } } | { set: string; option: { label: string; leave: string; what: string } } | { remove: string },
): GuideIn => todo();
