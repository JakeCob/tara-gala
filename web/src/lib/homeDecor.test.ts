// TG-45 part C: the home page's Philippine decor strip (ux.md section 1). Pure data in lib/homeDecor.ts, plus static
// guards on HomeDecor.tsx and page.tsx (no component runner yet). Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PNG_ART, SPRITES } from "./sprites.ts";
import type { SpriteName } from "./sprites.ts";

const WEB = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB), "utf8");
const source = (path: string) => {
  assert.ok(existsSync(new URL(path, WEB)), `${path} exists`);
  return read(path);
};

// homeDecor.ts doesn't exist until GREEN: load it inside each test, so every test fails on its own
type HomeDecor = typeof import("./homeDecor.ts");
const load = (): Promise<HomeDecor> => import(new URL("src/lib/homeDecor.ts", WEB).href);

const PH = [
  "deco-sun-stars", "deco-carabao", "deco-bahay-kubo", "chibi-barong", "chibi-filipiniana",
  "deco-taho-vendor", "deco-parol", "deco-sampaguita", "deco-rice-terraces", "deco-panagbenga-float",
];
// ux §1.3, in order
const ROW = [
  { name: "deco-rice-terraces", show: "md" },
  { name: "deco-bahay-kubo", show: "all" },
  { name: "chibi-barong", show: "all" },
  { name: "chibi-filipiniana", show: "all" },
  { name: "deco-taho-vendor", show: "md" },
  { name: "deco-carabao", show: "min375" },
  { name: "deco-sampaguita", show: "md" },
  { name: "deco-panagbenga-float", show: "md" },
];
const SKY = [
  { name: "deco-sun-stars", show: "all", at: "absolute top-1 right-1" },
  { name: "deco-parol", show: "md", at: "absolute top-1 left-2" },
];
// ux §1.2
const STRIP = "pointer-events-none relative h-20 pixel-frame bg-screen pixelated flex items-end justify-center gap-2 pl-2 pr-14 pb-1 md:gap-4 md:pl-12 lg:gap-6";
const SHOW = { all: "", min375: "hidden min-[375px]:block", md: "hidden md:block" };

const size2x = (name: string) => {
  const s = SPRITES[name as SpriteName];
  assert.ok(s, `${name} is in SPRITES`);
  return { w: s.w * 2, h: s.h * 2 };
};

// ---- T45-H1 the composition --------------------------------------------------------------------------

test("T45-H1 homeDecor.ts is a plain module holding ux §1.3's composition and §1.2's strip class", async () => {
  const src = source("src/lib/homeDecor.ts");
  assert.doesNotMatch(src, /^\s*import\b/m, "no imports");
  assert.doesNotMatch(src, /\bimport\s*\(|use client|\benum\s|\bnamespace\s/);
  const { HOME_ROW, HOME_SKY, HOME_STRIP_CLASS, SHOW_CLASS } = await load();
  assert.deepEqual(HOME_ROW, ROW);
  assert.deepEqual(HOME_SKY, SKY);
  assert.equal(HOME_STRIP_CLASS, STRIP);
  assert.deepEqual(SHOW_CLASS, SHOW);
  const all = [...HOME_ROW, ...HOME_SKY].map((d) => d.name as string);
  assert.deepEqual([...all].sort(), [...PH].sort(), "each of the 10 decor sprites exactly once");
  assert.ok(!HOME_ROW.some((d) => (d.name as string) === "deco-sun-stars"), "the emblem is only the sun in the sky");
  for (const name of all) {
    assert.ok(name in SPRITES, `${name} in SPRITES`);
    assert.ok(PNG_ART.has(name as SpriteName), `${name} in PNG_ART`);
  }
});

// ---- T45-H2 the fit arithmetic (ux §1.3), from SPRITES x 2 -------------------------------------------

test("T45-H2 the strip fits every width from 320 to 1280; the carabao needs 375", async () => {
  const { HOME_ROW, HOME_SKY } = await load();
  const shown = (vw: number, withCarabao?: boolean) =>
    HOME_ROW.filter((d) => d.show === "all" || (d.show === "min375" && (withCarabao ?? vw >= 375)) || (d.show === "md" && vw >= 768));
  const rowWidth = (items: readonly { name: string }[], gap: number) =>
    items.reduce((sum, d) => sum + size2x(d.name).w, 0) + (items.length - 1) * gap;
  // phone: viewport - 32 (shell px-4) - 6 (frame) - 8 (pl-2) - 56 (pr-14), gap-2
  const phoneInner = (vw: number) => vw - 32 - 6 - 8 - 56;
  for (const vw of [320, 360]) {
    const items = shown(vw);
    assert.deepEqual(items.map((d) => d.name), ["deco-bahay-kubo", "chibi-barong", "chibi-filipiniana"], `${vw}`);
    assert.ok(rowWidth(items, 8) <= phoneInner(vw), `${vw}: ${rowWidth(items, 8)} <= ${phoneInner(vw)}`);
  }
  assert.equal(rowWidth(shown(320), 8), 192);
  assert.ok(rowWidth(shown(360, true), 8) > phoneInner(360), "at 360 the carabao doesn't fit: the 375 threshold is needed");
  for (const vw of [375, 380]) {
    const items = shown(vw);
    assert.ok(items.some((d) => d.name === "deco-carabao"), `${vw} shows the carabao`);
    assert.equal(rowWidth(items, 8), 264);
    assert.ok(rowWidth(items, 8) <= phoneInner(vw), `${vw}: 264 <= ${phoneInner(vw)}`);
  }
  // md and up: TG-44's shell content widths; inner = content - 6 - 48 (md:pl-12) - 56 (pr-14)
  for (const [vw, content, gap] of [[768, 720, 16], [1024, 960, 24], [1280, 1088, 24]] as const) {
    const items = shown(vw);
    assert.equal(items.length, 8, `${vw}: all 8 grounded sprites`);
    const inner = content - 6 - 48 - 56;
    assert.ok(rowWidth(items, gap) <= inner, `${vw}: ${rowWidth(items, gap)} <= ${inner}`);
  }
  assert.equal(rowWidth(shown(768), 16), 560);
  assert.equal(rowWidth(shown(1024), 24), 616);
  // the sky clears the grounded row: the sun inside pr-14, the parol inside md:pl-12
  const [sun, parol] = HOME_SKY.map((d) => size2x(d.name));
  assert.ok(sun.w + 4 <= 56, "sun (right-1) inside pr-14");
  assert.ok(parol.w + 8 <= 48, "parol (left-2) inside md:pl-12");
});

// ---- T45-H5 no layout shift ----------------------------------------------------------------------------

test("T45-H5 no layout shift: a fixed 80px strip that no sprite can grow; the sky is absolute", async () => {
  const { HOME_ROW, HOME_SKY, HOME_STRIP_CLASS } = await load();
  const tokens = HOME_STRIP_CLASS.split(/\s+/);
  assert.ok(tokens.includes("h-20"));
  for (const t of tokens) assert.doesNotMatch(t, /^(min-h-|max-h-|h-auto|h-fit|h-full)/, t);
  for (const d of HOME_ROW) assert.ok(size2x(d.name).h <= 80 - 6 - 4, `${d.name} fits the 70px inner height`);
  for (const d of HOME_SKY) assert.match(d.at, /^absolute\s/, `${d.name} is out of the flow`);
});

// ---- T45-H3 HomeDecor.tsx (static) -------------------------------------------------------------------

test("T45-H3 HomeDecor is a hidden, inert server component of sized, pixelated background sprites with no text", () => {
  const src = source("src/components/HomeDecor.tsx");
  assert.match(src, /<div aria-hidden="true" className=\{HOME_STRIP_CLASS\}/);
  assert.match(src, /backgroundImage: `url\(\$\{spriteSrc\("tile-grass"\)\}\)`/);
  assert.match(src, /backgroundSize: "32px"/);
  // ux-review S1: CSS backgrounds, not <img>, so a sprite that fails to load just leaves grass (no broken-image icon)
  assert.doesNotMatch(src, /<img\b/, "no <img> in the strip");
  const spans = [...src.matchAll(/<span\b[^>]*?\/>/g)].map((m) => m[0]);
  assert.ok(spans.length >= 2, "renders the sky and the row as <span> elements");
  for (const span of spans) {
    for (const want of [/aria-hidden="true"/, /backgroundImage: `url\(\$\{spriteSrc\(/, /width: SPRITES\[[^\]]+\]\.w \* 2/,
      /height: SPRITES\[[^\]]+\]\.h \* 2/, /"pixelated bg-no-repeat bg-\[length:100%_100%\]"/, /SHOW_CLASS\[/]) {
      assert.match(span, want, `${want} in ${span}`);
    }
    // display comes from the flex row (or absolute) and SHOW_CLASS only: a base "block" would fight SHOW_CLASS's "hidden"
    const base = span.match(/cx\("([^"]*)"/)?.[1] ?? "";
    assert.doesNotMatch(base, /(^|\s)(block|inline|inline-block|flex|grid|hidden)(\s|$)/, `display token in ${base}`);
    // Nothing else sets display or the size: exactly these class arguments, and no display or backgroundSize in style
    assert.match(span, /className=\{cx\("pixelated bg-no-repeat bg-\[length:100%_100%\]",\s*SHOW_CLASS\[(\w+)\.show\](,\s*\1\.at)?\)\}/, `class arguments in ${span}`);
    assert.doesNotMatch(span, /\bdisplay\s*:|backgroundSize/, `a style override in ${span}`);
  }
  for (const banned of [/use client/, /\buse[A-Z]\w*\(/, /animate-/, /transition/, /@keyframes/, /tabIndex/, /<a\b/, /<button\b/,
    /\bLink\b/, /loading="lazy"/, /\brole=/, /["'`]\/sprites\//, /onClick|onError|onLoad/]) {
    assert.doesNotMatch(src, banned, String(banned));
  }
  // Both lists render in full, and each sky sprite takes its `at` position (ux §1.3)
  assert.match(src, /\{HOME_SKY\.map\(\((\w+)\)\s*=>[\s\S]*?SHOW_CLASS\[\1\.show\],\s*\1\.at\)/, "every sky sprite, at its position");
  assert.match(src, /\{HOME_ROW\.map\(/, "every grounded sprite");
  // No JSX text: after a tag closes (not an arrow =>), the next thing is never a word
  assert.doesNotMatch(src.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, ""), /(?<![=-])>\s*[A-Za-z0-9&][^<{}]*</, "JSX text in the strip");
});

// ---- T45-H4 page.tsx (static) ------------------------------------------------------------------------

test("T45-H4 the home page renders the strip once, between </header> and the search", () => {
  const src = source("src/app/page.tsx");
  assert.equal(src.match(/<HomeDecor\b/g)?.length ?? 0, 1, "one <HomeDecor />");
  assert.match(src, /<\/header>\s*<HomeDecor \/>\s*<TripSearch \/>/, "a sibling of <header>, before the search (review finding 2)");
  assert.match(src, /^import HomeDecor from "@\/components\/HomeDecor";$/m);
});

// ---- T45-S2 the emblem's scope -----------------------------------------------------------------------

function sourceFiles(dir: URL, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const url = new URL(name, dir);
    if (statSync(url).isDirectory()) sourceFiles(new URL(`${name}/`, dir), out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(url.pathname);
  }
  return out;
}

test("T45-S2 the sun-and-stars emblem is named only by the manifest and the home sky; nothing is a flag", () => {
  const src = new URL("src/", WEB);
  const allowed = new Set(["lib/sprites.ts", "lib/homeDecor.ts"]);
  for (const file of sourceFiles(src)) {
    const rel = file.slice(src.pathname.length);
    if (rel.endsWith(".test.ts") || allowed.has(rel)) continue;
    assert.doesNotMatch(readFileSync(file, "utf8"), /deco-sun-stars/, `${rel} names the emblem`);
  }
  for (const name of Object.keys(SPRITES)) assert.doesNotMatch(name, /flag/, name);
  assert.ok(existsSync(join(src.pathname, "lib/homeDecor.ts")), "lib/homeDecor.ts holds the home sky");
});

// ---- TG-44's P2 and the strip --------------------------------------------------------------------------

// TG44-P2 bans width-based show/hide (content parity) in TG-44's SCOPE. The strip's hidden md:block and
// min-[375px]:block are aria-hidden decoration with no content, so HomeDecor.tsx and homeDecor.ts stay out of SCOPE
// (TG-45 plan §0, agreed in review-plan.md). page.tsx is in SCOPE and gains no width class.
test("T45-P2 the decor files stay outside TG-44's P2 scope, and page.tsx adds no width class", () => {
  const responsive = read("src/lib/responsive.test.ts");
  const changed = responsive.match(/const CHANGED = \[([\s\S]*?)\];/)?.[1] ?? "";
  const scope = responsive.match(/const SCOPE = \[([^\]]*)\]/)?.[1] ?? "";
  assert.ok(changed.includes('"src/app/page.tsx"'), "page.tsx is in P2's scope");
  assert.doesNotMatch(changed + scope, /HomeDecor|homeDecor/);
  const page = source("src/app/page.tsx");
  const decorLine = page.split("\n").find((l) => l.includes("<HomeDecor"));
  assert.ok(decorLine, "page.tsx renders <HomeDecor />");
  assert.doesNotMatch(decorLine, /className/, "the strip's classes live in homeDecor.ts, not page.tsx");
});
