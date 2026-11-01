// TG-52: the trip as a game level map (owner, 2026-11-02: "a level map like a game and each level be like a checkbox",
// after their pixel ROAD MAP reference). One world per day; each row of the day is a level on a road that winds up the
// screen from START to GOAL. Pure geometry here, so it's tested without a browser.

import { type Guide, type GuideDay, type GuideRow, type Mark, rowMark, rowShows, whereNow } from "./guide.ts";

export const GAP_PX = 112; // between two levels, up the screen
export const PAD_PX = 96; // room for START below the first level and GOAL above the last
export const TILE_PX = 64;
export const COLUMNS = [28, 72] as const; // the road zig-zags between these, as % of the width

export type Level = { row: GuideRow; label: string; done: boolean };
export type Point = { x: number; y: number }; // x in % of the width, y in px from the top

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

export const GOAL_POINT: Point = { x: 50, y: 24 };

/** The road from START through every level to GOAL: S-curves between points, in a 100-wide box. */
export function roadPath(points: readonly Point[], start: Point, goal: Point): string {
  const all = [start, ...points, goal];
  let d = `M ${all[0].x} ${all[0].y}`;
  for (let i = 1; i < all.length; i++) {
    const a = all[i - 1];
    const b = all[i];
    const mid = (a.y + b.y) / 2;
    d += ` C ${a.x} ${mid} ${b.x} ${mid} ${b.x} ${b.y}`;
  }
  return d;
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
