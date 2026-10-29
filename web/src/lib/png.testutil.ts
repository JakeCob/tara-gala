// Test helpers for the TG-33 art drop (not a test file, not used at runtime).
// decodePng() reads an 8-bit, non-interlaced PNG into RGBA pixels with node:zlib, so tests can check every pixel
// without an image dependency. Anything else (16-bit, interlaced, low bit depths) is reported, not guessed.
import { inflateSync } from "node:zlib";

export type Rgba = [number, number, number, number];
export type Png = { w: number; h: number; colourType: number; chunks: string[]; pixels: Rgba[] };

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }; // grey, RGB, palette, grey+alpha, RGBA

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(buf: Buffer): Png {
  if (buf.length < 8 || SIGNATURE.some((v, i) => buf[i] !== v)) throw new Error("not a PNG signature");
  const chunks: string[] = [];
  const data: Buffer[] = [];
  let ihdr: Buffer | null = null, plte: Buffer | null = null, trns: Buffer | null = null;
  for (let at = 8; at < buf.length; ) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString("ascii", at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + len);
    chunks.push(type);
    if (type === "IHDR") ihdr = body;
    else if (type === "PLTE") plte = body;
    else if (type === "tRNS") trns = body;
    else if (type === "IDAT") data.push(body);
    at += 12 + len;
  }
  if (!ihdr) throw new Error("no IHDR");
  const w = ihdr.readUInt32BE(0), h = ihdr.readUInt32BE(4);
  const [depth, colourType, , , interlace] = ihdr.subarray(8, 13);
  if (depth !== 8 || interlace !== 0 || !(colourType in CHANNELS)) {
    throw new Error(`unsupported PNG: depth ${depth}, colour type ${colourType}, interlace ${interlace}`);
  }
  if (colourType === 3 && !plte) throw new Error("palette PNG without PLTE");
  const bpp = CHANNELS[colourType];
  const stride = w * bpp;
  const raw = inflateSync(Buffer.concat(data));
  if (raw.length !== h * (stride + 1)) throw new Error(`pixel data is ${raw.length} bytes, expected ${h * (stride + 1)}`);
  const pixels: Rgba[] = [];
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Uint8Array.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      if (filter === 1) line[x] += a;
      else if (filter === 2) line[x] += b;
      else if (filter === 3) line[x] += (a + b) >> 1;
      else if (filter === 4) line[x] += paeth(a, b, c);
      else if (filter !== 0) throw new Error(`row ${y}: unknown filter ${filter}`);
    }
    for (let x = 0; x < w; x++) {
      const p = line.subarray(x * bpp, (x + 1) * bpp);
      if (colourType === 6) pixels.push([p[0], p[1], p[2], p[3]]);
      else if (colourType === 2) pixels.push([p[0], p[1], p[2], 255]);
      else if (colourType === 0) pixels.push([p[0], p[0], p[0], 255]);
      else if (colourType === 4) pixels.push([p[0], p[0], p[0], p[1]]);
      else {
        const i = p[0];
        if (i * 3 + 2 >= plte!.length) throw new Error(`palette index ${i} out of range`);
        pixels.push([plte![i * 3], plte![i * 3 + 1], plte![i * 3 + 2], trns && i < trns.length ? trns[i] : 255]);
      }
    }
    prev = line;
  }
  return { w, h, colourType, chunks, pixels };
}

const hex = (n: number) => n.toString(16).padStart(2, "0");

// Every rule broken by the pixels: a partly transparent pixel, or an opaque colour outside the palette.
export function paletteProblems(png: Png, palette: readonly string[]): string[] {
  const problems = new Set<string>();
  png.pixels.forEach(([r, g, b, a], i) => {
    const where = `(${i % png.w},${Math.floor(i / png.w)})`;
    if (a !== 0 && a !== 255) problems.add(`alpha ${a} at ${where}`);
    else if (a === 255 && !palette.includes(`#${hex(r)}${hex(g)}${hex(b)}`)) problems.add(`#${hex(r)}${hex(g)}${hex(b)} off-palette`);
  });
  return [...problems].slice(0, 5);
}
