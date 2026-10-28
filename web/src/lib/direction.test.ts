// Search direction tests (TG-31). Run with `npm test` (node --test, Node 22.18+ type stripping).
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_DIRECTION,
  emptyMessage,
  endpoints,
  formatTravelDate,
  initialSearchState,
  resultsHeading,
  routeLabel,
  searchReducer,
  swapDirection,
  swapLabel,
  type Direction,
  type SearchAction,
  type SearchState,
} from "./direction.ts";

const BOTH: Direction[] = ["to-baguio", "from-baguio"];

// Stand-in for API trips: each one remembers which query it answered, so the tests can check that shown
// results always belong to the direction and date in the heading.
type FakeTrip = { direction: Direction; date: string };
type State = SearchState<FakeTrip>;

function reduce(state: State, ...actions: SearchAction<FakeTrip>[]): State {
  return actions.reduce((s, a) => searchReducer(s, a), state);
}

/** Start a search for the state's direction on `date`; returns the new state and the trips the API would send. */
function start(state: State, date: string): { state: State; requestId: number; trips: FakeTrip[] } {
  const next = searchReducer(state, { type: "searchStarted", date });
  return { state: next, requestId: next.requestId, trips: [{ direction: next.direction, date }] };
}

function assertConsistent(s: State, step: string) {
  // Whenever results are shown, they answer the query in the heading, and that query is the form's direction
  if (s.status === "done") {
    assert.ok(s.searched, `${step}: done without a searched query`);
    assert.equal(s.searched.direction, s.direction, `${step}: heading direction differs from the form`);
    for (const t of s.trips) {
      assert.deepEqual(t, s.searched, `${step}: a shown trip answers another query`);
    }
  } else {
    assert.deepEqual(s.trips, [], `${step}: trips kept while ${s.status}`);
  }
  if (s.status === "idle") assert.equal(s.searched, null, `${step}: idle but still has a heading`);
}

const originalTZ = process.env.TZ;

afterEach(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

// T31-1 (B1, B2)
test("swap toggles and is its own inverse", () => {
  assert.equal(DEFAULT_DIRECTION, "to-baguio");
  assert.equal(swapDirection("to-baguio"), "from-baguio");
  assert.equal(swapDirection("from-baguio"), "to-baguio");
  for (const d of BOTH) assert.equal(swapDirection(swapDirection(d)), d);
});

// T31-2 (B1, B2, B8)
test("endpoints map each direction to the API params", () => {
  assert.deepEqual(endpoints("to-baguio"), { originCity: "Metro Manila", destinationCity: "Baguio" });
  assert.deepEqual(endpoints("from-baguio"), { originCity: "Baguio", destinationCity: "Metro Manila" });
  const first = endpoints("to-baguio");
  first.originCity = "Changed";
  assert.equal(endpoints("to-baguio").originCity, "Metro Manila", "endpoints must return a fresh object");
});

// T31-3 (B5, B6, B8)
test("labels follow the direction", () => {
  assert.equal(routeLabel("to-baguio"), "Metro Manila → Baguio");
  assert.equal(routeLabel("from-baguio"), "Baguio → Metro Manila");
  // Says what tapping will do, in words a screen reader reads well (no arrow)
  assert.equal(swapLabel("to-baguio"), "Swap direction, search Baguio to Metro Manila instead");
  assert.equal(swapLabel("from-baguio"), "Swap direction, search Metro Manila to Baguio instead");
});

// T31-4 (B5)
test("results heading shows direction and date", () => {
  assert.equal(resultsHeading("from-baguio", "2026-11-08"), "Baguio → Metro Manila · Sun, Nov 8");
  assert.equal(resultsHeading("to-baguio", "2026-11-06"), "Metro Manila → Baguio · Fri, Nov 6");
});

// T31-4 (B5, review nit 7)
test("empty message names the direction and date", () => {
  assert.equal(emptyMessage("from-baguio", "2026-11-08"), "No trips on file from Baguio to Metro Manila on Sun, Nov 8 yet.");
  assert.equal(emptyMessage("to-baguio", "2026-11-06"), "No trips on file from Metro Manila to Baguio on Fri, Nov 6 yet.");
});

// T31-5 (B8)
test("travel date formats", () => {
  assert.equal(formatTravelDate("2026-11-08"), "Sun, Nov 8");
  assert.equal(formatTravelDate("2026-11-06"), "Fri, Nov 6");
  assert.equal(formatTravelDate("2026-10-31"), "Sat, Oct 31");
  assert.equal(formatTravelDate("2026-12-31"), "Thu, Dec 31");
  assert.equal(formatTravelDate(""), "");
});

test("travel date format is timezone-proof", () => {
  // new Date("2026-11-08") read back in local time would say Sat, Nov 7 in Los Angeles
  for (const tz of ["America/Los_Angeles", "Pacific/Kiritimati", "Asia/Manila"]) {
    process.env.TZ = tz;
    assert.equal(formatTravelDate("2026-11-08"), "Sun, Nov 8", tz);
  }
});

// T31-6 (B3)
test("swap keeps the picked date", () => {
  const picked = reduce(initialSearchState<FakeTrip>(), { type: "pickDate", date: "2026-11-08" });
  const swapped = searchReducer(picked, { type: "swap" });
  assert.equal(swapped.direction, "from-baguio");
  assert.equal(swapped.date, "2026-11-08");
  // Before today is known the date is empty, and swapping leaves it empty
  const early = searchReducer(initialSearchState<FakeTrip>(), { type: "swap" });
  assert.equal(early.direction, "from-baguio");
  assert.equal(early.date, "");
});

test("initial state is idle, default direction, no date", () => {
  const s = initialSearchState<FakeTrip>();
  assert.deepEqual(s, { direction: "to-baguio", date: "", status: "idle", trips: [], searched: null, requestId: 0 });
});

// T31-7 (B4, B5)
test("swap clears shown results, and results always match the heading", () => {
  let s = initialSearchState<FakeTrip>();
  const steps: [string, (s: State) => State][] = [
    ["pick Nov 6", (s) => searchReducer(s, { type: "pickDate", date: "2026-11-06" })],
    ["search", (s) => {
      const r = start(s, "2026-11-06");
      assert.equal(r.state.status, "loading");
      return searchReducer(r.state, { type: "searchDone", requestId: r.requestId, trips: r.trips });
    }],
    ["swap", (s) => searchReducer(s, { type: "swap" })],
    ["search again", (s) => {
      const r = start(s, "2026-11-06");
      return searchReducer(r.state, { type: "searchDone", requestId: r.requestId, trips: r.trips });
    }],
    ["pick Nov 8", (s) => searchReducer(s, { type: "pickDate", date: "2026-11-08" })],
    ["swap back", (s) => searchReducer(s, { type: "swap" })],
  ];
  const seen: string[] = [];
  for (const [name, step] of steps) {
    s = step(s);
    assertConsistent(s, name);
    seen.push(`${name}: ${s.status} ${s.direction}`);
  }
  assert.deepEqual(seen, [
    "pick Nov 6: idle to-baguio",
    "search: done to-baguio",
    "swap: idle from-baguio",
    "search again: done from-baguio",
    "pick Nov 8: done from-baguio",
    "swap back: idle to-baguio",
  ]);
});

test("a search with no trips is done and keeps its heading", () => {
  const r = start(initialSearchState<FakeTrip>(), "2026-11-08");
  const s = searchReducer(r.state, { type: "searchDone", requestId: r.requestId, trips: [] });
  assert.equal(s.status, "done");
  assert.deepEqual(s.searched, { direction: "to-baguio", date: "2026-11-08" });
  assert.deepEqual(s.trips, []);
});

test("searching without a date does nothing", () => {
  const s = initialSearchState<FakeTrip>();
  assert.equal(searchReducer(s, { type: "searchStarted", date: "" }), s);
});

// T31-8 (B4)
test("late response for the old direction is ignored", () => {
  const r = start(initialSearchState<FakeTrip>(), "2026-11-06");
  const swapped = searchReducer(r.state, { type: "swap" });
  const late = searchReducer(swapped, { type: "searchDone", requestId: r.requestId, trips: r.trips });
  assert.equal(late, swapped, "a stale response must leave the state unchanged");
  assert.equal(late.direction, "from-baguio");
  assert.equal(late.status, "idle");
  assertConsistent(late, "late response");
});

test("late failure for the old direction is ignored", () => {
  const r = start(initialSearchState<FakeTrip>(), "2026-11-06");
  const swapped = searchReducer(r.state, { type: "swap" });
  assert.equal(searchReducer(swapped, { type: "searchFailed", requestId: r.requestId }), swapped);
});

test("only the latest of two searches is shown", () => {
  const first = start(initialSearchState<FakeTrip>(), "2026-11-06");
  const second = start(searchReducer(first.state, { type: "pickDate", date: "2026-11-07" }), "2026-11-07");
  assert.notEqual(first.requestId, second.requestId);
  const done = searchReducer(second.state, { type: "searchDone", requestId: second.requestId, trips: second.trips });
  assert.equal(searchReducer(done, { type: "searchDone", requestId: first.requestId, trips: first.trips }), done);
  assert.deepEqual(done.searched, { direction: "to-baguio", date: "2026-11-07" });
});

test("a current failure shows the error and no results", () => {
  const r = start(initialSearchState<FakeTrip>(), "2026-11-06");
  const s = searchReducer(r.state, { type: "searchFailed", requestId: r.requestId });
  assert.equal(s.status, "error");
  assert.deepEqual(s.trips, []);
  assertConsistent(s, "failure");
});

// T31-9 (B5)
test("heading keeps the date that was searched", () => {
  const r = start(reduce(initialSearchState<FakeTrip>(), { type: "swap" }), "2026-11-08");
  const done = searchReducer(r.state, { type: "searchDone", requestId: r.requestId, trips: r.trips });
  const repicked = searchReducer(done, { type: "pickDate", date: "2026-11-09" });
  assert.equal(repicked.date, "2026-11-09");
  assert.deepEqual(repicked.searched, { direction: "from-baguio", date: "2026-11-08" });
  assert.ok(repicked.searched);
  assert.equal(resultsHeading(repicked.searched.direction, repicked.searched.date), "Baguio → Metro Manila · Sun, Nov 8");
  assertConsistent(repicked, "re-picked date");
});

// T31-11
test("direction.ts is a plain module", () => {
  const source = readFileSync(new URL("./direction.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^\s*import\b/m);
  assert.doesNotMatch(source, /\bimport\s*\(/);
  assert.doesNotMatch(source, /@\//);
  assert.doesNotMatch(source, /use client/);
  assert.doesNotMatch(source, /\benum\s/);
  assert.doesNotMatch(source, /\bnamespace\s/);
  assert.doesNotMatch(source, /<\/[A-Za-z]|\/>/, "no JSX"); // closing or self-closing tags; generics like <T> are fine
});
