// Regenerates web/public/sprites/<name>.svg from every grid in this folder (TG-33).
// Run from the repo root: node web/sprites-src/build.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { gridToSvg, parseGrid } from "../src/lib/pixelSvg.ts";

const src = new URL("./", import.meta.url);
const out = new URL("../public/sprites/", import.meta.url);
mkdirSync(out, { recursive: true });

const grids = readdirSync(src).filter((f) => f.endsWith(".txt")).sort();
for (const file of grids) {
  const svg = gridToSvg(parseGrid(readFileSync(new URL(file, src), "utf8"), file));
  writeFileSync(new URL(file.replace(/\.txt$/, ".svg"), out), svg);
}
console.log(`wrote ${grids.length} sprites`);
