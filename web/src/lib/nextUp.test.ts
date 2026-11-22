// TG-69: the trip page's Next up card. Ids are from tickets/TG-69/test-plan.md: T69-N (the lib), T69-C (the card, its
// place and the jump), T69-F (the fold), T69-D (Show the driver) and T69-X (fences). Every trip, plan, hotel and bus
// here is made up. `today` and `now` are always fixed arguments, never the machine's clock. Web has no component
// runner, so the card's checks read its source, each sliced to its own function where it can be.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as api from "./api.ts"; // a namespace, so RED fails per test before manilaNow exists
import { type Trip as BusTrip, formatTime } from "./api.ts";
import { type BusRow, type BusTable, type Guide, type GuideDay, type GuidePlace, type GuideRow, type LegOut, type Mark, marksByKey } from "./guide.ts";
import { levels, nextLevel } from "./levelMap.ts";
import {
  type BusPart, type NextUp, type NextUpTrip, type StopPart, busFor, busLines, busOn, dayLine, jumpFor, nextUp, nextUpLog, phase, pickBus, shortDate, thenLine, todosLine,
  tomorrowLine, toMinutes,
} from "./nextUp.ts";
import type { Hotel } from "./trip.ts";

const WEB = new URL("../../", import.meta.url);
const ROOT = new URL("../", WEB);
/** A source file, or "" before it exists (RED), so each check fails on its own assertion */
const read = (path: string) => (existsSync(new URL(path, WEB)) ? readFileSync(new URL(path, WEB), "utf8") : "");
const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
/** The branch's base, as palette.test.ts finds it: where it left origin/main. CI's shallow checkout of the PR merge commit
 * has no merge base, but there HEAD is main + the PR, so it diffs origin/main. Null when origin/main isn't there at all */
function mergeBase(): string | null {
  try {
    return git("merge-base", "origin/main", "HEAD").trim();
  } catch {
    try {
      git("rev-parse", "--verify", "origin/main");
      return "origin/main";
    } catch {
      return null;
    }
  }
}
/** From `start` to the end of that top-level function */
const fn = (src: string, start: string) => {
  const at = src.indexOf(start);
  return at < 0 ? "" : src.slice(at, src.indexOf("\n}\n", at) + 2);
};

// ---------------------------------------------------------------- made-up fixtures

const busTrip = (id: string, departure: string, from: string, to: string, operator = "Made-up Lines"): BusTrip => ({
  trip_id: id, operator_slug: "made-up", operator_name: operator, origin_slug: "a", origin_name: from, origin_city: from, destination_slug: "b",
  destination_name: to, destination_city: to, via: null, service_class: "regular", fare_php: 700, travel_minutes: 600, departure_time: departure,
  arrives_around: null, arrives_day_offset: null, booking_url: null, source: "made-up", source_url: null, last_verified_at: "2026-11-20T02:00:00Z",
  confirm_note: "Confirm with the bus company before you go.",
});
const bus = (trip: BusTrip | null, date: string, booked = false, id = trip?.trip_id ?? `gone-${date}`): BusRow => ({ trip_id: id, date, trip, note: "", booked });
const table = (buses: BusRow[]): BusTable => ({ title: "Buses", intro: "", buses, tips: [] });
const spot = (name: string, lodging = false): GuidePlace => ({ kind: "spot", id: name, name, category: lodging ? "lodging" : "park", lodging });
const terminal = (name: string): GuidePlace => ({ kind: "terminal", id: name, name, category: null, lodging: false });
const walk: LegOut = { kind: "estimate", mode: "walk", minutes: 15, km: 1.2 };
const row = (key: string, time: string, plan: string, place: GuidePlace | null = null, extra: Partial<GuideRow> = {}): GuideRow => ({
  key, time, plan, note: "", place, bus: null, show_if: null, hide_if: null, ...extra,
});
const day = (n: number, rows: GuideRow[], extra: Partial<GuideDay> = {}): GuideDay => ({ day: n, title: `Day ${n}: Fri Nov 6`, intro: "", pick: null, rows, tips: [], ...extra });
const guideOf = (g: Partial<Guide>): Guide => ({
  title: "Made-up trip", summary: "", lodging: null, getting_there: table([]), getting_home: table([]), days: [],
  budget: { summary: "", rows: [], excluded: "" }, todo: [], sources: [], ...g,
});
const done = (key: string, at = "2026-11-25T12:00:00Z"): Mark => ({ key: `row:${key}`, value: "done", updated_at: at });
const picked = (pick: string, option: string): Mark => ({ key: `pick:${pick}`, value: option, updated_at: "2026-11-26T01:00:00Z" });

// G1, Sagada-shaped: 5 days, Nov 25 to 29. The outbound bus leaves day 1 at 22:30 (the row says 21:00, which is never
// shown), a pick on day 2, and the return bus on day 4 (Sat 28, 14:30) arriving on day 5. Check-out is the 28th.
const OUT = busTrip("t-out", "22:30", "Made-up Cubao", "Made-up Sagada");
const HOME = busTrip("t-home", "14:30", "Made-up Sagada", "Made-up Cubao");
const G1 = guideOf({
  lodging: spot("Pine Ridge Lodge", true),
  getting_there: table([bus(OUT, "2026-11-25", true)]),
  getting_home: table([bus(HOME, "2026-11-28", true)]),
  days: [
    day(1, [row("d1-01", "20:45", "Meet at the terminal", terminal("Made-up Terminal")), row("d1-02", "21:00", "Bus to Sagada", null, { bus: "outbound" })]),
    day(2, [
      row("d2-01", "07:30", "Breakfast at the inn", spot("Inn Cafe"), { leg: walk }),
      row("d2-02", "11:00", "Lunch at Yoghurt House", spot("Yoghurt House"), { show_if: { pick: "brunch", is: "A" } }),
      row("d2-03", "11:00", "Lunch at Lemon Pie House", spot("Lemon Pie House"), { show_if: { pick: "brunch", is: "B" } }),
      row("d2-04", "14:00", "Echo Valley and the hanging coffins", spot("Echo Valley"), { leg: walk }),
    ], { pick: { key: "brunch", title: "Where's lunch?", options: [] } }),
    day(3, [row("d3-01", "09:30", "Sumaguing Cave", spot("Sumaguing Cave")), row("d3-02", "", "Free afternoon")]),
    day(4, [row("d4-01", "07:00", "Check out and breakfast", spot("Pine Ridge Lodge", true)), row("d4-02", "13:30", "Bus to Cubao", null, { bus: "return" })]),
    day(5, [row("d5-01", "02:30", "Arrive in Cubao", terminal("Made-up Terminal"))]),
  ],
  todo: [{ key: "todo-01", text: "Pack a jacket", done: false }, { key: "todo-02", text: "Print the tickets", done: false }, { key: "todo-03", text: "Ask the inn", done: false }],
});
const HOTEL: Hotel = {
  name: "Made-up Pine Inn", address: "12 Made-up Road, Sagada, Mountain Province", check_in: "2026-11-26T14:00:00", check_out: "2026-11-28T11:00:00", booking_ref: "", notes: "",
};
const T1 = (marks: Mark[] = [], hotel: Hotel | null = HOTEL): NextUpTrip => ({ start_date: "2026-11-25", return_date: "2026-11-29", hotel, marks });
const up1 = (today: string, marks: Mark[] = [], now = "12:00", hotel: Hotel | null = HOTEL, guide: Guide | "frame" | null = G1) =>
  nextUp({ today, now, trip: T1(marks, hotel), guide, city: "Sagada" });
const during = (u: NextUp | null) => {
  assert.equal(u?.state, "during");
  return u as Extract<NextUp, { state: "during" }>;
};

// G2, Baguio-shaped: 3 days, Nov 6 to 8, the default city. Two buses out on the 6th, none booked; the bus home is gone.
const G2 = guideOf({
  getting_there: table([bus(busTrip("t-late", "09:00", "Made-up Pasay", "Made-up Baguio"), "2026-11-06"), bus(busTrip("t-early", "06:00", "Made-up Pasay", "Made-up Baguio"), "2026-11-06")]),
  getting_home: table([bus(null, "2026-11-08")]),
  days: [
    day(1, [row("b1-01", "13:00", "Burnham Park", spot("Burnham Park"))]),
    day(2, [row("b2-01", "08:00", "Mines View", spot("Mines View Park"))]),
    day(3, [row("b3-01", "10:00", "Bus home", null, { bus: "return" })]),
  ],
});
const T2: NextUpTrip = { start_date: "2026-11-06", return_date: "2026-11-08", hotel: null, marks: [] };

// G3, a day trip (Dec 5) with a bus out at 09:00 and a bus home at 14:30, both booked (G3's ruling)
const G3 = guideOf({
  getting_there: table([bus(busTrip("t-9", "09:00", "Made-up A", "Made-up B"), "2026-12-05", true)]),
  getting_home: table([bus(busTrip("t-1430", "14:30", "Made-up B", "Made-up A"), "2026-12-05", true)]),
  days: [day(1, [row("c1-01", "10:00", "Walk the market", spot("Made-up Market"))])],
});
const T3: NextUpTrip = { start_date: "2026-12-05", return_date: "2026-12-05", hotel: null, marks: [] };
const up3 = (now: string, marks: Mark[] = []) => during(nextUp({ today: "2026-12-05", now, trip: { ...T3, marks }, guide: G3, city: "Baguio" }));

// ---------------------------------------------------------------- N1, the lib

test("T69-N1 the state by Manila date: before, the day before, during, after; a one-day trip", () => {
  const states = ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-29", "2026-11-30"].map((d) => up1(d)?.state ?? null);
  assert.deepEqual(states, [null, "tomorrow", "during", "during", null]);
  assert.deepEqual(["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-29", "2026-11-30"].map((d) => phase(d, T1())), ["before", "tomorrow", "during", "during", "after"]);
  assert.equal(phase("2026-12-04", T3), "tomorrow");
  assert.equal(up3("08:00").state, "during", "a one-day trip is during on its day");
  assert.equal(nextUp({ today: "2026-11-24", now: "12:00", trip: T1(), guide: null, city: "Sagada" }), null, "the day before, with neither part: no card");
});

test("T69-N2 no plan: no hotel gives no card; a hotel gives the day line and the hotel; a failed plan is no plan", () => {
  assert.equal(up1("2026-11-26", [], "12:00", null, null), null);
  const u = during(up1("2026-11-26", [], "12:00", HOTEL, null));
  assert.equal(u.stop, null);
  assert.equal(u.bus, null);
  assert.equal(u.hotel?.from, "trip");
  assert.equal(dayLine(u), "Day 2 of 5 · Thu, Nov 26");
});

test("T69-N3 the day line: day 1 is start_date, the count has both ends, the plan's own titles are ignored, months cross", () => {
  assert.equal(dayLine(during(up1("2026-11-25"))), "Day 1 of 5 · Wed, Nov 25");
  assert.equal(dayLine(during(up1("2026-11-29"))), "Day 5 of 5 · Sun, Nov 29");
  assert.ok(G1.days.every((d) => d.title === `Day ${d.day}: Fri Nov 6`), "the fixture's titles are another trip's");
  const g = guideOf({ days: [day(1, [row("m1", "09:00", "One")]), day(2, [row("m2", "09:00", "Two")]), day(3, [row("m3", "09:00", "Three")])] });
  const u = during(nextUp({ today: "2026-12-01", now: "12:00", trip: { start_date: "2026-11-30", return_date: "2026-12-02", hotel: null, marks: [] }, guide: g, city: "Baguio" }));
  assert.equal(u.day, 2);
  assert.equal(u.days, 3);
  assert.equal(dayLine(u), "Day 2 of 3 · Tue, Dec 1");
  assert.equal(shortDate("2026-11-24"), "Tue, Nov 24");
});

test("T69-N4 the plan still opening: the stop part is opening", () => {
  assert.deepEqual(during(up1("2026-11-26", [], "12:00", HOTEL, "frame")).stop, { kind: "opening" });
});

test("T69-N5 the next stop is the map's next level, never the clock; its time, plan, leg and the city's Maps", () => {
  const d2 = G1.days[1];
  const states: Mark[][] = [[], [picked("brunch", "B"), done("d2-01")], [picked("brunch", "A"), done("d2-02")], [picked("brunch", "A"), done("d2-01"), done("d2-04")]];
  for (const marks of states) {
    const stop = during(up1("2026-11-26", marks)).stop;
    const want = nextLevel(levels(d2, marksByKey(marks)));
    assert.equal(stop && "key" in stop ? stop.key : null, want, JSON.stringify(marks));
  }
  for (const now of ["00:00", "07:31", "11:00", "14:01", "23:59"]) {
    const stop = during(up1("2026-11-26", [], now)).stop;
    assert.equal(stop?.kind === "row" && stop.key, "d2-01", `at ${now}`);
  }
  const s = during(up1("2026-11-26")).stop as Extract<StopPart, { kind: "row" }>;
  assert.equal(s.time, "07:30");
  assert.equal(s.plan, "Breakfast at the inn");
  assert.equal(s.leg, "Walk, about 15 min, 1.2 km");
  assert.equal(s.mapsName, "Inn Cafe");
  assert.match(s.mapsUrl ?? "", /Mountain%20Province/, "a Sagada plan searches Mountain Province");
  const free = during(up1("2026-11-27", [done("d3-01")])).stop as Extract<StopPart, { kind: "row" }>;
  assert.equal(free.time, null, "a row with no time has no time");
  assert.equal(free.mapsUrl, null);
  assert.equal(free.mapsName, null);
  assert.equal(free.leg, null);
  const b = during(nextUp({ today: "2026-11-06", now: "12:00", trip: T2, guide: G2, city: "Baguio" })).stop as Extract<StopPart, { kind: "row" }>;
  assert.match(b.mapsUrl ?? "", /Benguet/, "a Baguio plan searches Benguet");
});

test("T69-N6 a bus row next: its bus, with the trip's time and never the row's; no separate Bus today", () => {
  const u = during(up1("2026-11-25", [done("d1-01")]));
  const s = u.stop as Extract<StopPart, { kind: "busRow" }>;
  assert.equal(s.kind, "busRow");
  assert.equal(s.key, "d1-02");
  assert.equal(s.plan, "Bus to Sagada");
  assert.equal(s.bus?.kind === "bus" && s.bus.row.trip?.departure_time, "22:30");
  assert.doesNotMatch(JSON.stringify(s), /21:00/, "the row's own time is never shown");
  assert.equal(u.bus, null, "no double");
  const late = during(up1("2026-11-25", [done("d1-01")], "23:30"));
  assert.equal(late.stop?.kind, "busRow", "the stop isn't chosen by the clock: it stays until it's ticked");
  // A plan reused on other dates: no bus row on that day's date, so the row's plan text and no time
  const moved = during(nextUp({ today: "2026-12-25", now: "12:00", trip: { ...T1([done("d1-01")]), start_date: "2026-12-25", return_date: "2026-12-29" }, guide: G1, city: "Sagada" }));
  assert.deepEqual(moved.stop, { kind: "busRow", day: 1, key: "d1-02", plan: "Bus to Sagada", bus: null, then: null });
});

test("T69-N7 which bus: booked first, then the earliest; none booked; gone; ticked done; the overnight bus", () => {
  const at = (dep: string, booked: boolean, id = dep) => ({ table: "getting_there" as const, row: bus(busTrip(id, dep, "A", "B"), "2026-11-06", booked) });
  const pick = (p: BusPart | null) => (p?.kind === "bus" ? p.row.trip_id : p?.kind ?? null);
  assert.equal(pick(pickBus([at("06:00", false), at("09:00", true)], null)), "09:00", "booked beats unbooked");
  assert.equal(pick(pickBus([at("11:00", true), at("08:00", true)], null)), "08:00", "several booked: the earliest");
  const none = busOn(G2, "2026-11-06", null);
  assert.equal(pick(none), "t-early", "none booked: the earliest of all, whatever the table order");
  assert.equal(none?.kind === "bus" && none.booked, false);
  assert.deepEqual(busOn(G2, "2026-11-08", null), { kind: "gone", direction: "return" });
  const tie = pickBus([{ table: "getting_home", row: bus(busTrip("home", "09:00", "A", "B"), "d") }, { table: "getting_there", row: bus(busTrip("there", "09:00", "A", "B"), "d") }, at("09:00", false, "there-2")], null);
  assert.equal(pick(tie), "there", "a tie goes getting_there first, then table order");
  assert.equal(pickBus([], "12:00"), null);
  // Bus today, from nextUp
  const d1 = during(up1("2026-11-25", [], "20:00"));
  assert.equal(d1.bus?.kind === "bus" && d1.bus.row.trip_id, "t-out");
  assert.equal(d1.bus?.kind === "bus" && d1.bus.booked, true);
  assert.equal(during(up1("2026-11-25", [done("d1-02")], "20:00")).bus, null, "the plan's outbound row ticked: hidden");
  assert.equal(during(up1("2026-11-26", [], "06:00")).bus, null, "overnight: day 2 has no bus, it's dated day 1");
  const d4 = during(up1("2026-11-28", [], "09:00"));
  assert.equal(d4.bus?.kind === "bus" && d4.bus.row.trip_id, "t-home");
  assert.equal(during(up1("2026-11-28", [done("d4-02")], "09:00")).bus, null, "the return row ticked: hidden");
});

test("T69-N7b the next bus that hasn't left (G3): strictly after now, Manila's clock, a lone bus, done, and the stop untouched", () => {
  const id = (now: string, marks: Mark[] = []) => {
    const b = up3(now, marks).bus;
    return b?.kind === "bus" ? b.row.trip_id : null;
  };
  assert.equal(id("08:00"), "t-9");
  assert.equal(id("09:00"), "t-1430", "a 09:00 bus has left at 09:00");
  assert.equal(id("12:00"), "t-1430");
  assert.equal(id("14:31"), null, "both have left");
  assert.equal(up3("15:00").bus, null);
  const lone = during(up1("2026-11-28", [], "15:00"));
  assert.equal(lone.bus, null, "a lone 14:30 at 15:00 has left, ticked or not");
  const out = guideOf({ ...G3, days: [day(1, [row("c1-00", "08:30", "Bus out", null, { bus: "outbound" }), row("c1-01", "10:00", "Walk the market")])] });
  const doneOut = during(nextUp({ today: "2026-12-05", now: "08:00", trip: { ...T3, marks: [done("c1-00")] }, guide: out, city: "Baguio" }));
  assert.equal(doneOut.bus?.kind === "bus" && doneOut.bus.row.trip_id, "t-1430", "ticked done hides it before it leaves");
  for (const now of ["07:00", "09:30", "23:00"]) {
    const s = during(nextUp({ today: "2026-12-05", now, trip: T3, guide: out, city: "Baguio" })).stop;
    assert.equal(s?.kind === "busRow" && s.key, "c1-00", `the bus row stays the stop at ${now}`);
  }
  // tg-test's RED audit: booked-only holds with the clock, and a gone row waits behind a timed row still to leave
  const mixed = [{ table: "getting_there" as const, row: bus(busTrip("b-9", "09:00", "A", "B"), "2026-12-05", true) }, { table: "getting_home" as const, row: bus(busTrip("u-1430", "14:30", "B", "A"), "2026-12-05", false) }];
  assert.equal(pickBus(mixed, "10:00"), null, "the booked 09:00 has left; the unbooked 14:30 isn't one the group is taking");
  const withGone = [{ table: "getting_there" as const, row: bus(null, "2026-12-05") }, { table: "getting_home" as const, row: bus(busTrip("t-1430", "14:30", "B", "A"), "2026-12-05") }];
  const g12 = pickBus(withGone, "12:00");
  assert.equal(g12?.kind === "bus" && g12.row.trip_id, "t-1430", "a timed row still to leave beats a gone one");
  assert.deepEqual(pickBus(withGone, "15:00"), { kind: "gone", direction: "outbound" }, "once nothing timed is left, the gone row shows");
  // tg-test Gate 3: a time with seconds compares as minutes, so a 09:00:00 bus has left at 09:00 (a string compare says not)
  assert.equal(pickBus([{ table: "getting_there", row: bus(busTrip("t-sec", "09:00:00", "A", "B"), "2026-12-05", true) }], "09:00"), null);
  assert.equal(toMinutes("22:30"), 1350);
  assert.equal(toMinutes("22:30:00"), 1350);
  assert.equal(toMinutes("07:05"), 425);
  const tz = process.env.TZ;
  try {
    process.env.TZ = "America/Los_Angeles";
    assert.equal(api.manilaNow(new Date("2026-11-25T14:31:00Z")), "22:31", "Manila's time, whatever the phone's zone");
    assert.equal(api.manilaNow(new Date("2026-11-25T16:05:00Z")), "00:05", "after midnight is 00, never 24");
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});

test("T69-N8 an unmade pick: Pick one first with the day's pick title; once made, the picked row is next", () => {
  const u = during(up1("2026-11-26", [done("d2-01")]));
  assert.deepEqual(u.stop, { kind: "pick", day: 2, title: "Where's lunch?" });
  const b = during(up1("2026-11-26", [done("d2-01"), picked("brunch", "B")])).stop;
  assert.equal(b?.kind === "row" && b.key, "d2-03");
  const a = during(up1("2026-11-26", [done("d2-01"), picked("brunch", "A"), done("d2-02")])).stop;
  assert.equal(a?.kind === "row" && a.key, "d2-04", "the other option's row never shows");
});

test("T69-N9 today done with a next day; the last day done; no day for today, or a day with no rows", () => {
  const u = during(up1("2026-11-26", [picked("brunch", "A"), done("d2-01"), done("d2-02"), done("d2-04")]));
  assert.deepEqual(u.stop, { kind: "todayDone", nextDay: 3, tomorrow: { time: "09:30", plan: "Sumaguing Cave" } });
  assert.equal(tomorrowLine({ time: "09:30", plan: "Sumaguing Cave" }), "Tomorrow, 9:30 AM: Sumaguing Cave");
  assert.equal(tomorrowLine({ time: null, plan: "Free afternoon" }), "Tomorrow: Free afternoon");
  const toBus = during(up1("2026-11-27", [done("d3-01"), done("d3-02"), done("d4-01")])).stop;
  assert.deepEqual(toBus, { kind: "todayDone", nextDay: 4, tomorrow: { time: "14:30", plan: "Bus to Cubao" } }, "a bus row tomorrow takes the bus's time");
  const noTime = guideOf({ days: [day(1, [row("x1", "09:00", "One")]), day(2, [row("x2", "", "Rest day")])] });
  const nt = during(nextUp({ today: "2026-11-06", now: "12:00", trip: { ...T2, marks: [done("x1")] }, guide: noTime, city: "Baguio" }));
  assert.deepEqual(nt.stop, { kind: "todayDone", nextDay: 2, tomorrow: { time: null, plan: "Rest day" } });
  assert.deepEqual(during(up1("2026-11-29", [done("d5-01")])).stop, { kind: "allDone" });
  const gap = guideOf({ days: [day(1, [row("y1", "09:00", "One")]), day(3, [row("y3", "09:00", "Three")])] });
  assert.deepEqual(during(nextUp({ today: "2026-11-07", now: "12:00", trip: T2, guide: gap, city: "Baguio" })).stop, { kind: "nothingToday" });
  const empty = guideOf({ days: [day(1, [row("z1", "09:00", "One")]), day(2, [])] });
  assert.deepEqual(during(nextUp({ today: "2026-11-07", now: "12:00", trip: T2, guide: empty, city: "Baguio" })).stop, { kind: "nothingToday" });
});

test("T69-N10 the Then line: the next undone row the same day; its words; a bus row's time; when there's none", () => {
  const first = during(up1("2026-11-26", [picked("brunch", "A")])).stop as Extract<StopPart, { kind: "row" }>;
  assert.deepEqual(first.then, { time: "11:00", plan: "Lunch at Yoghurt House" });
  assert.equal(thenLine(first.then!), "Then 11:00 AM · Lunch at Yoghurt House");
  assert.equal(thenLine({ time: null, plan: "Lunch at Yoghurt House" }), "Then Lunch at Yoghurt House");
  const skip = during(up1("2026-11-26", [picked("brunch", "A"), done("d2-02")])).stop as Extract<StopPart, { kind: "row" }>;
  assert.deepEqual(skip.then, { time: "14:00", plan: "Echo Valley and the hanging coffins" }, "ticked out of order: the next undone row");
  const toBus = during(up1("2026-11-25")).stop as Extract<StopPart, { kind: "row" }>;
  assert.deepEqual(toBus.then, { time: "22:30", plan: "Bus to Sagada" }, "a bus row as Then takes its bus's time");
  assert.equal(thenLine(toBus.then!), "Then 10:30 PM · Bus to Sagada");
  const last = during(up1("2026-11-26", [picked("brunch", "A"), done("d2-01"), done("d2-02")])).stop as Extract<StopPart, { kind: "row" }>;
  assert.equal(last.then, null, "the day's last undone row: no Then, and never the next day's");
  const beforePick = during(up1("2026-11-26")).stop as Extract<StopPart, { kind: "row" }>;
  assert.equal(beforePick.then, null, "the next row depends on an unmade pick");
  for (const s of [{ kind: "pick" }, { kind: "todayDone" }, { kind: "allDone" }, { kind: "nothingToday" }, { kind: "opening" }]) {
    assert.ok(!("then" in s), `${s.kind} has no Then`);
  }
  const gone1 = guideOf({ ...G2, days: [day(1, [row("g1", "08:00", "Pack up"), row("g2", "10:00", "Bus home", null, { bus: "return" })])] });
  const s = during(nextUp({ today: "2026-11-08", now: "12:00", trip: { ...T2, start_date: "2026-11-08" }, guide: gone1, city: "Baguio" })).stop as Extract<StopPart, { kind: "row" }>;
  assert.deepEqual(s.then, { time: null, plan: "Bus home" }, "a gone bus has no time");
});

test("T69-N11 never invents a time: every HH:MM in the card comes from the fixtures; every bus carries its check and note", () => {
  const cases: { trip: NextUpTrip; guide: Guide | "frame" | null; city: string; days: string[] }[] = [
    { trip: T1(), guide: G1, city: "Sagada", days: ["2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29"] },
    { trip: T2, guide: G2, city: "Baguio", days: ["2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"] },
    { trip: T3, guide: G3, city: "Baguio", days: ["2026-12-04", "2026-12-05"] },
  ];
  const marks: Mark[][] = [[], [done("d1-01"), picked("brunch", "A"), done("d2-01")], [done("d2-01"), done("d2-02"), done("d2-04"), picked("brunch", "A"), done("d3-01"), done("d3-02")]];
  const times = (s: string) => new Set(s.match(/\d{2}:\d{2}/g) ?? []);
  for (const c of cases) {
    const own = times(JSON.stringify([c.trip, c.guide]));
    for (const today of c.days) {
      for (const m of marks) {
        for (const now of ["05:00", "12:00", "23:00"]) {
          const u = nextUp({ today, now, trip: { ...c.trip, marks: m }, guide: c.guide, city: c.city });
          const out = JSON.stringify(u);
          for (const t of times(out)) assert.ok(own.has(t), `${t} on ${today} at ${now} isn't the fixture's`);
          const buses = [u?.bus, u?.state === "during" && u.stop?.kind === "busRow" ? u.stop.bus : null].filter((b): b is Extract<BusPart, { kind: "bus" }> => b?.kind === "bus");
          for (const b of buses) {
            const lines = busLines(b);
            assert.equal(lines.checked, "Checked Nov 20. Confirm with the bus company before you go.");
            assert.equal(lines.time, `${formatTime(b.row.trip!.departure_time)} · Made-up Lines`);
          }
        }
      }
    }
  }
  const b = busOn(G1, "2026-11-25", null) as Extract<BusPart, { kind: "bus" }>;
  assert.deepEqual(busLines(b), { time: "10:30 PM · Made-up Lines", route: "Made-up Cubao to Made-up Sagada · ✓ Booked", checked: "Checked Nov 20. Confirm with the bus company before you go." });
  const unbooked = busOn(G2, "2026-11-06", null) as Extract<BusPart, { kind: "bus" }>;
  assert.equal(busLines(unbooked).route, "Made-up Pasay to Made-up Baguio");
  assert.deepEqual(busFor(G1, G1.days[0].rows[1], "2026-11-25"), b);
  assert.equal(busFor(G1, G1.days[0].rows[0], "2026-11-25"), null, "not a bus row");
});

test("T69-N12 where we're staying: the trip's hotel, the plan's lodging, or none", () => {
  const h = during(up1("2026-11-26")).hotel;
  assert.deepEqual(h, { from: "trip", name: HOTEL.name, address: HOTEL.address, mapsUrl: "https://www.google.com/maps/search/?api=1&query=Made-up%20Pine%20Inn%2C%2012%20Made-up%20Road%2C%20Sagada%2C%20Mountain%20Province", checkIn: "2026-11-26T14:00:00", checkOut: null });
  const lodge = during(up1("2026-11-26", [], "12:00", null)).hotel;
  assert.equal(lodge?.from, "lodging");
  assert.equal(lodge?.from === "lodging" && lodge.name, "Pine Ridge Lodge");
  assert.match(lodge?.from === "lodging" ? lodge.mapsUrl : "", /Pine%20Ridge%20Lodge%2C%20Mountain%20Province/);
  assert.ok(lodge && !("address" in lodge), "lodging has no address");
  assert.deepEqual(during(nextUp({ today: "2026-11-07", now: "12:00", trip: T2, guide: G2, city: "Baguio" })).hotel, { from: "none" });
  assert.equal(during(up1("2026-11-29", [], "02:00", null)).hotel?.from, "lodging", "lodging shows through return_date");
});

test("T69-N12b check-out (S1): the line all day on check_out's Manila date; hidden after it; no check_out shows through return_date", () => {
  const sat = during(up1("2026-11-28", [], "23:30"));
  assert.equal(sat.hotel?.from === "trip" && sat.hotel.checkOut, "2026-11-28T11:00:00", "after 11:00 too");
  assert.equal(during(up1("2026-11-28", [], "06:00")).hotel?.from === "trip", true);
  const sun = during(up1("2026-11-29", [], "02:30"));
  assert.equal(sun.hotel, null, "the day after check-out (the overnight return): no hotel part");
  assert.notEqual(sun.stop, null, "the card stays, on d5-01");
  const allDone = during(up1("2026-11-29", [done("d5-01")], "02:30"));
  assert.deepEqual(allDone.stop, { kind: "allDone" }, "the whole plan done still has its card");
  const loose = { ...HOTEL, check_out: null };
  for (const d of ["2026-11-26", "2026-11-28", "2026-11-29"]) {
    const u = during(up1(d, [], "12:00", loose));
    assert.equal(u.hotel?.from === "trip" && u.hotel.checkOut, null, `no check_out: no line on ${d}`);
  }
  assert.equal(nextUp({ today: "2026-11-29", now: "12:00", trip: T1([], HOTEL), guide: null, city: "Sagada" }), null, "after check-out with no plan and no bus: no card");
});

test("T69-N12c check-in (review nit 3, ux §5.4): hidden before check-in's Manila date; the Check-in line all that day; a one-night stay shows check-out only", () => {
  const hotel = (d: string, h: Hotel | null = HOTEL) => during(up1(d, [], "06:00", h)).hotel;
  assert.equal(hotel("2026-11-25"), null, "Wed 25, still in Manila: no Sagada address, no Show the driver");
  assert.notEqual(during(up1("2026-11-25")).stop, null, "the card stays, on its stop");
  const thu = hotel("2026-11-26");
  assert.equal(thu?.from === "trip" && thu.checkIn, "2026-11-26T14:00:00", "the check-in day, before 2 PM too");
  assert.equal(thu?.from === "trip" && thu.checkOut, null);
  assert.equal(during(up1("2026-11-26", [], "23:00")).hotel?.from === "trip", true, "and after it");
  const fri = hotel("2026-11-27");
  assert.equal(fri?.from === "trip" && fri.checkIn, null, "only on that day");
  const noIn = { ...HOTEL, check_in: null };
  const wed = hotel("2026-11-25", noIn);
  assert.equal(wed?.from === "trip" && wed.checkIn, null, "no check_in: from start_date, with no line");
  const oneNight = { ...HOTEL, check_in: "2026-11-27T14:00:00", check_out: "2026-11-27T22:00:00" };
  assert.equal(hotel("2026-11-26", oneNight), null);
  const same = hotel("2026-11-27", oneNight);
  assert.equal(same?.from === "trip" && same.checkIn, null, "a one-night stay: check-out only");
  assert.equal(same?.from === "trip" && same.checkOut, "2026-11-27T22:00:00");
  assert.equal(hotel("2026-11-28", oneNight), null);
  assert.equal(nextUp({ today: "2026-11-25", now: "12:00", trip: T1(), guide: null, city: "Sagada" }), null, "before check-in with no plan: no card");
  assert.equal(during(up1("2026-11-25", [], "12:00", null)).hotel?.from, "lodging", "the plan's lodging has no check-in to key on");
});

test("T69-N13 Leaving tomorrow: the bus dated start_date, the to-dos left, all done still a card, nothing gives none", () => {
  const u = up1("2026-11-24", [], "23:00");
  assert.equal(u?.state, "tomorrow");
  const t = u as Extract<NextUp, { state: "tomorrow" }>;
  assert.equal(t.date, "2026-11-25");
  assert.equal(t.bus?.kind === "bus" && t.bus.row.trip_id, "t-out", "tomorrow's bus has no has-it-left check");
  assert.deepEqual(t.todos, { left: 3 });
  const two = up1("2026-11-24", [{ key: "todo:01", value: "done", updated_at: "x" }]) as Extract<NextUp, { state: "tomorrow" }>;
  assert.deepEqual(two.todos, { left: 2 });
  const all = up1("2026-11-24", ["01", "02", "03"].map((k) => ({ key: `todo:${k}`, value: "done", updated_at: "x" }))) as Extract<NextUp, { state: "tomorrow" }>;
  assert.deepEqual(all.todos, { left: 0 }, "every to-do done: the card stays");
  const builtIn = guideOf({ ...G1, todo: [{ key: "todo-09", text: "Done in the plan", done: true }] });
  assert.deepEqual((nextUp({ today: "2026-11-24", now: "12:00", trip: T1(), guide: builtIn, city: "Sagada" }) as Extract<NextUp, { state: "tomorrow" }>).todos, { left: 0 });
  assert.equal(todosLine(3), "3 to-dos left");
  assert.equal(todosLine(1), "1 to-do left");
  assert.equal(todosLine(0), "Every to-do is done.");
  const noTodos = guideOf({ ...G1, todo: [] });
  assert.equal((nextUp({ today: "2026-11-24", now: "12:00", trip: T1(), guide: noTodos, city: "Sagada" }) as Extract<NextUp, { state: "tomorrow" }>).todos, null);
  const unbooked = guideOf({ ...G1, todo: [], getting_there: table([bus(OUT, "2026-11-25", false)]) });
  const ub = nextUp({ today: "2026-11-24", now: "12:00", trip: T1(), guide: unbooked, city: "Sagada" }) as Extract<NextUp, { state: "tomorrow" }>;
  assert.equal(ub.bus?.kind === "bus" && ub.bus.booked, false);
  // tg-test Gate 3: no bus on start_date and every to-do done still gives the card (ux §8.1)
  const doneNoBus = guideOf({ ...G1, getting_there: table([]) });
  const allTicked = ["01", "02", "03"].map((k) => ({ key: `todo:${k}`, value: "done", updated_at: "x" }));
  assert.deepEqual(nextUp({ today: "2026-11-24", now: "12:00", trip: T1(allTicked), guide: doneNoBus, city: "Sagada" }), { state: "tomorrow", date: "2026-11-25", bus: null, todos: { left: 0 } });
  const nothing = guideOf({ ...G1, todo: [], getting_there: table([]) });
  assert.equal(nextUp({ today: "2026-11-24", now: "12:00", trip: T1(), guide: nothing, city: "Sagada" }), null);
});

test("T69-N13b the jump for each stop part, and the log line (B18, B26): words and counts only", () => {
  assert.deepEqual(jumpFor(during(up1("2026-11-26")).stop!), { day: 2, key: "d2-01" });
  assert.deepEqual(jumpFor(during(up1("2026-11-25", [done("d1-01")])).stop!), { day: 1, key: "d1-02" });
  assert.deepEqual(jumpFor({ kind: "pick", day: 2, title: "x" }), { day: 2 }, "an unmade pick: the World, no dialog");
  assert.deepEqual(jumpFor({ kind: "todayDone", nextDay: 3, tomorrow: null }), { day: 3 }, "tomorrow's World, no dialog");
  for (const kind of ["allDone", "nothingToday", "opening"] as const) assert.equal(jumpFor({ kind }), null, kind);
  assert.equal(nextUpLog("2026-11-25", T1(), up1("2026-11-25", [], "20:00")), "state=during parts=stop,bus", "before check-in: no hotel part (review nit 3)");
  assert.equal(nextUpLog("2026-11-28", T1(), up1("2026-11-28", [], "09:00")), "state=during parts=stop,bus,hotel");
  assert.equal(nextUpLog("2026-11-29", T1(), up1("2026-11-29")), "state=during parts=stop");
  assert.equal(nextUpLog("2026-11-24", T1(), up1("2026-11-24")), "state=tomorrow parts=bus,todo");
  assert.equal(nextUpLog("2026-11-20", T1(), null), "state=before");
  assert.equal(nextUpLog("2026-12-01", T1(), null), "state=after");
  assert.equal(nextUpLog("2026-11-26", T1(), null), "state=none");
});

test("T69-N14 the flag: NEXT_PUBLIC_NEXT_UP, read literally, off by default, with its README row", () => {
  const flags = read("src/lib/flags.ts");
  assert.match(flags, /nextUp: parseFlag\(process\.env\.NEXT_PUBLIC_NEXT_UP, FLAG_DEFAULTS\.nextUp\)/);
  assert.match(flags, /nextUp: false,/);
  const readme = readFileSync(new URL("README.md", ROOT), "utf8");
  const row = readme.slice(readme.indexOf("## 7.")).split("\n").find((l) => l.includes("`NEXT_PUBLIC_NEXT_UP`"));
  assert.ok(row, "README section 7 has a row for NEXT_PUBLIC_NEXT_UP");
  assert.ok(row.includes("`false`") && row.includes("TG-69"), row);
});

test("T69-N15 purity: nextUp.ts has no React and nothing from components/", () => {
  const src = read("src/lib/nextUp.ts");
  const from = [...src.matchAll(/^import [^;]* from "([^"]+)";/gm)].map((m) => m[1]);
  assert.ok(from.length > 0);
  for (const f of from) assert.ok(["./api.ts", "./guide.ts", "./levelMap.ts", "./planLines.ts", "./trip.ts"].includes(f), f);
  assert.doesNotMatch(src, /use client|from "react"|components\//);
  assert.match(src, /import \{[^}]*\blevels\b[^}]*\bnextLevel\b[^}]*\} from "\.\/levelMap\.ts"/, "the stop is the map's own next level (C7)");
  assert.doesNotMatch(src, /manilaToday\(|new Date\(\)|Date\.now\(/, "today and now are arguments");
});

// ---------------------------------------------------------------- N2, the card, its place and the jump

const view = () => read("src/components/TripView.tsx");
const card = () => read("src/components/NextUpCard.tsx");
const map = () => read("src/components/LevelMap.tsx");

test("T69-C1 the gate: only under flags.nextUp, the card first in the page, no jump or fold with it off; never on /r/ or /i/", () => {
  const v = fn(view(), "export default function TripView(");
  assert.match(v, /const up = flags\.nextUp \? nextUp\(\{ today: clock\.today, now: clock\.now, trip, guide: slot, city \}\) : null;/);
  assert.match(v, /return \(\n\s+<div className="flex flex-col gap-6">\n\s+\{up && <NextUpCard up=\{up\} onJump=\{jumpTo\} \/>\}\n\s+<div className="flex flex-col gap-6 md:grid md:grid-cols-2 md:items-start">/, "the first thing on the page, above TripHeader and Who's coming");
  assert.equal(v.match(/<NextUpCard\b/g)?.length, 1);
  assert.match(v, /jump=\{flags\.nextUp \? jump : undefined\}/, "no jump with the flag off");
  assert.match(v, /fold=\{up\?\.state === "during" \|\| undefined\}/, "no fold with the flag off, or without a card (G4)");
  assert.match(v, /const clock = useManilaClock\(flags\.nextUp\);/, "the clock only runs with the flag on");
  const users = (pattern: RegExp) => {
    const out: string[] = [];
    const walk = (dir: URL) => {
      for (const name of readdirSync(dir)) {
        const at = new URL(name, dir);
        if (statSync(at).isDirectory()) walk(new URL(`${name}/`, dir));
        else if (/\.tsx?$/.test(name) && !name.endsWith(".test.ts") && pattern.test(readFileSync(at, "utf8"))) out.push(at.pathname.slice(new URL("src/", WEB).pathname.length));
      }
    };
    walk(new URL("src/", WEB));
    return out.sort();
  };
  assert.deepEqual(users(/from "(\.\/|@\/components\/)NextUpCard"/), ["components/TripView.tsx"], "only the trip page draws it");
  assert.deepEqual(users(/from "(\.\.?\/|@\/)lib\/nextUp"|from "\.\/nextUp(\.ts)?"/), ["components/NextUpCard.tsx", "components/TripView.tsx"]);
  assert.deepEqual(users(/\bjump=\{/), ["components/TripView.tsx"], "only TripView passes jump: the recap and /i/ don't");
});

test("T69-C2 the card: one PixelBox section, its parts split by a 2px rule, columns from md, ux.md's words, no truncation", () => {
  const src = card();
  assert.match(src, /<PixelBox as="section" aria-labelledby="next-up-title"/);
  assert.match(src, /<SectionTitle id="next-up-title">\{up\.state === "during" \? "Next up" : "Leaving tomorrow"\}<\/SectionTitle>/);
  assert.match(src, /border-b-2 border-border/);
  assert.match(src, /md:grid/);
  assert.match(src, /md:border-r-2/);
  assert.match(src, /text-lg select-text break-words/, "the address, to hold up to a driver");
  assert.doesNotMatch(src, /\btruncate\b|line-clamp/);
  for (const words of [
    "Next stop", "Bus today", "Bus tomorrow", "Where we&apos;re staying", "To-do", "Open in Google Maps", "Open on the map", "Open the to-do list",
    "Pick one first: ", "Today&apos;s plan is done.", "That&apos;s the whole plan. Ingat pauwi!", "Nothing on the plan for today.", "Opening the plan...",
    "Not marked booked yet.</p>", "This bus isn&apos;t on the schedule any more.</p>", "No hotel added yet.</p>", "See Buses", "Add the hotel", "Check-in ", "Check-out ", "Show the driver",
  ]) assert.ok(src.includes(words), words);
  // ux review S1: no inline links; each sentence ends, and a 44px secondary button follows it
  assert.doesNotMatch(src, /PX\.inlineLink|See <|Add it in/);
  assert.equal(src.match(/className=\{AFTER\}/g)?.length, 2, "See Buses and Add the hotel");
  for (const helper of ["dayLine(", "shortDate(", "thenLine(", "tomorrowLine(", "todosLine(", "busLines(", "formatTime(", "hotelTime(", "mapsLabel("]) assert.ok(src.includes(helper), helper);
  assert.doesNotMatch(src, /["'`>]\d{1,2}:\d{2}/, "no time written into the card");
  assert.doesNotMatch(src, /role="status"|aria-live/, "a moving card doesn't talk (B25)");
});

test("T69-C3 LevelMap's jump: a new n only; goTo for the World (M1), then the dialog as a tap opens it, or the panel; nothing without it", () => {
  const src = map();
  assert.match(src, /\/\*\* TG-69: [^\n]*\*\/\n\s+jump\?: \{ day\?: number; key\?: string; menu\?: "buses" \| "todo"; n: number \};/);
  assert.match(src, /export default function LevelMap\(\{[^}]*\bjump\b[^}]*\}: Props\)/);
  const guard = src.slice(src.indexOf("const lastJump = useRef(jump?.n);"), src.indexOf("\n  });\n", src.indexOf("const lastJump = useRef(jump?.n);")));
  assert.ok(guard.length > 0, "it starts at the n seen on mount (N3)");
  assert.match(guard, /if \(!jump \|\| jump\.n === lastJump\.current\) return;/);
  assert.match(guard, /lastJump\.current = jump\.n;\n\s+moveTo\(jump\);/);
  // GREEN: the body is a component-scope function the effect calls, as the chat's find step is (react-hooks lint)
  const at = src.indexOf("const moveTo = (to: NonNullable<Props[\"jump\"]>) => {");
  assert.ok(at > 0 && at < src.indexOf("const lastJump"));
  const effect = src.slice(at, src.indexOf("\n  };\n", at));
  assert.match(effect, /goTo\(to\.day\);/, "the tab tap's own path, so closing the dialog keeps the World (M1)");
  assert.match(effect, /tabTapped\.current = true;/, "goTo's scroll, even on the same World; there's no second scroll (review D1)");
  assert.doesNotMatch(effect, /setWorld\(/, "never a bare setWorld");
  assert.ok(effect.indexOf("goTo(to.day)") < effect.indexOf("setOpen("), "the World first, then the dialog");
  assert.match(effect, /setOpen\(\(o\) => \(\{ key: to\.key!?, tap: \(o\?\.tap \?\? 0\) \+ 1 \}\)\)/, "as a tap on the level does");
  assert.match(effect, /setMenu\(to\.menu\);/);
  // tg-review N2: the target is the opened panel, held by a ref; no walk up the DOM
  assert.doesNotMatch(src, /parentElement/);
  assert.match(effect, /if \(menu === to\.menu && panel\.current\) scrollToPanel\(panel\.current\);/, "an open panel scrolls in now");
  assert.match(effect, /panelDue\.current = true;\n\s+setMenu\(to\.menu\);/, "a new one once it's drawn");
  const show = src.slice(src.indexOf("const showPanel = "), src.indexOf("\n  };\n", src.indexOf("const showPanel = ")));
  assert.match(show, /panel\.current = el;\n\s+if \(!el \|\| !panelDue\.current\) return;\n\s+panelDue\.current = false;\n\s+scrollToPanel\(el\);/);
  assert.match(src, /const scrollToPanel = \(el: HTMLElement\) => el\.scrollIntoView\(/);
  assert.match(src, /\{menu === "buses" && \(\n\s+<div ref=\{showPanel\} className="flex flex-col gap-5">/, "the Buses panel");
  assert.match(src, /\{menu === "todo" && <Todo [^\n]*panel=\{showPanel\} \/>\}/, "the To-do panel");
  assert.match(fn(src, "function Todo("), /<section ref=\{panel\} className="flex flex-col gap-2">\n\s+<h3 className=\{PX\.dataHeading\}>To do before the trip<\/h3>/);
  assert.doesNotMatch(effect, /progress-title/);
  assert.doesNotMatch(fn(view(), "export default function TripView("), /progress-title"\)\?\.scrollIntoView|getElementById\("progress-title"\)/, "TripView doesn't scroll as well");
  assert.match(read("src/components/RecapView.tsx"), /<LevelMap\b/);
  assert.doesNotMatch(read("src/components/RecapView.tsx"), /jump=/);
});

test("T69-C4 the card's buttons call onJump; there's no tick button", () => {
  const src = card();
  assert.match(src, /onJump\(jump\)/, "Open on the map, with jumpFor(stop)");
  assert.match(src, /const jump = jumpFor\(stop\);/);
  assert.match(src, /onJump\(\{ menu: "buses" \}\)/);
  assert.match(src, /onJump\(\{ menu: "todo" \}\)/);
  assert.doesNotMatch(src, /Mark done|onTick|tripApi/);
  const tv = fn(view(), "export default function TripView(");
  assert.match(tv, /const jumpTo = \(j: NextUpJump\) => \{/);
  assert.match(tv, /console\.info\("\[tg-trip\] next-up jump to=%s", j\.key \? "level" : j\.menu \?\? "world"\);/);
  assert.match(tv, /setJump\(\(prev\) => \(\{ \.\.\.j, n: \(prev\?\.n \?\? 0\) \+ 1 \}\)\);/);
});

test("T69-C5 Add it in Where we're staying scrolls to the hotel title and focuses it", () => {
  const src = card();
  assert.match(src, /document\.getElementById\("hotel-title"\)/);
  assert.match(src, /\.scrollIntoView\(/);
  assert.match(src, /\.focus\(\{ preventScroll: true \}\)/);
  assert.match(fn(view(), "function HotelSection("), /<SectionTitle id="hotel-title" tabIndex=\{flags\.nextUp \? -1 : undefined\}>/, "focusable only with the flag on, so flag off is main's");
});

test("T69-C6 the clock re-reads Manila's today and time on return to the tab and every minute, and cleans up", () => {
  const hook = fn(card(), "export function useManilaClock(");
  assert.ok(hook.length > 0);
  assert.match(hook, /manilaToday\(\)/);
  assert.match(hook, /manilaNow\(\)/);
  assert.match(hook, /if \(!on\) return;/, "nothing runs with the flag off");
  assert.match(hook, /addEventListener\("visibilitychange", /);
  assert.match(hook, /removeEventListener\("visibilitychange", /);
  assert.match(hook, /setInterval\([^;]*, 60_000\)/);
  assert.match(hook, /clearInterval\(/);
});

test("T69-C7 the map's lit tile comes from the same two functions as the card", () => {
  const src = map();
  assert.match(src, /const list = levels\(day, byKey\);/);
  assert.match(src, /const next = marks && !recap \? nextLevel\(list\) : null;/);
  assert.match(read("src/lib/nextUp.ts"), /nextLevel\(levels\(/);
});

test("T69-C8 the logs: the state once per day, and the jump; words and counts only", () => {
  const src = card();
  const log = fn(src, "export function NextUpLog(");
  assert.match(log, /console\.info\("\[tg-trip\] next-up %s", line\);/);
  assert.match(log, /seen\.current === today/, "once per day per page");
  assert.match(fn(view(), "export default function TripView("), /<NextUpLog today=\{clock\.today\} line=\{nextUpLog\(clock\.today, trip, up\)\} ready=\{slot !== "frame"\} \/>/);
  for (const f of [src, view(), map()]) {
    for (const call of f.match(/console\.info\("\[tg-trip\] next-up[^\n]*/g) ?? []) assert.doesNotMatch(call, /\.(plan|name|address|time|departure_time)\b/, call);
  }
});

// ---------------------------------------------------------------- N3, the fold

test("T69-F1 Who's coming folds its per-person lines during the trip; the summary, its buttons and Edit the list stay", () => {
  const box = read("src/components/TripPeople.tsx");
  assert.match(box, /export default function TripPeople\(\{ trip, plan, busy, apply, fold \}: \{/);
  assert.match(box, /\/\*\* TG-69: [^\n]*\*\/\n\s+fold\?: boolean;/);
  const coming = box.slice(box.indexOf('{face === "coming" && ('), box.indexOf('{face === "here" && ('));
  assert.match(coming, /<p className="text-sm font-semibold">\{comingSummary\(list\)\}<\/p>\n\s+\{!fold && comingLines\(list\)\.map\(/);
  assert.match(view(), /<TripPeople trip=\{trip\} plan=\{slot\} busy=\{busy\} apply=\{apply\} fold=\{up\?\.state === "during" \|\| undefined\} \/>/);
});

test("T69-F2 the other faces and openFace don't change: TripPeople's diff is the fold only", (t) => {
  const base = mergeBase();
  if (!base) return t.skip("no origin/main in this checkout, so there's no diff to read");
  // On main after the merge the diff is empty, and that passes: F1 pins the fold itself
  const diff = git("diff", base, "--", "web/src/components/TripPeople.tsx", "web/src/lib/people.ts");
  const changed = diff.split("\n").filter((l) => /^[+-](?![+-])/.test(l));
  for (const l of changed) assert.match(l, /fold|TG-69|\}: \{$|comingLines\(list\)\.map/, l);
  assert.doesNotMatch(diff, /people\.ts/);
});

// ---------------------------------------------------------------- N4, Show the driver

test("T69-D1 Show the driver: only for the trip's hotel with an address, full width, above Google Maps", () => {
  const src = card();
  const part = fn(src, "function HotelBody(");
  assert.match(part, /hotel\.from === "trip" && hotel\.address/);
  assert.ok(part.indexOf("Show the driver") > 0 && part.indexOf("Show the driver") < part.indexOf("Open in Google Maps"), "above Maps");
  // tg-review N1 (mutant j): the button itself sits inside the guard, not only the dialog
  const button = part.search(/>\s*Show the driver\s*<\/PixelButton>/);
  assert.ok(button > 0, "the button's label");
  const block = part.slice(part.lastIndexOf("{hotel", button), button);
  assert.match(block, /^\{hotel\.from === "trip" && hotel\.address && \(\n\s+<PixelButton /, "the guard opens the block the button is in");
  assert.doesNotMatch(block, /\)\}/, "and nothing closes it before the button");
  assert.match(part, /<DriverView /);
});

test("T69-D2 DriverView: a full-screen native dialog on the page's tokens, a 44px Close, big wrapping text, focus back to the opener", () => {
  const src = read("src/components/DriverView.tsx");
  assert.match(src, /<dialog\b/);
  assert.match(src, /\.showModal\(\)/);
  assert.match(src, /m-0 h-dvh max-h-none w-full max-w-none/);
  assert.match(src, /bg-background/);
  assert.match(src, /text-foreground/);
  assert.match(src, /overflow-y-auto/, "it scrolls in landscape if it must");
  assert.match(src, /<PixelButton variant="secondary"[^>]*>\s*Close\s*<\/PixelButton>/);
  assert.match(src, /text-2xl font-bold break-words/);
  assert.match(src, /text-\[28px\] leading-tight font-bold break-words select-text/);
  assert.doesNotMatch(src, /\btruncate\b|line-clamp|<img|Sprite/);
  assert.match(src, /opener\.current\?\.focus\(\)/, "focus goes back to Show the driver");
  assert.match(src, /onClose=\{/, "Esc closes it through the dialog's own close");
});

test("T69-D3 the driver log carries no address or name", () => {
  const src = read("src/components/DriverView.tsx");
  assert.match(src, /console\.info\("\[tg-trip\] next-up driver open"\);/);
  for (const call of src.match(/console\.info\([^\n]*/g) ?? []) assert.match(call, /^console\.info\("\[tg-trip\] next-up driver (open|close)"\);$/, call);
});

// ---------------------------------------------------------------- fences

test("T69-X1 only the plan's files change: no API, schema, worker or package file", (t) => {
  const base = mergeBase();
  if (!base) return t.skip("no origin/main in this checkout, so there's no diff to read");
  // TG-72: this fences TG-69's own branch; on any other branch (main's next tickets) it would refuse their files
  const branch = git("rev-parse", "--abbrev-ref", "HEAD").trim();
  if (!branch.startsWith("TG-69")) return t.skip(`TG-69's fence; this is ${branch}`);
  const files = git("diff", "--name-only", base).trim().split("\n").filter(Boolean);
  const untracked = git("ls-files", "--others", "--exclude-standard").trim().split("\n").filter(Boolean);
  const allowed = [
    "README.md", "web/src/lib/nextUp.ts", "web/src/lib/nextUp.test.ts", "web/src/lib/api.ts", "web/src/lib/flags.ts", "web/src/lib/flags.test.ts",
    "web/src/components/NextUpCard.tsx", "web/src/components/DriverView.tsx", "web/src/components/TripView.tsx", "web/src/components/LevelMap.tsx",
    "web/src/components/TripPeople.tsx", "web/src/lib/people.test.ts",
  ];
  for (const f of [...files, ...untracked]) assert.ok(allowed.includes(f), f);
});
