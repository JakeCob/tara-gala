// TG-52: the trip as a game level map, one world per day. Run with `npm test` (node --test, type stripping).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Guide, GuideRow, Mark } from "./guide.ts";
import { marksByKey } from "./guide.ts";
import { COLUMNS, GAP_PX, GOAL_POINT, PAD_PX, levelPoints, levels, placeMapsUrl, roadPath, startPoint, startWorld, worldHeight } from "./levelMap.ts";

const row = (key: string, extra: Partial<GuideRow> = {}): GuideRow => ({
  key, time: "09:00", plan: key, note: "", place: { kind: "spot", id: key, name: key, category: "park", lodging: false },
  bus: null, show_if: null, hide_if: null, ...extra,
});
const mark = (key: string, value = "done", at = "2026-11-06T01:00:00Z"): Mark => ({ key, value, updated_at: at });
const bus = { title: "", intro: "", buses: [], tips: [] };
const guide: Guide = {
  title: "T", summary: "", lodging: null, getting_there: bus, getting_home: bus, budget: { summary: "", rows: [], excluded: "" }, todo: [], sources: [],
  days: [
    { day: 1, title: "D1", intro: "", pick: null, tips: [], rows: [row("d1-01"), row("d1-02")] },
    { day: 2, title: "D2", intro: "", tips: [], pick: { key: "sunrise", title: "S", options: [] },
      rows: [row("d2-01", { show_if: { pick: "sunrise", is: "A" } }), row("d2-02"), row("d2-03")] },
  ],
};

test("LM1 a day's levels are its rows as they show for the pick, numbered world-level", () => {
  const before = levels(guide.days[1], marksByKey([]));
  assert.deepEqual(before.map((l) => l.label), ["2-1", "2-2", "2-3"]);
  const picked = levels(guide.days[1], marksByKey([mark("pick:sunrise", "B"), mark("row:d2-02")]));
  assert.deepEqual(picked.map((l) => [l.label, l.row.key, l.done]), [["2-1", "d2-02", true], ["2-2", "d2-03", false]]);
});

test("LM2 levels climb the screen from START to GOAL, zig-zagging between two columns", () => {
  const pts = levelPoints(4);
  assert.equal(worldHeight(4), PAD_PX * 2 + 3 * GAP_PX);
  assert.deepEqual(pts.map((p) => p.x), [COLUMNS[0], COLUMNS[1], COLUMNS[0], COLUMNS[1]]);
  assert.ok(pts.every((p, i) => i === 0 || p.y === pts[i - 1].y - GAP_PX), "each level one gap above the last");
  assert.ok(startPoint(4).y > pts[0].y && GOAL_POINT.y < pts[3].y, "START below the first, GOAL above the last");
  assert.ok(pts[3].y - GAP_PX / 2 > GOAL_POINT.y);
});

test("LM3 the road is one path through START, every level and GOAL", () => {
  const pts = levelPoints(3);
  const d = roadPath(pts, startPoint(3), GOAL_POINT);
  assert.match(d, /^M 50 \d+/);
  assert.equal(d.match(/ C /g)?.length, 4, "three levels: four curves");
  assert.ok(d.endsWith(`${GOAL_POINT.x} ${GOAL_POINT.y}`));
});

test("LM4 the map opens on the group's world, else the first world not finished", () => {
  assert.equal(startWorld(guide, []), 1);
  assert.equal(startWorld(guide, [mark("row:d1-01"), mark("row:d1-02")]), 1, "day 1 all done: the group still stands on its last level");
  const noPlaces: Guide = { ...guide, days: guide.days.map((d) => ({ ...d, rows: d.rows.map((r) => ({ ...r, place: null })) })) };
  assert.equal(startWorld(noPlaces, [mark("row:d1-01"), mark("row:d1-02")]), 2, "no group on the map: the first world not finished");
  assert.equal(startWorld(guide, [mark("row:d2-03", "done", "2026-11-07T01:00:00Z"), mark("row:d1-01", "done", "2026-11-06T01:00:00Z")]), 2, "where the group is");
});

test("LM5 a level's place opens in Google Maps by name", () => {
  assert.equal(placeMapsUrl("BenCab Museum"), "https://www.google.com/maps/search/?api=1&query=BenCab%20Museum%2C%20Benguet%2C%20Philippines");
});
