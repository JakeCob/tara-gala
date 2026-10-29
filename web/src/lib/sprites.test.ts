// TG-33: the sprite manifest, the committed placeholder files and their grids.
// Names and sizes come from a parse of web/sprites-src/art-prompts.md (a byte copy of _team/art-prompts.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gridToSvg, parseGrid } from "./pixelSvg.ts";
import type { Grid } from "./pixelSvg.ts";
import { gridPixels, rasterize } from "./pixelSvg.testutil.ts";
import type { Pixels } from "./pixelSvg.testutil.ts";
import { decodePng, paletteProblems } from "./png.testutil.ts";
import {
  CHIBI_FRAMES, LAST_MILE_MODES, PASSENGER_TYPES, PNG_ART, SPOT_CATEGORIES, SPRITES,
  chibi, modeSprite, placeSprite, spriteSrc,
} from "./sprites.ts";
import type { SpriteName } from "./sprites.ts";

type Size = { w: number; h: number };

const path = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const SPRITE_DIR = path("../../public/sprites/");
const GRID_DIR = path("../../sprites-src/");
const PUBLIC_DIR = path("../../public/");
const ART_LIST = path("../../sprites-src/art-prompts.md");
const SCHEMA = path("../../../supabase/schema.sql");

const PALETTE_HEXES = ["#1d2a24", "#167856", "#5fb36b", "#cfe8c4", "#fbf7ee", "#ffd65c"];
const INK = "#1d2a24";
const TYPES = ["adult", "student", "senior", "pwd"] as const;
const FRAMES = ["idle-1", "idle-2", "wave"] as const;
const PLACES = ["terminal", "lodging", "park", "food", "market", "museum", "viewpoint", "shopping", "church", "cafe", "other"];
const VEHICLES = ["vehicle-bus", "mode-jeep", "mode-taxi", "mode-tricycle", "mode-van", "mode-grab"];
const OPAQUE_TILES = ["tile-grass", "tile-path-straight", "tile-path-corner", "tile-road", "tile-water"];

// The 2026-10-29 art drop (_team/tickets/TG-33/art-drop.md): these 35 ship as PNG (the owner's SHIP-AS-PNG.txt),
// and these 8 stay hand-made SVG (AI output too noisy or unclear, or seamless map tiles the map tests rely on).
const ART_DROP = [
  ...TYPES.flatMap((t) => FRAMES.map((f) => `chibi-${t}-${f}`)),
  "logo-wordmark", "mode-grab", "mode-jeep", "mode-taxi", "mode-tricycle", "mode-walk",
  ...PLACES.map((p) => `place-${p}`),
  "tile-mountain", "tile-pine", "ui-badge-verified", "ui-heart", "ui-star", "vehicle-bus",
];
const KEPT_SVG = [
  "ui-dialog-frame", "ui-cursor", "tile-grass", "tile-path-straight", "tile-path-corner", "tile-road", "tile-water", "mode-van",
];
// TG-45 Philippine decor (_team/tickets/TG-45/ticket.md, the owner's ~/tara-art/ph/SHIP.txt): 10 decorative PNGs from the
// same pipeline, in the ticket's table order. The two chibis are decor, not passenger types. sha256 is pinned so a
// silent re-export (or two same-size files swapped) shows up; the values are in TG-45/build-log.md.
const PH_DROP = new Map([
  ["deco-sun-stars", { w: 24, h: 24, sha256: "26b989060be4bf1baa355be5d3ed3bc13a3b2ddd8cff981d939ab773f361531e" }],
  ["deco-carabao", { w: 32, h: 24, sha256: "07eb059e0a3e41fbd5da400276cc9991fb8e8ae301985805c787c6707477a744" }],
  ["deco-bahay-kubo", { w: 24, h: 24, sha256: "f0cfddbcc92ae874e11ccc31724721e6fd861185d6855ab0de91d06c10180117" }],
  ["chibi-barong", { w: 32, h: 32, sha256: "c5038d76a32ac640c6673be1898934a540fc8865e26136b6e8fc6a2f4f5c285d" }],
  ["chibi-filipiniana", { w: 32, h: 32, sha256: "e5355982c80bc543250ee38a8556624e5ffde6be172681d7338a616ac5cdfe9c" }],
  ["deco-taho-vendor", { w: 32, h: 32, sha256: "6820afdbe38cffbead35b38f17f7ed96d5d730c9e59dabbcece9a5becb126c98" }],
  ["deco-parol", { w: 16, h: 16, sha256: "eedad4b29ecd30af0e44621a7eef66d467c75b26c85103bcb2d6879ef909c137" }],
  ["deco-sampaguita", { w: 16, h: 16, sha256: "5b4cf375a9fde3fd128797749a177876b4f8981940277be7cd8e7c8ad0b4b115" }],
  ["deco-rice-terraces", { w: 24, h: 24, sha256: "5ba90f536e9ca07cb2c1b91c545c6bc697d364e86d3c8ef3538b40728238e1c0" }],
  ["deco-panagbenga-float", { w: 32, h: 24, sha256: "75ff7f59244fcbaaa5011a5b84b95aee85242e095d0f6309c191c838203513b1" }],
]);
const PH_NAMES = [...PH_DROP.keys()];
const PNG_CHUNKS = ["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]; // nothing else: no text, time or colour-profile metadata

// ux.md section 1: art-list entries that are not shipped as sprites, each with its reason.
const EXCLUDED = new Map([
  ["ref-style-sheet", "a style reference for the owner, not shipped"],
  ["chibi-{type}-walk-1..4", "optional walk cycle; nothing references it until art exists"],
  ["icon-app", "ships as the existing icon-192.png, icon-512.png and apple-touch-icon.png"],
]);

// --- helpers ----------------------------------------------------------------------------------------

// Every `name.png` in the art list with its size: a table cell or inline WxH after the names, else the
// section's **WxH px** line. Shorthand like `-idle-2.png` reuses the row's first full name minus its frame.
function parseArtList(md: string): Map<string, Size> {
  const out = new Map<string, Size>();
  let section: Size | null = null;
  for (const line of md.split("\n")) {
    if (line.startsWith("## ")) section = null;
    const sec = line.match(/^\*\*(\d+)×(\d+) px\*\*/);
    if (sec) section = { w: Number(sec[1]), h: Number(sec[2]) };
    const found = [...line.matchAll(/`([^`]+)\.png`/g)];
    if (!found.length) continue;
    const after = line.slice(found.at(-1)!.index! + found.at(-1)![0].length);
    const inline = after.match(/(\d+)×(\d+)/);
    const size = inline ? { w: Number(inline[1]), h: Number(inline[2]) } : section;
    if (!size) throw new Error(`no size for: ${line}`);
    // `chibi-adult-idle-1.png`, `-idle-2.png`, `-wave.png`: the first shorthand fixes the prefix (chibi-adult)
    const first = found[0][1];
    const shorthand = found.find((m) => m[1].startsWith("-"))?.[1];
    const prefix = shorthand ? first.split("-").slice(0, -shorthand.slice(1).split("-").length).join("-") : "";
    for (const [, raw] of found) out.set(raw.startsWith("-") ? prefix + raw : raw, size);
  }
  return out;
}

function pngHeader(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b.writeUInt8(8, 24); // bit depth; colour type etc. left 0; CRC not checked
  return b;
}

function pngSize(buf: Buffer): Size | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 24 || sig.some((v, i) => buf[i] !== v) || buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

// The sprite dir must hold exactly one file per manifest name (.png if in pngArt, else .svg), plus README.md.
function checkDir(dir: string, manifest: Record<string, Size>, pngArt: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const files = new Set<string>();
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile()) files.add(e.name);
    else problems.push(`${e.name}: not a plain file`);
  }
  const known = new Set(["README.md"]);
  for (const [name, size] of Object.entries(manifest)) {
    const svg = `${name}.svg`;
    const png = `${name}.png`;
    known.add(svg).add(png);
    const wantPng = pngArt.has(name);
    if (files.has(svg) && files.has(png)) problems.push(`${name}: both ${svg} and ${png} exist`);
    if (wantPng && !files.has(png)) problems.push(`${png}: missing (${name} is in PNG_ART)`);
    if (!wantPng && !files.has(svg)) problems.push(`${svg}: missing`);
    if (wantPng && files.has(svg) && !files.has(png)) problems.push(`${svg}: ${name} is in PNG_ART, expected ${png}`);
    if (!wantPng && files.has(png)) problems.push(`${png}: not in PNG_ART`);
    if (wantPng && files.has(png)) {
      const got = pngSize(readFileSync(join(dir, png)));
      if (!got) problems.push(`${png}: not a PNG (bad signature or IHDR)`);
      else if (got.w !== size.w || got.h !== size.h) problems.push(`${png}: IHDR is ${got.w}x${got.h}, expected ${size.w}x${size.h}`);
    }
  }
  for (const f of files) if (!known.has(f)) problems.push(`${f}: not in the manifest`);
  return problems;
}

function manifestNames(): SpriteName[] {
  const names = Object.keys(SPRITES) as SpriteName[];
  assert.equal(names.length, 53, "the manifest must list all 53 sprites");
  return names;
}

function svgNames(): SpriteName[] {
  return manifestNames().filter((n) => !PNG_ART.has(n));
}

const readSvg = (name: string) => readFileSync(join(SPRITE_DIR, `${name}.svg`), "utf8");
const grid = (name: string): Grid => parseGrid(readFileSync(join(GRID_DIR, `${name}.txt`), "utf8"), `${name}.txt`);
const pixels = (name: string): Pixels => {
  const g = grid(name);
  return gridPixels(g.rows, g.scale);
};
const mask = (p: Pixels) => p.map((row) => row.map((c) => (c === null ? "." : "#")).join("")).join("\n");
const lowestRow = (p: Pixels) => p.findLastIndex((row) => row.some((c) => c !== null));
const column = (p: Pixels, x: number) => p.map((row) => row[x]);
// The grid-based art rules hold the placeholders to ux.md section 3. Once a sprite is swapped for PNG art (PNG_ART),
// its grid is gone and the art is checked by its IHDR size instead, so these rules skip it.
const placeholders = (...names: string[]) => names.every((n) => !PNG_ART.has(n as SpriteName));

// --- T33-1 the art list and the manifest ------------------------------------------------------------

test("the art-list parser finds all 56 entries (53 sprites + 3 exclusions)", () => {
  const art = parseArtList(readFileSync(ART_LIST, "utf8"));
  assert.equal(art.size, 56, [...art.keys()].join(", "));
  for (const [name, { w, h }] of PH_DROP) assert.deepEqual(art.get(name), { w, h }, `${name} in section 7 (TG-45)`);
  assert.deepEqual(art.get("ref-style-sheet"), { w: 512, h: 512 });
  assert.deepEqual(art.get("chibi-{type}-walk-1..4"), { w: 32, h: 32 });
  assert.deepEqual(art.get("icon-app"), { w: 512, h: 512 });
  assert.deepEqual(art.get("ui-dialog-frame"), { w: 24, h: 24 });
  for (const t of TYPES) for (const f of FRAMES) assert.deepEqual(art.get(`chibi-${t}-${f}`), { w: 32, h: 32 }, `chibi-${t}-${f}`);
  for (const name of art.keys()) {
    if (!EXCLUDED.has(name)) assert.match(name, /^[a-z]+(-[a-z0-9]+)+$/, `odd parsed name ${name}`);
  }
});

test("the manifest covers every art-list name and size, minus the documented exclusions", () => {
  const art = parseArtList(readFileSync(ART_LIST, "utf8"));
  for (const name of EXCLUDED.keys()) assert.ok(art.has(name), `excluded ${name} is in the art list`);
  for (const [name, size] of art) {
    if (EXCLUDED.has(name)) {
      assert.ok(!(name in SPRITES), `${name} is excluded: ${EXCLUDED.get(name)}`);
      continue;
    }
    assert.deepEqual(SPRITES[name as SpriteName], size, `${name} size`);
  }
  for (const name of Object.keys(SPRITES)) assert.ok(art.has(name), `${name} is not in the art list`);
  assert.equal(Object.keys(SPRITES).length, 53);
});

test("the irregular sizes are right", () => {
  assert.deepEqual(SPRITES["ui-dialog-frame" as SpriteName], { w: 24, h: 24 });
  assert.deepEqual(SPRITES["vehicle-bus" as SpriteName], { w: 48, h: 24 });
  assert.deepEqual(SPRITES["mode-walk" as SpriteName], { w: 16, h: 16 });
  assert.deepEqual(SPRITES["mode-jeep" as SpriteName], { w: 24, h: 16 });
  assert.deepEqual(SPRITES["logo-wordmark" as SpriteName], { w: 192, h: 48 });
});

// --- T33-2b the app icons stand in for icon-app (guard) ---------------------------------------------

test("icon-app maps to the existing app icons", () => {
  for (const [file, side] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180]] as const) {
    assert.deepEqual(pngSize(readFileSync(join(PUBLIC_DIR, file))), { w: side, h: side }, file);
  }
});

test("the app icons are the art-drop icon: 512, 192 and 180 PNGs in the 6-colour palette", async (t) => {
  for (const [file, side] of [["icon-512.png", 512], ["icon-192.png", 192], ["apple-touch-icon.png", 180]] as const) {
    await t.test(file, () => {
      const png = decodePng(readFileSync(join(PUBLIC_DIR, file)));
      assert.deepEqual({ w: png.w, h: png.h }, { w: side, h: side });
      assert.deepEqual(paletteProblems(png, PALETTE_HEXES), []);
      assert.deepEqual(png.chunks.filter((c) => !PNG_CHUNKS.includes(c)), [], "metadata chunks");
    });
  }
});

// --- T33-19 the art drop ------------------------------------------------------------------------------

test("PNG_ART is exactly the 35 art-drop names plus the 10 TG-45 decor names; the 8 kept placeholders stay SVG", () => {
  const names = manifestNames();
  assert.equal(ART_DROP.length, 35);
  assert.equal(PH_DROP.size, 10);
  assert.deepEqual([...ART_DROP, ...PH_NAMES, ...KEPT_SVG].sort(), [...names].sort(), "art drop + decor + kept SVG = the manifest");
  assert.deepEqual([...PNG_ART].sort(), [...ART_DROP, ...PH_NAMES].sort());
  for (const [name, { w, h }] of PH_DROP) assert.deepEqual(SPRITES[name as SpriteName], { w, h }, `${name}: the ticket's size`);
  for (const name of KEPT_SVG) assert.equal(spriteSrc(name as SpriteName), `/sprites/${name}.svg`);
});

test("every art-drop PNG is its manifest size, palette colours only, alpha 0 or 255, not empty, at most 4 KB", async (t) => {
  for (const name of [...ART_DROP, ...PH_NAMES]) {
    await t.test(name, () => {
      const file = join(SPRITE_DIR, `${name}.png`);
      assert.ok(existsSync(file), `${name}.png is missing`);
      const buf = readFileSync(file);
      assert.ok(buf.length <= 4096, `${buf.length} bytes`);
      const png = decodePng(buf);
      assert.deepEqual({ w: png.w, h: png.h }, SPRITES[name as SpriteName]);
      assert.deepEqual(paletteProblems(png, PALETTE_HEXES), []);
      assert.deepEqual(png.chunks.filter((c) => !PNG_CHUNKS.includes(c)), [], "metadata chunks");
      assert.ok(png.pixels.some(([, , , a]) => a === 255), "draws something");
    });
  }
});

test("T45-S3 the 10 decor PNGs are byte-for-byte the shipped art (sha256 pinned)", async (t) => {
  for (const [name, { sha256 }] of PH_DROP) {
    await t.test(name, () => {
      const file = join(SPRITE_DIR, `${name}.png`);
      assert.ok(existsSync(file), `${name}.png is missing`);
      assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"), sha256);
    });
  }
});

test("T45-S1 the decor chibis are not passenger types: chibi() never names them", () => {
  assert.deepEqual([...PASSENGER_TYPES], ["adult", "student", "senior", "pwd"]);
  assert.deepEqual([...CHIBI_FRAMES], ["idle-1", "idle-2", "wave"]);
  const named = new Set(PASSENGER_TYPES.flatMap((t) => CHIBI_FRAMES.map((f) => chibi(t, f))));
  for (const name of PH_NAMES) assert.ok(!named.has(name as SpriteName), `${name} is a chibi() result`);
  assert.equal(named.size, 12);
});

test("each art-drop idle-2 is its idle-1 one pixel lower", async (t) => {
  const clear = (p: number[]) => (p[3] === 0 ? "." : p.join(","));
  for (const type of TYPES) {
    await t.test(type, () => {
      const [one, two] = ["idle-1", "idle-2"].map((f) => decodePng(readFileSync(join(SPRITE_DIR, `chibi-${type}-${f}.png`))));
      const w = one.w;
      const lowered = [...Array(w).fill([0, 0, 0, 0]), ...one.pixels.slice(0, -w)];
      assert.deepEqual(two.pixels.map(clear), lowered.map(clear));
    });
  }
});

// UX review S1: the AI hair had Leaf speckles; rows 8-19 (hat brim, hair and face) carry no Leaf in the fixed art.
test("the senior's hair and face have no Leaf speckles (rows 8-19 of idle-1 and wave)", async (t) => {
  for (const name of ["chibi-senior-idle-1", "chibi-senior-wave"]) {
    await t.test(name, () => {
      const png = decodePng(readFileSync(join(SPRITE_DIR, `${name}.png`)));
      const leaf = png.pixels.flatMap(([r, g, b, a], i) => {
        const y = Math.floor(i / png.w);
        return a === 255 && y >= 8 && y <= 19 && r === 0x5f && g === 0xb3 && b === 0x6b ? [`(${i % png.w},${y})`] : [];
      });
      assert.deepEqual(leaf, []);
    });
  }
});

test("decodePng and paletteProblems catch what the art test relies on", () => {
  const png = (w: number, h: number, colourType: number, rows: number[][], extra: Buffer[] = []) => {
    const chunk = (type: string, body: Buffer) => {
      const b = Buffer.alloc(12 + body.length);
      b.writeUInt32BE(body.length, 0);
      b.write(type, 4, "ascii");
      body.copy(b, 8);
      return b; // CRC left 0: the decoder doesn't check it
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = colourType;
    const raw = Buffer.concat(rows.map((r) => Buffer.from([0, ...r])));
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), ...extra,
      chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  };
  const ok = decodePng(png(2, 1, 6, [[0x1d, 0x2a, 0x24, 255, 9, 9, 9, 0]]));
  assert.deepEqual([ok.w, ok.h, ok.pixels.length], [2, 1, 2]);
  assert.deepEqual(paletteProblems(ok, PALETTE_HEXES), [], "palette colour + fully transparent off-palette pixel");
  assert.deepEqual(paletteProblems(decodePng(png(1, 1, 6, [[0x1d, 0x2a, 0x24, 128]])), PALETTE_HEXES), ["alpha 128 at (0,0)"]);
  assert.deepEqual(paletteProblems(decodePng(png(1, 1, 2, [[0x28, 0x3c, 0x50]])), PALETTE_HEXES), ["#283c50 off-palette"]);
  const text = Buffer.from([0, 0, 0, 1, 0x74, 0x45, 0x58, 0x74, 0x41, 0, 0, 0, 0]); // a 1-byte tEXt chunk
  assert.ok(decodePng(png(1, 1, 2, [[0x1d, 0x2a, 0x24]], [text])).chunks.includes("tEXt"));
  const deep = png(1, 1, 2, [[0, 0, 0]]);
  deep[24] = 16; // IHDR bit depth
  assert.throws(() => decodePng(deep), /unsupported PNG: depth 16/);
  assert.throws(() => decodePng(Buffer.from("GIF89a")), /not a PNG/);
});

// --- T33-3 the sprite dir matches the manifest ------------------------------------------------------

test("the sprite dir holds exactly one file per manifest name, plus README.md", () => {
  manifestNames();
  assert.deepEqual(checkDir(SPRITE_DIR, SPRITES, PNG_ART), []);
});

// --- T33-4 to T33-7 per-SVG rules -----------------------------------------------------------------

const grammar = ({ w, h }: Size) => new RegExp(
  `^<svg xmlns="http://www\\.w3\\.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">` +
  `(?:<path fill="#[0-9a-f]{6}" d="[MmHhVvZz0-9 ]+"/>|<rect x="\\d+" y="\\d+" width="\\d+" height="\\d+" fill="#[0-9a-f]{6}"/>)+` +
  `</svg>\\n?$`,
);

test("every SVG matches the strict whole-file grammar (size, crispEdges, only svg/path/rect)", async (t) => {
  for (const name of svgNames()) {
    await t.test(name, () => assert.match(readSvg(name), grammar(SPRITES[name])));
  }
});

test("every SVG is within its byte budget, and the dir totals at most 100 KB", async (t) => {
  let total = 0;
  for (const name of svgNames()) {
    const bytes = statSync(join(SPRITE_DIR, `${name}.svg`)).size;
    total += bytes;
    await t.test(name, () => assert.ok(bytes <= (name === "logo-wordmark" ? 8192 : 4096), `${bytes} bytes`));
  }
  assert.ok(total <= 102_400, `total ${total} bytes`);
});

test("no SVG holds a script, an external reference or raster bytes", async (t) => {
  const banned = ["<script", "javascript:", "data:", "base64", "url(", "href", "xlink", "@import", "<image", "<foreignobject", "<!", "<?"];
  for (const name of svgNames()) {
    await t.test(name, () => {
      const buf = readFileSync(join(SPRITE_DIR, `${name}.svg`));
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
      assert.ok(text.startsWith("<svg"), "starts with <svg");
      for (const sig of [[0x89, 0x50, 0x4e, 0x47], [0x47, 0x49, 0x46], [0xff, 0xd8, 0xff], [0x52, 0x49, 0x46, 0x46]]) {
        assert.ok(!sig.every((v, i) => buf[i] === v), "raster signature");
      }
      const lower = text.toLowerCase();
      for (const b of banned) assert.ok(!lower.includes(b), `contains ${b}`);
      const withoutNs = lower.replace('<svg xmlns="http://www.w3.org/2000/svg"', "<svg");
      assert.ok(!/https?:/.test(withoutNs), "a URL other than the root xmlns");
    });
  }
});

test("every SVG uses only palette colours, one path per colour, and draws each pixel once inside the box", async (t) => {
  for (const name of svgNames()) {
    await t.test(name, () => {
      const svg = readSvg(name);
      const elements = [...svg.matchAll(/<(path|rect)\b[^>]*\/>/g)].map((m) => m[0]);
      assert.ok(elements.length > 0, "draws something");
      const fills = elements.map((el) => el.match(/\bfill="([^"]*)"/)?.[1]);
      for (const f of fills) assert.ok(f !== undefined && PALETTE_HEXES.includes(f), `fill ${f}`);
      const pathFills = [...svg.matchAll(/<path fill="([^"]*)"/g)].map((m) => m[1]);
      assert.equal(new Set(pathFills).size, pathFills.length, "a colour appears in more than one path");
      const r = rasterize(svg, name);
      assert.deepEqual(r.problems, []);
      assert.deepEqual({ w: r.w, h: r.h }, SPRITES[name]);
      if (/^(chibi|place|vehicle|mode)-/.test(name)) assert.ok(fills.includes(INK), "uses the Ink outline colour");
    });
  }
});

// --- T33-10 grids are the source --------------------------------------------------------------------

test("every committed SVG is exactly gridToSvg(its grid), at the manifest size", async (t) => {
  const names = svgNames();
  const gridFiles = readdirSync(GRID_DIR).filter((f) => f.endsWith(".txt")).map((f) => f.slice(0, -4)).sort();
  assert.deepEqual(gridFiles, [...names].sort(), "one grid per SVG sprite, none for PNG_ART names");
  const others = readdirSync(GRID_DIR).filter((f) => !f.endsWith(".txt")).sort();
  assert.deepEqual(others, ["art-prompts.md", "build.ts"]);
  for (const name of names) {
    await t.test(name, () => {
      const g = grid(name);
      assert.deepEqual({ w: g.w, h: g.h }, SPRITES[name]);
      assert.equal(g.rows[0].length * g.scale, g.w);
      assert.equal(g.rows.length * g.scale, g.h);
      assert.equal(gridToSvg(g), readSvg(name));
    });
  }
});

// --- T33-11 anchors -----------------------------------------------------------------------------------

test("chibis stand on row 30 (idle-2 one lower), centred on x 15.5", async (t) => {
  for (const type of TYPES) {
    await t.test(type, () => {
      if (!placeholders(...FRAMES.map((f) => `chibi-${type}-${f}`))) return;
      const idle1 = pixels(`chibi-${type}-idle-1`);
      assert.equal(lowestRow(idle1), 30, "idle-1 lowest row");
      assert.equal(lowestRow(pixels(`chibi-${type}-wave`)), 30, "wave lowest row");
      assert.equal(lowestRow(pixels(`chibi-${type}-idle-2`)), type === "pwd" ? 30 : 31, "idle-2 lowest row (the chair doesn't move)");
      const xs = idle1.flatMap((row) => row.flatMap((c, x) => (c === null ? [] : [x])));
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
      assert.ok(Math.abs(mean - 15.5) <= 1, `mean x ${mean.toFixed(2)}`);
    });
  }
});

test("idle-2 is idle-1 one pixel lower; for PWD only the body above the seat moves", async (t) => {
  for (const type of TYPES) {
    await t.test(type, () => {
      if (!placeholders(`chibi-${type}-idle-1`, `chibi-${type}-idle-2`)) return;
      const one = grid(`chibi-${type}-idle-1`).rows;
      const two = grid(`chibi-${type}-idle-2`);
      const blank = ".".repeat(one[0].length);
      if (type !== "pwd") {
        assert.deepEqual(two.rows, [blank, ...one.slice(0, -1)]);
        return;
      }
      const seat = Number(two.headers.seat);
      assert.ok(Number.isInteger(seat) && seat > 0 && seat < 31, "PWD idle-2 declares seat=N");
      assert.equal(grid("chibi-pwd-idle-1").headers.seat, two.headers.seat, "both PWD idles declare the same seat");
      assert.deepEqual(two.rows.slice(seat), one.slice(seat), "the chair (seat row and below) stays still");
      assert.deepEqual(two.rows.slice(0, seat), [blank, ...one.slice(0, seat - 1)], "the body above the seat drops 1px");
    });
  }
});

test("places sit on row 23", async (t) => {
  for (const place of PLACES) {
    await t.test(place, () => {
      if (placeholders(`place-${place}`)) assert.equal(lowestRow(pixels(`place-${place}`)), 23);
    });
  }
});

test("vehicles touch the bottom row (mode-walk footprints are exempt but not empty)", async (t) => {
  for (const name of VEHICLES) {
    await t.test(name, () => {
      if (!placeholders(name)) return;
      const p = pixels(name);
      assert.equal(lowestRow(p), p.length - 1);
    });
  }
  if (placeholders("mode-walk")) assert.ok(lowestRow(pixels("mode-walk")) >= 0);
});

// --- T33-12 seamless tiles and the 9-slice frame -----------------------------------------------------

test("ground tiles are opaque; pine and mountain are drawn over grass", async (t) => {
  for (const name of OPAQUE_TILES) {
    await t.test(name, () => {
      if (placeholders(name)) assert.ok(pixels(name).every((row) => row.every((c) => c !== null)), "a transparent pixel");
    });
  }
  for (const name of ["tile-pine", "tile-mountain"]) {
    await t.test(name, () => {
      if (placeholders(name)) assert.ok(pixels(name).some((row) => row.some((c) => c === null)));
    });
  }
});

test("tiles repeat without seams", () => {
  for (const name of ["tile-path-straight", "tile-road", "tile-water"].filter((n) => placeholders(n))) {
    const p = pixels(name);
    assert.deepEqual(p[0], p[15], `${name}: row 0 = row 15`);
  }
  if (placeholders("tile-water")) {
    const water = pixels("tile-water");
    assert.deepEqual(column(water, 0), column(water, 15), "tile-water: column 0 = column 15");
  }
  if (placeholders("tile-grass")) {
    const grass = pixels("tile-grass");
    const edges = [...grass[0], ...grass[15], ...column(grass, 0), ...column(grass, 15)];
    assert.ok(!edges.includes("#5fb36b"), "tile-grass: no Leaf on an edge");
  }
});

test("a rotated path corner joins a straight path", () => {
  if (!placeholders("tile-path-straight", "tile-path-corner")) return;
  const straight = pixels("tile-path-straight");
  const corner = pixels("tile-path-corner");
  assert.deepEqual(corner[15], straight[15], "corner bottom row = straight bottom row");
  assert.deepEqual(column(corner, 15), straight[15], "corner right column = straight bottom row");
});

test("ui-dialog-frame stretches cleanly as a 9-slice with 8px corners", () => {
  if (!placeholders("ui-dialog-frame")) return;
  const p = pixels("ui-dialog-frame");
  const uniform = (cells: (string | null)[], what: string) => assert.equal(new Set(cells).size, 1, what);
  for (let y = 0; y < 24; y++) {
    if (y < 8 || y >= 16) uniform(p[y].slice(8, 16), `row ${y}, columns 8-15`);
  }
  for (let x = 0; x < 24; x++) {
    if (x < 8 || x >= 16) uniform(column(p, x).slice(8, 16), `column ${x}, rows 8-15`);
  }
  uniform(p.slice(8, 16).flatMap((row) => row.slice(8, 16)), "the centre");
});

// --- T33-18 silhouettes differ by shape --------------------------------------------------------------

test("the four chibi types differ by silhouette, and each wave differs from its idle", () => {
  const idles = TYPES.map((t) => `chibi-${t}-idle-1`).filter((n) => placeholders(n));
  const masks = idles.map((n) => mask(pixels(n)));
  assert.equal(new Set(masks).size, idles.length, "two chibi types share a silhouette");
  for (const t of TYPES) {
    const [wave, idle] = [`chibi-${t}-wave`, `chibi-${t}-idle-1`];
    if (placeholders(wave, idle)) assert.notEqual(mask(pixels(wave)), mask(pixels(idle)), `${t} wave`);
  }
  if (placeholders("mode-taxi", "mode-grab")) {
    assert.notEqual(mask(pixels("mode-taxi")), mask(pixels("mode-grab")), "taxi and grab share a silhouette");
  }
});

// --- T33-13 lookups ---------------------------------------------------------------------------------

test("chibi() names every type x frame", () => {
  for (const t of TYPES) {
    for (const f of FRAMES) {
      const name = chibi(t, f);
      assert.equal(name, `chibi-${t}-${f}`);
      assert.ok(name in SPRITES);
    }
  }
});

test("placeSprite() maps categories, terminal and lodging; anything else is place-other", () => {
  for (const p of PLACES) assert.equal(placeSprite(p), `place-${p}`);
  for (const odd of ["", "Park", "park ", "unknown", "__proto__", "constructor", "toString", "hasOwnProperty"]) {
    assert.equal(placeSprite(odd), "place-other", JSON.stringify(odd));
  }
});

test("modeSprite() maps the six modes; anything else is null", () => {
  for (const m of ["jeep", "taxi", "walk", "tricycle", "van", "grab"]) assert.equal(modeSprite(m), `mode-${m}`);
  for (const odd of ["", "Jeep", "bus", "vehicle-bus", "__proto__", "toString", "constructor"]) {
    assert.equal(modeSprite(odd), null, JSON.stringify(odd));
  }
});

test("spriteSrc() gives /sprites/<name>.svg, or .png once the name is in PNG_ART", () => {
  for (const name of manifestNames()) {
    assert.equal(spriteSrc(name), `/sprites/${name}.${PNG_ART.has(name) ? "png" : "svg"}`);
  }
  const art = PNG_ART as Set<SpriteName>;
  const before = new Set(art);
  const probe = manifestNames().find((n) => !art.has(n));
  if (probe) {
    art.add(probe);
    try {
      assert.equal(spriteSrc(probe), `/sprites/${probe}.png`);
    } finally {
      art.delete(probe);
    }
  }
  assert.deepEqual(new Set(art), before, "PNG_ART restored");
});

// --- T33-14 enums match the schema ------------------------------------------------------------------

function schemaEnum(sql: string, type: string): string[] {
  const m = sql.match(new RegExp(`create type ${type} as enum \\(([^;]*?)\\);`));
  assert.ok(m, `enum ${type} in schema.sql`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((v) => v[1]);
}

test("the enum lists equal the schema enums, in order", () => {
  const sql = readFileSync(SCHEMA, "utf8");
  const spots = schemaEnum(sql, "spot_category");
  const modes = schemaEnum(sql, "last_mile_mode");
  const passengers = schemaEnum(sql, "passenger_type");
  assert.deepEqual([spots.length, modes.length, passengers.length], [9, 6, 5], "parser sanity");
  assert.deepEqual([...SPOT_CATEGORIES], spots);
  assert.deepEqual([...LAST_MILE_MODES], modes);
  assert.ok(passengers.includes("child"));
  assert.deepEqual([...PASSENGER_TYPES], passengers.filter((p) => p !== "child"));
  assert.deepEqual([...CHIBI_FRAMES], FRAMES);
  for (const c of SPOT_CATEGORIES) assert.ok(`place-${c}` in SPRITES, `place-${c}`);
  for (const m of LAST_MILE_MODES) assert.ok(`mode-${m}` in SPRITES, `mode-${m}`);
});

// --- T33-15 the PNG art-drop path ---------------------------------------------------------------------

test("checkDir accepts a dropped PNG at the right size and names the file on every mistake", () => {
  const dir = mkdtempSync(join(tmpdir(), "tg33-"));
  const manifest = { x: { w: 32, h: 32 } };
  const art = new Set(["x"]);
  try {
    writeFileSync(join(dir, "x.png"), pngHeader(32, 32));
    assert.deepEqual(checkDir(dir, manifest, art), []);
    writeFileSync(join(dir, "x.png"), pngHeader(64, 64));
    assert.match(checkDir(dir, manifest, art).join("\n"), /x\.png: IHDR is 64x64/);
    writeFileSync(join(dir, "x.png"), pngHeader(32, 32).subarray(0, 20));
    assert.match(checkDir(dir, manifest, art).join("\n"), /x\.png: not a PNG/);
    writeFileSync(join(dir, "x.png"), Buffer.concat([Buffer.from("GIF89a"), pngHeader(32, 32).subarray(6)]));
    assert.match(checkDir(dir, manifest, art).join("\n"), /x\.png: not a PNG/);
    writeFileSync(join(dir, "x.png"), pngHeader(32, 32));
    writeFileSync(join(dir, "x.svg"), "<svg/>");
    assert.match(checkDir(dir, manifest, art).join("\n"), /x: both x\.svg and x\.png/);
    rmSync(join(dir, "x.png"));
    assert.match(checkDir(dir, manifest, art).join("\n"), /x\.svg: x is in PNG_ART/);
    assert.deepEqual(checkDir(dir, manifest, new Set()), []);
    writeFileSync(join(dir, "stray.svg"), "<svg/>");
    assert.match(checkDir(dir, manifest, new Set()).join("\n"), /stray\.svg: not in the manifest/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- T33-16 plain modules -----------------------------------------------------------------------------

test("sprites.ts and pixelSvg.ts are plain modules", () => {
  for (const file of ["./sprites.ts", "./pixelSvg.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /^\s*import\b/m, file);
    assert.doesNotMatch(source, /\bimport\s*\(/, file);
    assert.doesNotMatch(source, /use client/, file);
    assert.doesNotMatch(source, /\benum\s/, file);
    assert.doesNotMatch(source, /\bnamespace\s/, file);
  }
});

test("build.ts imports only node:* and the converter", () => {
  const source = readFileSync(join(GRID_DIR, "build.ts"), "utf8");
  const imports = [...source.matchAll(/^\s*import\b[^'"]*["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0);
  for (const spec of imports) assert.ok(spec.startsWith("node:") || spec === "../src/lib/pixelSvg.ts", spec);
  assert.doesNotMatch(source, /\bimport\s*\(/);
});

// --- T33-17 the sprites README ------------------------------------------------------------------------

test("the sprites README has the agreed text and a row per sprite", () => {
  const file = join(SPRITE_DIR, "README.md");
  assert.ok(existsSync(file), "web/public/sprites/README.md");
  const readme = readFileSync(file, "utf8");
  for (const line of [
    "Art: AI-generated with fal nano-banana, owner-approved, 2026-10-29.",
    "Names and sizes follow `web/sprites-src/art-prompts.md`. To swap in art: export PNGs at exactly the listed size (nearest-neighbour, 6-colour palette, transparent), copy them here with the same base name, add each name to `PNG_ART` in `web/src/lib/sprites.ts`, delete the matching `.svg`, and run the web tests.",
    "App icon: export `icon-app.png` over `web/public/icon-512.png`, `icon-192.png` and `apple-touch-icon.png` (180×180).",
    "Processing script: `process.py` in the owner's `~/tara-art/` (Pillow, so it stays outside the repo).",
    `Still SVG: ${KEPT_SVG.map((n) => `\`${n}\``).join(", ")}.`,
  ]) {
    assert.ok(readme.includes(line), `missing: ${line}`);
  }
  assert.ok(!readme.includes("Placeholders: hand-made pixel-art SVG"), "the placeholder-only intro is gone");
  for (const name of manifestNames()) {
    const { w, h } = SPRITES[name];
    const row = readme.split("\n").find((l) => l.startsWith("|") && l.includes(`\`${name}\``));
    assert.ok(row, `no table row for ${name}`);
    assert.ok(row.includes(`${w}×${h}`), `${name}: size ${w}×${h} in its row`);
    assert.ok(row.includes(PNG_ART.has(name) ? "| PNG |" : "| SVG |"), `${name}: format in its row`);
  }
});
