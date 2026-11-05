// TG-52: the trip as a game level map, one world per day. Run with `npm test` (node --test, type stripping).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Guide, GuideRow, Mark } from "./guide.ts";
import { marksByKey, placeIcon, whereNow } from "./guide.ts";
import { BAND_PX, COLUMNS, GAP_PX, PAD_PX, SIGN_DROP, SIGN_GAP, SIGN_ROOM, SNAKE_MIN_PX, START_POINT, TILE_PX, TOP_PX, UNIT, goalPoint, levelPoints, levelScenery, levels, nextLevel, pixelRoad, placeMapsUrl, roadBand, roadStops, runsPath, snakeMap, snakeRoad, snakeScenery, startWorld, worldHeight } from "./levelMap.ts";

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

test("LM2 levels run down the screen from START to GOAL, zig-zagging between two columns", () => {
  const pts = levelPoints(4);
  assert.equal(worldHeight(4), TOP_PX + PAD_PX + 3 * GAP_PX);
  assert.deepEqual(pts.map((p) => p.x), [COLUMNS[0], COLUMNS[1], COLUMNS[0], COLUMNS[1]]);
  assert.ok(pts.every((p, i) => i === 0 || p.y === pts[i - 1].y + GAP_PX), "each level one gap below the last");
  assert.ok(START_POINT.y < pts[0].y && goalPoint(4).y > pts[3].y, "START above the first, GOAL below the last");
  assert.ok(pts[3].y + GAP_PX / 2 < goalPoint(4).y);
  assert.ok(START_POINT.y - 16 + 64 <= pts[0].y - 41, "the group at START, 64px tall, clears an 82px sign on level 1");
  assert.deepEqual([GAP_PX, TOP_PX, PAD_PX], [120, 160, 132], "room for three lines of sign, and for START under the world's bar");
});

test("LM3 the road is 3px cells on the screen's real width, through START, every level and GOAL", () => {
  const pts = levelPoints(7);
  const H = worldHeight(7);
  for (const W of [282, 342, 442, 1000, 1441]) {
    const stops = roadStops(pts, START_POINT, goalPoint(7), W);
    const road = pixelRoad(stops, W, H);
    assert.deepEqual(road, pixelRoad(stops, W, H), "deterministic");
    for (const run of [...road.curb, ...road.asphalt, ...road.dash]) {
      assert.ok(run.x % UNIT === 0 && run.y % UNIT === 0 && run.w % UNIT === 0, `on the grid: ${JSON.stringify(run)}`);
      assert.ok(run.x >= 0 && run.y >= 0 && run.x + run.w <= W && run.y + UNIT <= H, `in bounds: ${JSON.stringify(run)}`);
    }
    for (const stop of stops) {
      const hit = road.asphalt.some((r) => stop.x >= r.x - UNIT && stop.x <= r.x + r.w + UNIT && Math.abs(stop.y - r.y) <= UNIT);
      assert.ok(hit, `the road reaches ${JSON.stringify(stop)}`);
    }
    assert.ok(road.curb.length >= road.asphalt.length / 2 && road.dash.length > 0, "three layers");
    assert.ok(runsPath(road.asphalt).length < 20_000, "a small path");
  }
  assert.equal(runsPath([{ x: 3, y: 6, w: 9 }]), "M3 6h9v3h-9z");
});

test("LM3b on a wide row the road stays in a centred band; on a phone the band is the whole screen", () => {
  assert.deepEqual(roadBand(342), { left: 0, width: 342 });
  assert.deepEqual(roadBand(BAND_PX), { left: 0, width: BAND_PX });
  assert.deepEqual(roadBand(1000), { left: 180, width: BAND_PX });
  const stops = roadStops(levelPoints(4), START_POINT, goalPoint(4), 1000);
  assert.ok(stops.every((s) => s.x >= 180 && s.x <= 820), "no stop outside the band");
  assert.equal(stops[0].x, 500, "START in the middle of the row");
  assert.equal(BAND_PX, 640);
});

// TG-56: 954 is the lg row, 1082 the xl one; the rest prove the sums hold at any width
const SNAKE_W = [SNAKE_MIN_PX, 954, 1082, 1228, 1441];
const COUNTS = [1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 16];
type Box = { l: number; t: number; r: number; b: number };
const touching = (a: Box, b: Box) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
const tileBox = (p: { x: number; y: number }): Box => ({ l: p.x - TILE_PX / 2, t: p.y - TILE_PX / 2, r: p.x + TILE_PX / 2, b: p.y + TILE_PX / 2 });
const signBox = (p: { x: number; y: number }, sign: number): Box => ({ l: p.x + TILE_PX / 2 + SIGN_GAP, t: p.y + SIGN_DROP, r: p.x + TILE_PX / 2 + SIGN_GAP + sign, b: p.y + SIGN_DROP + SIGN_ROOM });
const runBoxes = (runs: readonly { x: number; y: number; w: number }[]): Box[] => runs.map((r) => ({ l: r.x, t: r.y, r: r.x + r.w, b: r.y + UNIT }));

test("TG56-1 only lg and up get the snake: below it the row is 714 at most", () => {
  assert.equal(SNAKE_MIN_PX, 900);
  assert.ok(714 < SNAKE_MIN_PX && SNAKE_MIN_PX <= 954, "md's row stays the zig-zag, lg's is the snake");
  assert.equal(snakeMap(7, 954).columns, 3);
  assert.equal(snakeMap(7, 1082).columns, 3);
  assert.equal(snakeMap(7, 1228).columns, 4, "4 once a sign can still hold its text");
  assert.equal(snakeMap(7, 3000).columns, 4, "never more");
});

test("TG56-2 tiles run in order along rows that alternate, with GOAL after the last", () => {
  for (const W of SNAKE_W) {
    for (const count of COUNTS) {
      const m = snakeMap(count, W);
      const stops = [...m.points, m.goal];
      assert.equal(m.points.length, count);
      assert.equal(m.rows, Math.ceil((count + 1) / m.columns), "GOAL takes a slot");
      const rows = [...new Set(stops.map((p) => p.y))];
      assert.equal(rows.length, m.rows);
      rows.forEach((y, r) => {
        const xs = stops.filter((p) => p.y === y).map((p) => p.x);
        assert.ok(xs.length <= m.columns);
        if (r < m.rows - 1) assert.equal(xs.length, m.columns, "only the last row is short");
        xs.slice(1).forEach((x, i) => assert.ok(r % 2 === 0 ? x > xs[i] : x < xs[i], `row ${r} runs ${r % 2 ? "right to left" : "left to right"} at ${W}: ${xs}`));
      });
      stops.forEach((p, i) => { if (i) assert.ok(p.y >= stops[i - 1].y, "never back up the screen"); });
      assert.ok(m.start.x < stops[0].x + TILE_PX && m.start.y < stops[0].y, "START top-left, before level 1");
    }
  }
  const first = snakeMap(7, 1082).points[0];
  assert.ok(first.y - TILE_PX / 2 - 48 >= snakeMap(7, 1082).start.y + 13, "the group on level 1 clears START's sign");
  assert.deepEqual(snakeMap(5, 1082).points.map((p) => p.y), [162, 162, 162, 304, 304], "3, then 2 and GOAL");
});

test("TG56-3 no tile, sign or GOAL touches another, a sign never touches the road, and it all stays within W", () => {
  for (const W of SNAKE_W) {
    for (const count of COUNTS) {
      const m = snakeMap(count, W);
      const road = snakeRoad(m, W);
      const paved = [...runBoxes(road.curb), ...runBoxes(road.asphalt)];
      const boxes = [...m.points.flatMap((p) => [tileBox(p), signBox(p, m.sign)]), tileBox(m.goal)];
      boxes.forEach((a, i) => {
        assert.ok(a.l >= 0 && a.r <= W && a.t >= 0 && a.b <= m.height, `in the world at ${W}: ${JSON.stringify(a)}`);
        boxes.slice(i + 1).forEach((b) => assert.ok(!touching(a, b), `apart at ${W}, ${count}: ${JSON.stringify([a, b])}`));
      });
      for (const p of m.points) {
        const sign = signBox(p, m.sign);
        assert.ok(!paved.some((r) => touching(r, sign)), `the road clears the sign at ${W}, ${count}: ${JSON.stringify(sign)}`);
      }
    }
  }
});

test("TG56-4 the snake is the same pixel road: on the grid, crisp, three layers, through every stop", () => {
  for (const W of SNAKE_W) {
    for (const count of [2, 7, 10, 13]) {
      const m = snakeMap(count, W);
      const road = snakeRoad(m, W);
      assert.deepEqual(road, snakeRoad(m, W), "deterministic");
      for (const run of [...road.curb, ...road.asphalt, ...road.dash]) {
        assert.ok(run.x % UNIT === 0 && run.y % UNIT === 0 && run.w % UNIT === 0, `on the grid: ${JSON.stringify(run)}`);
        assert.ok(run.x >= 0 && run.y >= 0 && run.x + run.w <= W && run.y + UNIT <= m.height, `in bounds: ${JSON.stringify(run)}`);
      }
      for (const stop of [m.start, ...m.points, m.goal]) {
        assert.ok(road.asphalt.some((r) => stop.x >= r.x - UNIT && stop.x <= r.x + r.w + UNIT && Math.abs(stop.y - r.y) <= UNIT), `the road reaches ${JSON.stringify(stop)}`);
      }
      assert.ok(road.dash.length > 0 && road.curb.length >= road.asphalt.length / 2, "three layers");
      assert.ok(runsPath(road.asphalt).length < 40_000, "a small path");
    }
  }
});

test("TG56-5 a row's end turns on rounded corners, in the side margin, on alternating sides", () => {
  const W = 1082;
  const m = snakeMap(10, W);
  const asphalt = snakeRoad(m, W).asphalt;
  const widest = (y: number) => asphalt.filter((r) => r.y === y - (y % UNIT)).reduce((a, r) => ({ l: Math.min(a.l, r.x), r: Math.max(a.r, r.x + r.w) }), { l: W, r: 0 });
  const [y0, y1, y2] = [162, 304, 446];
  assert.ok(widest((y0 + y1) / 2).l > W / 2 && widest((y0 + y1) / 2).r > W - 54, "row 1 turns on the right");
  assert.ok(widest((y1 + y2) / 2).r < W / 2 && widest((y1 + y2) / 2).l < 54, "row 2 turns on the left");
  const steps = [y0 + 3, y0 + 9, y0 + 15, y0 + 21].map((y) => widest(y).r);
  assert.ok(steps.every((x, i) => i === 0 || x >= steps[i - 1]) && steps[0] < steps[3], `the corner curves, it isn't square: ${steps}`);
});

test("TG56-6 a day fits about one desktop screen", () => {
  for (const W of [954, 1082]) {
    assert.ok(snakeMap(10, W).height <= 720, "World 3's 10 levels");
    assert.ok(snakeMap(7, W).height < snakeMap(10, W).height);
    assert.ok(snakeMap(10, W).height < worldHeight(10) * 0.6, "far shorter than the zig-zag");
  }
});

test("TG56-7 snake scenery is seeded, in the world, and clear of the road, tiles, signs, START and GOAL", () => {
  const FIXED = new Set(["tile-pine", "tile-mountain", "deco-sampaguita", "deco-rice-terraces", "deco-bahay-kubo", "deco-carabao"]);
  for (const W of SNAKE_W) {
    for (const count of [2, 7, 9, 10, 11, 13]) {
      const m = snakeMap(count, W);
      const road = snakeRoad(m, W);
      const paved = [...runBoxes(road.curb), ...runBoxes(road.asphalt)];
      const taken = [...m.points.flatMap((p) => [tileBox(p), signBox(p, m.sign)]), tileBox(m.goal), { l: 0, t: 0, r: W, b: 52 }, { l: 0, t: 52, r: 216, b: 116 }];
      assert.deepEqual(snakeScenery(m, W, 7), snakeScenery(m, W, 7), "deterministic");
      assert.notDeepEqual(snakeScenery(m, W, 7), snakeScenery(m, W, 8), "the seed changes it");
      for (let seed = 0; seed < 24; seed++) {
        const items = snakeScenery(m, W, seed);
        assert.ok(items.length >= Math.min(count, 4), `some scenery at ${W}, ${count}`);
        assert.ok(items.filter((d) => d.name === "deco-carabao").length === 2, "a carabao at each end");
        for (const d of items) {
          const box = { l: d.x, t: d.y, r: d.x + d.w, b: d.y + d.h };
          assert.ok(FIXED.has(d.name), d.name);
          assert.ok(d.x >= 3 && box.r <= W - 3 && d.y >= 0 && box.b <= m.height, `in the world at ${W}: ${JSON.stringify(d)}`);
          assert.ok(!taken.some((t) => touching(t, box)), `clear at ${W}, ${count}, seed ${seed}: ${JSON.stringify(d)}`);
          assert.ok(!paved.some((r) => touching(r, box)), `off the road at ${W}, ${count}, seed ${seed}: ${JSON.stringify(d)}`);
        }
      }
    }
  }
});

test("TG56-8 the map picks the snake by its measured width, and phones keep the zig-zag", () => {
  const map = readFileSync("src/components/LevelMap.tsx", "utf8");
  assert.match(map, /const snake = W >= SNAKE_MIN_PX \? snakeMap\(list\.length, W\) : null;/);
  assert.match(map, /const points = snake\?\.points \?\? levelPoints\(list\.length\);/, "levelPoints still drives a phone");
  assert.match(map, /const height = snake\?\.height \?\? worldHeight\(list\.length\);/);
  assert.match(map, /useLayoutEffect\(/, "measured before paint, so a desktop never flashes the phone map");
  assert.match(map, /map \? snakeRoad\(map, W\) : pixelRoad\(roadStops\(levelPoints\(count\), START_POINT, goalPoint\(count\), W\), W, H\)/);
  assert.match(map, /map \? snakeScenery\(map, W, seed\) : levelScenery\(levelPoints\(count\), W, seed\)/);
  assert.match(map, /min-w-0 max-w-88 flex-1 pixel-frame/, "the sign's cap holds on both");
  assert.match(map, /useMemo\(\(\) => \(W >= SNAKE_MIN_PX \? snakeMap\(count, W\) : null\), \[W, count\]\)/, "the road takes the same switch as the tiles");
  assert.match(map, /width: TILE_PX \+ SIGN_GAP \+ snake\.sign \}/, "a sign is as wide as the sums allow");
  assert.match(map, /style=\{snake \? \{ marginTop: TILE_PX \/ 2 \+ SIGN_DROP \} : undefined\}/, "a sign hangs below the road");
  assert.match(map, /snake \? "items-start" : "-translate-y-1\/2 items-center"/, "a phone's tile stays centred on its spot");
  assert.match(map, /!snake && !left && "flex-row-reverse"/, "and its right-hand rows stay mirrored");
});

test("TG56-9 a plan with a guide: the level map only, as wide as a trip; a premade plan is unchanged", () => {
  const list = readFileSync("src/components/ItineraryList.tsx", "utf8");
  const guided = list.indexOf("it.guide ? (");
  const old = list.indexOf("<OverworldMap");
  assert.equal(list.match(/<OverworldMap /g)?.length, 1, "the old map is drawn once");
  assert.doesNotMatch(list.slice(guided, list.indexOf(") : map ? (")), /OverworldMap|Tap a stop/, "and never in the guide's branch");
  assert.ok(guided > 0 && guided < list.indexOf("<LevelMap guide={it.guide} />") && list.indexOf("<LevelMap guide={it.guide} />") < old, "the guide's branch comes first");
  assert.equal(list.match(/<LevelMap /g)?.length, 1);
  assert.match(list, /it\.guide \? "lg:\[&_button\]:w-auto lg:\[&_button\]:self-start" : undefined/, "Copy link doesn't stretch across the row");
  assert.match(list, /\) : map \? \(\n\s+<>\n\s+<p className="text-sm">Tap a stop or a ride for details\.<\/p>/, "the old map stays for plans without a guide");
  assert.match(list, /<div data-wide="" className="contents">\n\s+<LevelMap guide=\{it\.guide\} \/>\n\s+\{confirmNote && <p className=\{PX\.meta\}>\{confirmNote\}<\/p>\}/, "confirm with the operator stays");
  assert.match(readFileSync("src/app/i/[slug]/page.tsx", "utf8"), /md:max-w-md lg:has-\[\[data-wide\]\]:max-w-none/, "from lg only, and only with a guide");
});

test("TG56-10 a phone's map is main's, cell for cell: spots, road and scenery, pinned to 00ece84", () => {
  const rows = [];
  for (const W of [282, 342, 442, 699, 714]) {
    for (const count of [1, 4, 7, 9, 10]) {
      const pts = levelPoints(count);
      const road = pixelRoad(roadStops(pts, START_POINT, goalPoint(count), W), W, worldHeight(count));
      rows.push([pts, runsPath(road.curb), runsPath(road.asphalt), runsPath(road.dash), levelScenery(pts, W, 7)]);
    }
  }
  assert.equal(createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16), "6776a21fa3fcce84", "a deliberate change to the phone map updates this hash");
});

test("LM4 the map opens on the group's world, else the first world not finished", () => {
  assert.equal(startWorld(guide, []), 1);
  assert.equal(startWorld(guide, [mark("row:d1-01"), mark("row:d1-02")]), 1, "day 1 all done: the group still stands on its last level");
  const noPlaces: Guide = { ...guide, days: guide.days.map((d) => ({ ...d, rows: d.rows.map((r) => ({ ...r, place: null })) })) };
  assert.equal(startWorld(noPlaces, [mark("row:d1-01"), mark("row:d1-02")]), 2, "no group on the map: the first world not finished");
  assert.equal(startWorld(guide, [mark("row:d2-03", "done", "2026-11-07T01:00:00Z"), mark("row:d1-01", "done", "2026-11-06T01:00:00Z")]), 2, "where the group is");
});

test("LM5 a level's place opens in Google Maps by name", () => {
  assert.equal(placeMapsUrl({ name: "BenCab Museum", kind: "spot" }), "https://www.google.com/maps/search/?api=1&query=BenCab%20Museum%2C%20Benguet%2C%20Philippines");
  assert.equal(placeMapsUrl({ name: "Victory Liner Cubao", kind: "terminal" }), "https://www.google.com/maps/search/?api=1&query=Victory%20Liner%20Cubao%2C%20Philippines", "Cubao isn't in Benguet");
});

test("LM6 a level's tag and a world's tab stay on one line", () => {
  const map = readFileSync("src/components/LevelMap.tsx", "utf8");
  assert.match(map, /absolute -bottom-3 left-1\/2 -translate-x-1\/2 whitespace-nowrap", PX\.screenTag/, "the tag is shrink-to-fit, so \"3-10\" would break at the hyphen");
  assert.match(map, /className="min-w-0 flex-1 whitespace-nowrap px-1 text-xs md:px-3 md:text-sm"/, "three tabs fit 320 only with text-xs and px-1");
  assert.doesNotMatch(map, /· \{ls\.filter/, "no dot in the tab");
});

test("LM7 closing a photo leaves its level dialog open", () => {
  // React bubbles a nested dialog's close through the component tree, and the viewer sits inside the level dialog
  assert.match(readFileSync("src/components/LevelMap.tsx", "utf8"), /onClose=\{\(e\) => e\.target === e\.currentTarget && onClose\(\)\}/);
});

test("LM8 the map still opens with the guide's title and summary, as the guide page did", () => {
  const map = readFileSync("src/components/LevelMap.tsx", "utf8");
  assert.match(map, /\{guide\.title\}<\/h2>/);
  assert.match(map, /\{guide\.summary && <p /);
});

test("LM9 the next level is the first not done", () => {
  const byKey = marksByKey([mark("row:d1-01")]);
  assert.equal(nextLevel(levels(guide.days[0], byKey)), "d1-02");
  assert.equal(nextLevel(levels(guide.days[0], marksByKey([mark("row:d1-01"), mark("row:d1-02")]))), null, "all done");
});

test("LM10 scenery is seeded, fits the free column, and never touches a tile", () => {
  const pts = levelPoints(10);
  const H = worldHeight(10);
  const FIXED = new Set(["tile-pine", "tile-mountain", "deco-sampaguita", "deco-rice-terraces", "deco-bahay-kubo", "deco-carabao"]);
  for (const W of [282, 342, 442, 700, 1000, 1441]) {
    const band = roadBand(W);
    assert.deepEqual(levelScenery(pts, W, 7), levelScenery(pts, W, 7), "deterministic");
    assert.notDeepEqual(levelScenery(pts, W, 7), levelScenery(pts, W, 8), "the seed changes it");
    for (let seed = 0; seed < 60; seed++) {
      const items = levelScenery(pts, W, seed);
      assert.ok(items.length >= pts.length, "every level gets some");
      for (const d of items) {
        assert.ok(FIXED.has(d.name), d.name);
        assert.ok(d.x >= 3 && d.x + d.w <= W - 3 && d.y >= 0 && d.y + d.h <= H, `in the world at ${W}: ${JSON.stringify(d)}`);
        for (const p of pts) {
          const tile = { l: band.left + (p.x / 100) * band.width - TILE_PX / 2, t: p.y - TILE_PX / 2 };
          const apart = d.x + d.w <= tile.l - 3 || d.x >= tile.l + TILE_PX + 3 || d.y + d.h <= tile.t || d.y >= tile.t + TILE_PX;
          assert.ok(apart, `clear of the tile at ${W}: ${JSON.stringify(d)} ${JSON.stringify(p)}`);
        }
      }
    }
  }
  assert.ok(!levelScenery(pts, 282, 3).some((d) => d.w === 48 && d.name !== "deco-carabao"), "48px sprites don't fit a 320 phone's column");
  const all = [...Array(60).keys()].flatMap((seed) => levelScenery(pts, 342, seed));
  assert.ok(all.some((d) => d.w === 48), "they do at 380");
  assert.ok(all.filter((d) => d.name === "deco-carabao").length >= 60, "a carabao at the corners");
  const carabaos = (W: number) => levelScenery(pts, W, 3).filter((d) => d.name === "deco-carabao").length;
  assert.deepEqual([carabaos(282), carabaos(342)], [1, 2], "a 320 phone keeps START's corner for the group");
  const pines = levelScenery(pts, 342, 0).filter((d) => d.name === "tile-pine");
  assert.ok(pines.length === 0 || pines.length >= 2, "pines come in clusters");
  assert.doesNotMatch(readFileSync("src/lib/levelMap.ts", "utf8"), /Math\.random|deco-sun-stars/, "seeded; never the emblem");
  const sides = (W: number) => levelScenery(pts, W, 3).filter((d) => d.x + d.w <= roadBand(W).left || d.x >= W - roadBand(W).left);
  assert.equal(sides(342).length, 0, "a phone has no sides to fill");
  const wide = sides(1200);
  assert.ok(wide.length >= 30, "the row's sides are filled");
  assert.ok(wide.some((d) => d.x < 280) && wide.some((d) => d.x > 920), "on both sides");
  for (const a of wide) {
    assert.equal(wide.filter((b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).length, 1, `one per cell: ${JSON.stringify(a)}`);
  }
});

test("LM11 the world is a game screen: a pixel road, grass, framed in Ink in both themes", () => {
  const map = readFileSync("src/components/LevelMap.tsx", "utf8");
  assert.doesNotMatch(map, /preserveAspectRatio|non-scaling-stroke/, "no stretched vector road");
  assert.match(map, /shapeRendering="crispEdges"/);
  assert.match(map, /new ResizeObserver\(/);
  assert.match(map, /usableWidth\(/);
  assert.match(map, /backgroundImage: `url\(\$\{spriteSrc\("tile-grass"\)\}\)`, backgroundSize: "32px"/);
  for (const v of ["--frame", "--focus", "--foreground"]) assert.ok(map.includes(`"${v}": "var(--color-screen-ink)"`), v);
  assert.match(map, /grid grid-cols-3 gap-2 lg:flex lg:flex-wrap/, "the trip menu");
  assert.match(map, /<Sprite name="ui-star" scale=\{1\} \/>Goal<Sprite name="ui-star" scale=\{1\} \/>/, "GOAL");
  assert.match(map, /PX\.pressStart\)\} style=\{\{ left: `\$\{start\.x\}\$\{u\}`, top: start\.y \}\}>\s+Start\s+<\/span>/, "START");
});

test("LM11b at every width the map has the whole row, with the World toggle right on top of it and the menu under it", () => {
  const map = readFileSync("src/components/LevelMap.tsx", "utf8");
  assert.doesNotMatch(map, /lg:grid-cols-\[28rem|lg:col-start|md:max-w-md/, "no side-by-side, no cap on the world");
  assert.doesNotMatch(map, /wide\?: boolean|, wide \}/);
  assert.doesNotMatch(readFileSync("src/components/TripView.tsx", "utf8"), /<LevelMap\n\s+wide\n/);
  const at = (s: string) => map.indexOf(s);
  const order = [at("{day.title}</h3>"), at("{day.pick && ("), at("{day.tips.length > 0 && ("), at('aria-label="Days"'), at("<section ref={screen}"), at('aria-label="Trip menu"')];
  assert.ok(order.every((n, i) => n > 0 && (i === 0 || n > order[i - 1])), `the order: ${order}`);
  assert.equal(map.slice(at("</nav>"), at("<section ref={screen}")).match(/<(PixelBox|ul|h3|p)\b/), null, "nothing between the toggle and the map");
  assert.match(map, /min-w-0 max-w-88 flex-1 pixel-frame/, "a sign stops at 22rem");
  assert.equal(map.match(/style=\{\{ maxWidth: band \}\}/g)?.length, 2, "the stops and the levels share the road's band");
  assert.match(map, /const band = snake \? undefined : BAND_PX;/, "the band is for the zig-zag: the snake has the whole row");
  assert.match(map, /const BAND = "absolute inset-0 mx-auto"/, "the band is centred");
  assert.match(map, /return \(\n\s+<div className="flex flex-col gap-4">\n\s+<header/, "no cap or grid on the whole block");
  assert.match(map, /<div className="w-full">\n\s+<section ref=\{screen\}/, "none on the world");
  assert.match(readFileSync("src/components/TripView.tsx", "utf8"), /<section aria-labelledby="progress-title" className="flex flex-col gap-3">/, "none on the page's section");
  assert.match(map, /const list = levels\(day, byKey\);/, "time order");
  assert.match(map, /const p = points\[i\];/, "level 1 on the first spot, under START");
  assert.match(map, /<PixelBox className="flex flex-col gap-2 p-4 md:max-w-2xl">\n\s+<p className="font-semibold">\{day\.pick\.title\}/, "a Pick button stays near its text");
  assert.match(map, /<section className="flex flex-col gap-2 md:max-w-2xl">\n\s+<h3 className=\{PX\.dataHeading\}>Budget per person/, "a figure stays near its item");
});

test("LM12 one level is one button, with a name from its content; nothing fades", () => {
  const map = readFileSync("src/components/LevelMap.tsx", "utf8");
  assert.doesNotMatch(map, /aria-label=\{`Level \$\{l\.label\}, /);
  assert.match(map, /<span className="sr-only">Level \{l\.label\}, <\/span>/);
  assert.match(map, /sr-only">, done</);
  assert.match(map, /sr-only">, the group is here</);
  assert.doesNotMatch(map.slice(0, map.indexOf("function WorldGround")), /opacity-70|line-clamp/);
  assert.match(map, /bg-flag-yellow/, "the next level");
  assert.match(map, /placeIcon\(l\.row\.place\) \?\? "place-other"/);
  assert.match(map, /chibiLook\(GROUP, "idle-1"\)\} scale=\{2\} className="max-w-none"/, "a shrink-to-fit box would squeeze it to half the tile");
  assert.doesNotMatch(map, /chibi\("adult"/, "TG-48: one cast");
});

test("LM13 the level dialog is themed, and opens with focus on Close", () => {
  const map = readFileSync("src/components/LevelMap.tsx", "utf8");
  assert.match(map, /pixel-box flex flex-col gap-3 bg-card p-4 text-foreground/);
  assert.doesNotMatch(map, /autoFocus/);
  assert.ok(map.indexOf("Close\n") < map.indexOf("Mark done!"), "Close first in the dialog");
  assert.match(map, /tone="alertText"/);
  assert.match(map, /role="alert"/);
  assert.match(map, /e\.target === e\.currentTarget && e\.currentTarget\.close\(\)/, "a backdrop tap closes");
  assert.match(map, /className=\{PX\.inlineLink\} href=\{placeMapsUrl/);
});

test("LM14 a World tab scrolls to the next level; first load doesn't", () => {
  const map = readFileSync("src/components/LevelMap.tsx", "utf8");
  assert.match(map, /scrollIntoView\(\{ block: "center", behavior: /);
  assert.match(map, /prefers-reduced-motion: reduce/);
  assert.match(map, /tabTapped\.current = true/);
});

test("LM15 Mark done and Add photos keep focus while busy, and the dialog says what happened", () => {
  const map = readFileSync("src/components/LevelMap.tsx", "utf8");
  const dialog = map.slice(map.indexOf("function LevelDialog"), map.indexOf("function Buses"));
  assert.equal(dialog.match(/aria-disabled=\{busy\}/g)?.length, 2);
  assert.doesNotMatch(dialog, /<PixelButton[^>]*(?<!aria-)disabled=\{busy\}/, "disabling the focused button drops focus to the body");
  assert.doesNotMatch(dialog, /aria-pressed/, "the label already says it");
  assert.match(dialog, /!busy && onTick\?\.\(/);
  assert.match(dialog, /!busy && picker\.current\?\.click\(\)/);
  assert.match(dialog, /<p role="status" className="text-sm empty:sr-only">\{said\}<\/p>/, "always mounted, or a screen reader misses it");
  assert.match(map, /onClick=\{\(\) => \{ onOpenLevel\?\.\(\); setOpen\(\(o\) => \(\{ key: l\.row\.key, tap: \(o\?\.tap \?\? 0\) \+ 1 \}\)\); \}\}/, "the last write's notice doesn't follow you to another level");
});

test("LM16 the Album loads a page of photos at a time, not all 300 at once", () => {
  const map = readFileSync("src/components/LevelMap.tsx", "utf8");
  const album = map.slice(map.indexOf("function Album"));
  assert.match(map, /const ALBUM_PAGE = 24;/);
  assert.match(album, /all\.slice\(0, shownCount\)\.map\(/);
  assert.match(album, /Show \{Math\.min\(ALBUM_PAGE, all\.length - shownCount\)\} more/);
});

test("TG54-6 a tap on any level before the last dialog's close event still opens it, the same level too", () => {
  // close() shuts the dialog at once, but the close event waits for the next frame. It must clear only its own tap, and
  // every tap needs its own dialog, because showModal runs once on mount.
  const map = readFileSync("src/components/LevelMap.tsx", "utf8");
  assert.match(map, /const \[open, setOpen\] = useState<\{ key: string; tap: number \} \| null>\(null\);/);
  assert.match(map, /setOpen\(\(o\) => \(\{ key: l\.row\.key, tap: \(o\?\.tap \?\? 0\) \+ 1 \}\)\);/);
  assert.match(map, /<LevelDialog key=\{open\.tap\} level=\{current\}/);
  assert.match(map, /onClose=\{\(\) => setOpen\(\(o\) => \(o\?\.tap === open\.tap \? null : o\)\)\}/);
  assert.doesNotMatch(map, /onClose=\{\(\) => setOpen\(null\)\}/);
});

test("TG57-10 a saved start, then fresh marks on a later day: the map follows the group until someone picks a World", () => {
  const saved = [mark("row:d1-01", "done", "2026-11-06T01:00:00Z")];
  const fresh = [...saved, mark("row:d2-02", "done", "2026-11-07T01:00:00Z")];
  assert.equal(startWorld(guide, saved), 1, "the map mounts on the saved copy's World");
  assert.equal(whereNow(guide, fresh)?.day, 2, "the fresh answer puts the group a day on");
  const map = readFileSync("src/components/LevelMap.tsx", "utf8");
  assert.match(map, /const groupDay = here\?\.day;/);
  assert.match(map, /const inDialog = !!current;/, "open stays set when the dialog's row goes away, so it can't hold the map");
  assert.match(map, /if \(groupDay && !tabPicked\.current && !inDialog\) setWorld\(groupDay\);\s+\}, \[groupDay, inDialog\]\);/, "an open dialog keeps its World until it closes");
  const goTo = map.slice(map.indexOf("const goTo ="), map.indexOf("return (", map.indexOf("const goTo =")));
  assert.match(goTo, /tabPicked\.current = true;/, "a World picked by hand stays picked");
});

test("T61-W16 a trip place opens directions to its own pin, with the plain stop icon; spots and terminals search by name", () => {
  assert.equal(placeMapsUrl({ name: "Cafe", kind: "trip_place", lat: 16.4123, lng: 120.5987 }), "https://www.google.com/maps/dir/?api=1&destination=16.4123,120.5987");
  assert.equal(placeMapsUrl({ name: "Burnham Park", kind: "spot" }), "https://www.google.com/maps/search/?api=1&query=Burnham%20Park%2C%20Benguet%2C%20Philippines");
  assert.equal(placeIcon({ kind: "trip_place", id: "tp", name: "Cafe", category: null, lodging: false, lat: 16.4, lng: 120.6, maps_url: "https://maps.app.goo.gl/x" }), "place-other");
});
