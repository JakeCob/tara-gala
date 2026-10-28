// Pixel theme tests (TG-42 PR A): tokens, contrast, fonts and the shared primitives in components/pixel.
// Run with `npm test` (node --test, Node 22.18+ type stripping). Source files are read as text, as in pwa.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

const WEB = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB), "utf8");
const PIXEL = "src/components/pixel/";

// PX lives in a plain module. Load it inside the tests that need it, so the token tests still run (and fail on
// their own assertions) while the module doesn't exist yet.
type Skinned = { skin: string; layout: string };
type PXShape = {
  box: Skinned;
  btn: Record<"primary" | "secondary" | "accent" | "icon" | "iconBrand", Skinned>;
  choice: Skinned;
  chip: string;
  screenChip: string;
  input: string;
  h1: string;
  h2: string;
  dataHeading: string;
  meta: string;
  inlineLink: string;
};
async function loadPixel(): Promise<{ PX: PXShape; cx: (...parts: unknown[]) => string }> {
  return import(new URL(`${PIXEL}classes.ts`, WEB).href);
}

// ---- globals.css parsing ----

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

// Top-level and nested blocks as { path: ["@media (...)", ":root"], body } with only the block's own declarations.
type Block = { path: string[]; body: string };
function blocks(css: string): Block[] {
  const out: Block[] = [];
  const walk = (src: string, path: string[]) => {
    let own = "";
    let start = 0; // start of the current statement
    let i = 0;
    while (i < src.length) {
      if (src[i] === ";") {
        own += src.slice(start, i + 1);
        start = i + 1;
      } else if (src[i] === "{") {
        let depth = 1;
        let j = i + 1;
        while (j < src.length && depth > 0) {
          if (src[j] === "{") depth++;
          else if (src[j] === "}") depth--;
          j++;
        }
        walk(src.slice(i + 1, j - 1), [...path, src.slice(start, i).trim().replace(/\s+/g, " ")]);
        i = j - 1;
        start = j;
      }
      i++;
    }
    own += src.slice(start);
    if (path.length) out.push({ path, body: own });
  };
  walk(stripComments(css), []);
  return out;
}

function decls(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of body.split(";")) {
    const m = part.match(/^\s*([\w-]+)\s*:\s*([\s\S]+?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const DARK = /^@media\s*\(prefers-color-scheme:\s*dark\)$/;
const isRoot = (b: Block) => b.path[b.path.length - 1] === ":root";

function tokenModes() {
  const css = read("src/app/globals.css");
  const all = blocks(css);
  const light: Record<string, string> = {};
  const darkOnly: Record<string, string> = {};
  for (const b of all.filter(isRoot)) {
    const target = b.path.length === 1 ? light : b.path.length === 2 && DARK.test(b.path[0]) ? darkOnly : null;
    if (target) Object.assign(target, decls(b.body));
  }
  const vars = (o: Record<string, string>) =>
    Object.fromEntries(Object.entries(o).filter(([k]) => k.startsWith("--")).map(([k, v]) => [k.slice(2), v.toLowerCase()]));
  const lightVars = vars(light);
  const darkVars = vars(darkOnly);
  return { css, all, light, darkOnly, lightVars, darkVars, dark: { ...lightVars, ...darkVars } };
}

// ---- contrast (WCAG 2.x) ----

function luminance(hex: string | undefined): number {
  const m = String(hex).match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  assert.ok(m, `not a 6-digit hex: ${hex}`);
  const [r, g, b] = m.slice(1).map((h) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string | undefined, b: string | undefined): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ---- guide 1.1 and 1.2 ----

const PALETTE = { ink: "#1d2a24", forest: "#167856", leaf: "#5fb36b", mint: "#cfe8c4", cream: "#fbf7ee", sun: "#ffd65c" };
const MUTED_LIGHT = "#4f5f57";

const LIGHT = {
  background: "#cfe8c4", foreground: "#1d2a24", muted: "#4f5f57", card: "#fbf7ee",
  frame: "#1d2a24", border: "#5fb36b", brand: "#167856", "brand-ink": "#fbf7ee",
  accent: "#ffd65c", "accent-ink": "#1d2a24", focus: "#1d2a24",
};
const DARK_OVERRIDES = {
  background: "#121815", foreground: "#fbf7ee", muted: "#a3b1aa", card: "#1b2420",
  frame: "#cfe8c4", border: "#2c3833", brand: "#5fb36b", "brand-ink": "#1d2a24", focus: "#ffd65c",
};
const SCREEN = {
  "--color-screen": "#cfe8c4", "--color-screen-paper": "#fbf7ee",
  "--color-screen-ink": "#1d2a24", "--color-screen-muted": "#4f5f57",
};
const TOKEN_NAMES = Object.keys(LIGHT);

// T2 (B1)
test("T2 tokens match guide 1.2 in light and dark", () => {
  const { lightVars, darkVars, dark } = tokenModes();
  const pick = (o: Record<string, string>) => Object.fromEntries(TOKEN_NAMES.filter((k) => k in o).map((k) => [k, o[k]]));
  assert.deepEqual(pick(lightVars), LIGHT, "the 11 light :root variables");
  assert.deepEqual(pick(darkVars), DARK_OVERRIDES, "dark overrides 9 tokens; accent and accent-ink are inherited");
  assert.deepEqual(pick(dark), { ...LIGHT, ...DARK_OVERRIDES });
});

test("T2 the screen tokens are fixed and every token is a Tailwind colour", () => {
  const { all } = tokenModes();
  const theme = all.filter((b) => b.path.length === 1 && b.path[0] === "@theme").map((b) => decls(b.body));
  const fixed = Object.assign({}, ...theme) as Record<string, string>;
  for (const [name, hex] of Object.entries(SCREEN)) {
    assert.equal(fixed[name]?.toLowerCase(), hex, `${name} in a plain @theme block`);
  }
  for (const b of all) {
    if (DARK.test(b.path[0] ?? "")) {
      assert.doesNotMatch(b.body, /--color-screen/, "screen tokens must not change in dark mode");
    }
  }
  const inline = Object.assign(
    {},
    ...all.filter((b) => b.path.length === 1 && b.path[0] === "@theme inline").map((b) => decls(b.body)),
  ) as Record<string, string>;
  for (const name of TOKEN_NAMES) {
    assert.equal(inline[`--color-${name}`], `var(--${name})`, `@theme inline --color-${name}`);
  }
  assert.match(inline["--font-sans"] ?? "", /^var\(--font-nunito\)/);
  assert.match(inline["--font-pixel"] ?? "", /^var\(--font-pixelify\),\s*var\(--font-nunito\)/);
});

test("T2 native controls follow the theme and the body uses the body font (ux.md 1)", () => {
  const { light, darkOnly, all } = tokenModes();
  assert.equal(light["color-scheme"], "light");
  assert.equal(darkOnly["color-scheme"], "dark");
  const body = Object.assign({}, ...all.filter((b) => b.path.join(" ") === "body").map((b) => decls(b.body)));
  assert.equal(body["font-family"], "var(--font-sans)", "guide 1.4's body rule replaces the v1 font stack");
  assert.equal(body.background, "var(--background)");
  assert.equal(body.color, "var(--foreground)");
});

test("T2 globals.css has guide 3.2's utilities", () => {
  const { all } = tokenModes();
  const util = (name: string) => {
    const found = all.filter((b) => b.path[0] === `@utility ${name}`);
    assert.ok(found.length, `@utility ${name}`);
    return found.map((b) => `${b.path.slice(1).join(" ")} { ${b.body} }`).join("\n");
  };
  assert.match(util("pixel-frame"), /border:\s*3px solid var\(--frame\)/);
  assert.match(util("pixel-frame"), /clip-path:\s*polygon\(/);
  assert.match(util("pixel-box"), /@apply pixel-frame/);
  assert.match(util("pixel-box"), /outline:\s*3px solid var\(--frame\)/);
  assert.match(util("pixel-box"), /outline-offset:\s*-9px/);
  assert.match(util("pixel-btn"), /box-shadow:\s*0 3px 0 0 var\(--frame\)/);
  assert.match(util("pixel-btn"), /&:active:not\(:disabled, \[aria-disabled="true"\]\)\s*\{\s*translate:\s*0 3px;\s*box-shadow:\s*none;?\s*\}/);
  assert.match(util("pixel-btn"), /&:disabled, &\[aria-disabled="true"\]\s*\{\s*opacity:\s*\.6;\s*box-shadow:\s*none;?\s*\}/);
  assert.match(util("focus-pixel"), /&:focus-visible\s*\{\s*outline:\s*3px solid var\(--focus\);\s*outline-offset:\s*2px;?\s*\}/);
  assert.match(util("focus-pixel-within"), /&:has\(:focus-visible\)\s*\{\s*outline:\s*3px solid var\(--focus\);\s*outline-offset:\s*2px;?\s*\}/);
  assert.match(util("pixelated"), /image-rendering:\s*pixelated/);
});

// T3 (B1)
test("T3 art palette is exactly 6 colours and the light tokens use only them", () => {
  const { lightVars, darkVars } = tokenModes();
  const palette = new Set(Object.values(PALETTE));
  assert.equal(palette.size, 6);
  for (const name of TOKEN_NAMES) {
    assert.ok(lightVars[name], `light --${name} is set`);
    assert.ok(palette.has(lightVars[name]) || lightVars[name] === MUTED_LIGHT, `light --${name} ${lightVars[name]} is off-palette`);
  }
  for (const hex of Object.values(SCREEN)) {
    assert.ok(palette.has(hex) || hex === MUTED_LIGHT, `screen token ${hex}`);
  }
  const offPalette = new Set(Object.values(darkVars).filter((hex) => !palette.has(hex)));
  assert.deepEqual([...offPalette].sort(), ["#121815", "#1b2420", "#2c3833", "#a3b1aa"], "the only non-palette dark values");
});

// T4 (B15)
const TEXT_PAIRS: [fg: string, bg: string][] = [
  ["foreground", "background"],
  ["foreground", "card"],
  ["muted", "background"],
  ["muted", "card"],
  ["brand-ink", "brand"],
  ["brand", "card"],
  ["accent-ink", "accent"],
];
const SCREEN_PAIRS: [fg: string, bg: string][] = [
  ["--color-screen-ink", "--color-screen"],
  ["--color-screen-ink", "--color-screen-paper"],
  ["--color-screen-muted", "--color-screen-paper"],
];

test("T4 every text pair used is AA (4.5:1) in both modes", () => {
  const { lightVars, dark } = tokenModes();
  for (const [mode, vars] of [["light", lightVars], ["dark", dark]] as const) {
    for (const [fg, bg] of TEXT_PAIRS) {
      assert.ok(vars[fg] && vars[bg], `${mode}: --${fg} and --${bg} are set`);
      const ratio = contrast(vars[fg], vars[bg]);
      assert.ok(ratio >= 4.5, `${mode}: ${fg} on ${bg} is ${ratio.toFixed(2)}`);
    }
  }
  const { all } = tokenModes();
  const fixed = Object.assign(
    {},
    ...all.filter((b) => b.path.length === 1 && b.path[0] === "@theme").map((b) => decls(b.body)),
  ) as Record<string, string>;
  for (const [fg, bg] of SCREEN_PAIRS) {
    assert.ok(fixed[fg] && fixed[bg], `${fg} and ${bg} are set`);
    const ratio = contrast(fixed[fg], fixed[bg]);
    assert.ok(ratio >= 4.5, `${fg} on ${bg} is ${ratio.toFixed(2)}`);
  }
});

// T5 (B15)
test("T5 brand on background is large-text only in light mode", () => {
  const { lightVars, dark } = tokenModes();
  const light = contrast(lightVars.brand, lightVars.background);
  assert.ok(light >= 3.0 && light < 4.5, `light brand on background is ${light.toFixed(2)}: h1 size only`);
  assert.ok(contrast(dark.brand, dark.background) >= 4.5, "dark brand on background");
});

test("T5 text-brand in PX appears only on the h1 or with a card fill", async () => {
  const { PX } = await loadPixel();
  const hits = flatPX(PX).filter(([, value]) => tokensOf(value).some((t) => t === "text-brand"));
  assert.ok(hits.length, "PX.h1 uses text-brand");
  for (const [path, value] of hits) {
    assert.ok(path === "h1" || tokensOf(value).includes("bg-card"), `${path}: text-brand without bg-card`);
  }
});

// T6 (B15)
test("T6 frames and focus are at least 3:1 on page and card", () => {
  const { lightVars, dark } = tokenModes();
  for (const [mode, vars] of [["light", lightVars], ["dark", dark]] as const) {
    for (const fg of ["frame", "focus"]) {
      for (const bg of ["background", "card"]) {
        const ratio = contrast(vars[fg], vars[bg]);
        assert.ok(ratio >= 3.0, `${mode}: ${fg} on ${bg} is ${ratio.toFixed(2)}`);
      }
    }
  }
});

// T7: documents why no control may sit on an accent or brand surface (T13 in PR B).
test("T7 known-failing pairs stay banned", () => {
  const { lightVars, dark } = tokenModes();
  const msg = "this pair now passes: revisit T13 before relaxing the rule";
  assert.ok(contrast(dark.focus, dark.accent) < 3.0, `dark focus on accent: ${msg}`);
  assert.ok(contrast(lightVars.focus, lightVars.brand) < 3.0, `light focus on brand: ${msg}`);
  assert.ok(contrast(dark.focus, dark.brand) < 3.0, `dark focus on brand: ${msg}`);
  // Leaf (light border) and Sun (accent) never carry text on Cream (card) or Mint (background)
  for (const fg of ["border", "accent"]) {
    for (const bg of ["card", "background"]) {
      assert.ok(contrast(lightVars[fg], lightVars[bg]) < 4.5, `light ${fg} on ${bg}: ${msg}`);
    }
  }
});

// ---- PX (components/pixel/classes.ts) ----

const tokensOf = (s: string) => s.split(/\s+/).filter(Boolean);
function flatPX(px: PXShape): [path: string, value: string][] {
  const out: [string, string][] = [];
  const walk = (node: unknown, path: string) => {
    if (typeof node === "string") out.push([path, node]);
    else for (const [k, v] of Object.entries(node as object)) walk(v, path ? `${path}.${k}` : k);
  };
  walk(px, "");
  return out;
}

// plan.md "PX values", with review-plan finding 1 (a named group, so nested groups don't light every cursor).
const EXPECTED_PX: PXShape = {
  box: { skin: "pixel-box bg-card", layout: "p-4 flex flex-col gap-2" },
  btn: {
    primary: { skin: "pixel-btn focus-pixel min-h-11 bg-brand font-bold text-brand-ink", layout: "px-4 py-3" },
    secondary: { skin: "pixel-btn focus-pixel min-h-11 bg-card font-semibold text-foreground", layout: "inline-flex items-center px-4 text-sm" },
    accent: { skin: "pixel-btn focus-pixel min-h-11 bg-accent font-bold text-accent-ink", layout: "inline-flex items-center px-3 text-sm" },
    icon: { skin: "pixel-btn focus-pixel min-h-11 min-w-11 bg-card", layout: "inline-flex items-center justify-center" },
    iconBrand: { skin: "pixel-btn focus-pixel min-h-11 min-w-11 bg-card text-brand", layout: "inline-flex items-center justify-center text-xl leading-none" },
  },
  choice: {
    skin: "group/choice pixel-btn focus-pixel-within min-h-11 cursor-pointer bg-card font-semibold has-checked:bg-brand has-checked:text-brand-ink has-checked:translate-y-[3px] has-checked:shadow-none has-[[aria-disabled=true]]:opacity-60 has-[[aria-disabled=true]]:shadow-none",
    layout: "flex items-center justify-center gap-1 px-2 py-2 text-center text-sm leading-tight",
  },
  chip: "pixel-frame bg-card px-2 py-1 text-sm",
  screenChip: "pixel-frame bg-screen-paper text-screen-ink px-2 py-1 text-sm",
  input: "min-h-11 rounded-none border-3 border-frame bg-card px-3 py-2 text-base text-foreground focus-pixel",
  h1: "font-pixel text-[2rem] leading-tight font-bold text-brand",
  h2: "font-pixel text-xl font-semibold",
  dataHeading: "text-base font-bold",
  meta: "text-xs text-muted",
  inlineLink: "underline underline-offset-2 focus-pixel",
};

// B5
test("B5 PX matches the plan's skins and layouts token for token", async () => {
  const { PX } = await loadPixel();
  const sorted = (px: PXShape) => Object.fromEntries(flatPX(px).map(([k, v]) => [k, tokensOf(v).sort()]));
  assert.deepEqual(sorted(PX), sorted(EXPECTED_PX));
});

// T8 (B4, B15)
test("T8 every interactive PX skin has min-h-11; icon buttons also min-w-11", async () => {
  const { PX } = await loadPixel();
  const interactive: [string, string][] = [
    ...Object.entries(PX.btn).map(([k, v]) => [`btn.${k}.skin`, v.skin] as [string, string]),
    ["choice.skin", PX.choice.skin],
    ["input", PX.input],
  ];
  for (const [path, value] of interactive) {
    assert.ok(tokensOf(value).includes("min-h-11"), `${path} needs min-h-11`);
  }
  for (const key of ["icon", "iconBrand"] as const) {
    assert.ok(tokensOf(PX.btn[key].skin).includes("min-w-11"), `btn.${key}.skin needs min-w-11`);
  }
});

// T10 (decision 2, B5, B12)
const bare = (token: string) => token.split(":").pop()!;
const TEXT_SIZE_OR_ALIGN = /^text-(xs|sm|base|lg|xl|[2-9]xl|center|left|right|start|end|justify|balance|pretty|wrap|nowrap|clip|ellipsis|\[\d[^\]]*\])$/;
function lookTokens(value: string): string[] {
  return tokensOf(value).filter((t) => {
    const b = bare(t);
    return (
      b.startsWith("bg-") ||
      (b.startsWith("text-") && !TEXT_SIZE_OR_ALIGN.test(b)) ||
      b.startsWith("font-") ||
      b.startsWith("border") ||
      b.startsWith("shadow") ||
      b.startsWith("min-h-") ||
      b.startsWith("outline") ||
      b.startsWith("rounded")
    );
  });
}

test("T10 PX skins carry the look, layouts carry no look", async () => {
  const { PX } = await loadPixel();
  const has = (value: string, t: string) => tokensOf(value).includes(t);
  assert.ok(has(PX.box.skin, "pixel-box"), "box skin is a pixel-box");
  for (const [k, v] of Object.entries(PX.btn)) {
    assert.ok(has(v.skin, "pixel-btn") && has(v.skin, "focus-pixel"), `btn.${k}.skin: pixel-btn + focus-pixel`);
  }
  assert.ok(has(PX.choice.skin, "pixel-btn") && has(PX.choice.skin, "focus-pixel-within"), "choice skin");
  assert.ok(has(PX.input, "border-frame") && has(PX.input, "focus-pixel"), "input");
  const layouts: [string, string][] = [
    ["box.layout", PX.box.layout],
    ...Object.entries(PX.btn).map(([k, v]) => [`btn.${k}.layout`, v.layout] as [string, string]),
    ["choice.layout", PX.choice.layout],
  ];
  for (const [path, value] of layouts) {
    assert.deepEqual(lookTokens(value), [], `${path} must not set the look`);
  }
});

test("T10 no PX string has rounded corners, rings, soft shadows or raw hex", async () => {
  const { PX } = await loadPixel();
  for (const [path, value] of flatPX(PX)) {
    assert.doesNotMatch(value, /rounded-(?!none\b)/, path);
    assert.doesNotMatch(value, /\bring-/, path);
    assert.doesNotMatch(value, /shadow-(lg|md|sm)\b/, path);
    assert.doesNotMatch(value, /\[#/, path);
  }
});

// T11 (B5)
test("T11 classes.ts is a plain module: no imports, JSX or use client", () => {
  assert.ok(existsSync(new URL(`${PIXEL}classes.ts`, WEB)), "components/pixel/classes.ts exists");
  const source = read(`${PIXEL}classes.ts`);
  assert.doesNotMatch(source, /^\s*import\b/m);
  assert.doesNotMatch(source, /\bimport\s*\(/);
  assert.doesNotMatch(source, /use client/);
  assert.doesNotMatch(source, /<\/?[A-Za-z][\w.]*[\s>/]/, "no JSX");
  assert.doesNotMatch(source, /\benum\s/);
  assert.doesNotMatch(source, /\bnamespace\s/);
});

// T12 (B4, decision 2)
test("T12 cx joins truthy parts with single spaces", async () => {
  const { cx } = await loadPixel();
  assert.equal(cx("a", false, undefined, "", "b"), "a b");
  assert.equal(cx("a", null, "b c"), "a b c");
  assert.equal(cx(), "");
  assert.equal(cx(false, undefined), "");
});

const PRIMITIVES = ["PixelBox", "DialogBox", "PixelButton", "PixelLink", "PixelCardLink", "PixelChoice", "MenuCursor", "PageTitle", "SectionTitle"];
const primitive = (name: string) => {
  const file = `${PIXEL}${name}.tsx`;
  assert.ok(existsSync(new URL(file, WEB)), `${file} exists`);
  return read(file);
};

test("T12 a className prop replaces the default layout, never merges with it", () => {
  for (const name of ["PixelBox", "PixelButton", "PixelLink", "PixelCardLink", "PixelChoice"]) {
    const source = primitive(name);
    assert.match(source, /className \?\? PX\.[\w.[\]]+\.layout/, `${name}: cx(skin, className ?? layout)`);
    assert.doesNotMatch(source, /\.layout\s*,\s*className\b/, `${name} must not append className to the layout`);
  }
});

// RED audit addition: B5 and T8 only see PX, so a primitive could still cap its own height in its cx() call.
test("T8 primitives add no height or size classes of their own", () => {
  for (const name of PRIMITIVES) {
    const source = primitive(name);
    assert.doesNotMatch(source, /["'`][^"'`\n]*(?<![\w-])(max-h|h|size)-(\d|\[|px\b)/, `${name} sets a height`);
  }
});

// B4
test("B4 the pixel barrel exports every primitive, PX and cx", () => {
  assert.ok(existsSync(new URL(`${PIXEL}index.ts`, WEB)), "components/pixel/index.ts exists");
  const index = read(`${PIXEL}index.ts`);
  for (const name of [...PRIMITIVES, "PX", "cx"]) {
    assert.match(index, new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`), `index.ts exports ${name}`);
  }
});

test("B4 primitives work in server and client components: no hooks, no use client", () => {
  for (const name of PRIMITIVES) {
    const source = primitive(name);
    assert.doesNotMatch(source, /use client/, name);
    assert.doesNotMatch(source, /\buse(State|Effect|Ref|Reducer|Context|LayoutEffect|Id)\b/, name);
    assert.doesNotMatch(source, /dangerouslySetInnerHTML/, name);
  }
});

test("B4 PixelLink: next/link inside the app, a new-tab anchor when external", () => {
  const source = primitive("PixelLink");
  assert.match(source, /from "next\/link"/);
  assert.match(source, /target="_blank"/);
  assert.match(source, /rel="noopener noreferrer"/);
  assert.match(source, /\bexternal\b/);
});

test("B4 PixelCardLink keeps focus off the clipped box (decision 4)", () => {
  const source = primitive("PixelCardLink");
  assert.match(source, /from "next\/link"/);
  assert.match(source, /className="block focus-pixel"/, "the outer link draws the focus");
  assert.match(source, /PX\.box\.skin/, "the inner box carries the pixel-box skin");
});

test("B4 DialogBox puts the hard shadow on a wrapper around the box", () => {
  const source = primitive("DialogBox");
  assert.match(source, /drop-shadow-\[0_6px_0_var\(--color-frame\)\]/);
  assert.match(source, /PX\.box\.skin/);
  assert.match(source, /p-4 flex flex-col gap-3/);
});

test("B4 PageTitle and SectionTitle use PX headings; SectionTitle supports the screen and form tags", () => {
  assert.match(primitive("PageTitle"), /<h1\b/);
  assert.match(primitive("PageTitle"), /PX\.h1/);
  const section = primitive("SectionTitle");
  assert.match(section, /PX\.h2/);
  assert.match(section, /onScreen\s*\?\s*"text-screen-ink"\s*:\s*"text-foreground"/);
  for (const tag of ["h2", "h3", "legend", "label"]) {
    assert.match(section, new RegExp(`"${tag}"`), `SectionTitle as="${tag}"`);
  }
  assert.match(section, /htmlFor/);
});

test("B4 MenuCursor is ux.md 5.2's inline SVG cursor", () => {
  const source = primitive("MenuCursor");
  assert.match(source, /<svg\b/);
  assert.match(source, /aria-hidden="true"/);
  assert.match(source, /viewBox="0 0 8 8"/);
  assert.match(source, /width=\{?"?8"?\}?/);
  assert.match(source, /shapeRendering="crispEdges"/);
  assert.match(source, /fill="currentColor"/);
  assert.match(source, /d="M2 0h1v8H2zM3 1h1v6H3zM4 2h1v4H4zM5 3h1v2H5z"/);
});

// T24 (B11), with review-plan finding 1
test("T24 PixelChoice renders a native sr-only radio or checkbox inside a label", () => {
  const source = primitive("PixelChoice");
  assert.match(source, /<label\b/);
  assert.match(source, /type\s*=\s*"radio"/, "radio is the default");
  assert.match(source, /"checkbox"/, "checkbox for TG-21's vibe chips");
  assert.match(source, /<input\b[^>]*className="sr-only"/);
  assert.match(source, /<MenuCursor\b/);
  assert.match(read("src/components/LastMile.tsx"), /input\[name="terminal"\]:checked/, "TG-17's focus fix query is unchanged");
});

test("T24 PixelChoice uses a named group, so an outer .group can't light every cursor", async () => {
  const { PX } = await loadPixel();
  const skin = tokensOf(PX.choice.skin);
  assert.ok(skin.includes("group/choice"), "choice skin has group/choice");
  assert.ok(!skin.includes("group"), "no bare group in the choice skin");
  const source = primitive("PixelChoice");
  assert.match(source, /group-has-checked\/choice:block/);
  assert.doesNotMatch(source, /group-has-checked:/);
});

// T18 (B2)
function walkFiles(dir: URL, out: URL[] = []): URL[] {
  for (const name of readdirSync(dir)) {
    const url = new URL(name, dir);
    if (statSync(url).isDirectory()) walkFiles(new URL(`${name}/`, dir), out);
    else out.push(url);
  }
  return out;
}

test("T18 layout.tsx loads Nunito and Pixelify Sans through next/font/google", () => {
  const layout = read("src/app/layout.tsx");
  assert.match(layout, /import\s*\{\s*Nunito,\s*Pixelify_Sans\s*\}\s*from\s*"next\/font\/google"/);
  assert.match(
    layout,
    /Nunito\(\{\s*subsets:\s*\["latin",\s*"latin-ext"\],\s*display:\s*"swap",\s*variable:\s*"--font-nunito"\s*\}\)/,
  );
  assert.match(
    layout,
    /Pixelify_Sans\(\{\s*subsets:\s*\["latin"\],\s*display:\s*"swap",\s*variable:\s*"--font-pixelify"\s*\}\)/,
  );
  const html = layout.match(/<html\b[^>]*>/)?.[0] ?? "";
  assert.match(html, /lang="en"/);
  assert.match(html, /className=\{`\$\{nunito\.variable\} \$\{pixelify\.variable\} h-full antialiased`\}/);
});

test("T18 no font or stylesheet is fetched from anywhere else", () => {
  const files = [...walkFiles(new URL("src/", WEB)), ...walkFiles(new URL("public/", WEB))].filter(
    (url) => /\.(tsx?|css|html|js|json|svg)$/.test(url.pathname) && !url.pathname.endsWith(".test.ts"),
  );
  assert.ok(files.length > 10);
  for (const url of files) {
    const source = readFileSync(url, "utf8");
    const where = url.pathname.slice(new URL(WEB).pathname.length);
    assert.doesNotMatch(source, /fonts\.(googleapis|gstatic)\.com/, where);
    assert.doesNotMatch(source, /@import\s+url\(/, where);
    assert.doesNotMatch(source, /@font-face[^}]*url\(\s*["']?https?:/, where);
    assert.doesNotMatch(source, /<link\b[^>]*rel=["']stylesheet["']/, where);
  }
});

// RED audit addition: a self-hosted @font-face with its own font-family would bypass next/font without fetching anything.
test("T18 no @font-face and no literal font-family outside next/font", () => {
  const files = [...walkFiles(new URL("src/", WEB)), ...walkFiles(new URL("public/", WEB))].filter(
    (url) => /\.(tsx?|css|html|js)$/.test(url.pathname) && !url.pathname.endsWith(".test.ts"),
  );
  for (const url of files) {
    const where = url.pathname.slice(new URL(WEB).pathname.length);
    assert.doesNotMatch(readFileSync(url, "utf8"), /@font-face/, where);
  }
  const css = stripComments(read("src/app/globals.css"));
  for (const m of css.matchAll(/font-family:\s*([^;}]+)/g)) {
    assert.match(m[1].trim(), /^var\(--font-(sans|pixel)\)$/, m[1]);
  }
});

// T22 (B15)
test("T22 no animation anywhere in the theme", () => {
  const files = [
    new URL("src/app/globals.css", WEB),
    ...walkFiles(new URL("src/", WEB)).filter((url) => url.pathname.endsWith(".tsx")),
  ];
  for (const url of files) {
    const source = readFileSync(url, "utf8");
    const where = url.pathname.slice(new URL(WEB).pathname.length);
    assert.doesNotMatch(source, /transition|animate-|@keyframes|duration-|animation/, where);
  }
});

// ---- PR B: the restyle of the existing screens (ux.md 2 to 7) ----

const tsxFiles = () => walkFiles(new URL("src/", WEB)).filter((url) => url.pathname.endsWith(".tsx"));
const relative = (url: URL) => url.pathname.slice(new URL(WEB).pathname.length);
const inPixel = (url: URL) => relative(url).startsWith(PIXEL);
// Every quoted or template string literal in a source file (class strings live in these).
const stringLiterals = (source: string) => [...source.matchAll(/"[^"\n]*"|`[^`]*`/g)].map((m) => m[0]);

// T9 (B9, B10, B15)
test("T9 every pixel-btn class string also has min-h-11", () => {
  for (const url of tsxFiles().filter((u) => !inPixel(u))) {
    for (const literal of stringLiterals(readFileSync(url, "utf8"))) {
      if (/(?<![\w-])pixel-btn(?![\w-])/.test(literal)) {
        assert.match(literal, /(?<![\w-])min-h-11(?![\w-])/, `${relative(url)}: ${literal}`);
      }
    }
  }
});

// T13: a focus outline drawn over Sun or Forest/Leaf is invisible (T7), so controls never sit inside those fills.
// The control itself may be filled (Book, primary, the checked pill): its outline lands on the card or page.
function elementsWithFill(source: string): { tag: string; inner: string }[] {
  const out: { tag: string; inner: string }[] = [];
  const open = /<([A-Za-z][\w.]*)\b((?:[^>"{]|"[^"]*"|\{[^}]*\})*?)(\/?)>/g;
  for (const m of source.matchAll(open)) {
    const [whole, tag, attrs, selfClosing] = m;
    if (selfClosing || !/(?<![\w:-])bg-(accent|brand)(?![\w-])/.test(attrs)) continue;
    // Find the matching close tag, counting nested elements with the same name
    const re = new RegExp(`<${tag}\\b|</${tag}>`, "g");
    re.lastIndex = m.index! + whole.length;
    let depth = 1;
    let end = source.length;
    for (let t = re.exec(source); t; t = re.exec(source)) {
      depth += t[0].startsWith("</") ? -1 : 1;
      if (depth === 0) {
        end = t.index;
        break;
      }
    }
    out.push({ tag, inner: source.slice(m.index! + whole.length, end) });
  }
  return out;
}

test("T13 no focusable element sits on an accent or brand surface", () => {
  for (const url of tsxFiles()) {
    for (const { tag, inner } of elementsWithFill(readFileSync(url, "utf8"))) {
      assert.doesNotMatch(
        inner,
        /<(a|button|input|select|textarea|Link|PixelButton|PixelLink|PixelCardLink|PixelChoice)\b/,
        `${relative(url)}: a control inside a bg-accent/bg-brand <${tag}>`,
      );
    }
  }
});

test("T13 the scan finds the filled elements it should", () => {
  const found = elementsWithFill('<div className="bg-accent p-2"><p>x</p><a href="/">y</a></div><a className="bg-brand">z</a>');
  assert.deepEqual(found.map((f) => f.tag), ["div", "a"]);
  assert.match(found[0].inner, /<a href/);
  assert.equal(found[1].inner, "z");
  assert.deepEqual(elementsWithFill('<label className="has-checked:bg-brand">x</label>'), [], "a variant fill isn't a surface");
});

// T14 (B12)
test("T14 no v1 classes anywhere", () => {
  const files = [...tsxFiles(), new URL("src/app/globals.css", WEB), new URL(`${PIXEL}classes.ts`, WEB)];
  for (const url of files) {
    const source = readFileSync(url, "utf8");
    const where = relative(url);
    assert.doesNotMatch(source, /rounded-(?!none\b)/, where);
    assert.doesNotMatch(source, /(?<![\w-])ring-/, where);
    assert.doesNotMatch(source, /(?<![\w-])shadow-(lg|md|sm)\b/, where);
    assert.doesNotMatch(source, /(?<![\w-])blur(-|\b)/, where);
    assert.doesNotMatch(source, /(text|bg)-\[#/, where);
    assert.doesNotMatch(source, /outline-(none|hidden)/, where);
    assert.doesNotMatch(source, /\bconst FOCUS\b/, where);
  }
});

// T15 (B12, guide 2.2): the pixel font has no ₱ or →, so it's for static headings written by us
test("T15 font-pixel only in components/pixel, and never on data", () => {
  const sources = walkFiles(new URL("src/", WEB)).filter(
    (url) => /\.tsx?$/.test(url.pathname) && !url.pathname.endsWith(".test.ts"),
  );
  for (const url of sources) {
    if (inPixel(url)) continue;
    assert.doesNotMatch(readFileSync(url, "utf8"), /(?<![\w-])font-pixel(?![\w-])/, relative(url));
  }
  for (const url of tsxFiles()) {
    const source = readFileSync(url, "utf8");
    for (const m of source.matchAll(/<(PageTitle|SectionTitle)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
      assert.doesNotMatch(m[2], /[₱→{\d]|formatPeso/, `${relative(url)}: <${m[1]}>${m[2]}</${m[1]}>`);
    }
  }
});

// T16 (B12, decision 2)
test("T16 className on Pixel* elements has no skin classes; PageTitle may add text-balance only", () => {
  for (const url of tsxFiles()) {
    const source = readFileSync(url, "utf8");
    for (const m of source.matchAll(/<(Pixel\w+|DialogBox)\b[^>]*?\bclassName="([^"]*)"/g)) {
      assert.deepEqual(lookTokens(m[2]), [], `${relative(url)}: <${m[1]} className="${m[2]}">`);
    }
    for (const m of source.matchAll(/<PageTitle\b[^>]*?\bclassName="([^"]*)"/g)) {
      assert.deepEqual(tokensOf(m[1]).filter((t) => t !== "text-balance"), [], `${relative(url)}: PageTitle className`);
    }
  }
});

// T21 (B10, ux.md 4.3): the standalone page duplicates the palette, so pin it to the tokens
test("T21 offline.html palette equals the tokens, in light and dark", () => {
  const html = read("public/offline.html");
  const { lightVars, darkVars } = tokenModes();
  const allowed = new Set([...Object.values(lightVars), ...Object.values(darkVars), ...Object.values(SCREEN)]);
  const hexes = [...html.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0].toLowerCase());
  assert.ok(hexes.length >= 8, "the page sets its own colours");
  for (const hex of hexes) assert.ok(allowed.has(hex), `offline.html ${hex} isn't a token value`);
  assert.match(html, /@media \(prefers-color-scheme: dark\)/);
  for (const hex of ["#121815", "#1b2420", "#5fb36b", "#ffd65c"]) assert.ok(hexes.includes(hex), `dark ${hex}`);
  assert.doesNotMatch(html, /border-radius:\s*(?!0[;\s}])/, "square corners only");
});

// T23 (B9, ux.md 3.3): the one copy-level change, so an overnight arrival is hard to miss
test("T23 the +1 day offset is emphasised", () => {
  const tripSearch = read("src/components/TripSearch.tsx");
  assert.match(
    tripSearch,
    /<span className="font-semibold text-foreground">\{formatDayOffset\(t\.arrives_day_offset\)\}<\/span>/,
  );
});

// B11 (ux.md 5.2): the pills are PixelChoice, so TG-17's :checked focus query still finds a native radio
test("B11 the terminal pills are PixelChoice radios named terminal", () => {
  const lastMile = read("src/components/LastMile.tsx");
  assert.match(lastMile, /<PixelChoice\b[^>]*\bname="terminal"/);
  assert.doesNotMatch(lastMile, /<input\b/, "the radio comes from PixelChoice");
});
