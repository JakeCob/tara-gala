// TG-49 the title screen's chibis come alive. Run with `npm test` (node --test, type stripping).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CHIBI_PX, STEP_PX, WALK_MS, homeX, startWalkers, stepWalker, walkerFrame, type Walker } from "./titleWalk.ts";

const WEB = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB), "utf8");

// A seeded random source (mulberry32), so a "random" walk is the same on every run
function seeded(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function run(width: number, steps: number, seed: number) {
  const rng = seeded(seed);
  let walkers = startWalkers(3, rng);
  const history: Walker[][] = [walkers];
  for (let i = 0; i < steps; i++) {
    walkers = walkers.map((w) => stepWalker(w, width, rng));
    history.push(walkers);
  }
  return history;
}

test("TC1 the trio starts side by side where the static layout puts them, and sets off at different times", () => {
  assert.deepEqual([0, 1, 2].map(homeX), [0, 68, 136]);
  const start = startWalkers(3, seeded(1));
  assert.deepEqual(start.map((w) => w.x), [0, 68, 136]);
  assert.ok(start.every((w) => w.mode === "rest"));
  assert.equal(new Set(start.map((w) => w.left)).size, 3, "three different first rests");
  assert.equal(WALK_MS, 200);
  assert.equal(STEP_PX, 4);
});

test("TC2 over two minutes they walk, rest and wave, always inside the strip, one step at a time", () => {
  for (const width of [322, 610, 930]) {
    for (const seed of [1, 2, 3]) {
      const history = run(width, 600, seed);
      for (let slot = 0; slot < 3; slot++) {
        const path = history.map((ws) => ws[slot]);
        assert.ok(path.every((w) => w.x >= 0 && w.x <= width - CHIBI_PX), `w${width} s${seed} #${slot}: inside the strip`);
        for (let i = 1; i < path.length; i++) assert.ok(Math.abs(path[i].x - path[i - 1].x) <= STEP_PX, "never jumps");
        const modes = new Set(path.map((w) => w.mode));
        assert.ok(modes.has("walk") && modes.has("rest"), `w${width} s${seed} #${slot}: walks and rests (${[...modes]})`);
        assert.ok(new Set(path.map((w) => w.x)).size > 10, "goes places");
      }
      assert.ok(history.some((ws) => ws.some((w) => w.mode === "wave")), `w${width} s${seed}: someone waves`);
    }
  }
});

test("TC2b at an edge a walker turns round and rests; a narrower strip pulls it back inside", () => {
  const rng = seeded(4);
  const atEdge: Walker = { x: 100 - CHIBI_PX, dir: 1, mode: "walk", left: 20, age: 0 };
  const turned = stepWalker(atEdge, 100, rng);
  assert.equal(turned.x, 100 - CHIBI_PX);
  assert.equal(turned.dir, -1);
  assert.equal(turned.mode, "rest");
  const squeezed = stepWalker({ x: 500, dir: -1, mode: "rest", left: 5, age: 0 }, 200, rng);
  assert.equal(squeezed.x, 200 - CHIBI_PX);
});

test("TC2c feet swap every step while walking, every other step at rest; a wave shows the wave frame", () => {
  const w = (mode: Walker["mode"], age: number): Walker => ({ x: 0, dir: 1, mode, left: 5, age });
  assert.deepEqual([0, 1, 2, 3].map((a) => walkerFrame(w("walk", a))), ["idle-1", "idle-2", "idle-1", "idle-2"]);
  assert.deepEqual([0, 1, 2, 3].map((a) => walkerFrame(w("rest", a))), ["idle-1", "idle-1", "idle-2", "idle-2"]);
  assert.equal(walkerFrame(w("wave", 3)), "wave");
});

test("TC3 the trio is decorative, keeps every frame loaded, and stands still for reduced motion, the server and a hidden tab", () => {
  const src = read("src/components/landing/TitleCast.tsx");
  assert.match(src, /^"use client";/);
  assert.match(src, /<div ref=\{strip\} aria-hidden="true" className="absolute inset-x-3 bottom-1 h-16 lg:inset-x-6 lg:bottom-3">/);
  assert.match(src, /style=\{\{ transform: `translateX\(\$\{x\}px\)` \}\}/, "moved by transform, so the layout never shifts");
  assert.match(src, /const x = moving \? walkers\[i\]\.x : homeX\(i\);/, "home spots when still");
  assert.match(src, /\{CHIBI_FRAMES\.map\(\(frame\) => \(/, "every frame rendered, one shown");
  assert.match(src, /hidden=\{frame !== shown\}/);
  assert.match(src, /alt=""/);
  assert.match(src, /"\(prefers-reduced-motion: reduce\)"/);
  assert.match(src, /useSyncExternalStore\(subscribeStill, [^,]+, \(\) => true\)/, "still on the server");
  assert.match(src, /if \(still \|\| width === 0\) return;/);
  assert.match(src, /if \(document\.hidden\) return;/);
  assert.match(src, /return \(\) => observer\.disconnect\(\);/);
  assert.match(src, /return \(\) => window\.clearInterval\(timer\);/);
  assert.match(read("src/components/landing/TitleScreen.tsx"), /<TitleCast \/>/);
});

test("TC4 PRESS START and the menu cursor blink once a second, steady for reduced motion, the server and a hidden tab", () => {
  const src = read("src/components/landing/TitleBlink.tsx");
  assert.match(src, /^"use client";/);
  assert.match(src, /export const BLINK_MS = 500;/);
  assert.match(src, /"\(prefers-reduced-motion: reduce\)"/);
  assert.match(src, /useSyncExternalStore\(subscribeStill, [^,]+, \(\) => true\)/, "steady on the server");
  assert.match(src, /if \(still\) return;/);
  assert.match(src, /if \(!document\.hidden\) setLit/);
  assert.match(src, /return \(\) => window\.clearInterval\(timer\);/);
  assert.match(src, /data-blink=\{still \|\| lit \? "on" : "off"\}/);
});
