// TG-61: the hand editor's pure helpers. The phone sends the whole new guide on every save, in its stored shape
// (options.md §3.1), worked out from the plan on screen. The server mints every key: a new row, to-do or choice goes up
// with key (or id) null, and a key the phone sends must already be in the plan it was worked out from. Nothing here
// calls fetch, and no helper changes the guide it's given.

import type { BusTable, Condition, Guide, GuidePlace, LegOut } from "./guide.ts";

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

// ---------------------------------------------------------------- the read shape back to the stored one

const placeIn = (p: GuidePlace | null | undefined): PlaceIn | undefined => {
  if (!p) return undefined;
  if (p.kind === "trip_place") return { trip_place_id: p.id };
  return p.kind === "terminal" ? { terminal_id: p.id } : { spot_id: p.id };
};

/** A leg as stored: the route's id, or the estimate itself. The route's details come back from its row on every read. */
export function legIn(leg: LegOut): LegIn {
  return leg.kind === "route" ? { last_mile_route_id: leg.last_mile_route_id } : { estimate: { mode: leg.mode, minutes: leg.minutes, km: leg.km } };
}

/** Drops the keys whose value is null or absent, as the stored plan does (the loader saves with exclude_none). A new
 * row's key and a new choice's id stay as null: that's how the server knows to mint one. */
function some<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([k, v]) => v !== undefined && (v !== null || k === "key" || k === "id"))) as T;
}

const tableIn = (t: BusTable): BusTableIn => ({
  title: t.title, intro: t.intro, tips: [...t.tips],
  buses: t.buses.map((b) => ({ trip_id: b.trip_id, date: b.date, note: b.note, booked: b.booked })),
});

/** GuideOut to the stored guide, without loss (options.md §3.1). A test checks it on the owner's plan. */
export function toStored(g: Guide): GuideIn {
  return some({
    title: g.title, summary: g.summary, lodging: placeIn(g.lodging),
    getting_there: tableIn(g.getting_there), getting_home: tableIn(g.getting_home),
    budget: { summary: g.budget.summary, rows: g.budget.rows.map((r) => ({ item: r.item, estimate: r.estimate })), excluded: g.budget.excluded },
    todo: g.todo.map((t) => ({ key: t.key, text: t.text, done: t.done })),
    sources: g.sources.map((x) => some({ label: x.label, url: x.url ?? undefined })),
    days: g.days.map((d) => some({
      day: d.day, title: d.title, intro: d.intro, tips: [...d.tips],
      pick: d.pick ? { key: d.pick.key, title: d.pick.title, options: d.pick.options.map((o) => some({ id: o.id, label: o.label, leave: o.leave, what: o.what, place: placeIn(o.place) })) } : undefined,
      rows: d.rows.map((r) => some({
        key: r.key, time: r.time, plan: r.plan, note: r.note, place: placeIn(r.place), bus: r.bus ?? undefined,
        show_if: r.show_if ? { pick: r.show_if.pick, is: r.show_if.is } : undefined, hide_if: r.hide_if ? { pick: r.hide_if.pick, is: r.hide_if.is } : undefined,
        leg: r.leg ? legIn(r.leg) : undefined,
      }) as RowIn),
    })),
  });
}

// ---------------------------------------------------------------- the edits: each one a new guide

const where = (g: GuideIn, key: string) => {
  for (const [d, day] of g.days.entries()) {
    const i = day.rows.findIndex((r) => r.key === key);
    if (i >= 0) return { d, i, row: day.rows[i] };
  }
  return null;
};
const withRows = (g: GuideIn, d: number, rows: RowIn[]): GuideIn => ({ ...g, days: g.days.map((day, j) => (j === d ? { ...day, rows } : day)) });
const dayIndex = (g: GuideIn, n: number) => g.days.findIndex((d) => d.day === n);

/** A new row, key null. After a row, it takes that row's condition, so it shows with it (tg-ux 5). */
export function addRow(g: GuideIn, at: { after: string } | { end_of_day: number } | { first_of_day: number }, row: NewRow): GuideIn {
  const fresh = (cond?: Pick<RowIn, "show_if" | "hide_if">): RowIn => some({ key: null, time: row.time, plan: row.plan, note: row.note, place: row.place ?? undefined, show_if: cond?.show_if, hide_if: cond?.hide_if });
  if ("after" in at) {
    const w = where(g, at.after);
    if (!w) return g;
    const rows = [...g.days[w.d].rows];
    rows.splice(w.i + 1, 0, fresh(w.row));
    return withRows(g, w.d, rows);
  }
  const d = dayIndex(g, "end_of_day" in at ? at.end_of_day : at.first_of_day);
  if (d < 0) return g;
  const rows = "end_of_day" in at ? [...g.days[d].rows, fresh()] : [fresh(), ...g.days[d].rows];
  return withRows(g, d, rows);
}

/** Null when there's nothing to remove, or it's a bus row: those stay, as their time comes from the bus. */
export function removeRow(g: GuideIn, key: string): GuideIn | null {
  const w = where(g, key);
  if (!w || w.row.bus) return null;
  return withRows(g, w.d, g.days[w.d].rows.filter((r) => r.key !== key));
}

/** The row, key and all, to another day after `afterKey` (null: first). A bus row stays on its day. */
export function moveRow(g: GuideIn, key: string, day: number, afterKey: string | null): GuideIn | null {
  const w = where(g, key);
  const to = dayIndex(g, day);
  if (!w || to < 0 || (w.row.bus && to !== w.d)) return null;
  const out = withRows(g, w.d, g.days[w.d].rows.filter((r) => r.key !== key));
  const rows = [...out.days[to].rows];
  const after = afterKey === null ? -1 : rows.findIndex((r) => r.key === afterKey);
  if (afterKey !== null && after < 0) return null;
  rows.splice(after + 1, 0, w.row);
  return withRows(out, to, rows);
}

/** One step earlier (-1) or later (1), past the rows that don't show for the picks. Null at either end of the day. */
export function nudgeRow(g: GuideIn, key: string, dir: -1 | 1, shows: (row: RowIn) => boolean = () => true): GuideIn | null {
  const w = where(g, key);
  if (!w) return null;
  const rows = g.days[w.d].rows;
  let j = w.i + dir;
  while (j >= 0 && j < rows.length && !shows(rows[j])) j += dir;
  if (j < 0 || j >= rows.length) return null;
  const next = rows.filter((r) => r.key !== key);
  const past = next.indexOf(rows[j]);
  next.splice(dir < 0 ? past : past + 1, 0, w.row);
  return withRows(g, w.d, next);
}

export function setRow(g: GuideIn, key: string, parts: { time?: string; plan?: string; note?: string }): GuideIn {
  const w = where(g, key);
  if (!w) return g;
  return withRows(g, w.d, g.days[w.d].rows.map((r) => (r.key === key ? { ...r, ...some(parts) } : r)));
}

/** The same slot, key and condition, with another place. A place with no pin has no leg. */
export function replacePlace(g: GuideIn, key: string, to: { place: PlaceIn | null; plan: string; leg?: LegIn }): GuideIn {
  const w = where(g, key);
  if (!w) return g;
  const row: RowIn = some({ ...w.row, plan: to.plan, place: to.place ?? undefined, leg: to.leg });
  return withRows(g, w.d, g.days[w.d].rows.map((r) => (r.key === key ? row : r)));
}

/** The ripple's later rows, shifted or dropped, on the guide as it is. */
function ripple(g: GuideIn, moves: Suggestion["ripple"]): GuideIn {
  let out = g;
  for (const m of moves) {
    if ("drop" in m) out = removeRow(out, m.key) ?? out;
    else out = setRow(out, m.key, { time: m.time });
  }
  return out;
}

/** A proposal, with only the parts the user kept: their time and plan text, the leg, and the ripple if chosen. */
export function applySuggestion(g: GuideIn, at: At, s: Suggestion, picked: { place: PlaceIn | null; plan: string; time: string; ripple: boolean }): GuideIn {
  const leg = picked.place && s.leg ? legIn(s.leg) : undefined;
  let out: GuideIn;
  if ("replace" in at) out = replacePlace(g, at.replace, { place: picked.place, plan: picked.plan, leg });
  else if ("move" in at) {
    const last = g.days[dayIndex(g, at.day)]?.rows.at(-1)?.key ?? null;
    out = moveRow(g, at.move, at.day, last === at.move ? null : last) ?? g;
    out = setRow(out, at.move, { time: picked.time });
  } else {
    out = addRow(g, "after" in at ? at : { first_of_day: at.first_of_day }, { time: picked.time, plan: picked.plan, note: "", place: picked.place });
    if (leg) {
      const fresh = "after" in at ? where(out, at.after)! : { d: dayIndex(out, at.first_of_day), i: -1 };
      out = withRows(out, fresh.d, out.days[fresh.d].rows.map((r, i) => (i === fresh.i + 1 ? { ...r, leg } : r)));
    }
  }
  return picked.ripple ? ripple(out, s.ripple) : out;
}

/** Only which real trip a bus row is: its date and the table stay (D5). */
export function swapBus(g: GuideIn, table: "getting_there" | "getting_home", index: number, tripId: string): GuideIn {
  return { ...g, [table]: { ...g[table], buses: g[table].buses.map((b, i) => (i === index ? { ...b, trip_id: tripId } : b)) } };
}

export function editTodo(g: GuideIn, op: { add: string } | { set: string; text: string } | { remove: string }): GuideIn {
  if ("add" in op) return { ...g, todo: [...g.todo, { key: null, text: op.add, done: false }] };
  if ("set" in op) return { ...g, todo: g.todo.map((t) => (t.key === op.set ? { ...t, text: op.text } : t)) };
  return { ...g, todo: g.todo.filter((t) => t.key !== op.remove) };
}

export function editBudget(
  g: GuideIn,
  op: { add: { item: string; estimate: string } } | { set: number; row: { item: string; estimate: string } } | { remove: number } | { summary: string } | { excluded: string },
): GuideIn {
  const b = g.budget;
  if ("add" in op) return { ...g, budget: { ...b, rows: [...b.rows, op.add] } };
  if ("set" in op) return { ...g, budget: { ...b, rows: b.rows.map((r, i) => (i === op.set ? op.row : r)) } };
  if ("remove" in op) return { ...g, budget: { ...b, rows: b.rows.filter((_, i) => i !== op.remove) } };
  return { ...g, budget: { ...b, ...op } };
}

export function editSources(g: GuideIn, op: { add: { label: string; url: string | null } } | { set: number; source: { label: string; url: string | null } } | { remove: number }): GuideIn {
  const clean = (x: { label: string; url: string | null }) => some({ label: x.label, url: x.url ?? undefined });
  if ("add" in op) return { ...g, sources: [...g.sources, clean(op.add)] };
  if ("set" in op) return { ...g, sources: g.sources.map((x, i) => (i === op.set ? clean(op.source) : x)) };
  return { ...g, sources: g.sources.filter((_, i) => i !== op.remove) };
}

/** A pick's choices. Removing one first clears the condition on its rows, so they show whatever the group picks. */
export function editPickOption(
  g: GuideIn,
  day: number,
  op: { add: { label: string; leave: string; what: string } } | { set: string; option: { label: string; leave: string; what: string } } | { remove: string },
): GuideIn {
  const d = dayIndex(g, day);
  const pick = g.days[d]?.pick;
  if (!pick) return g;
  let options = pick.options;
  let out = g;
  if ("add" in op) options = [...options, { id: null, ...op.add }];
  else if ("set" in op) options = options.map((o) => (o.id === op.set ? { ...o, ...op.option } : o));
  else {
    options = options.filter((o) => o.id !== op.remove);
    const loose = (c?: Condition) => c && c.pick === pick.key && c.is === op.remove;
    out = { ...g, days: g.days.map((dd) => ({ ...dd, rows: dd.rows.map((r) => some({ ...r, show_if: loose(r.show_if) ? undefined : r.show_if, hide_if: loose(r.hide_if) ? undefined : r.hide_if })) })) };
  }
  return { ...out, days: out.days.map((dd, j) => (j === d ? { ...dd, pick: { ...pick, options } } : dd)) };
}
