// TG-33: the grid -> SVG converter (T33-8) and grid parsing errors (T33-9). Fixtures are in-test only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PALETTE, gridToSvg, parseGrid } from "./pixelSvg.ts";
import { gridPixels, gridText, rasterize } from "./pixelSvg.testutil.ts";

const HEAD = (w: number, h: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">`;

function svgOf(rows: string[], headers: Record<string, string | number> = {}): string {
  const scale = Number(headers.scale ?? 1);
  const size = `${rows[0].length * scale}x${rows.length * scale}`;
  return gridToSvg(parseGrid(gridText(rows, { size, ...headers }), "fixture.txt"));
}

// --- T33-8 gridToSvg ------------------------------------------------------------------------------

test("two pixels give the exact pinned bytes", () => {
  assert.equal(
    svgOf(["IS"]),
    `${HEAD(2, 1)}<path fill="#1d2a24" d="M0 0h1v1H0z"/><path fill="#ffd65c" d="M1 0h1v1H1z"/></svg>\n`,
  );
});

test("paths follow palette order, whatever order the letters appear in, and unused colours have no path", () => {
  const svg = svgOf(["SCI"]);
  const fills = [...svg.matchAll(/fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
  assert.deepEqual(fills, [PALETTE.I, PALETTE.C, PALETTE.S]);
});

test("a horizontal run is one rectangle and stacked identical runs merge", () => {
  assert.equal(svgOf(["FFF", "FFF", "FFF"]), `${HEAD(3, 3)}<path fill="#167856" d="M0 0h3v3H0z"/></svg>\n`);
  assert.equal(svgOf(["L.L"]), `${HEAD(3, 1)}<path fill="#5fb36b" d="M0 0h1v1H0zM2 0h1v1H2z"/></svg>\n`);
});

test("runs merge only with identical runs below (same x and length)", () => {
  assert.equal(svgOf(["FF", "F."]), `${HEAD(2, 2)}<path fill="#167856" d="M0 0h2v1H0zM0 1h1v1H0z"/></svg>\n`);
});

test("transparent cells draw nothing", () => {
  assert.equal(svgOf([".I.", "..."]), `${HEAD(3, 2)}<path fill="#1d2a24" d="M1 0h1v1H1z"/></svg>\n`);
});

test("scale=4 makes each character 4x4 pixels", () => {
  assert.equal(svgOf(["F"], { scale: 4 }), `${HEAD(4, 4)}<path fill="#167856" d="M0 0h4v4H0z"/></svg>\n`);
});

test("output is deterministic", () => {
  const rows = ["IFL.", "MCS.", "IIII"];
  assert.equal(svgOf(rows), svgOf(rows));
});

test("rasterizing the output gives the grid back (3 seeded random 8x8 grids)", () => {
  let seed = 33;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
  const letters = ".IFLMCS";
  for (let n = 0; n < 3; n++) {
    const rows = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => letters[next() % letters.length]).join(""));
    const r = rasterize(svgOf(rows), `random-${n}`);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.pixels, gridPixels(rows), rows.join("/"));
  }
});

test("parseGrid returns size, scale, rows and headers", () => {
  const g = parseGrid(gridText(["I.", ".I"], { size: "8x8", scale: 4, seat: 1 }), "fixture.txt");
  assert.deepEqual(
    { w: g.w, h: g.h, scale: g.scale, rows: g.rows, seat: g.headers.seat },
    { w: 8, h: 8, scale: 4, rows: ["I.", ".I"], seat: "1" },
  );
  assert.equal(parseGrid(gridText(["I"], { size: "1x1" }), "fixture.txt").scale, 1);
});

// --- T33-9 parseGrid errors (file, row and column named) ------------------------------------------

function throwsNaming(text: string, ...patterns: RegExp[]) {
  assert.throws(() => parseGrid(text, "bad.txt"), (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    assert.match(msg, /bad\.txt/);
    for (const p of patterns) assert.match(msg, p);
    return true;
  });
}

test("an unknown letter throws with its row and column", () => {
  throwsNaming(gridText(["II", "IX"], { size: "2x2" }), /row 1\b/, /column 1\b/);
  throwsNaming(gridText(["Ii"], { size: "2x1" }), /row 0\b/, /column 1\b/); // lowercase isn't a palette letter
});

test("a ragged row throws", () => {
  throwsNaming(gridText(["III", "II"], { size: "3x2" }), /row 1\b/);
});

test("the wrong number of rows or columns for the declared size throws", () => {
  throwsNaming(gridText(["II", "II"], { size: "2x3" }), /row/);
  throwsNaming(gridText(["II", "II"], { size: "3x2" }), /row 0\b/);
});

test("a header after the first grid row throws", () => {
  throwsNaming(["size=2x2", "II", "scale=1", "II"].join("\n"), /row/);
});

test("scale=0 or a non-integer scale throws", () => {
  throwsNaming(gridText(["I"], { size: "0x0", scale: 0 }), /scale/);
  throwsNaming(gridText(["I"], { size: "2x2", scale: "1.5" }), /scale/);
});

test("a missing size header throws", () => {
  throwsNaming(["# no size", "II"].join("\n"), /size/);
});

test("comments and blank lines are allowed anywhere", () => {
  const g = parseGrid(["# c", "size=2x2", "", "# c2", "IF", "# c3", "LM", ""].join("\n"), "ok.txt");
  assert.deepEqual(g.rows, ["IF", "LM"]);
});
