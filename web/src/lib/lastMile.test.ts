// Last-mile helper tests (TG-17). Run with `npm test`. Leg data below is made up for tests only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BAGUIO_TERMINALS,
  formatFare,
  formatMinutes,
  groupByDestination,
  modeLabel,
  type LastMileLeg,
  type Place,
} from "./lastMile.ts";
import { formatVerified } from "./api.ts";

const VL: Place = { kind: "terminal", id: "t-1", slug: "vl-baguio", name: "Victory Liner Baguio", lat: null, lng: null };

function place(kind: Place["kind"], slug: string, name: string): Place {
  return { kind, id: `${kind}-${slug}`, slug, name, lat: null, lng: null };
}

function leg(id: string, destination: Place, mode = "jeep"): LastMileLeg {
  return {
    last_mile_route_id: id,
    origin: VL,
    destination,
    mode,
    signboard: null,
    boarding_point: null,
    alighting_point: null,
    fare_min_php: null,
    fare_max_php: null,
    minutes: null,
    notes: null,
    source: "manual",
    last_verified_at: "2026-10-24T04:00:00Z",
    confirm_note: "Fares and routes change. Confirm with the driver or a local before you ride.",
  };
}

// [destination key, leg ids] per group, for compact assertions
function summary(groups: { destination: Place; legs: LastMileLeg[] }[], key: (p: Place) => string) {
  return groups.map((g) => [key(g.destination), g.legs.map((l) => l.last_mile_route_id)]);
}

test("formatFare cases", () => {
  const cases: [number | null, number | null, string][] = [
    [13, 15, "₱13–15"], // en dash
    [13, 13, "₱13"],
    [120, 120, "₱120"],
    [100, 150, "₱100–150"],
    [12.5, 12.5, "₱12.50"],
    [12.5, 15, "₱12.50–15"],
    [1000, 1200, "₱1,000–1,200"],
    [13, null, "₱13+"],
    [null, 15, "up to ₱15"],
    [null, null, ""], // a walk leg never shows ₱0
  ];
  for (const [min, max, expected] of cases) {
    assert.equal(formatFare(min, max), expected, `formatFare(${min}, ${max})`);
  }
});

test("formatMinutes cases", () => {
  const cases: [number | null, string][] = [
    [15, "15 min"],
    [75, "1 h 15 min"],
    [60, "1 h"],
    [null, ""],
    [0, ""],
  ];
  for (const [minutes, expected] of cases) {
    assert.equal(formatMinutes(minutes), expected, `formatMinutes(${minutes})`);
  }
});

test("modeLabel names every schema mode and capitalises unknown ones", () => {
  const labels: Record<string, string> = {
    jeep: "Jeepney",
    taxi: "Taxi",
    walk: "Walk",
    tricycle: "Tricycle",
    van: "Van",
    grab: "Grab",
  };
  for (const [mode, label] of Object.entries(labels)) {
    assert.equal(modeLabel(mode), label, mode);
  }
  assert.equal(modeLabel("monorail"), "Monorail");
});

test("groupByDestination keeps the API's first-seen order", () => {
  const market = place("spot", "test-market", "Test Market (made up)");
  const park = place("spot", "test-park", "Test Park (made up)");
  // API order: destination name, then minutes; the helper must not re-sort
  const legs = [leg("a", market, "taxi"), leg("b", market, "walk"), leg("c", park)];
  const before = JSON.stringify(legs);

  const groups = groupByDestination(legs);

  assert.deepEqual(summary(groups, (p) => p.slug), [["test-market", ["a", "b"]], ["test-park", ["c"]]]);
  assert.equal(groups[0].destination, market);
  assert.equal(JSON.stringify(legs), before, "input not mutated");
  assert.deepEqual(groupByDestination([]), []);
});

test("groupByDestination keys on kind and slug", () => {
  const spot = place("spot", "same", "Same spot (made up)");
  const terminal = place("terminal", "same", "Same terminal (made up)");
  const groups = groupByDestination([leg("a", spot), leg("b", terminal), leg("c", spot)]);
  assert.deepEqual(summary(groups, (p) => p.kind), [["spot", ["a", "c"]], ["terminal", ["b"]]]);
});

test("BAGUIO_TERMINALS lists the three seeded terminals", () => {
  assert.deepEqual(BAGUIO_TERMINALS, [
    { slug: "vl-baguio", label: "Victory Liner" },
    { slug: "gen-baguio", label: "Genesis / Joy Bus" },
    { slug: "sn-baguio", label: "Solid North" },
  ]);
});

test("formatVerified shows the Manila date whatever the device time zone", () => {
  // Characterisation: formatVerified already formats in Asia/Manila.
  const original = process.env.TZ;
  try {
    for (const tz of ["America/Los_Angeles", "Pacific/Kiritimati", "Asia/Manila"]) {
      process.env.TZ = tz;
      assert.equal(formatVerified("2026-10-24T04:00:00Z"), "Checked Oct 24", tz);
      assert.equal(formatVerified("2026-10-24T15:30:00Z"), "Checked Oct 24", `${tz} 23:30 Manila`);
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
  assert.equal(formatVerified(null), "Not yet verified");
});

test("lastMile.ts is a plain module", () => {
  const source = readFileSync(new URL("./lastMile.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^\s*import\b/m);
  assert.doesNotMatch(source, /\bimport\s*\(/);
  assert.doesNotMatch(source, /use client/);
  assert.doesNotMatch(source, /\benum\s/);
  assert.doesNotMatch(source, /\bnamespace\s/);
});
