// Chibi spawn (TG-15, reused by TG-22): the frame timeline as data, plus a controller with injected timers.
// Plain module: timers, reduced motion and rendering come in through io, so node --test can drive it with a fake clock.
import type { ChibiFrame } from "./sprites.ts";

export type SpawnStep = { at: number; frame: ChibiFrame; stars: boolean };
export type SpawnState = { active: number[]; step: SpawnStep };

// Frame swaps only (ux-guide §11): wave with sparkles, the landing dip, then rest
export const SPAWN: readonly SpawnStep[] = [
  { at: 0, frame: "wave", stars: true },
  { at: 200, frame: "idle-2", stars: false },
  { at: 300, frame: "idle-1", stars: false },
];
export const SPAWN_MS = 300; // total; must stay under 500
const REST = SPAWN[SPAWN.length - 1];

// The last step with at <= ms; anything before 0 (or NaN) is step 0
export function frameAt(ms: number): SpawnStep {
  let step = SPAWN[0];
  for (const s of SPAWN) if (s.at <= ms) step = s;
  return step;
}

export type SpawnIO = {
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
  reducedMotion(): boolean; // read on every start, so a live OS change applies
  onChange(state: SpawnState): void;
};

export function createSpawner(io: SpawnIO) {
  let state: SpawnState = { active: [], step: REST };
  let timers: unknown[] = [];

  function set(next: SpawnState) {
    state = next;
    io.onChange(state);
  }

  function clear() {
    for (const t of timers) io.cancel(t);
    timers = [];
  }

  // Jump a running spawn to rest at once (a tap or keypress anywhere in the picker)
  function skip() {
    clear();
    if (state.active.length > 0) set({ active: [], step: REST });
  }

  function start(indices: number[]) {
    skip();
    if (indices.length === 0 || io.reducedMotion()) return;
    set({ active: [...indices], step: SPAWN[0] });
    for (const s of SPAWN.slice(1)) {
      timers.push(
        io.schedule(() => {
          set({ active: s === REST ? [] : state.active, step: s });
          if (s === REST) timers = [];
        }, s.at),
      );
    }
  }

  return {
    start,
    skip,
    dispose: clear,
    state: () => state,
  };
}
