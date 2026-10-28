// Test helpers for TG-33 sprites (not a test file, not used at runtime).
// rasterize() reads an SVG back into pixels independently of gridToSvg, so tests can check what is drawn.

export type Pixels = (string | null)[][]; // [y][x] -> hex, or null for transparent

export type Raster = { w: number; h: number; pixels: Pixels; problems: string[] };

function blank(w: number, h: number): Pixels {
  return Array.from({ length: h }, () => Array<string | null>(w).fill(null));
}

function paint(r: Raster, x0: number, y0: number, x1: number, y1: number, fill: string, where: string): void {
  for (let y = Math.min(y0, y1); y < Math.max(y0, y1); y++) {
    for (let x = Math.min(x0, x1); x < Math.max(x0, x1); x++) {
      if (x < 0 || y < 0 || x >= r.w || y >= r.h) {
        r.problems.push(`${where}: pixel (${x}, ${y}) is outside ${r.w}x${r.h}`);
      } else if (r.pixels[y][x] !== null) {
        r.problems.push(`${where}: pixel (${x}, ${y}) is drawn twice (${r.pixels[y][x]} and ${fill})`);
      } else {
        r.pixels[y][x] = fill;
      }
    }
  }
}

// One subpath's corner points -> the rectangle it encloses, or null if it isn't an axis-aligned closed rectangle.
function asRect(points: [number, number][]): [number, number, number, number] | null {
  const pts = points.length > 1 && points[0][0] === points.at(-1)![0] && points[0][1] === points.at(-1)![1]
    ? points.slice(0, -1)
    : points;
  if (pts.length !== 4) return null;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % 4];
    if (ax !== bx && ay !== by) return null; // diagonal edge
  }
  const xs = new Set(pts.map((p) => p[0]));
  const ys = new Set(pts.map((p) => p[1]));
  if (xs.size !== 2 || ys.size !== 2) return null;
  const [x0, x1] = [...xs].sort((a, b) => a - b);
  const [y0, y1] = [...ys].sort((a, b) => a - b);
  return [x0, y0, x1, y1];
}

function tracePath(r: Raster, d: string, fill: string, where: string): void {
  const tokens = d.match(/[MmHhVvZz]|-?\d+(?:\.\d+)?/g) ?? [];
  let i = 0;
  let x = 0;
  let y = 0;
  let points: [number, number][] = [];
  const num = (): number => {
    const t = tokens[i++];
    if (t === undefined || !/^-?\d/.test(t)) throw new Error(`${where}: expected a number in path data`);
    return Number(t);
  };
  const close = () => {
    if (!points.length) return;
    const rect = asRect(points);
    if (!rect) r.problems.push(`${where}: a subpath is not an axis-aligned closed rectangle`);
    else paint(r, rect[0], rect[1], rect[2], rect[3], fill, where);
    points = [];
  };
  while (i < tokens.length) {
    const cmd = tokens[i++];
    switch (cmd) {
      case "M": close(); x = num(); y = num(); points = [[x, y]]; break;
      case "m": close(); x += num(); y += num(); points = [[x, y]]; break;
      case "H": x = num(); points.push([x, y]); break;
      case "h": x += num(); points.push([x, y]); break;
      case "V": y = num(); points.push([x, y]); break;
      case "v": y += num(); points.push([x, y]); break;
      case "Z": case "z": points.push(points[0]); close(); break;
      default: throw new Error(`${where}: unexpected path token ${cmd}`);
    }
  }
  if (points.length) r.problems.push(`${where}: a subpath is not closed with z`);
}

export function rasterize(svg: string, name = "svg"): Raster {
  const root = svg.match(/<svg\b[^>]*\bwidth="(\d+)"[^>]*\bheight="(\d+)"/);
  if (!root) throw new Error(`${name}: no root width/height`);
  const r: Raster = { w: Number(root[1]), h: Number(root[2]), pixels: [], problems: [] };
  r.pixels = blank(r.w, r.h);
  for (const el of svg.matchAll(/<(path|rect)\b([^>]*)\/>/g)) {
    const attrs = Object.fromEntries([...el[2].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
    const fill = attrs.fill;
    if (!fill) { r.problems.push(`${name}: a <${el[1]}> has no fill`); continue; }
    if (el[1] === "rect") {
      const [x0, y0, w, h] = ["x", "y", "width", "height"].map((k) => Number(attrs[k] ?? 0));
      paint(r, x0, y0, x0 + w, y0 + h, fill, name);
    } else {
      tracePath(r, attrs.d ?? "", fill, name);
    }
  }
  return r;
}

export const LETTERS: Record<string, string> = {
  I: "#1d2a24", F: "#167856", L: "#5fb36b", M: "#cfe8c4", C: "#fbf7ee", S: "#ffd65c",
};

// Grid rows (one letter per cell, "." transparent) at `scale` -> pixels.
export function gridPixels(rows: string[], scale = 1): Pixels {
  const out: Pixels = [];
  for (const row of rows) {
    const line = [...row].flatMap((ch) => Array<string | null>(scale).fill(ch === "." ? null : LETTERS[ch]));
    for (let k = 0; k < scale; k++) out.push([...line]);
  }
  return out;
}

// Grid text in the sprites-src format, for in-test fixtures.
export function gridText(rows: string[], headers: Record<string, string | number> = {}, comment = "# fixture"): string {
  return [comment, ...Object.entries(headers).map(([k, v]) => `${k}=${v}`), ...rows].join("\n") + "\n";
}
