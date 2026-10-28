// Pixel-art grids -> SVG (TG-33). Used by web/sprites-src/build.ts and the sprite tests; nothing imports it at runtime.
// Grid format (web/sprites-src/<name>.txt): `#` comments, then `size=WxH` (rendered pixels), optional `scale=N` and
// `seat=N` headers, then one row per line, one letter per cell from PALETTE, or `.` for transparent.

export const PALETTE = { I: "#1d2a24", F: "#167856", L: "#5fb36b", M: "#cfe8c4", C: "#fbf7ee", S: "#ffd65c" } as const;

export type Grid = { w: number; h: number; scale: number; rows: string[]; headers: Record<string, string> };

type Letter = keyof typeof PALETTE;
const HEADERS = ["size", "scale", "seat"];

export function parseGrid(text: string, name: string): Grid {
  const headers: Record<string, string> = {};
  const rows: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trimEnd();
    if (line === "" || line.startsWith("#")) return;
    const kv = line.match(/^([a-z]+)=(.*)$/);
    if (!kv) {
      rows.push(line);
      return;
    }
    if (rows.length) throw new Error(`${name}: row ${rows.length}, column 0: header "${kv[1]}" after the first grid row`);
    if (!HEADERS.includes(kv[1])) throw new Error(`${name}: line ${i + 1}: unknown header "${kv[1]}"`);
    headers[kv[1]] = kv[2].trim();
  });

  const scaleText = headers.scale ?? "1";
  if (!/^[1-9]\d*$/.test(scaleText)) throw new Error(`${name}: scale must be a positive integer, got "${scaleText}"`);
  const scale = Number(scaleText);
  const size = (headers.size ?? "").match(/^(\d+)x(\d+)$/);
  if (!size) throw new Error(`${name}: missing or malformed size=WxH header`);
  const [w, h] = [Number(size[1]), Number(size[2])];
  if (w % scale || h % scale) throw new Error(`${name}: size ${w}x${h} is not a multiple of scale ${scale}`);

  const cols = w / scale;
  if (rows.length !== h / scale) throw new Error(`${name}: row ${rows.length}: expected ${h / scale} rows for size ${w}x${h}`);
  rows.forEach((row, r) => {
    if (row.length !== cols) {
      throw new Error(`${name}: row ${r}, column ${Math.min(row.length, cols)}: expected ${cols} columns, got ${row.length}`);
    }
    [...row].forEach((ch, c) => {
      if (ch !== "." && !(ch in PALETTE)) throw new Error(`${name}: row ${r}, column ${c}: unknown letter "${ch}"`);
    });
  });
  return { w, h, scale, rows, headers };
}

// Does `row` hold exactly the run [x, x + len) of `ch`, with different cells (or the edge) on both sides?
function sameRun(row: string, x: number, len: number, ch: string): boolean {
  if (row[x - 1] === ch || row[x + len] === ch) return false;
  for (let i = x; i < x + len; i++) if (row[i] !== ch) return false;
  return true;
}

// One <path> per colour in PALETTE order. Each horizontal run of a letter merges with identical runs directly below
// it into one rectangle, written with absolute integer coordinates. Same input, same bytes.
export function gridToSvg(g: Grid): string {
  const s = g.scale;
  const height = g.rows.length;
  const used = g.rows.map((row) => Array<boolean>(row.length).fill(false));
  const rects: Record<string, string[]> = {};
  for (let y = 0; y < height; y++) {
    const row = g.rows[y];
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      let len = 1;
      while (row[x + len] === ch) len++;
      if (ch !== "." && !used[y][x]) {
        let depth = 1;
        while (y + depth < height && !used[y + depth][x] && sameRun(g.rows[y + depth], x, len, ch)) depth++;
        for (let dy = 0; dy < depth; dy++) for (let dx = 0; dx < len; dx++) used[y + dy][x + dx] = true;
        (rects[ch] ??= []).push(`M${x * s} ${y * s}h${len * s}v${depth * s}H${x * s}z`);
      }
      x += len;
    }
  }
  const paths = (Object.keys(PALETTE) as Letter[])
    .filter((ch) => rects[ch])
    .map((ch) => `<path fill="${PALETTE[ch]}" d="${rects[ch].join("")}"/>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${g.w}" height="${g.h}" viewBox="0 0 ${g.w} ${g.h}" shape-rendering="crispEdges">${paths}</svg>\n`;
}
