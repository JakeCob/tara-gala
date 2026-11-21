// TG-69: the trip page's Next up card (ux.md). One pure function decides the card's state and parts from the two
// answers the page already saves for offline (the session and the plan), so it works offline with no new request.
// Never invents a time: a stop's is its row's, a bus's is always its `trips` departure. `today` and `now` are Manila's,
// passed in, so nothing here reads the clock.

import { formatTime, formatVerified } from "./api.ts";
import { type BusRow, type Guide, type GuideDay, type GuideRow, type Mark, marksByKey, pickMark, rowMark, todoMark } from "./guide.ts";
import { type Level, levels, nextLevel, placeMapsUrl } from "./levelMap.ts";
import { legLines } from "./planLines.ts";
import { type Trip, hotelMapsUrl } from "./trip.ts";

export type Direction = "outbound" | "return";
export type BusPart = { kind: "bus"; direction: Direction; row: BusRow; booked: boolean } | { kind: "gone"; direction: Direction };
export type Then = { time: string | null; plan: string };
export type StopPart =
  | { kind: "row"; day: number; key: string; time: string | null; plan: string; leg: string | null; mapsUrl: string | null; mapsName: string | null; then: Then | null }
  | { kind: "busRow"; day: number; key: string; plan: string; bus: BusPart | null; then: Then | null }
  | { kind: "pick"; day: number; title: string }
  | { kind: "todayDone"; nextDay: number; tomorrow: Then | null }
  | { kind: "allDone" }
  | { kind: "nothingToday" }
  | { kind: "opening" };
/** checkOut: the hotel's check_out wall time, set only on its Manila date (B19b) */
export type HotelPart =
  | { from: "trip"; name: string; address: string; mapsUrl: string; checkOut: string | null }
  | { from: "lodging"; name: string; mapsUrl: string }
  | { from: "none" };
/** stop null: no plan. hotel null: after check-out (B19b). todos null: none on the plan */
export type NextUp =
  | { state: "during"; day: number; days: number; date: string; stop: StopPart | null; bus: BusPart | null; hotel: HotelPart | null }
  | { state: "tomorrow"; date: string; bus: BusPart | null; todos: { left: number } | null };
export type Phase = "before" | "tomorrow" | "during" | "after";
/** Where the card's buttons send the map: a World, a level's dialog in it, or a menu panel */
export type NextUpJump = { day?: number; key?: string; menu?: "buses" | "todo" };
export type NextUpTrip = Pick<Trip, "start_date" | "return_date" | "hotel" | "marks">;
export type TableRow = { table: "getting_there" | "getting_home"; row: BusRow };

const DAY_MS = 86_400_000;
const utc = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
const addDays = (iso: string, n: number) => new Date(utc(iso) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((utc(to) - utc(from)) / DAY_MS);
const DIRECTION = { getting_there: "outbound", getting_home: "return" } as const;
const TABLE = { outbound: "getting_there", return: "getting_home" } as const;

/** "22:30" or "22:30:00" as minutes since midnight, so times never compare as strings (review N2) */
export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/**
 * B14b: one rule for every bus the card shows, over rows that share one date. Booked rows only, if any are; with
 * `now`, rows that have left drop out (a 13:00 bus has left at 13:00); then the earliest, ties going getting_there
 * first, then table order. A row no longer listed (`trip: null`) has no time, so it's picked only if no timed row is left.
 */
export function pickBus(rows: readonly TableRow[], now: string | null): BusPart | null {
  const booked = rows.filter((r) => r.row.booked);
  const pool = booked.length ? booked : rows;
  const timed = pool
    .map((r, i) => ({ ...r, i }))
    .filter((r) => r.row.trip && (now === null || toMinutes(r.row.trip.departure_time) > toMinutes(now)))
    .sort((a, b) => toMinutes(a.row.trip!.departure_time) - toMinutes(b.row.trip!.departure_time) || (a.table === b.table ? a.i - b.i : a.table === "getting_there" ? -1 : 1));
  const first = timed[0];
  if (first) return { kind: "bus", direction: DIRECTION[first.table], row: first.row, booked: first.row.booked };
  const gone = pool.find((r) => !r.row.trip);
  return gone ? { kind: "gone", direction: DIRECTION[gone.table] } : null;
}

const rowsOn = (guide: Guide, date: string, tables: readonly ("getting_there" | "getting_home")[]): TableRow[] =>
  tables.flatMap((table) => guide[table].buses.filter((b) => b.date === date).map((row) => ({ table, row })));

/** The bus on a date, from both tables; `now` null skips the has-it-left check (tomorrow's bus) */
export function busOn(guide: Guide, date: string, now: string | null): BusPart | null {
  return pickBus(rowsOn(guide, date, ["getting_there", "getting_home"]), now);
}

/** B9: a bus row's bus, from its own table on that day's trip date. Never the row's own time */
export function busFor(guide: Guide, row: GuideRow, date: string): BusPart | null {
  return row.bus ? pickBus(rowsOn(guide, date, [TABLE[row.bus]]), null) : null;
}

/** Where today sits against the trip's dates (Manila dates, plain calendar days) */
export function phase(today: string, trip: Pick<Trip, "start_date" | "return_date">): Phase {
  if (today > trip.return_date) return "after";
  if (today >= trip.start_date) return "during";
  return today === addDays(trip.start_date, -1) ? "tomorrow" : "before";
}

/** A row's time and words for a Then or Tomorrow line: a bus row's time is its bus's */
function lineFor(guide: Guide, row: GuideRow, date: string): Then {
  if (!row.bus) return { time: row.time || null, plan: row.plan };
  const b = busFor(guide, row, date);
  return { time: b?.kind === "bus" ? b.row.trip!.departure_time : null, plan: row.plan };
}

/** Whether a row shows only for an option of a pick nobody has made yet */
const waitsOnPick = (row: GuideRow, byKey: ReadonlyMap<string, Mark>) => !!row.show_if && !byKey.has(pickMark(row.show_if.pick));

function stopFor(guide: Guide, trip: NextUpTrip, n: number, byKey: ReadonlyMap<string, Mark>, city: string): StopPart {
  const dateOf = (d: number) => addDays(trip.start_date, d - 1);
  const today = guide.days.find((d) => d.day === n);
  const list: Level[] = today ? levels(today, byKey) : [];
  if (!today || list.length === 0) return { kind: "nothingToday" };
  // The map's own lit tile (data-next), so the card and the map always agree (ux §5.2)
  const key = nextLevel(levels(today, byKey));
  const at = list.findIndex((l) => l.row.key === key);
  if (at < 0) {
    const next: GuideDay | undefined = guide.days.find((d) => d.day === n + 1);
    if (!next) return { kind: "allDone" };
    const first = levels(next, byKey).find((l) => !l.done);
    return { kind: "todayDone", nextDay: n + 1, tomorrow: first ? lineFor(guide, first.row, dateOf(n + 1)) : null };
  }
  const row = list[at].row;
  if (waitsOnPick(row, byKey)) {
    const title = guide.days.find((d) => d.pick?.key === row.show_if!.pick)?.pick?.title ?? today.pick?.title ?? "";
    return { kind: "pick", day: n, title };
  }
  const after = list.slice(at + 1).find((l) => !l.done);
  const then = after && !waitsOnPick(after.row, byKey) ? lineFor(guide, after.row, dateOf(n)) : null;
  if (row.bus) return { kind: "busRow", day: n, key: row.key, plan: row.plan, bus: busFor(guide, row, dateOf(n)), then };
  const place = row.place?.name ? row.place : null;
  return {
    kind: "row", day: n, key: row.key, time: row.time || null, plan: row.plan, leg: row.leg ? legLines(row.leg).line : null,
    mapsUrl: place ? placeMapsUrl({ name: place.name!, kind: place.kind, lat: place.lat, lng: place.lng, city }) : null, mapsName: place?.name ?? null, then,
  };
}

/** B16: once the plan's bus row for that direction is ticked, its bus is no longer one to catch */
function busToday(guide: Guide, date: string, now: string | null, byKey: ReadonlyMap<string, Mark>): BusPart | null {
  const ticked = (dir: Direction) => guide.days.some((d) => d.rows.some((r) => r.bus === dir && byKey.get(rowMark(r))?.value === "done"));
  const rows = rowsOn(guide, date, ["getting_there", "getting_home"]).filter((r) => !ticked(DIRECTION[r.table]));
  return pickBus(rows, now);
}

function hotelFor(trip: NextUpTrip, guide: Guide | null, today: string, city: string): HotelPart | null {
  const h = trip.hotel;
  if (h) {
    const out = h.check_out?.slice(0, 10) ?? null; // Manila wall time, so its date is the Manila date
    if (out && today > out) return null; // after check-out: no old address at 2:30 AM in Cubao (ux §5.4)
    return { from: "trip", name: h.name, address: h.address, mapsUrl: hotelMapsUrl(h), checkOut: out === today ? h.check_out : null };
  }
  const lodge = guide?.lodging;
  if (lodge?.name) return { from: "lodging", name: lodge.name, mapsUrl: placeMapsUrl({ name: lodge.name, kind: lodge.kind, lat: lodge.lat, lng: lodge.lng, city }) };
  return { from: "none" };
}

/** The card for today, or null when there's none (ux §2, §6, §8.1) */
export function nextUp({ today, now, trip, guide, city }: { today: string; now: string; trip: NextUpTrip; guide: Guide | "frame" | null; city: string }): NextUp | null {
  const byKey = marksByKey(trip.marks);
  const plan = guide === "frame" ? null : guide;
  const p = phase(today, trip);
  if (p === "tomorrow") {
    if (!plan) return null;
    const bus = busToday(plan, trip.start_date, null, byKey);
    const todos = plan.todo.length ? { left: plan.todo.filter((t) => !(t.done || byKey.get(todoMark(t))?.value === "done")).length } : null;
    return bus || todos ? { state: "tomorrow", date: trip.start_date, bus, todos } : null;
  }
  if (p !== "during") return null;
  const day = daysBetween(trip.start_date, today) + 1;
  const stop: StopPart | null = guide === "frame" ? { kind: "opening" } : plan ? stopFor(plan, trip, day, byKey, city) : null;
  const bus = plan && stop?.kind !== "busRow" ? busToday(plan, today, now, byKey) : null;
  const hotel = hotelFor(trip, plan, today, city);
  if (!stop && !bus && (!hotel || hotel.from === "none")) return null;
  return { state: "during", day, days: daysBetween(trip.start_date, trip.return_date) + 1, date: today, stop, bus, hotel };
}

/** Where the stop part's Open on the map goes: the level's dialog, or the World alone (a pick, tomorrow) */
export function jumpFor(stop: StopPart): NextUpJump | null {
  if (stop.kind === "row" || stop.kind === "busRow") return { day: stop.day, key: stop.key };
  if (stop.kind === "pick") return { day: stop.day };
  if (stop.kind === "todayDone") return { day: stop.nextDay };
  return null;
}

/** "Thu, Nov 26" */
export function shortDate(iso: string): string {
  return new Date(utc(iso)).toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/** "Day 2 of 5 · Thu, Nov 26": the trip's own day, never the plan's day title */
export const dayLine = (up: Extract<NextUp, { state: "during" }>) => `Day ${up.day} of ${up.days} · ${shortDate(up.date)}`;
export const thenLine = (t: Then) => (t.time ? `Then ${formatTime(t.time)} · ${t.plan}` : `Then ${t.plan}`);
export const tomorrowLine = (t: Then) => (t.time ? `Tomorrow, ${formatTime(t.time)}: ${t.plan}` : `Tomorrow: ${t.plan}`);
export const todosLine = (left: number) => (left === 0 ? "Every to-do is done." : `${left} to-do${left === 1 ? "" : "s"} left`);

/** A bus's three lines, every one from its `trips` row, with its checked date and the confirm note (ux §5.3) */
export function busLines(part: Extract<BusPart, { kind: "bus" }>): { time: string; route: string; checked: string } {
  const t = part.row.trip!;
  return {
    time: `${formatTime(t.departure_time)} · ${t.operator_name}`,
    route: `${t.origin_name} to ${t.destination_name}${part.booked ? " · ✓ Booked" : ""}`,
    checked: `${formatVerified(t.last_verified_at)}. ${t.confirm_note}`,
  };
}

/** ux §7's log: the state and the parts that show. Words only: no names, addresses, times or plan text */
export function nextUpLog(today: string, trip: Pick<Trip, "start_date" | "return_date">, up: NextUp | null): string {
  if (!up) {
    const p = phase(today, trip);
    return `state=${p === "before" || p === "after" ? p : "none"}`;
  }
  const parts = up.state === "during" ? [up.stop && "stop", up.bus && "bus", up.hotel && "hotel"] : [up.bus && "bus", up.todos && "todo"];
  return `state=${up.state} parts=${parts.filter(Boolean).join(",")}`;
}
