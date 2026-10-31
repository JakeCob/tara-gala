// TG-49 the title screen's chibis come alive. Run with `npm test` (node --test, type stripping).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CAST, TICK_MS, castFrame } from "./landingCast.ts";

const WEB = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB), "utf8");
const trio = CAST.heroTrio.length;

test("TC1 each chibi steps between its idle frames every tick, out of step with its neighbour", () => {
  assert.equal(TICK_MS, 400);
  for (const tick of [0, 1, 2, 3, 4, 5]) {
    for (let slot = 0; slot < trio; slot++) {
      assert.notEqual(castFrame(slot, tick), castFrame(slot, tick + 1), `slot ${slot} moves at tick ${tick}`);
    }
    assert.notEqual(castFrame(0, tick), castFrame(1, tick), `neighbours differ at tick ${tick}`);
  }
});

test("TC2 one chibi waves per 8-second round, for 1.6 seconds, taking turns", () => {
  for (let round = 0; round < 6; round++) {
    const ticks = Array.from({ length: 20 }, (_, i) => round * 20 + i);
    const waving = ticks.flatMap((t) => [0, 1, 2].filter((s) => castFrame(s, t) === "wave").map((s) => [s, t % 20]));
    assert.deepEqual(waving.map(([, t]) => t), [12, 13, 14, 15], `round ${round}: four waving ticks`);
    assert.ok(waving.every(([s]) => s === round % trio), `round ${round}: chibi ${round % trio} waves`);
  }
});

test("TC3 the trio is decorative, keeps every frame loaded, and stays still for reduced motion, the server and a hidden tab", () => {
  const src = read("src/components/landing/TitleCast.tsx");
  assert.match(src, /^"use client";/);
  assert.match(src, /<div aria-hidden="true" className="absolute bottom-1 left-3 flex gap-1 lg:bottom-3 lg:left-6">/);
  assert.match(src, /\{CHIBI_FRAMES\.map\(\(frame\) => \(/, "every frame rendered, one shown");
  assert.match(src, /hidden=\{frame !== shown\}/);
  assert.match(src, /alt=""/);
  assert.match(src, /"\(prefers-reduced-motion: reduce\)"/);
  assert.match(src, /useSyncExternalStore\(subscribeStill, [^,]+, \(\) => true\)/, "still on the server");
  assert.match(src, /if \(still\) return;/);
  assert.match(src, /if \(!document\.hidden\) setTick/);
  assert.match(src, /return \(\) => window\.clearInterval\(timer\);/);
  assert.match(read("src/components/landing/TitleScreen.tsx"), /<TitleCast \/>/);
});

test("TC4 the start menu's cursor blinks once a second, steady for reduced motion, the server and a hidden tab", () => {
  const src = read("src/components/landing/StartMenu.tsx");
  assert.match(src, /^"use client";/);
  assert.match(src, /export const BLINK_MS = 500;/);
  assert.match(src, /"\(prefers-reduced-motion: reduce\)"/);
  assert.match(src, /useSyncExternalStore\(subscribeStill, [^,]+, \(\) => true\)/, "steady on the server");
  assert.match(src, /if \(still\) return;/);
  assert.match(src, /if \(!document\.hidden\) setLit/);
  assert.match(src, /return \(\) => window\.clearInterval\(timer\);/);
  assert.match(src, /data-blink=\{still \|\| lit \? "on" : "off"\}/);
});
