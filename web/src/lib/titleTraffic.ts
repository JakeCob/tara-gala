// TG-49 traffic on the title screen (owner: "add moving pixel objects ... like jeepneys, tickets, bus"). Jeepneys and
// buses, with the odd taxi or tricycle, drive along the bottom of the scene behind the trio, and tickets drift across
// the sky behind the sign and the menu, like the clouds. A plain state machine with the random source passed in, like
// titleWalk.ts, so the moves are tested without timers or chance.

import { SPRITES, type SpriteName } from "./sprites.ts";
import type { Rng } from "./titleWalk.ts";

export const TRAFFIC_MS = 100; // one tick
export const SCALE = 3; // drawn at 3x: at the trio's 2x they were lost against the trees

export type Lane = "road" | "sky";
/** x from the scene's left edge; y is up from the road's line, or down from the top of the sky. wait > 0: off screen. */
export type Mover = { lane: Lane; sprite: SpriteName; x: number; y: number; dir: 1 | -1; wait: number; age: number };

// Jeepneys and buses come by most; one list entry per chance
export const ROAD: readonly SpriteName[] = ["mode-jeep", "vehicle-bus", "mode-jeep", "mode-taxi", "vehicle-bus", "mode-tricycle"];
export const ROAD_SPRITES: readonly SpriteName[] = [...new Set(ROAD)];
export const TICKET: SpriteName = "ui-ticket";
// Which way each sprite's art faces, and how far it goes in a tick (whole art pixels at 3x)
const FACING: Partial<Record<SpriteName, 1 | -1>> = { "vehicle-bus": 1, "mode-jeep": 1, "mode-taxi": 1, "mode-tricycle": -1, "ui-ticket": 1 };
export const SPEED: Partial<Record<SpriteName, number>> = { "vehicle-bus": 6, "mode-jeep": 6, "mode-taxi": 9, "mode-tricycle": 3, "ui-ticket": 3 };
// The second road lane sits a little further back, so two vehicles pass rather than run into each other
export const BACK_LANE_PX = 9;
const SKY_PAD_PX = 4;

const between = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
const snap = (n: number) => Math.round(n / SCALE) * SCALE; // whole art pixels

export function moverSize(sprite: SpriteName): { w: number; h: number } {
  return { w: SPRITES[sprite].w * SCALE, h: SPRITES[sprite].h * SCALE };
}

/** Drawn mirrored when it goes against the way its art faces */
export function flipped(m: Mover): boolean {
  return (FACING[m.sprite] ?? 1) !== m.dir;
}

/** A ticket bobs up and down one art pixel as it drifts */
export function moverY(m: Mover): number {
  return m.lane === "sky" ? m.y + (Math.floor(m.age / 4) % 2) * SCALE : m.y;
}

function skyY(rng: Rng, skyHeight: number): number {
  return snap(between(rng, SKY_PAD_PX, Math.max(SKY_PAD_PX, skyHeight - moverSize(TICKET).h - SKY_PAD_PX)));
}

/** A new mover just off the edge it comes in from */
function spawn(m: Mover, width: number, skyHeight: number, rng: Rng): Mover {
  if (m.lane === "sky") return { ...m, sprite: TICKET, dir: 1, x: -moverSize(TICKET).w, y: skyY(rng, skyHeight), wait: 0, age: 0 };
  const sprite = ROAD[Math.floor(rng() * ROAD.length)];
  const dir = rng() < 0.5 ? 1 : -1;
  return { ...m, sprite, dir, x: dir === 1 ? -moverSize(sprite).w : width, wait: 0, age: 0 };
}

/**
 * The opening scene, also the still one (reduced motion): a jeepney on the road, a bus waiting to come on, and two
 * tickets in the sky. Only the bus's wait uses the random source, so the still scene is the moving one's first frame.
 */
export function startTraffic(width: number, skyHeight: number, rng: Rng): Mover[] {
  return [
    { lane: "road", sprite: "vehicle-bus", x: width, y: BACK_LANE_PX, dir: -1, wait: between(rng, 10, 40), age: 0 },
    { lane: "road", sprite: "mode-jeep", x: snap(width * 0.55), y: 0, dir: 1, wait: 0, age: 0 },
    { lane: "sky", sprite: TICKET, x: snap(width * 0.08), y: SKY_PAD_PX * 3, dir: 1, wait: 0, age: 0 },
    { lane: "sky", sprite: TICKET, x: snap(width * 0.78), y: snap(skyHeight * 0.55), dir: 1, wait: 0, age: 2 },
  ];
}

/** One tick for one mover in a scene `width` pixels wide with a sky `skyHeight` pixels tall */
export function stepMover(m: Mover, width: number, skyHeight: number, rng: Rng): Mover {
  if (m.wait > 0) return m.wait > 1 ? { ...m, wait: m.wait - 1 } : spawn(m, width, skyHeight, rng);
  const x = m.x + m.dir * (SPEED[m.sprite] ?? 2);
  if (x < -moverSize(m.sprite).w || x > width) {
    // Gone past the edge: off screen for a while, then something new comes on
    return { ...m, x, wait: m.lane === "road" ? between(rng, 10, 50) : between(rng, 20, 80) };
  }
  return { ...m, x, age: m.age + 1 };
}
