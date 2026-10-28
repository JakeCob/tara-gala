// Overworld map tests (TG-22): the pure layout in world.ts, plus static guards on the map components
// (no component runner yet). Run with `npm test` (node --test, Node 22.18+ type stripping).
// Every itinerary, trip, spot and leg here is made up for tests only.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { formatDayOffset, formatTime, formatVerified, type Trip } from "./api.ts";
import { formatTravelDate } from "./direction.ts";
import { formatPeso, issuesFor, partySummary, type Itinerary, type StopOut } from "./itinerary.ts";
import { formatFare, formatMinutes, modeLabel, type LastMileLeg, type Spot } from "./lastMile.ts";
import { googleMapsUrl } from "./mapLinks.ts";
import { SPRITES, modeSprite, placeSprite } from "./sprites.ts";

const WEB = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB), "utf8");

// world.ts doesn't exist until GREEN: load it inside each test, so every test fails on its own
type World = typeof import("./world.ts");
const load = (): Promise<World> => import(new URL("src/lib/world.ts", WEB).href);

// The real helpers, passed in so world.ts stays a plain module with type-only imports
const F = {
  time: formatTime,
  dayOffset: formatDayOffset,
  verified: formatVerified,
  travelDate: formatTravelDate,
  modeLabel,
  fare: formatFare,
  minutes: formatMinutes,
  peso: formatPeso,
  partySummary,
  issuesFor,
  placeSprite,
  modeSprite,
};

// ---- fixture (made up) ----

const VERIFIED = "2026-10-24T02:00:00+00:00"; // Oct 24 in Manila
const trip = (o: Partial<Trip>): Trip => ({
  trip_id: "t-out",
  operator_slug: "victory-liner",
  operator_name: "Victory Liner",
  origin_slug: "vl-cubao",
  origin_name: "Victory Liner Cubao (made up)",
  origin_city: "Quezon City",
  destination_slug: "vl-baguio",
  destination_name: "Victory Liner Baguio (made up)",
  destination_city: "Baguio",
  via: null,
  service_class: "deluxe",
  fare_php: 760,
  travel_minutes: 360,
  departure_time: "22:00",
  arrives_around: "04:00",
  arrives_day_offset: 1,
  booking_url: "https://example.test/book",
  source: "manual",
  source_url: null,
  last_verified_at: VERIFIED,
  confirm_note: "Schedules can change. Confirm with the operator before you travel.",
  ...o,
});
const spot = (o: Partial<Spot>): Spot => ({
  spot_id: "s-x",
  slug: "x",
  name: "X (made up)",
  city: "Baguio",
  category: "park",
  lat: 16.41,
  lng: 120.59,
  description: null,
  visit_minutes: 60,
  opening_hours: null,
  entrance_fee_php: null,
  ...o,
});
const place = (kind: "terminal" | "spot", slug: string, name: string, lat: number | null = null, lng: number | null = null) => ({
  kind,
  id: `id-${slug}`,
  slug,
  name,
  lat,
  lng,
});
const LEG_NOTE = "Fares and routes change. Confirm with the driver or a local before you ride.";
const leg = (o: Partial<LastMileLeg>): LastMileLeg => ({
  last_mile_route_id: "l-x",
  origin: place("terminal", "vl-baguio", "Victory Liner Baguio (made up)"),
  destination: place("spot", "x", "X (made up)"),
  mode: "jeep",
  signboard: null,
  boarding_point: null,
  alighting_point: null,
  fare_min_php: null,
  fare_max_php: null,
  minutes: null,
  notes: null,
  source: "manual",
  last_verified_at: VERIFIED,
  confirm_note: LEG_NOTE,
  ...o,
});

const BURNHAM = spot({ spot_id: "s-park", slug: "burnham", name: "Burnham Park (made up)", category: "park", entrance_fee_php: null,
  description: "A lake park (made up).", opening_hours: { mon: "06:00-22:00" } });
const CAFE = spot({ spot_id: "s-cafe", slug: "cafe", name: "Session Cafe (made up)", category: "cafe", lat: null, lng: null });
const LODGING = spot({ spot_id: "s-lodge", slug: "lodge", name: "Hilltop Lodging (made up)", category: "other", lat: 16.40823, lng: 120.59035,
  description: "Lodging. 1 Made Up Street, Baguio (made up)." });
const VIEW = spot({ spot_id: "s-view", slug: "view", name: "Mines View (made up)", category: "viewpoint", entrance_fee_php: 50 });

const JEEP = leg({ last_mile_route_id: "l-jeep", mode: "jeep", destination: place("spot", "burnham", BURNHAM.name, 16.4124, 120.5932),
  signboard: "Plaza - Mines View (made up)", boarding_point: "Gov. Pack Rd stop (made up)", alighting_point: "Park gate (made up)",
  fare_min_php: 13, fare_max_php: 15, minutes: 15, notes: "made up for tests only" });
const WALK = leg({ last_mile_route_id: "l-walk", mode: "walk", origin: place("spot", "burnham", BURNHAM.name),
  destination: place("spot", "cafe", CAFE.name), minutes: 10 });
// TG-34's shape: a terminal taxi to lodging with no fare and no minutes on file
const TAXI = leg({ last_mile_route_id: "l-taxi", mode: "taxi", origin: place("spot", "cafe", CAFE.name),
  destination: place("spot", "lodge", LODGING.name, 16.40823, 120.59035) });
const HABAL = leg({ last_mile_route_id: "l-habal", mode: "habal-habal", origin: place("spot", "lodge", LODGING.name),
  destination: place("spot", "view", VIEW.name, 16.42, 120.62), fare_min_php: 50, fare_max_php: null, minutes: 20, last_verified_at: null });

const stop = (s: Spot, l: LastMileLeg, arrive: string, leave: string): StopOut => ({
  spot_id: s.spot_id, arrive, leave, spot: s, last_mile_route_id: l.last_mile_route_id, leg: l,
});

const FIXTURE: Itinerary = {
  share_slug: "made-up-slug",
  premade: false,
  trip_date: "2026-11-06",
  return_date: "2026-11-09",
  party: [{ type: "adult", name: null }, { type: "adult", name: null }, { type: "senior", name: null }],
  budget_php: 6000,
  vibe: "chill",
  created_at: "2026-10-28T00:00:00Z",
  outbound: { trip_id: "t-out", date: "2026-11-06", trip: trip({}) },
  return: {
    trip_id: "t-ret",
    date: "2026-11-09",
    trip: trip({ trip_id: "t-ret", origin_slug: "vl-baguio", origin_name: "Victory Liner Baguio (made up)", origin_city: "Baguio",
      destination_slug: "vl-cubao", destination_name: "Victory Liner Cubao (made up)", destination_city: "Quezon City",
      departure_time: "21:00", arrives_around: "03:00", arrives_day_offset: 1, booking_url: null }),
  },
  days: [
    { day: 1, date: "2026-11-07", stops: [stop(BURNHAM, JEEP, "13:00", "15:00"), stop(CAFE, WALK, "15:10", "16:00"), stop(LODGING, TAXI, "17:00", "21:00")] },
    { day: 2, date: "2026-11-08", stops: [] },
    { day: 3, date: "2026-11-09", stops: [stop(VIEW, HABAL, "00:05", "12:00")] },
  ],
  plan: null,
  issues: [{ code: "trip_inactive", path: "outbound.trip_id", message: "made up" }],
};
const clone = (): Itinerary => structuredClone(FIXTURE);

type Row = Awaited<ReturnType<World["worldLayout"]>>[number];
const ofKind = <K extends Row["kind"]>(rows: Row[], kind: K) => rows.filter((r): r is Extract<Row, { kind: K }> => r.kind === kind);
const byId = (rows: Row[], id: string) => {
  const r = rows.find((x) => "id" in x && x.id === id);
  assert.ok(r, `row ${id}`);
  return r;
};

const originalTZ = process.env.TZ;
afterEach(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

// ---- T22-L1 order (B1) ----

test("T22-L1 rows run party, outbound, each day in order, then the return bus", async () => {
  const { worldLayout } = await load();
  const rows = worldLayout(FIXTURE, F);
  const ids = rows.map((r) => ("id" in r ? r.id : r.kind));
  assert.deepEqual(ids, [
    "party",
    "out-banner", "out-origin", "out-bus", "turn-out-destination", "out-destination",
    "d0-banner",
    "d0-s0-leg", "turn-d0-s0-node", "d0-s0-node",
    "d0-s1-leg", "turn-d0-s1-node", "d0-s1-node",
    "d0-s2-leg", "turn-d0-s2-node", "d0-s2-node",
    "d1-banner", "d1-free",
    "d2-banner", "d2-s0-leg", "turn-d2-s0-node", "d2-s0-node",
    "ret-banner", "ret-to-terminal", "turn-ret-origin", "ret-origin", "ret-bus", "turn-ret-destination", "ret-destination",
  ]);
  assert.deepEqual(ofKind(rows, "banner").map((b) => b.text), [
    "Bus to Baguio · Fri, Nov 6", "Day 1 · Sat, Nov 7", "Day 2 · Sun, Nov 8", "Day 3 · Mon, Nov 9", "Bus to Metro Manila · Mon, Nov 9",
  ]);
  const party = rows[0];
  assert.equal(party.kind, "party");
  assert.equal(party.kind === "party" && party.summary, "Party of 3: 2 adults, 1 senior.");
  const stops = ofKind(rows, "node").flatMap((n) => (n.node.type === "stop" ? [[n.node.dayIndex, n.node.stopIndex]] : []));
  assert.deepEqual(stops, [[0, 0], [0, 1], [0, 2], [2, 0]]);
});

// ---- T22-L2 sides and turns (B2), over the fixture and generated itineraries ----

function checkSides(rows: Row[], label: string) {
  const nodes = ofKind(rows, "node");
  if (nodes.length) assert.equal(nodes[0].side, "left", `${label}: first node is left`);
  for (let i = 1; i < nodes.length; i++) assert.notEqual(nodes[i].side, nodes[i - 1].side, `${label}: ${nodes[i].id} alternates`);
  let lastNodeSide: string | null = null;
  rows.forEach((r, i) => {
    if (r.kind === "node") lastNodeSide = r.side;
    if (r.kind === "leg" || r.kind === "toTerminal" || r.kind === "free") {
      assert.equal(r.side, lastNodeSide ?? "left", `${label}: ${r.id} keeps the side of the node above`);
    }
    if (r.kind === "banner") assert.ok(!("side" in r), `${label}: banners have no side`);
    if (r.kind === "turn") {
      const before = rows[i - 1], after = rows[i + 1];
      assert.ok(before && (before.kind === "leg" || before.kind === "toTerminal"), `${label}: ${r.id} follows a ride`);
      assert.ok(after && after.kind === "node", `${label}: ${r.id} precedes a node`);
      assert.equal(r.from, (before as { side: string }).side, `${label}: ${r.id} from`);
      assert.equal(r.to, (after as { side: string }).side, `${label}: ${r.id} to`);
      assert.notEqual(r.from, r.to);
    }
  });
}

// Small seeded generator (mulberry32), so the 20 itineraries are the same on every run
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function generated(n: number): Itinerary[] {
  const r = rng(22);
  const pool = FIXTURE.days[0].stops;
  return Array.from({ length: n }, () => {
    const it = clone();
    it.days = Array.from({ length: Math.floor(r() * 5) }, (_, d) => ({
      day: d + 1,
      date: null,
      stops: Array.from({ length: Math.floor(r() * 6) }, (_, s) => structuredClone(pool[s % pool.length])),
    }));
    return it;
  });
}

test("T22-L2 node sides alternate and turns sit only between a ride and the next node", async () => {
  const { worldLayout } = await load();
  checkSides(worldLayout(FIXTURE, F), "fixture");
  generated(20).forEach((it, i) => checkSides(worldLayout(it, F), `generated ${i}`));
});

// Banners are pixel-font SectionTitles (TG-42 T15, narrowed by the manager's decision): the text itself must
// never carry the glyphs Pixelify Sans lacks (ux-guide 2.2)
test("T22-L2b banner text never has ₱ or →", async () => {
  const { worldLayout } = await load();
  const cases: [string, Itinerary][] = [["fixture", FIXTURE], ...generated(20).map((g, i): [string, Itinerary] => [`generated ${i}`, g])];
  for (const [label, it] of cases) {
    for (const b of ofKind(worldLayout(it, F), "banner")) assert.doesNotMatch(b.text, /[₱→\u20b1\u2192]/, `${label}: ${b.text}`);
  }
});

// ---- T22-L3 day labels (B3) ----

test("T22-L3 Day 1 uses the day's own date (the overnight arrival), in any time zone", async () => {
  const { worldLayout } = await load();
  const labels = new Set<string>();
  for (const tz of ["America/Los_Angeles", "Pacific/Kiritimati", "Asia/Manila"]) {
    process.env.TZ = tz;
    const banners = ofKind(worldLayout(FIXTURE, F), "banner").map((b) => b.text);
    assert.equal(banners[1], "Day 1 · Sat, Nov 7", `${tz}: Day 1 is the arrival day, not outbound.date`);
    labels.add(banners.join("|"));
  }
  assert.equal(labels.size, 1, "identical labels in all three time zones");
  const it = clone();
  it.days[1].date = null;
  const day2 = ofKind(worldLayout(it, F), "banner")[2].text;
  assert.equal(day2, "Day 2");
  assert.doesNotMatch(JSON.stringify(worldLayout(it, F)), /undefined|Invalid Date|NaN/);
});

// ---- T22-L4 empty day (B4) ----

test("T22-L4 an empty day is a banner plus one free row, with no turn and the side carried over", async () => {
  const { worldLayout } = await load();
  const rows = worldLayout(FIXTURE, F);
  const i = rows.findIndex((r) => "id" in r && r.id === "d1-banner");
  const free = rows[i + 1];
  assert.equal(free.kind, "free");
  assert.equal(free.kind === "free" && free.text, "Free time. No stops planned for this day.");
  assert.equal(rows[i + 2].kind, "banner", "no turn after the free row");
  assert.notEqual(rows[i - 1].kind, "turn");
  const lastNode = ofKind(rows.slice(0, i), "node").at(-1)!;
  assert.equal(free.kind === "free" && free.side, lastNode.side);
  const nextNode = ofKind(rows.slice(i), "node")[0];
  assert.notEqual(nextNode.side, lastNode.side, "the next node alternates from the last node");
});

// ---- T22-L5 toTerminal (B5) ----

test("T22-L5 the row before the return bus says where to go, with no invented mode, time or fare", async () => {
  const { worldLayout } = await load();
  const row = byId(worldLayout(FIXTURE, F), "ret-to-terminal");
  assert.equal(row.kind, "toTerminal");
  assert.equal(row.kind === "toTerminal" && row.text, "Head to Victory Liner Baguio (made up) for your 9:00 PM bus");
  for (const key of ["mode", "minutes", "fare", "checked", "sign"]) assert.ok(!(key in row), `no ${key}`);
  const text = JSON.stringify(row);
  assert.doesNotMatch(text, /₱|\bmin\b/);
  assert.deepEqual(row.kind === "toTerminal" && row.terminal, { slug: "vl-baguio", name: "Victory Liner Baguio (made up)", city: "Baguio" });

  const it = clone();
  it.return.trip = null;
  const gone = byId(worldLayout(it, F), "ret-to-terminal");
  // Builder's pick for the plan's open text: no terminal name and no time when the bus didn't join
  assert.equal(gone.kind === "toTerminal" && gone.text, "Head to your terminal for the bus back");
  assert.equal(gone.kind === "toTerminal" && gone.terminal, null);
  assert.doesNotMatch(JSON.stringify(gone), /undefined|null bus|NaN|\d:\d\d/);
});

// ---- T22-L6 missing joins and issues (B6) ----

test("T22-L6 a bus that didn't join is marked missing, and its terminals invent nothing", async () => {
  const { worldLayout } = await load();
  const it = clone();
  it.outbound.trip = null;
  const rows = worldLayout(it, F);
  const bus = byId(rows, "out-bus");
  assert.ok(bus.kind === "leg" && bus.sign.missing);
  assert.equal(bus.kind === "leg" && bus.sign.title, "This bus is no longer in our schedules");
  assert.equal(bus.kind === "leg" && bus.sign.checked, null);
  for (const id of ["out-origin", "out-destination"]) {
    const n = byId(rows, id);
    assert.ok(n.kind === "node" && n.sign.missing, id);
    assert.equal(n.kind === "node" && n.sign.title, "Terminal (no longer listed)", id);
    assert.deepEqual(n.kind === "node" && n.sign.lines, [], `${id}: no time line invented`);
  }
});

test("T22-L6 a stop or leg that didn't join is marked missing; the stop keeps its times", async () => {
  const { worldLayout } = await load();
  const it = clone();
  it.days[0].stops[0].spot = null;
  it.days[0].stops[1].leg = null;
  const rows = worldLayout(it, F);
  const node = byId(rows, "d0-s0-node");
  assert.ok(node.kind === "node" && node.sign.missing);
  assert.equal(node.kind === "node" && node.sign.title, "No longer in our list");
  assert.ok(node.kind === "node" && node.sign.lines.includes("1:00 PM – 3:00 PM"), "times still shown");
  const l = byId(rows, "d0-s1-leg");
  assert.ok(l.kind === "leg" && l.sign.missing);
  assert.equal(l.kind === "leg" && l.sign.title, "No longer in our list");
  assert.equal(l.kind === "leg" && l.sprite, null);
});

test("T22-L6 issues mark only the row at their path", async () => {
  const { worldLayout } = await load();
  const CHANGED = "Changed since this plan was saved";
  const rows = worldLayout(FIXTURE, F);
  const changed = rows.filter((r) => (r.kind === "node" || r.kind === "leg") && r.sign.changed).map((r) => ("id" in r ? r.id : ""));
  assert.deepEqual(changed, ["out-bus"], "trip_inactive at outbound.trip_id marks the outbound bus only");
  const bus = byId(rows, "out-bus");
  assert.ok(bus.kind === "leg" && bus.sign.lines.includes(CHANGED));

  // Path precision: an issue at stop 10 must not mark stop 1
  const it = clone();
  const pool = it.days[0].stops;
  it.days[0].stops = Array.from({ length: 11 }, (_, s) => structuredClone(pool[s % pool.length]));
  it.issues = [
    { code: "unknown_spot", path: "days[0].stops[10].spot_id", message: "made up" },
    { code: "leg_wrong_end", path: "days[0].stops[2].leg.last_mile_route_id", message: "made up" },
    { code: "closed", path: "days[0].stops[3].spot_id", message: "made up" },
  ];
  const r2 = worldLayout(it, F);
  const marked = r2.filter((r) => (r.kind === "node" || r.kind === "leg") && r.sign.changed).map((r) => ("id" in r ? r.id : "")).sort();
  assert.deepEqual(marked, ["d0-s10-node", "d0-s2-leg", "d0-s3-node"]);
});

// ---- T22-L7 and L8 sign lines (B8, B9) ----

test("T22-L7 ride signs: mode, minutes and fare with nulls skipped, and a Checked line on every ride", async () => {
  const { worldLayout } = await load();
  const rows = worldLayout(FIXTURE, F);
  const sign = (id: string) => {
    const r = byId(rows, id);
    assert.equal(r.kind, "leg", id);
    return (r as Extract<Row, { kind: "leg" }>).sign;
  };
  assert.equal(sign("d0-s0-leg").title, "Jeepney · 15 min · ₱13–15");
  assert.equal(sign("d0-s1-leg").title, "Walk · 10 min");
  assert.equal(sign("d0-s2-leg").title, "Taxi", "TG-34 taxi: no ₱0, no 0 min, no stray ·");
  assert.equal(sign("d2-s0-leg").title, "Habal-habal · 20 min · ₱50+", "an unknown mode is still named");
  assert.equal(sign("out-bus").title, "Victory Liner");
  assert.deepEqual(sign("out-bus").lines.filter((l) => l.includes("→")), [`10:00 PM → 4:00 AM${formatDayOffset(1)}`]);
  assert.deepEqual(sign("ret-bus").lines.filter((l) => l.includes("→")), [`9:00 PM → 3:00 AM${formatDayOffset(1)}`]);
  assert.equal(sign("d0-s0-leg").checked, "Checked Oct 24");
  assert.equal(sign("d2-s0-leg").checked, "Not yet verified");
  for (const r of ofKind(rows, "leg")) {
    assert.ok(r.sign.checked, `${r.id}: the Checked line is always on the map`);
    for (const line of [r.sign.title, ...r.sign.lines]) {
      assert.doesNotMatch(line, /^\s*·|·\s*$|·\s*·/, `${r.id}: "${line}"`);
      assert.doesNotMatch(line, /₱0\b|\b0 min\b/, `${r.id}: "${line}"`);
    }
  }
});

test("T22-L8 node signs: stop times, terminal departs and arrives", async () => {
  const { worldLayout } = await load();
  const rows = worldLayout(FIXTURE, F);
  const sign = (id: string) => (byId(rows, id) as Extract<Row, { kind: "node" }>).sign;
  assert.deepEqual([sign("d0-s0-node").title, sign("d0-s0-node").lines], ["Burnham Park (made up)", ["1:00 PM – 3:00 PM"]]);
  assert.deepEqual(sign("d2-s0-node").lines, ["12:05 AM – 12:00 PM"], "midnight and noon");
  assert.deepEqual([sign("out-origin").title, sign("out-origin").lines], ["Victory Liner Cubao (made up)", ["Departs 10:00 PM"]]);
  assert.deepEqual([sign("out-destination").title, sign("out-destination").lines], ["Victory Liner Baguio (made up)", [`Arrives 4:00 AM${formatDayOffset(1)}`]]);
  assert.deepEqual(sign("ret-origin").lines, ["Departs 9:00 PM"]);
  assert.deepEqual(sign("ret-destination").lines, [`Arrives 3:00 AM${formatDayOffset(1)}`]);
  const it = clone();
  it.outbound.trip!.arrives_around = null;
  assert.deepEqual((byId(worldLayout(it, F), "out-destination") as Extract<Row, { kind: "node" }>).sign.lines, [], "unknown arrival: no line");
});

// ---- T22-L9 detail sheets (B10, ux 3.1 and 3.2) ----

test("T22-L9 legSheet: ux 3.1 rows in order, null fields absent, Checked and the confirm note", async () => {
  const { legSheet } = await load();
  const jeep = legSheet(JEEP, F);
  assert.equal(jeep.title, "Jeepney to Burnham Park (made up)");
  assert.deepEqual(jeep.rows, [
    ["From", "Victory Liner Baguio (made up)"],
    ["To", "Burnham Park (made up)"],
    ["Signboard", "Plaza - Mines View (made up)"],
    ["Board at", "Gov. Pack Rd stop (made up)"],
    ["Get off at", "Park gate (made up)"],
    ["Fare", "₱13–15"],
    ["Time", "15 min"],
    ["Notes", "made up for tests only"],
  ]);
  assert.equal(jeep.checked, "Checked Oct 24");
  assert.equal(jeep.note, LEG_NOTE);
  const taxi = legSheet(TAXI, F);
  assert.deepEqual(taxi.rows.map(([k]) => k), ["From", "To"], "TG-34 taxi: no signboard, board, get off, fare or time rows");
  assert.equal(taxi.title, "Taxi to Hilltop Lodging (made up)");
});

test("T22-L9 stopSheet: times, category (Other hidden), description, entrance; never opening hours", async () => {
  const { stopSheet } = await load();
  const park = stopSheet(FIXTURE.days[0].stops[0], F)!;
  assert.equal(park.title, "Burnham Park (made up)");
  assert.deepEqual(park.rows, [
    ["Time", "Arrive 1:00 PM · Leave 3:00 PM"],
    ["Category", "Park"],
    ["About", "A lake park (made up)."],
  ]);
  assert.doesNotMatch(JSON.stringify(park), /06:00|opening/i, "opening_hours is raw JSON: out of scope");
  const lodge = stopSheet(FIXTURE.days[0].stops[2], F)!;
  assert.ok(!lodge.rows.some(([k]) => k === "Category"), "Other is hidden");
  assert.ok(lodge.rows.some(([k, v]) => k === "About" && v.startsWith("Lodging.")));
  const view = stopSheet(FIXTURE.days[2].stops[0], F)!;
  assert.deepEqual(view.rows.find(([k]) => k === "Entrance"), ["Entrance", "₱50"]);
  const free = clone().days[2].stops[0];
  free.spot!.entrance_fee_php = 0;
  assert.deepEqual(stopSheet(free, F)!.rows.find(([k]) => k === "Entrance"), ["Entrance", "Free"], "plan decision: 0 is free, never ₱0");
  const missing = clone().days[0].stops[0];
  missing.spot = null;
  assert.equal(stopSheet(missing, F), null, "no sheet for a stop that didn't join");
});

// ---- T22-L10 geometry (B7, ux 2.1) ----

test("T22-L10 trackGeometry: ux 2.1's numbers at 316px, and whole tiles at every width", async () => {
  const { trackGeometry } = await load();
  const pick = (W: number) => {
    const g = trackGeometry(W);
    return { tile: g.tile, straights: g.straights, leftX: g.leftX, rightX: g.rightX };
  };
  assert.deepEqual(pick(316), { tile: 32, straights: 6, leftX: 30, rightX: 254 });
  assert.deepEqual(pick(256), { tile: 32, straights: 4, leftX: 30, rightX: 190 });
  assert.equal(pick(412).straights, 9);
  for (let W = 160; W <= 448; W++) {
    const g = trackGeometry(W);
    assert.ok(g.straights >= 1, `${W}: straights`);
    assert.equal(g.rightX - (g.leftX + 32), g.straights * 32, `${W}: no gap or overlap`);
    assert.ok(g.rightX + 32 <= W, `${W}: right track inside the world`);
    assert.ok(g.leftX >= 0);
    const leftSign = [g.leftX + 48, W - 8], rightSign = [8, g.rightX - 16];
    assert.ok(leftSign[0] > g.leftX + 32 && rightSign[1] < g.rightX, `${W}: signs never cover their own track`);
    if (W === 256) assert.ok(leftSign[1] - leftSign[0] >= 120 && rightSign[1] - rightSign[0] >= 120, "signs at least 120px at 256");
  }
  for (const W of [156, 100, 0]) {
    const g = trackGeometry(W);
    assert.ok([g.straights, g.leftX, g.rightX].every((n) => Number.isFinite(n) && n >= 0), `${W}: no negatives`);
  }
});

// 380px defect (manager, 2026-10-28): during a full-page capture Chrome briefly resizes the viewport and the
// ResizeObserver reports a world width of 0; the map re-laid out for W = 0 and left-column signs shrank to 70px.
test("T22-L10c sign boxes come from trackGeometry: the same width on both sides, never negative", async () => {
  const { signBoxes, trackGeometry } = await load();
  assert.deepEqual(signBoxes(316), { left: { x: 78, width: 230 }, right: { x: 8, width: 230 } }, "380px phone (world 316)");
  const narrow = signBoxes(256); // 320px phone
  assert.equal(narrow.left.width, narrow.right.width);
  assert.ok(narrow.left.width >= 160, `320px phone: ${narrow.left.width}px signs`);
  for (let W = 156; W <= 448; W++) {
    const g = trackGeometry(W);
    const { left, right } = signBoxes(W);
    assert.equal(left.width, right.width, `${W}: equal sign widths`);
    assert.ok(left.width > 0, `${W}: positive width`);
    assert.ok(left.x >= g.leftX + 32 + 16 && left.x + left.width <= W - 8, `${W}: the right-hand sign clears the left track and the edge`);
    assert.ok(right.x >= 8 && right.x + right.width <= g.rightX - 16, `${W}: the left-hand sign clears the edge and the right track`);
  }
  for (const W of [0, 100, 155]) {
    const { left, right } = signBoxes(W);
    assert.ok(left.width >= 0 && right.width >= 0, `${W}: never negative`);
  }
});

test("T22-L10d a collapsed width measurement keeps the last good world width", async () => {
  const { usableWidth, MIN_WORLD } = await load();
  assert.equal(MIN_WORLD, 156);
  assert.equal(usableWidth(0, 316), 316, "Chrome's capture resize reports 0");
  assert.equal(usableWidth(3, 316), 316);
  assert.equal(usableWidth(155, 316), 316);
  assert.equal(usableWidth(156, 316), 156);
  assert.equal(usableWidth(256, 316), 256, "a real narrower phone is applied");
  assert.equal(usableWidth(448, 316), 448);
});

// ---- T22-L10b row ids ----

test("T22-L10b row ids are unique, stable, and resolve back to the tapped row's data", async () => {
  const { worldLayout, rowData } = await load();
  const rows = worldLayout(FIXTURE, F);
  const ids = rows.flatMap((r) => ("id" in r ? [r.id] : []));
  assert.equal(new Set(ids).size, ids.length, "unique");
  assert.deepEqual(worldLayout(clone(), F), rows, "same input, same rows");
  assert.deepEqual(rowData(FIXTURE, "d0-s1-node"), { kind: "stop", stop: FIXTURE.days[0].stops[1] });
  assert.deepEqual(rowData(FIXTURE, "d0-s1-leg"), { kind: "leg", leg: WALK });
  assert.deepEqual(rowData(FIXTURE, "out-bus"), { kind: "bus", bus: "outbound", trip: FIXTURE.outbound.trip });
  assert.deepEqual(rowData(FIXTURE, "ret-origin"), { kind: "terminal", bus: "return", end: "origin", trip: FIXTURE.return.trip });
  assert.deepEqual(rowData(FIXTURE, "out-destination"), { kind: "terminal", bus: "outbound", end: "destination", trip: FIXTURE.outbound.trip });
  for (const r of rows) {
    if (r.kind === "node" || r.kind === "leg") assert.ok(rowData(FIXTURE, r.id), `${r.id} resolves`);
  }
  assert.equal(rowData(FIXTURE, "d9-s9-node"), null);
  assert.equal(rowData(FIXTURE, "nonsense"), null);
});

// ---- T22-L11 turn rotations ----

test("T22-L11 turnRotations matches ux 2.1's table; a same-side turn throws", async () => {
  const { turnRotations } = await load();
  assert.deepEqual(turnRotations("left", "right"), { start: -90, end: 90 });
  assert.deepEqual(turnRotations("right", "left"), { start: 180, end: 0 });
  assert.throws(() => turnRotations("left", "left"));
  assert.throws(() => turnRotations("right", "right"));
});

// ---- T22-L12 Maps links (B11); the googleMapsUrl argument itself is tested in mapLinks.test.ts ----

test("T22-L12 mapsTravelMode: walking for walk, driving for every other mode", async () => {
  const { mapsTravelMode } = await load();
  assert.equal(mapsTravelMode("walk"), "walking");
  for (const m of ["jeep", "taxi", "tricycle", "van", "grab", "habal-habal", ""]) assert.equal(mapsTravelMode(m), "driving", m);
});

test("T22-L12 each sheet's Maps target: coordinates when known, else the name; terminals by name and city", async () => {
  const { mapsTarget, mapsLabel } = await load();
  const url = (id: string) => {
    const t = mapsTarget(FIXTURE, id);
    assert.ok(t, id);
    return new URL(googleMapsUrl(t.place, t.travelmode));
  };
  const lodging = url("d0-s2-leg");
  assert.equal(lodging.searchParams.get("destination"), "16.40823,120.59035", "TG-34-shaped lodging coordinates");
  assert.equal(lodging.searchParams.get("travelmode"), "driving");
  assert.equal(url("d0-s1-leg").searchParams.get("destination"), "Session Cafe (made up)", "no coordinates: the name");
  assert.equal(url("d0-s1-leg").searchParams.get("travelmode"), "walking");
  const park = url("d0-s0-node");
  assert.equal(park.searchParams.get("destination"), "16.41,120.59");
  assert.equal(park.searchParams.get("travelmode"), "transit");
  const terminal = url("out-origin");
  assert.equal(terminal.searchParams.get("destination"), "Victory Liner Cubao (made up), Quezon City");
  assert.equal(terminal.searchParams.get("travelmode"), "transit");
  assert.equal(url("ret-to-terminal").searchParams.get("destination"), "Victory Liner Baguio (made up), Baguio");
  for (const id of ["d0-s0-leg", "out-origin", "d0-s0-node"]) {
    assert.deepEqual([...url(id).searchParams.keys()].sort(), ["api", "destination", "travelmode"], `${id}: no origin`);
  }
  assert.equal(mapsTarget(FIXTURE, "out-bus"), null, "the bus sheet links to Book, not Maps");
  const it = clone();
  it.return.trip = null;
  assert.equal(mapsTarget(it, "ret-to-terminal"), null);
  assert.equal(mapsLabel("Burnham Park (made up)"), "Open in Google Maps, directions to Burnham Park (made up), opens in a new tab");
  assert.ok(mapsLabel("X").startsWith("Open in Google Maps"), "starts with the visible text (WCAG 2.5.3)");
});

// ---- T22-L13 sprites (B7) ----

test("T22-L13 sprites come from TG-33's mapping; lodging is never guessed", async () => {
  const { worldLayout } = await load();
  const rows = worldLayout(FIXTURE, F);
  const sprite = (id: string) => (byId(rows, id) as { sprite: string | null }).sprite;
  assert.equal(sprite("d0-s0-node"), "place-park");
  assert.equal(sprite("d0-s2-node"), "place-other", "category other with a 'Lodging.' description stays place-other");
  assert.equal(sprite("out-origin"), "place-terminal");
  assert.equal(sprite("ret-destination"), "place-terminal");
  assert.equal(sprite("d0-s0-leg"), "mode-jeep");
  assert.equal(sprite("d0-s1-leg"), "mode-walk");
  assert.equal(sprite("d2-s0-leg"), null, "unknown mode: no image");
  assert.equal(sprite("out-bus"), "vehicle-bus");
  for (const r of rows) {
    const s = (r as { sprite?: string | null }).sprite;
    if (s != null) assert.ok(Object.hasOwn(SPRITES, s), `${s} is a SPRITES key`);
  }
  const buses = ofKind(rows, "leg").filter((l) => l.leg.type === "bus");
  assert.ok(buses.every((b) => b.track === "road") && ofKind(rows, "leg").filter((l) => l.leg.type === "lastMile").every((l) => l.track === "path"));
});

// ---- T22-L14 every node and ride carries its facts (criterion 1) ----

test("T22-L14 every stop shows its name and times; every ride its mode and minutes", async () => {
  const { worldLayout } = await load();
  const rows = worldLayout(FIXTURE, F);
  for (const n of ofKind(rows, "node")) {
    if (n.node.type !== "stop") continue;
    const s = FIXTURE.days[n.node.dayIndex].stops[n.node.stopIndex];
    assert.equal(n.sign.title, s.spot!.name);
    assert.ok(n.sign.lines.some((l) => /^\d{1,2}:\d{2} [AP]M – \d{1,2}:\d{2} [AP]M$/.test(l)), n.id);
  }
  for (const l of ofKind(rows, "leg")) {
    if (l.leg.type !== "lastMile") continue;
    const data = FIXTURE.days[l.leg.dayIndex].stops[l.leg.stopIndex].leg!;
    assert.ok(l.sign.title.startsWith(modeLabel(data.mode)), l.id);
    if (data.minutes != null) assert.match(l.sign.title, new RegExp(`· ${formatMinutes(data.minutes)}`), l.id);
  }
});

// ---- T22-L15 pure and offline (B13) ----

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

test("T22-L15 the layout and sheets never mutate their input or touch the network", async (t) => {
  const { worldLayout, legSheet, stopSheet, rowData, mapsTarget } = await load();
  const frozen = deepFreeze(clone());
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("no network");
  });
  worldLayout(frozen, F);
  legSheet(frozen.days[0].stops[0].leg!, F);
  stopSheet(frozen.days[0].stops[0], F);
  rowData(frozen, "d0-s0-node");
  mapsTarget(frozen, "d0-s0-leg");
  assert.deepEqual(frozen, FIXTURE);
});

test("T22-L15 world.ts is a plain module: type-only imports, no JSX, no fetch", () => {
  const file = new URL("src/lib/world.ts", WEB);
  assert.ok(existsSync(file), "src/lib/world.ts exists");
  const source = readFileSync(file, "utf8");
  for (const m of source.matchAll(/^\s*import\b.*$/gm)) assert.match(m[0], /^\s*import type\b/, m[0]);
  assert.doesNotMatch(source, /\bimport\s*\(/);
  assert.doesNotMatch(source, /from "@\//);
  assert.doesNotMatch(source, /use client|\benum\s|\bnamespace\s|\bfetch\(/);
  assert.doesNotMatch(source, /<\/?[A-Za-z][\w.]*[\s>/]/, "no JSX");
});

// ---- static guards on the map components (until a component runner exists) ----

const MAP = "src/components/OverworldMap.tsx";
const SHEET = "src/components/WorldSheet.tsx";
const component = (path: string) => {
  assert.ok(existsSync(new URL(path, WEB)), `${path} exists`);
  return read(path);
};
const both = () => [component(MAP), component(SHEET)];

test("T22-S1 no network: the map renders from props only", () => {
  for (const src of both()) {
    assert.doesNotMatch(src, /\bfetch\(|fetchItinerary|fetchTerminals|getTerminals|fetchLastMile|XMLHttpRequest|sendBeacon|new WebSocket/);
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@\/lib\/api"/g)) {
      for (const name of m[1].split(",").map((s) => s.replace(/\btype\b/, "").trim()).filter(Boolean)) {
        assert.ok(["formatTime", "formatDayOffset", "formatVerified", "Trip"].includes(name), `api import ${name}`);
      }
    }
  }
  assert.match(component(MAP), /export default function OverworldMap\(\{\s*itinerary\s*\}:\s*\{\s*itinerary:\s*Itinerary\s*\}\)/);
});

test("T22-S2 every image is a TG-33 sprite: spriteSrc, alt empty, sized, pixelated", () => {
  for (const src of both()) {
    assert.doesNotMatch(src, /["'`]\/sprites\//, "no literal sprite paths");
    assert.doesNotMatch(src, /<canvas|<svg\b/);
    for (const m of src.matchAll(/url\(/g)) {
      assert.match(src.slice(m.index!, m.index! + 20), /^url\(\$\{spriteSrc\(/, "CSS backgrounds go through spriteSrc");
    }
    for (const [img] of src.matchAll(/<img\b[\s\S]*?\/>/g)) {
      assert.match(img, /\balt=""/, img);
      assert.match(img, /\bwidth=\{[\w.\s*+]+\}/, img);
      assert.match(img, /\bheight=\{[\w.\s*+]+\}/, img);
      assert.match(img, /\bpixelated\b/, img);
      assert.match(img, /\bsrc=\{spriteSrc\(/, img);
      assert.match(img, /draggable=\{false\}/, img);
    }
  }
});

test("T22-S3 one native dialog, Close first, and the Maps link opens a new tab safely", () => {
  const sheet = component(SHEET);
  assert.equal(sheet.match(/<dialog\b/g)?.length, 1);
  assert.match(sheet, /<dialog\b[^>]*aria-labelledby=/);
  assert.match(component(MAP) + sheet, /\.showModal\(\)/);
  const inside = sheet.slice(sheet.indexOf("<dialog"));
  const first = inside.match(/<(button|PixelButton|a|PixelLink|Link|input|MapsLink|TripCard)\b[^>]*>/)?.[0] ?? "";
  assert.match(first, /^<PixelButton\b[^>]*variant="secondary"/, "Close is the first focusable element");
  assert.match(inside, /Close/);
  assert.match(sheet, /<PixelLink\b[^>]*variant="primary"[^>]*\bexternal\b/, "Maps is a primary external PixelLink (TG-42)");
  assert.match(sheet, /aria-label=\{mapsLabel\(/);
  assert.match(sheet, /<DialogBox\b/, "the sheet's box is TG-42's DialogBox");
  assert.match(sheet, /backdrop:bg-screen-ink\/60/, "review nit 5: a token, not a hex");
});

test("T22-S4 motion goes through TG-15's spawn; skip on tap, key and scroll", () => {
  const map = component(MAP);
  assert.match(map, /import \{ useSpawn \} from "@\/components\/useSpawn"/);
  assert.match(map, /<PartyStage\b[^>]*fixedRows=\{false\}/);
  for (const src of both()) assert.doesNotMatch(src, /\bsetTimeout\(|requestAnimationFrame|@keyframes/);
  assert.match(map, /onPointerDownCapture=/);
  assert.match(map, /onKeyDownCapture=/);
  assert.match(map, /addEventListener\("scroll"/);
  assert.match(map, /removeEventListener\("scroll"/);
});

test("T22-S5 accessibility shape: sections, ordered lists, buttons named by their text", () => {
  const map = component(MAP);
  for (const src of both()) {
    assert.doesNotMatch(src, /role="application"|tabIndex|tabindex|onKeyDown=/);
    assert.doesNotMatch(src, /dangerouslySetInnerHTML/);
    for (const [btn] of src.matchAll(/<button\b[^>]*>/g)) assert.doesNotMatch(btn, /aria-label/, btn);
  }
  assert.match(map, /<section\b[^>]*aria-labelledby=/);
  assert.match(map, /<ol\b/);
  assert.match(map, /<li\b/);
  assert.match(map, /<button type="button"/);
  assert.match(map, /aria-hidden="true"/);
  assert.match(map, /<SectionTitle\b[^>]*onScreen/, "banners are TG-42 SectionTitles on the game screen");
});

test("T22-S6 the world fits the phone: measured width, starting at 316", () => {
  const map = component(MAP);
  assert.match(map, /new ResizeObserver\(/);
  assert.match(map, /useState\(316\)/);
  // The measured width only applies when it's usable, and signs are placed from the tested signBoxes
  assert.match(map, /new ResizeObserver\(\(\[entry\]\) =>[^;]*usableWidth\(/);
  assert.match(map, /signBoxes\(/);
  for (const m of map.matchAll(/\b(min-)?w-\[(\d+)px\]/g)) {
    assert.ok(Number(m[2]) <= (m[1] ? 316 : 380), m[0]);
  }
});

test("T22-S7 logs: one render line, sheet kinds and failed sprite names, never party data or URLs", () => {
  const src = both().join("\n");
  assert.match(src, /console\.info\("\[tg-map\] render rows=%d days=%d missing=%d"/);
  assert.match(src, /console\.info\("\[tg-map\] sheet kind=%s"/);
  assert.match(src, /console\.warn\("\[tg-map\] sprite failed %s"/);
  for (const m of src.matchAll(/console\.\w+\(([^;]*)\);/g)) {
    assert.doesNotMatch(m[1], /party|href|\burl\b|googleMapsUrl|spot\b|\.name\b|trip\b/i, m[0]);
  }
});

// ---- B15 wiring on TG-23's page ----

test("T22-B15 the share page shows the map, and the list stays behind the kill switch", () => {
  const view = read("src/components/ItineraryView.tsx");
  assert.match(view, /flags\.overworldMap/);
  const list = read("src/components/ItineraryList.tsx");
  assert.match(list, /<OverworldMap itinerary=\{it\} \/>/);
  // The summary, Share and the changes notice are TG-23's page shell: they stay in both views
  const map = list.indexOf("<OverworldMap");
  assert.ok(list.indexOf("<ShareButton") >= 0 && list.indexOf("<ShareButton") < map, "summary and Share above the map");
  assert.ok(list.indexOf("Some of this plan has changed") < map, "the changes notice above the map");
  assert.match(list, /<BusSection\b/, "the list sections stay as the fallback");
  assert.match(list, /Tap a stop or a ride for details\./, "ux 2.5 intro above the world");
});

// ---- RED audit gaps A to C (tg-test3's prototypes) ----

test("motion classes are motion-safe: prefixed (test-plan S4)", () => {
  for (const src of both()) {
    for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
      for (const tok of (m[1] ?? m[2]).split(/\s+/)) {
        if (/(^|:)(animate-|transition|duration-)/.test(tok)) assert.match(tok, /^motion-safe:/, tok);
      }
    }
  }
});

test("the bus sheet is TG-23's TripCard (ux 3.2: Checked, confirm note, Book)", () => {
  const sheet = component(SHEET);
  assert.match(sheet, /^import TripCard from "@\/components\/TripCard";$/m);
  assert.match(sheet, /<TripCard\b[^>]*\btrip=\{/);
});

test("the kill switch reaches the map: flag -> prop -> conditional", () => {
  const view = read("src/components/ItineraryView.tsx");
  const list = read("src/components/ItineraryList.tsx");
  const prop = view.match(/<ItineraryList\b[^>]*\b(\w+)=\{flags\.overworldMap\}/)?.[1];
  assert.ok(prop, "ItineraryView passes flags.overworldMap as a prop");
  assert.match(list, new RegExp(`export default function ItineraryList\\(\\{[^)]*\\b${prop}\\b`), "the list takes it");
  assert.match(list, new RegExp(`\\{\\s*${prop}\\s*\\?[\\s\\S]{0,200}?<OverworldMap itinerary=\\{it\\} \\/>`), "and renders the map only when it's true");
});

// UX review finding 1 (ux 3.2, the CLAUDE.md trust pair): TripCard has no confirm_note (search shows it once per
// list), so the bus sheet adds it under the card, next to TripCard's Checked line
test("the bus sheet shows the trip's confirm note under TripCard", () => {
  const sheet = component(SHEET);
  const bus = sheet.slice(sheet.indexOf('data?.kind === "bus"'), sheet.indexOf('data?.kind === "terminal"'));
  assert.match(bus, /<TripCard\b[^>]*\/>\s*<\/ul>\s*<p className="text-xs text-muted">\{t\.confirm_note\}<\/p>/);
});
