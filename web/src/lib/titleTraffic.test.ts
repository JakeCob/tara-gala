// TG-49 traffic on the title screen (owner: "add moving pixel objects ... like jeepneys, tickets, bus").
// Run with `npm test` (node --test, type stripping).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SPRITES } from "./sprites.ts";
import {
  BACK_LANE_PX, ROAD, ROAD_SPRITES, SCALE, SPEED, TICKET, TRAFFIC_MS, flipped, moverSize, moverY, startTraffic, stepMover, type Mover,
} from "./titleTraffic.ts";

const WEB = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB), "utf8");

// A seeded random source (mulberry32), so a "random" drive is the same on every run
function seeded(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function run(width: number, sky: number, ticks: number, seed: number) {
  const rng = seeded(seed);
  let movers = startTraffic(width, sky, rng);
  const history: Mover[][] = [movers];
  for (let i = 0; i < ticks; i++) {
    movers = movers.map((m) => stepMover(m, width, sky, rng));
    history.push(movers);
  }
  return history;
}

test("TT1 the opening scene: a jeepney on the road, a bus waiting, two tickets in the sky; the still scene is the same", () => {
  const [bus, jeep, ...tickets] = startTraffic(380, 270, seeded(1));
  assert.equal(TRAFFIC_MS, 100);
  assert.equal(SCALE, 3);
  assert.deepEqual([jeep.lane, jeep.sprite, jeep.wait, jeep.y], ["road", "mode-jeep", 0, 0]);
  assert.ok(jeep.x >= 0 && jeep.x + moverSize("mode-jeep").w <= 380, `the jeepney is on screen at ${jeep.x}`);
  assert.deepEqual([bus.lane, bus.sprite, bus.y], ["road", "vehicle-bus", BACK_LANE_PX]);
  assert.ok(bus.wait > 0, "the bus waits off screen");
  for (const t of tickets) {
    assert.deepEqual([t.lane, t.sprite, t.wait], ["sky", TICKET, 0]);
    assert.ok(t.x >= 0 && t.x + moverSize(TICKET).w <= 380 && t.y >= 0 && t.y + moverSize(TICKET).h <= 270, `ticket at ${t.x},${t.y}`);
  }
  const still = startTraffic(380, 270, () => 0);
  const moving = startTraffic(380, 270, seeded(9));
  assert.deepEqual(still.map(({ wait, ...m }) => (wait > 0 ? null : m)), moving.map(({ wait, ...m }) => (wait > 0 ? null : m)), "the still scene is the moving one's first frame");
});

test("TT2 sprites are drawn at 3x, and step whole art pixels", () => {
  assert.deepEqual(moverSize("vehicle-bus"), { w: 144, h: 72 });
  assert.deepEqual(moverSize("mode-jeep"), { w: 72, h: 48 });
  assert.deepEqual(moverSize(TICKET), { w: 48, h: 30 });
  assert.deepEqual(SPRITES[TICKET], { w: 16, h: 10 });
  for (const name of [...ROAD_SPRITES, TICKET]) assert.equal((SPEED[name] ?? 0) % SCALE, 0, `${name} speed`);
});

test("TT3 a vehicle drives its way at its speed, leaves, waits off screen, then a new one comes on at the far edge", () => {
  const rng = seeded(3);
  const jeep: Mover = { lane: "road", sprite: "mode-jeep", x: 30, y: 0, dir: 1, wait: 0, age: 0 };
  assert.equal(stepMover(jeep, 380, 270, rng).x, 30 + SPEED["mode-jeep"]!);
  assert.equal(stepMover({ ...jeep, dir: -1 }, 380, 270, rng).x, 30 - SPEED["mode-jeep"]!);
  const gone = stepMover({ ...jeep, x: 378 }, 380, 270, rng);
  assert.ok(gone.wait >= 10 && gone.wait <= 50, `waits ${gone.wait} ticks`);
  const next = stepMover({ ...gone, wait: 1 }, 380, 270, seeded(4));
  assert.equal(next.wait, 0);
  assert.ok(ROAD.includes(next.sprite));
  assert.equal(next.x, next.dir === 1 ? -moverSize(next.sprite).w : 380, "on at the edge it drives in from");
  assert.equal(next.y, 0, "keeps its lane");
});

test("TT4 over 20 minutes: every vehicle comes by both ways, jeepneys and buses most; nothing shown strays out of the scene", () => {
  const history = run(960, 300, 12_000, 7);
  const seen = new Map<string, number>();
  for (const frame of history) {
    for (const m of frame) {
      if (m.wait > 0) continue;
      const { w, h } = moverSize(m.sprite);
      assert.ok(m.x >= -w && m.x <= 960, `${m.sprite} at x ${m.x}`);
      if (m.lane === "sky") {
        assert.equal(m.sprite, TICKET);
        assert.equal(m.dir, 1, "tickets drift one way, with the wind");
        assert.ok(moverY(m) >= 0 && moverY(m) + h <= 300, `ticket at y ${moverY(m)}`);
      } else {
        assert.ok([0, BACK_LANE_PX].includes(m.y));
        const key = `${m.sprite} ${m.dir}`;
        if (m.age === 0) seen.set(key, (seen.get(key) ?? 0) + 1);
      }
    }
  }
  for (const name of ROAD_SPRITES) for (const dir of [1, -1]) assert.ok(seen.get(`${name} ${dir}`), `${name} going ${dir}`);
  const count = (name: string) => (seen.get(`${name} 1`) ?? 0) + (seen.get(`${name} -1`) ?? 0);
  assert.ok(count("mode-jeep") > count("mode-taxi") && count("vehicle-bus") > count("mode-tricycle"), JSON.stringify([...seen]));
  const shown = history.map((f) => f.filter((m) => m.lane === "road" && m.wait === 0).length);
  assert.ok(shown.filter((n) => n > 0).length > shown.length / 2, "a vehicle is on the road most of the time");
});

test("TT5 a vehicle going against the way its art faces is drawn mirrored; a ticket bobs one art pixel", () => {
  const m = (sprite: Mover["sprite"], dir: 1 | -1): Mover => ({ lane: "road", sprite, x: 0, y: 0, dir, wait: 0, age: 0 });
  assert.deepEqual([flipped(m("vehicle-bus", 1)), flipped(m("vehicle-bus", -1))], [false, true]);
  assert.deepEqual([flipped(m("mode-jeep", 1)), flipped(m("mode-jeep", -1))], [false, true]);
  assert.deepEqual([flipped(m("mode-tricycle", 1)), flipped(m("mode-tricycle", -1))], [true, false], "the tricycle's art faces left");
  const t: Mover = { lane: "sky", sprite: TICKET, x: 0, y: 12, dir: 1, wait: 0, age: 0 };
  assert.deepEqual([0, 3, 4, 7, 8].map((age) => moverY({ ...t, age })), [12, 12, 15, 15, 12]);
});

test("TT6 the traffic is decorative, behind the menu and the trio, keeps every vehicle loaded, and stands still for reduced motion and a hidden tab", () => {
  const src = read("src/components/landing/TitleTraffic.tsx");
  assert.match(src, /^"use client";/);
  assert.match(src, /<div ref=\{layer\} aria-hidden="true" className="absolute inset-0">/);
  assert.match(src, /style=\{\{ transform: move \}\}/, "moved by transform, so the layout never shifts");
  assert.match(src, /\(road \? ROAD_SPRITES : \[TICKET\]\)\.map\(\(name\) => \(/, "every vehicle rendered, one shown");
  assert.match(src, /hidden=\{name !== m\.sprite\}/);
  assert.match(src, /hidden=\{m\.wait > 0\}/, "off screen while it waits");
  assert.match(src, /alt=""/);
  assert.match(src, /"\(prefers-reduced-motion: reduce\)"/);
  assert.match(src, /useSyncExternalStore\(subscribeStill, [^,]+, \(\) => true\)/, "still on the server");
  assert.match(src, /if \(still \|\| size\.width === 0\) return;/);
  assert.match(src, /if \(document\.hidden\) return;/);
  assert.match(src, /startTraffic\(size\.width, size\.sky, \(\) => 0\)/, "the still scene");
  assert.match(src, /return \(\) => observer\.disconnect\(\);/);
  assert.match(src, /return \(\) => window\.clearInterval\(timer\);/);
  const screen = read("src/components/landing/TitleScreen.tsx");
  const order = ["{spriteSrc(\"hero-scene\")}", "<TitleTraffic />", "<Placard size=\"lg\">", "<TitleCast />"].map((s) => screen.indexOf(s));
  assert.ok(order.every((i) => i >= 0) && order.every((i, k) => k === 0 || i > order[k - 1]), `scene, traffic, sign and menu, trio: ${order}`);
});
