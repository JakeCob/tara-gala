// TG-49 the title screen's trio walks about (owner: "make the chibis on the title screen walk around"). The sprites have
// no walk cycle, so a walking chibi steps sideways while its two idle frames swap like feet; at rest it idles slower or
// waves. A plain state machine with the random source passed in, so the moves are tested without timers or chance.

import type { ChibiFrame } from "./sprites.ts";

export const WALK_MS = 200; // one step
export const STEP_PX = 4; // two art pixels at the 2x sprite size
export const CHIBI_PX = 64;
export const HOME_GAP_PX = 4; // where they stand before they set off: side by side, as in the hero

export type Walker = { x: number; dir: 1 | -1; mode: "walk" | "rest" | "wave"; left: number; age: number };
export type Rng = () => number; // [0, 1)

const between = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
const maxX = (width: number) => Math.max(0, width - CHIBI_PX);

/** The trio's starting spots, side by side from the left (the static layout) */
export function homeX(slot: number): number {
  return slot * (CHIBI_PX + HOME_GAP_PX);
}

/** A first rest of different lengths, so the three don't set off together */
export function startWalkers(count: number, rng: Rng): Walker[] {
  return Array.from({ length: count }, (_, i) => ({ x: homeX(i), dir: 1, mode: "rest", left: between(rng, 3, 10) + i * 4, age: 0 }));
}

function nextMode(w: Walker, rng: Rng): Walker {
  if (w.mode === "walk") {
    // Stop: a third of rests are a wave
    return { ...w, mode: rng() < 1 / 3 ? "wave" : "rest", left: between(rng, 5, 14) };
  }
  return { ...w, mode: "walk", dir: rng() < 0.5 ? -1 : 1, left: between(rng, 10, 40) };
}

/** One step for one chibi inside a strip `width` pixels wide */
export function stepWalker(w: Walker, width: number, rng: Rng): Walker {
  const limit = maxX(width);
  let next: Walker = { ...w, x: Math.min(Math.max(w.x, 0), limit), age: w.age + 1, left: w.left - 1 };
  if (next.mode === "walk") {
    const x = next.x + next.dir * STEP_PX;
    if (x < 0 || x > limit) {
      // At an edge: turn round, then rest
      next = { ...next, x: Math.min(Math.max(x, 0), limit), dir: next.dir === 1 ? -1 : 1, mode: "rest", left: between(rng, 5, 14) };
      return next;
    }
    next = { ...next, x };
  }
  return next.left <= 0 ? nextMode(next, rng) : next;
}

/** The frame a chibi shows: feet swap every step while walking, every other step at rest; a wave is the wave frame */
export function walkerFrame(w: Walker): ChibiFrame {
  if (w.mode === "wave") return "wave";
  const beat = w.mode === "walk" ? w.age : Math.floor(w.age / 2);
  return beat % 2 === 0 ? "idle-1" : "idle-2";
}
