// TG-52: the trip as a game level map, one world per day. Run with `npm test` (node --test, type stripping).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Guide, GuideRow, Mark } from "./guide.ts";
import { marksByKey } from "./guide.ts";
import { COLUMNS, GAP_PX, GOAL_POINT, PAD_PX, TILE_PX, UNIT, levelPoints, levelScenery, levels, nextLevel, pixelRoad, placeMapsUrl, roadStops, runsPath, startPoint, startWorld, worldHeight } from "./levelMap.ts";

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
  assert.deepEqual([GAP_PX, PAD_PX], [120, 132], "room for three lines of sign, and for GOAL under the world's bar");
});

test("LM3 the road is 3px cells on the screen's real width, through START, every level and GOAL", () => {
  const pts = levelPoints(7);
  const H = worldHeight(7);
  for (const W of [282, 342, 442]) {
    const stops = roadStops(pts, startPoint(7), GOAL_POINT, W);
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
  for (const W of [282, 342, 442]) {
    assert.deepEqual(levelScenery(pts, W, 7), levelScenery(pts, W, 7), "deterministic");
    assert.notDeepEqual(levelScenery(pts, W, 7), levelScenery(pts, W, 8), "the seed changes it");
    for (let seed = 0; seed < 60; seed++) {
      const items = levelScenery(pts, W, seed);
      assert.ok(items.length >= pts.length, "every level gets some");
      for (const d of items) {
        assert.ok(FIXED.has(d.name), d.name);
        assert.ok(d.x >= 3 && d.x + d.w <= W - 3 && d.y >= 0 && d.y + d.h <= H, `in the world at ${W}: ${JSON.stringify(d)}`);
        for (const p of pts) {
          const tile = { l: (p.x / 100) * W - TILE_PX / 2, t: p.y - TILE_PX / 2 };
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
  const pines = levelScenery(pts, 342, 0).filter((d) => d.name === "tile-pine");
  assert.ok(pines.length === 0 || pines.length >= 2, "pines come in clusters");
  assert.doesNotMatch(readFileSync("src/lib/levelMap.ts", "utf8"), /Math\.random|deco-sun-stars/, "seeded; never the emblem");
});

test("LM11 the world is a game screen: a pixel road, grass, framed in Ink in both themes, capped at a phone's width", () => {
  const map = readFileSync("src/components/LevelMap.tsx", "utf8");
  assert.doesNotMatch(map, /preserveAspectRatio|non-scaling-stroke/, "no stretched vector road");
  assert.match(map, /shapeRendering="crispEdges"/);
  assert.match(map, /new ResizeObserver\(/);
  assert.match(map, /usableWidth\(/);
  assert.match(map, /backgroundImage: `url\(\$\{spriteSrc\("tile-grass"\)\}\)`, backgroundSize: "32px"/);
  for (const v of ["--frame", "--focus", "--foreground"]) assert.ok(map.includes(`"${v}": "var(--color-screen-ink)"`), v);
  assert.match(map, /w-full md:mx-auto md:max-w-md/);
  assert.match(map, /wide && "lg:grid lg:grid-cols-\[28rem_minmax\(0,1fr\)\] lg:grid-rows-\[repeat\(7,auto\)_1fr\]/);
  assert.match(map, /lg:col-start-1 lg:row-span-full/);
  assert.match(readFileSync("src/components/TripView.tsx", "utf8"), /<LevelMap\n\s+wide\n/, "the trip page has the width; \/i\/ doesn't");
  assert.match(map, /grid grid-cols-3 gap-2 lg:col-start-2 lg:flex lg:flex-wrap/, "the trip menu");
  assert.match(map, /<Sprite name="ui-star" scale=\{1\} \/>Goal<Sprite name="ui-star" scale=\{1\} \/>/, "GOAL");
  assert.match(map, /PX\.pressStart\)\} style=\{\{ left: `\$\{start\.x\}%`, top: start\.y \}\}>\s+Start\s+<\/span>/, "START");
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
  assert.match(map, /onClick=\{\(\) => \{ onOpenLevel\?\.\(\); setOpen\(l\); \}\}/, "the last write's notice doesn't follow you to another level");
});

test("LM16 the Album loads a page of photos at a time, not all 300 at once", () => {
  const map = readFileSync("src/components/LevelMap.tsx", "utf8");
  const album = map.slice(map.indexOf("function Album"));
  assert.match(map, /const ALBUM_PAGE = 24;/);
  assert.match(album, /all\.slice\(0, shownCount\)\.map\(/);
  assert.match(album, /Show \{Math\.min\(ALBUM_PAGE, all\.length - shownCount\)\} more/);
});
