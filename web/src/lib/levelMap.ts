// TG-52: the trip as a game level map (owner, 2026-11-02: "a level map like a game and each level be like a checkbox",
// after their pixel ROAD MAP reference). One world per day; each row of the day is a level on a road that winds up the
// screen from START to GOAL. Pure geometry here, so it's tested without a browser.

import { type Guide, type GuideDay, type GuideRow, type Mark, rowMark, rowShows, whereNow } from "./guide.ts";
import type { SpriteName } from "./sprites.ts";

export const GAP_PX = 120; // between two levels, up the screen; the longest sign is 82px tall at 320
export const PAD_PX = 132; // room for START below the first level, and the bar and GOAL above the last
export const TILE_PX = 64;
export const COLUMNS = [28, 72] as const; // the road zig-zags between these, as % of the width
export const UNIT = 3; // the pixel unit (ux-guide 3.1)
const BAR_PX = 52; // the world's title bar, at the top of the screen

export type Level = { row: GuideRow; label: string; done: boolean };
export type Point = { x: number; y: number }; // x in % of the width, y in px from the top
export type Run = { x: number; y: number; w: number }; // one row of road cells, in px
export type Road = { curb: Run[]; asphalt: Run[]; dash: Run[] };
export type Decor = { name: SpriteName; x: number; y: number; w: number; h: number }; // in px, at 2x

/** The day's levels, as they show for the picks so far, numbered "2-1", "2-2"... */
export function levels(day: GuideDay, marks: ReadonlyMap<string, Mark>): Level[] {
  return day.rows
    .filter((r) => rowShows(r, marks))
    .map((row, i) => ({ row, label: `${day.day}-${i + 1}`, done: marks.get(rowMark(row))?.value === "done" }));
}

export function worldHeight(count: number): number {
  return PAD_PX * 2 + Math.max(0, count - 1) * GAP_PX;
}

/** Where each level sits: the first at the bottom, then up the screen, alternating sides. */
export function levelPoints(count: number): Point[] {
  const h = worldHeight(count);
  return Array.from({ length: count }, (_, i) => ({ x: COLUMNS[i % 2], y: h - PAD_PX - i * GAP_PX }));
}

export function startPoint(count: number): Point {
  return { x: 50, y: worldHeight(count) - 24 };
}

export const GOAL_POINT: Point = { x: 50, y: 68 };

/** START, every level and GOAL, in px on a screen W wide: the stops the road runs through. */
export function roadStops(points: readonly Point[], start: Point, goal: Point, W: number): { x: number; y: number }[] {
  return [start, ...points, goal].map((p) => ({ x: (p.x / 100) * W, y: p.y }));
}

/** The road as 3px cells: discs stamped along S-curves between the stops, so it's chunky pixels at any width. */
export function pixelRoad(stops: readonly { x: number; y: number }[], W: number, H: number, half = 12): Road {
  const cols = Math.floor(W / UNIT);
  const rows = Math.floor(H / UNIT);
  const curb = new Uint8Array(cols * rows);
  const asphalt = new Uint8Array(cols * rows);
  const dash = new Uint8Array(cols * rows);
  const stamp = (cells: Uint8Array, px: number, py: number, r: number) => {
    const cx = Math.round(px / UNIT);
    const cy = Math.round(py / UNIT);
    for (let y = Math.max(0, cy - r); y <= Math.min(rows - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(cols - 1, cx + r); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r + r / 2) cells[y * cols + x] = 1;
      }
    }
  };
  const r = Math.round(half / UNIT);
  let along = 0;
  let last: { x: number; y: number } | null = null;
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1];
    const b = stops[i];
    const mid = (a.y + b.y) / 2;
    for (let s = 0; s <= 80; s++) {
      const t = s / 80;
      const u = 1 - t;
      const x = (u * u * u + 3 * u * u * t) * a.x + (3 * u * t * t + t * t * t) * b.x;
      const y = u * u * u * a.y + 3 * u * t * (u + t) * mid + t * t * t * b.y;
      if (last) along += Math.hypot(x - last.x, y - last.y);
      last = { x, y };
      stamp(curb, x, y, r + 1);
      stamp(asphalt, x, y, r);
      if (along % 30 < 14) stamp(dash, x, y, 0);
    }
  }
  const runs = (cells: Uint8Array) => {
    const out: Run[] = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (!cells[y * cols + x]) continue;
        let end = x;
        while (end + 1 < cols && cells[y * cols + end + 1]) end++;
        out.push({ x: x * UNIT, y: y * UNIT, w: (end - x + 1) * UNIT });
        x = end;
      }
    }
    return out;
  };
  return { curb: runs(curb), asphalt: runs(asphalt), dash: runs(dash) };
}

export const runsPath = (runs: readonly Run[]) => runs.map((r) => `M${r.x} ${r.y}h${r.w}v${UNIT}h-${r.w}z`).join("");

const CLEAR = 3; // scenery stays this far from the tile and the world's edge
const PINE = 32;
const PINES = "pines"; // two or three together read far better than one
const SCENERY = [
  { name: PINES, w: PINE, h: PINE },
  { name: "deco-rice-terraces", w: 48, h: 48 },
  { name: "tile-mountain", w: 32, h: 32 },
  { name: "deco-bahay-kubo", w: 48, h: 48 },
  { name: PINES, w: PINE, h: PINE },
  { name: "deco-sampaguita", w: 32, h: 32 },
] as const;
const CARABAO = { name: "deco-carabao", w: 64, h: 48 } as const;

/**
 * The world's scenery, at 2x. One group in the free column outside each tile, picked by the seed from what fits there
 * (about 47px on a 320 phone, 64 at 380), and a carabao in the corners by START and GOAL. Never the emblem (TG-45).
 */
export function levelScenery(points: readonly Point[], W: number, seed: number): Decor[] {
  const out: Decor[] = [];
  points.forEach((p, i) => {
    const left = p.x < 50;
    const free = (left ? (p.x / 100) * W : W - (p.x / 100) * W) - TILE_PX / 2;
    const from = left ? 0 : W - free;
    const fits = SCENERY.filter((s) => s.w + CLEAR * 2 <= free);
    if (!fits.length) return;
    const pick = fits[(seed + i * 5) % fits.length];
    if (pick.name === PINES) {
      const step = Math.min(12, Math.floor(free - PINE - CLEAR * 2));
      const x = Math.round(from + (free - PINE - step) / 2);
      const three = (seed + i) % 2 === 0;
      const rows = three ? [[0, -36], [step, -8], [0, 20]] : [[0, -24], [step, 8]];
      for (const [dx, dy] of rows) out.push({ name: "tile-pine", x: x + dx, y: p.y + dy, w: PINE, h: PINE });
    } else {
      out.push({ name: pick.name, x: Math.round(from + (free - pick.w) / 2), y: p.y - pick.h / 2, w: pick.w, h: pick.h });
    }
  });
  if (points.length) {
    const edge = 6;
    const corner = (left: boolean) => (left ? edge : W - CARABAO.w - edge);
    out.push({ ...CARABAO, x: corner(points[0].x >= 50), y: worldHeight(points.length) - CARABAO.h - edge });
    out.push({ ...CARABAO, x: corner(points[points.length - 1].x < 50), y: BAR_PX });
  }
  return out;
}

/** The first level of the world not done yet: it's the one lit up, and where a World tab scrolls to. */
export function nextLevel(list: readonly Level[]): string | null {
  return list.find((l) => !l.done)?.row.key ?? null;
}

/** The world to open on: where the group is now, else the first day with a level not done, else day 1. */
export function startWorld(guide: Guide, marks: readonly Mark[]): number {
  const here = whereNow(guide, marks);
  if (here) return here.day;
  const byKey = new Map(marks.map((m) => [m.key, m]));
  const open = guide.days.find((d) => levels(d, byKey).some((l) => !l.done));
  return open?.day ?? guide.days[0]?.day ?? 1;
}

/** A Google Maps search for a level's place, by its name (spots outside the city, like BenCab, still resolve). */
export function placeMapsUrl(name: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name}, Benguet, Philippines`)}`;
}
