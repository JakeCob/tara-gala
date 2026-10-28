// Pixel-art grid <-> SVG (TG-33). RED stub: implemented in GREEN.

export const PALETTE = { I: "#1d2a24", F: "#167856", L: "#5fb36b", M: "#cfe8c4", C: "#fbf7ee", S: "#ffd65c" } as const;

export type Grid = { w: number; h: number; scale: number; rows: string[]; headers: Record<string, string> };

export function parseGrid(text: string, name: string): Grid {
  throw new Error(`parseGrid not implemented (${name}, ${text.length} chars)`);
}

export function gridToSvg(g: Grid): string {
  throw new Error(`gridToSvg not implemented (${g.w}x${g.h})`);
}
