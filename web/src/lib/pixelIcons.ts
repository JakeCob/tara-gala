// TG-49 tab icons: 16 by 16 one-colour pixel drawings, one character per pixel ("#" filled, "." empty). They are drawn
// in currentColor, so they follow the theme and the current tab's colour, unlike the full-colour sprites, which need
// their light plate (ux-guide 1.3).

import type { TabHref } from "./tabs.ts";

export const ICON_SIZE = 16;

export const TAB_ICONS: Record<TabHref, readonly string[]> = {
  // A provincial bus, side on: windows, the windscreen at the front, two wheels
  "/buses": [
    "................",
    "................",
    "................",
    ".#############..",
    "###############.",
    "#..#..#..#..####",
    "#..#..#..#..####",
    "################",
    "################",
    "################",
    ".####....####...",
    ".####....####...",
    "..##......##....",
    "................",
    "................",
    "................",
  ],
  // A map pin: where the trip goes
  "/plan": [
    "................",
    ".....######.....",
    "....########....",
    "...###....###...",
    "...##......##...",
    "...##......##...",
    "...###....###...",
    "....########....",
    ".....######.....",
    "......####......",
    "......####......",
    ".......##.......",
    ".......##.......",
    "................",
    "..############..",
    "................",
  ],
  // A pine: Baguio, the City of Pines
  "/baguio": [
    ".......##.......",
    "......####......",
    ".....######.....",
    "......####......",
    ".....######.....",
    "....########....",
    ".....######.....",
    "....########....",
    "...##########...",
    "..############..",
    "...##########...",
    ".##############.",
    ".......##.......",
    ".......##.......",
    ".......##.......",
    "................",
  ],
  // A wallet with its clasp
  "/wallet": [
    "................",
    "................",
    "................",
    "..##########....",
    ".############...",
    "################",
    "################",
    "###########....#",
    "###########.##.#",
    "###########.##.#",
    "###########....#",
    "################",
    "################",
    ".##############.",
    "................",
    "................",
  ],
};

/** One SVG path for a drawing: each horizontal run of "#" becomes a 1-pixel-tall rectangle. */
export function iconPath(rows: readonly string[]): string {
  const parts: string[] = [];
  rows.forEach((row, y) => {
    for (const m of row.matchAll(/#+/g)) parts.push(`M${m.index} ${y}h${m[0].length}v1h-${m[0].length}z`);
  });
  return parts.join("");
}
