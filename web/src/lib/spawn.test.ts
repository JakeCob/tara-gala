// Chibi spawn tests (TG-15): the timeline as data and the timer-injected controller. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SPAWN, SPAWN_MS, createSpawner, frameAt, type SpawnState } from "./spawn.ts";
import { CHIBI_FRAMES } from "./sprites.ts";

const source = readFileSync(new URL("./spawn.ts", import.meta.url), "utf8");

const look = (s: { frame: string; stars: boolean }) => ({ frame: s.frame, stars: s.stars });
const WAVE = { frame: "wave", stars: true };
const DIP = { frame: "idle-2", stars: false };
const REST = { frame: "idle-1", stars: false };

// A fake clock: schedule/cancel record timers, advance(ms) fires the due ones in order
function fakeClock(reducedMotion: () => boolean = () => false) {
  let now = 0;
  let nextId = 1;
  let scheduled = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const changes: SpawnState[] = [];
  const spawner = createSpawner({
    schedule(fn, ms) {
      scheduled++;
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    cancel(handle) {
      timers.delete(handle as number);
    },
    reducedMotion,
    onChange(s) {
      changes.push(s);
    },
  });
  function advance(ms: number) {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = end;
  }
  return {
    spawner,
    advance,
    changes,
    pending: () => [...timers.values()].map((t) => t.at).sort((a, b) => a - b),
    scheduled: () => scheduled,
  };
}

// T15-T1..T6 (B11)
test("T15-T1 frameAt(0) is the wave with stars", () => {
  assert.deepEqual(look(frameAt(0)), WAVE);
});

test("T15-T2 the wave lasts until 200 ms, then idle-2 without stars", () => {
  assert.deepEqual(look(frameAt(199)), WAVE);
  assert.deepEqual(look(frameAt(200)), DIP);
});

test("T15-T3 idle-1 from 300 ms on", () => {
  assert.deepEqual(look(frameAt(299)), DIP);
  assert.deepEqual(look(frameAt(300)), REST);
  assert.deepEqual(look(frameAt(10_000)), REST);
});

test("T15-T4 timeline bounds: under 0.5 s, sorted, ends at rest", () => {
  assert.ok(SPAWN_MS < 500, `SPAWN_MS ${SPAWN_MS}`);
  assert.equal(SPAWN.length, 3, "wave, idle-2, idle-1");
  assert.equal(SPAWN[0].at, 0);
  for (let i = 1; i < SPAWN.length; i++) assert.ok(SPAWN[i].at > SPAWN[i - 1].at, "strictly sorted by at");
  const last = SPAWN[SPAWN.length - 1];
  assert.equal(last.at, SPAWN_MS);
  assert.deepEqual(look(last), REST);
});

test("T15-T5 every frame is a TG-33 chibi frame", () => {
  assert.ok(SPAWN.length > 0);
  for (const s of SPAWN) assert.ok((CHIBI_FRAMES as readonly string[]).includes(s.frame), s.frame);
});

test("T15-T6 frameAt before 0 or NaN gives step 0 and never throws", () => {
  assert.deepEqual(look(frameAt(-1)), WAVE);
  assert.deepEqual(look(frameAt(NaN)), WAVE);
});

// T15-C1..C9 (Q1: skip, reduced motion and clean-up reachable from node --test)
test("T15-C1 start shows the wave and schedules the 200 and 300 ms swaps", () => {
  const c = fakeClock();
  c.spawner.start([2]);
  const s = c.spawner.state();
  assert.deepEqual(s.active, [2]);
  assert.deepEqual(look(s.step), WAVE);
  assert.equal(c.changes.length, 1);
  assert.deepEqual(c.pending(), [200, 300]);
});

test("T15-C2 the spawn runs wave, idle-2, idle-1 and then rests with no timers", () => {
  const c = fakeClock();
  c.spawner.start([2]);
  c.advance(199);
  assert.deepEqual(look(c.spawner.state().step), WAVE);
  c.advance(1);
  assert.deepEqual(look(c.spawner.state().step), DIP);
  assert.deepEqual(c.spawner.state().active, [2]);
  c.advance(100);
  assert.deepEqual(c.spawner.state().active, []);
  assert.deepEqual(look(c.spawner.state().step), REST);
  assert.deepEqual(c.pending(), []);
  assert.deepEqual(look(c.changes[c.changes.length - 1].step), REST);
});

test("T15-C3 skip jumps to idle-1 and cancels its timers (B12)", () => {
  const c = fakeClock();
  c.spawner.start([2]);
  c.advance(50);
  const before = c.changes.length;
  c.spawner.skip();
  assert.deepEqual(c.spawner.state().active, []);
  assert.deepEqual(look(c.spawner.state().step), REST);
  assert.deepEqual(c.pending(), []);
  assert.equal(c.changes.length, before + 1);
  c.advance(1000);
  assert.equal(c.changes.length, before + 1, "nothing fires after skip");
});

test("T15-C4 a fast second add finishes the first spawn and starts the next", () => {
  const c = fakeClock();
  c.spawner.start([2]);
  c.advance(50);
  c.spawner.start([3]);
  assert.deepEqual(c.spawner.state().active, [3]);
  assert.deepEqual(look(c.spawner.state().step), WAVE);
  assert.deepEqual(c.pending(), [250, 350], "only the second spawn's timers");
});

test("T15-C5 reduced motion: idle-1 at once, no stars, nothing scheduled (B13)", () => {
  const c = fakeClock(() => true);
  c.spawner.start([4]);
  assert.deepEqual(c.spawner.state().active, []);
  assert.deepEqual(look(c.spawner.state().step), REST);
  assert.equal(c.scheduled(), 0);
  assert.ok(c.changes.every((s) => !s.step.stars), "no stars at any point");
});

test("T15-C6 reduced motion is read at each start, not cached", () => {
  let reduced = false;
  const c = fakeClock(() => reduced);
  c.spawner.start([1]);
  assert.deepEqual(look(c.spawner.state().step), WAVE);
  c.advance(300);
  reduced = true;
  const scheduled = c.scheduled();
  c.spawner.start([2]);
  assert.deepEqual(c.spawner.state().active, []);
  assert.deepEqual(look(c.spawner.state().step), REST);
  assert.equal(c.scheduled(), scheduled);
});

test("T15-C7 skip with nothing running is a no-op", () => {
  const c = fakeClock();
  c.spawner.skip();
  assert.equal(c.changes.length, 0);
  c.spawner.start([1]);
  c.advance(300);
  const after = c.changes.length;
  c.spawner.skip();
  assert.equal(c.changes.length, after);
});

test("T15-C8 dispose mid-spawn cancels everything (unmount)", () => {
  const c = fakeClock();
  c.spawner.start([2]);
  c.advance(50);
  const before = c.changes.length;
  c.spawner.dispose();
  assert.deepEqual(c.pending(), []);
  c.advance(1000);
  assert.equal(c.changes.length, before);
});

test("T15-C9 a new controller is at rest and schedules nothing until start", () => {
  const c = fakeClock();
  assert.deepEqual(c.spawner.state().active, []);
  assert.deepEqual(look(c.spawner.state().step), REST);
  c.advance(1000);
  assert.equal(c.scheduled(), 0);
  assert.equal(c.changes.length, 0);
});

// T15-X1
test("T15-X1 spawn.ts is a plain module", () => {
  for (const line of source.match(/^\s*import\b.*$/gm) ?? []) {
    assert.match(line, /^import type \{[^}]*\} from "\.\/sprites\.ts";$/, `only a type import from sprites: ${line}`);
  }
  assert.doesNotMatch(source, /\bimport\s*\(/);
  assert.doesNotMatch(source, /@\//);
  assert.doesNotMatch(source, /<\/[A-Za-z]|\/>/);
  assert.doesNotMatch(source, /use client/);
  assert.doesNotMatch(source, /\benum\s/);
  assert.doesNotMatch(source, /\bnamespace\s/);
  assert.doesNotMatch(source, /\b(setTimeout|clearTimeout|matchMedia|window|document)\b/, "timers and media come in through io");
});
