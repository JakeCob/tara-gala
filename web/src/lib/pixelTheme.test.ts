// Pixel theme tests (TG-42 PR A): tokens, contrast, fonts and the shared primitives in components/pixel.
// Run with `npm test` (node --test, Node 22.18+ type stripping). Source files are read as text, as in pwa.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { PALETTE as ART_PALETTE } from "./pixelSvg.ts";

const WEB = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB), "utf8");
const PIXEL = "src/components/pixel/";

// PX lives in a plain module. Load it inside the tests that need it, so the token tests still run (and fail on
// their own assertions) while the module doesn't exist yet.
type Skinned = { skin: string; layout: string };
type PXShape = {
  box: Skinned & { alert: string; alertText: string }; // TG-47 ux §7: the alert lining, as PixelBox tones
  btn: Record<"primary" | "secondary" | "accent" | "icon" | "iconBrand", Skinned>;
  choice: Skinned;
  chip: string;
  chipHighlight: string; // TG-47 ux §2
  screenChip: string;
  input: string;
  h1: string;
  wordmark: string;
  h2: string;
  dataHeading: string;
  meta: string;
  inlineLink: string;
  plate: string; // TG-43 ux §4
  numeral: string; // TG-43 plan §3.2
  shell: string;
  screenTag: string;
  inputPrefix: string;
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

// The art palette has one source, pixelSvg.ts (TG-47: the 6 greens, Flag Blue, Red and Yellow, two skin tones)
const PALETTE: Record<string, string> = { ...ART_PALETTE };
const SKIN = ["#8d5524", "#c68642"]; // art only, never a UI token (ux §0.6)
const MUTED_LIGHT = "#4f5f57"; // the screen's muted text (screen-muted)
// TG-49 (ux-guide v3, the signboard look): the UI's own colours beside the art palette. Paper is the page, White the
// card, Chrome the decorative divider, Dust the muted text.
const SIGNBOARD = { paper: "#fff8e7", white: "#ffffff", chrome: "#c9ced3", dust: "#5c5446" };

const LIGHT = {
  background: "#fff8e7", foreground: "#1d2a24", muted: "#5c5446", card: "#ffffff",
  frame: "#1d2a24", border: "#c9ced3", brand: "#ce1126", "brand-ink": "#fff8e7",
  accent: "#fcd116", "accent-ink": "#1d2a24", focus: "#1d2a24",
  // TG-49: Red to act (the jeepney's "go"), Blue for links and the box's hard shadow (lift), Yellow to look or book
  primary: "#ce1126", "primary-ink": "#ffffff", link: "#0038a8", danger: "#ce1126", "danger-text": "#ce1126",
  lift: "#0038a8",
};
const DARK_OVERRIDES = {
  background: "#16130e", foreground: "#fff8e7", muted: "#b9ae9a", card: "#211d16",
  frame: "#fff8e7", border: "#3a342a", brand: "#ff6b6b", "brand-ink": "#16130e", focus: "#fcd116",
  link: "#8fb0ff", "danger-text": "#ff8a8a", lift: "#8fb0ff", // UI-only tints: Flag Blue and Red can't be text on the dark card
};
// TG-47: the flag colours for the game screen (map banners), fixed in both themes like screen-*
const FIXED_FLAG = { "--color-flag-blue": "#0038a8", "--color-flag-red": "#ce1126", "--color-flag-yellow": "#fcd116" };
const SCREEN = {
  "--color-screen": "#cfe8c4", "--color-screen-paper": "#fbf7ee",
  "--color-screen-ink": "#1d2a24", "--color-screen-muted": "#4f5f57",
};
const TOKEN_NAMES = Object.keys(LIGHT);

// T2 (B1)
test("T2 tokens match guide 1.2 in light and dark", () => {
  const { lightVars, darkVars, dark } = tokenModes();
  const pick = (o: Record<string, string>) => Object.fromEntries(TOKEN_NAMES.filter((k) => k in o).map((k) => [k, o[k]]));
  assert.deepEqual(pick(lightVars), LIGHT, "the 17 light :root variables");
  assert.deepEqual(pick(darkVars), DARK_OVERRIDES, "dark overrides 12 tokens; accent, accent-ink, primary, primary-ink and danger are inherited");
  assert.deepEqual(pick(dark), { ...LIGHT, ...DARK_OVERRIDES });
});

test("T2 the screen tokens are fixed and every token is a Tailwind colour", () => {
  const { all } = tokenModes();
  const theme = all.filter((b) => b.path.length === 1 && b.path[0] === "@theme").map((b) => decls(b.body));
  const fixed = Object.assign({}, ...theme) as Record<string, string>;
  for (const [name, hex] of Object.entries({ ...SCREEN, ...FIXED_FLAG })) {
    assert.equal(fixed[name]?.toLowerCase(), hex, `${name} in a plain @theme block`);
  }
  for (const b of all) {
    if (DARK.test(b.path[0] ?? "")) {
      assert.doesNotMatch(b.body, /--color-screen/, "screen tokens must not change in dark mode");
      assert.doesNotMatch(b.body, /--color-flag/, "the flag colours are the game screen's: fixed in dark mode too");
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
  // TG-49: font-pixel keeps its name and now draws the signboard display face
  assert.match(inline["--font-pixel"] ?? "", /^var\(--font-sign\),\s*var\(--font-nunito\)/);
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
  // TG-49: square signboard corners (no notch, no clip-path), one frame, and a hard offset shadow
  assert.match(util("pixel-frame"), /border:\s*3px solid var\(--frame\)/);
  assert.match(util("pixel-frame"), /border-radius:\s*0/);
  assert.doesNotMatch(util("pixel-frame"), /clip-path/);
  assert.match(util("pixel-box"), /@apply pixel-frame/);
  assert.match(util("pixel-box"), /box-shadow:\s*5px 5px 0 0 var\(--lift\)/);
  assert.doesNotMatch(util("pixel-box"), /outline/, "one frame, not the v2 double line");
  assert.match(util("pixel-btn"), /box-shadow:\s*3px 3px 0 0 var\(--frame\)/);
  assert.match(util("pixel-btn"), /&:active:not\(:disabled, \[aria-disabled="true"\]\)\s*\{\s*translate:\s*3px 3px;\s*box-shadow:\s*none;?\s*\}/);
  assert.match(util("pixel-btn"), /&:disabled, &\[aria-disabled="true"\]\s*\{\s*opacity:\s*\.6;\s*box-shadow:\s*none;?\s*\}/);
  assert.match(util("focus-pixel"), /&:focus-visible\s*\{\s*outline:\s*3px solid var\(--focus\);\s*outline-offset:\s*2px;?\s*\}/);
  assert.match(util("focus-pixel-within"), /&:has\(:focus-visible\)\s*\{\s*outline:\s*3px solid var\(--focus\);\s*outline-offset:\s*2px;?\s*\}/);
  assert.match(util("pixelated"), /image-rendering:\s*pixelated/);
});

// T3 (B1)
test("T3 art palette is exactly 11 colours and the light tokens use only it plus the signboard colours", () => {
  const { lightVars, darkVars } = tokenModes();
  const palette = new Set(Object.values(PALETTE));
  assert.deepEqual([...palette], [
    "#1d2a24", "#167856", "#5fb36b", "#cfe8c4", "#fbf7ee", "#ffd65c", "#0038a8", "#ce1126", "#fcd116", "#8d5524", "#c68642",
  ], "pixelSvg.ts PALETTE, in order (the one deliberate copy)");
  const ui = new Set([...palette, ...Object.values(SIGNBOARD)]);
  for (const name of TOKEN_NAMES) {
    assert.ok(lightVars[name], `light --${name} is set`);
    assert.ok(ui.has(lightVars[name]), `light --${name} ${lightVars[name]} is off-palette`);
  }
  for (const hex of Object.values(SCREEN)) {
    assert.ok(palette.has(hex) || hex === MUTED_LIGHT, `screen token ${hex}`);
  }
  const offPalette = new Set(Object.values(darkVars).filter((hex) => !ui.has(hex)));
  assert.deepEqual([...offPalette].sort(), ["#16130e", "#211d16", "#3a342a", "#8fb0ff", "#b9ae9a", "#ff6b6b", "#ff8a8a"], "the only non-palette dark values");
  // Skin tones are art only (ux §0.6): no token in either mode uses one
  for (const [mode, vars] of [["light", lightVars], ["dark", { ...lightVars, ...darkVars }]] as const) {
    for (const [name, hex] of Object.entries(vars)) assert.ok(!SKIN.includes(hex), `${mode} --${name} is a skin tone`);
  }
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
  // TG-47 ux §3
  ["primary-ink", "primary"],
  ["link", "card"],
  ["link", "background"],
  ["danger-text", "card"],
];
const SCREEN_PAIRS: [fg: string, bg: string][] = [
  ["--color-screen-ink", "--color-screen"],
  ["--color-screen-ink", "--color-screen-paper"],
  ["--color-screen-muted", "--color-screen-paper"],
  ["--color-screen-paper", "--color-flag-blue"], // TG-47: the map's Blue title bars
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

// T5 (B15). TG-49: the Red h1 passes AA on Paper at any size (Forest on Mint was large-text only)
test("T5 brand on background is AA in both modes", () => {
  const { lightVars, dark } = tokenModes();
  assert.ok(contrast(lightVars.brand, lightVars.background) >= 4.5, "light brand on background");
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
  // Chrome (light border) and Flag Yellow (accent) never carry text on White (card) or Paper (background)
  for (const fg of ["border", "accent"]) {
    for (const bg of ["card", "background"]) {
      assert.ok(contrast(lightVars[fg], lightVars[bg]) < 4.5, `light ${fg} on ${bg}: ${msg}`);
    }
  }
  for (const name of ["primary", "danger", "danger-text"]) assert.ok(lightVars[name], `light --${name} is set`);
  // No control on a Red surface (Ink focus on Red is 2.65), and Yellow focus on Yellow is 1.0 in dark mode
  assert.ok(contrast(lightVars.focus, lightVars.primary) < 3.0, `light focus on primary: ${msg}`);
  assert.ok(contrast(lightVars.focus, lightVars.danger) < 3.0, `light focus on danger: ${msg}`);
  assert.ok(contrast(lightVars.focus, lightVars.lift) < 3.0, `light focus on lift (Blue): ${msg}`);
  // Ink text never on Blue or Red: White or Paper only
  assert.ok(contrast(lightVars.foreground, lightVars.primary) < 4.5, `Ink on primary: ${msg}`);
  assert.ok(contrast(lightVars.foreground, lightVars.link) < 4.5, `Ink on Flag Blue: ${msg}`);
  assert.ok(contrast(lightVars.foreground, lightVars.danger) < 4.5, `Ink on danger: ${msg}`);
  // Raw Flag Blue and Red can't be text on the dark card, hence the dark link and danger-text tints
  assert.ok(contrast(lightVars.primary, dark.card) < 4.5, `Flag Blue on the dark card: ${msg}`);
  assert.ok(contrast(lightVars.danger, dark.card) < 4.5, `Flag Red on the dark card: ${msg}`);
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
  box: {
    skin: "pixel-box bg-card",
    layout: "p-4 flex flex-col gap-2",
    // TG-49: a Red inner line and a Red hard shadow in place of the Blue lift; no element, no layout change
    alert: "shadow-[inset_0_0_0_3px_var(--danger),5px_5px_0_0_var(--danger)]",
    alertText: "shadow-[inset_0_0_0_3px_var(--danger),5px_5px_0_0_var(--danger)] text-danger-text", // a one-sentence box is its own lead
  },
  btn: {
    primary: { skin: "pixel-btn focus-pixel min-h-11 bg-primary font-bold text-primary-ink", layout: "px-4 py-3" },
    secondary: { skin: "pixel-btn focus-pixel min-h-11 bg-card font-semibold text-foreground", layout: "inline-flex items-center px-4 text-sm" },
    accent: { skin: "pixel-btn focus-pixel min-h-11 bg-accent font-bold text-accent-ink", layout: "inline-flex items-center px-3 text-sm" },
    icon: { skin: "pixel-btn focus-pixel min-h-11 min-w-11 bg-card", layout: "inline-flex items-center justify-center" },
    iconBrand: { skin: "pixel-btn focus-pixel min-h-11 min-w-11 bg-card text-link", layout: "inline-flex items-center justify-center text-xl leading-none" },
  },
  choice: {
    skin: "group/choice pixel-btn focus-pixel-within min-h-11 cursor-pointer bg-card font-semibold has-checked:bg-primary has-checked:text-primary-ink has-checked:translate-x-[3px] has-checked:translate-y-[3px] has-checked:shadow-none has-[[aria-disabled=true]]:opacity-60 has-[[aria-disabled=true]]:shadow-none",
    layout: "flex items-center justify-center gap-1 px-2 py-2 text-center text-sm leading-tight",
  },
  chip: "pixel-frame bg-card px-2 py-1 text-sm",
  chipHighlight: "pixel-frame bg-accent text-accent-ink px-2 py-1 text-sm", // TG-47 ux §2, colour only (plan §6.2)
  screenChip: "pixel-frame bg-screen-paper text-screen-ink px-2 py-1 text-sm",
  input: "min-h-11 rounded-none border-3 border-frame bg-card px-3 py-2 text-base text-foreground focus-pixel",
  // TG-49: the signboard face is wide and has one weight (400), so titles step down and never synthesise bold
  h1: "font-pixel text-[1.75rem] leading-tight font-normal text-brand md:text-[2.25rem]",
  wordmark: "font-wordmark text-[1.75rem] leading-tight font-normal text-screen-ink md:text-[2.25rem]",
  h2: "font-pixel text-xl font-normal",
  dataHeading: "text-base font-bold",
  meta: "text-xs text-muted",
  inlineLink: "underline underline-offset-2 focus-pixel text-link",
  // TG-43 ux §4: the sprite plate (stepper rows, stop sprites), the stage tag, the budget's ₱ prefix;
  // plan §3.2: the share page's decorative step numeral
  plate: "pixel-frame bg-screen-paper p-0.5 inline-flex shrink-0",
  numeral: "font-pixel text-xl font-normal",
  screenTag: "pixel-frame bg-screen-paper text-screen-ink px-1 text-xs font-semibold",
  inputPrefix: "inline-flex items-center border-3 border-r-0 border-frame bg-card px-3 text-base font-bold text-foreground",
  // TG-44 ux §2: the page shell
  shell: "mx-auto w-full max-w-md flex-1 px-4 py-6 flex flex-col gap-5 md:max-w-3xl md:px-6 md:py-8 lg:max-w-5xl lg:px-8 xl:max-w-6xl",
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

test("B4 DialogBox takes the box's own hard shadow, with no wrapper drop-shadow (TG-49: no clip-path to dodge)", () => {
  const source = primitive("DialogBox");
  assert.doesNotMatch(source, /drop-shadow-/);
  assert.match(source, /PX\.box\.skin/);
  assert.match(source, /p-4 flex flex-col gap-3/);
});

test("B4 PageTitle and SectionTitle use PX headings; SectionTitle supports the screen and form tags", () => {
  assert.match(primitive("PageTitle"), /<h1\b/);
  assert.match(primitive("PageTitle"), /PX\.h1/);
  const section = primitive("SectionTitle");
  assert.match(section, /PX\.h2/);
  assert.match(section, /onScreen === "banner"\s*\?\s*"text-screen-paper"\s*:\s*onScreen\s*\?\s*"text-screen-ink"\s*:\s*"text-foreground"/);
  assert.match(section, /onScreen\?: boolean \| "banner"/, "TG-47: the Blue map banner");
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

// TG-49: the signboard display face (Cubao Free, OFL) replaces Pixelify Sans, self-hosted by next/font like Nunito
test("T18 layout.tsx loads Nunito through next/font/google and the signboard face through next/font/local", () => {
  const layout = read("src/app/layout.tsx");
  assert.match(layout, /import\s*\{\s*Nunito\s*\}\s*from\s*"next\/font\/google"/);
  assert.match(layout, /import\s+localFont\s+from\s*"next\/font\/local"/);
  assert.doesNotMatch(layout, /Bungee/);
  assert.doesNotMatch(layout, /Pixelify/);
  assert.match(
    layout,
    /Nunito\(\{\s*subsets:\s*\["latin",\s*"latin-ext"\],\s*display:\s*"swap",\s*variable:\s*"--font-nunito"\s*\}\)/,
  );
  assert.match(
    layout,
    /localFont\(\{\s*src:\s*"\.\.\/fonts\/Cubao_Free_Regular\.otf",\s*display:\s*"swap",\s*variable:\s*"--font-sign"\s*\}\)/,
  );
  // the Wide cut draws the home wordmark only
  assert.match(
    layout,
    /localFont\(\{\s*src:\s*"\.\.\/fonts\/Cubao_Free_Wide\.otf",\s*display:\s*"swap",\s*variable:\s*"--font-sign-wide"\s*\}\)/,
  );
  // OFL 1.1 travels with the font file
  assert.match(read("src/fonts/OFL.txt"), /Copyright \(c\) 2018, Aaron Amar[\s\S]*SIL Open Font License, Version 1\.1/);
  const html = layout.match(/<html\b[^>]*>/)?.[0] ?? "";
  assert.match(html, /lang="en"/);
  assert.match(html, /className=\{`\$\{nunito\.variable\} \$\{sign\.variable\} \$\{signWide\.variable\} h-full antialiased`\}/);
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
    if (selfClosing || !/(?<![\w:-])bg-(accent|brand|primary|danger|flag-blue|flag-red|flag-yellow)(?![\w-])/.test(attrs)) continue;
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
        `${relative(url)}: a control inside a bg-accent/brand/primary/danger/flag-* <${tag}>`,
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
  // TG-47: the Blue, Red and Yellow fills are surfaces too
  const flags = elementsWithFill('<div className="bg-primary"><a>y</a></div><span className="bg-flag-blue px-1">t</span>');
  assert.deepEqual(flags.map((f) => f.tag), ["div", "span"]);
  assert.deepEqual(elementsWithFill('<label className="has-checked:bg-primary">x</label>'), [], "a checked pill's fill isn't a surface");
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

// Dates and numbers are fine in the pixel font (ux-guide 2.2 allows day banners like "Day 1 · Sat, Nov 7", and
// TG-22's banners are {banner.text}); only ₱ and → lack glyphs. Narrowed for TG-22 (manager decision, 2026-10-28),
// then extended to the helpers that return them: formatPeso and formatFare (₱), routeLabel (→).
// world.test.ts checks the banner text itself has no ₱ or →.
const PIXEL_TITLE_BAN = /[₱→]|\\u20b1|\\u2192|formatPeso|formatFare|routeLabel/i;

test("T15 the pixel-title ban list catches each glyph and helper, and allows dates", () => {
  for (const banned of ["Fare ₱50", "Manila → Baguio", '{"\\u20b1"}', '{"\\u2192"}', "{formatPeso(6000)}", "{formatFare(13, 15)}", '{routeLabel("to-baguio")}']) {
    assert.match(banned, PIXEL_TITLE_BAN, banned);
  }
  for (const allowed of ["Day 1 · Sat, Nov 7", "{banner.text}", "Who's travelling?"]) assert.doesNotMatch(allowed, PIXEL_TITLE_BAN, allowed);
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
      assert.doesNotMatch(m[2], PIXEL_TITLE_BAN, `${relative(url)}: <${m[1]}>${m[2]}</${m[1]}>`);
    }
    // Children go between the tags, where this test can see them
    assert.doesNotMatch(source, /<(PageTitle|SectionTitle)\b[^>]*\bchildren=/, `${relative(url)}: children prop on a title`);
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
  for (const hex of ["#16130e", "#211d16", "#ff6b6b", "#fcd116"]) assert.ok(hexes.includes(hex), `dark ${hex}`);
  assert.doesNotMatch(html, /border-radius:(?!\s*0[;\s}])/, "square corners only");
});

// T23 (B9, ux.md 3.3): the one copy-level change, so an overnight arrival is hard to miss
// TG-23 moved the bus card out of TripSearch.tsx into TripCard.tsx (shared with the share page)
test("T23 the +1 day offset is emphasised", () => {
  const tripCard = read("src/components/TripCard.tsx");
  assert.match(read("src/components/TripSearch.tsx"), /<TripCard\b/, "search renders the shared card");
  assert.match(
    tripCard,
    /<span className="font-semibold text-foreground">\{formatDayOffset\(t\.arrives_day_offset\)\}<\/span>/,
  );
});

// B11 (ux.md 5.2): the pills are PixelChoice, so TG-17's :checked focus query still finds a native radio
test("B11 the terminal pills are PixelChoice radios named terminal", () => {
  const lastMile = read("src/components/LastMile.tsx");
  assert.match(lastMile, /<PixelChoice\b[^>]*\bname="terminal"/);
  assert.doesNotMatch(lastMile, /<input\b/, "the radio comes from PixelChoice");
});

// ---------------------------------------------------------------- TG-43 A2: the three new PX keys

test("T43-P1 the new plate, stage tag and ₱ prefix keys are screen-paper or frame, with no v1 shapes", async () => {
  const { PX } = await loadPixel();
  for (const key of ["plate", "screenTag", "inputPrefix"] as const) assert.equal(typeof PX[key], "string", `PX.${key} exists`);
  for (const key of ["plate", "screenTag"] as const) {
    const t = tokensOf(PX[key]);
    assert.ok(t.includes("bg-screen-paper"), `${key} sits on screen-paper (guide 1.3: sprites never on card)`);
    assert.ok(!t.includes("bg-card"), key);
    assert.ok(t.includes("pixel-frame"), key);
  }
  assert.ok(tokensOf(PX.screenTag).includes("text-screen-ink"), "screen text, fixed in both themes");
  const prefix = tokensOf(PX.inputPrefix);
  for (const t of ["border-frame", "border-r-0", "border-3"]) assert.ok(prefix.includes(t), `inputPrefix has ${t}`);
  for (const key of ["plate", "screenTag", "inputPrefix"] as const) {
    assert.doesNotMatch(PX[key], /rounded-|\bring-|shadow-(sm|md|lg|xl)|#[0-9a-f]{3,8}\b/i, key);
  }
});

// TG-43 UX review S2: the date input's calendar-button Tab stop matches neither :focus nor :focus-visible on the
// input (focus is in Chrome's shadow DOM), so focus-pixel can't draw there. :focus-within can, for every date input.
test("T43-U2 globals.css outlines a date input whenever focus is inside it", () => {
  const rule = blocks(read("src/app/globals.css")).find((b) => b.path[b.path.length - 1] === "input[type=date]:focus-within");
  assert.ok(rule, "an input[type=date]:focus-within rule");
  assert.equal(rule.path.length, 1, "top level, not inside a media query");
  const d = decls(rule.body);
  assert.equal(d.outline, "3px solid var(--focus)");
  assert.equal(d["outline-offset"], "2px");
});

// ---------------------------------------------------------------- TG-47 B/C: flag-colour tokens, contrast, no flag

// T47-T1, revised for TG-49 (ux-guide v3 §1.2): the action, link, alert and accent tokens per mode. "same" in dark means
// inherited, never redeclared.
test("T47-T1 the new and changed tokens have ux's exact values in light and dark", () => {
  const { lightVars, darkVars, dark } = tokenModes();
  const ux: [name: string, light: string, dark: string][] = [
    ["primary", "#ce1126", "#ce1126"],
    ["primary-ink", "#ffffff", "#ffffff"],
    ["link", "#0038a8", "#8fb0ff"],
    ["danger", "#ce1126", "#ce1126"],
    ["danger-text", "#ce1126", "#ff8a8a"],
    ["accent", "#fcd116", "#fcd116"],
    ["accent-ink", "#1d2a24", "#1d2a24"],
    ["lift", "#0038a8", "#8fb0ff"],
  ];
  for (const [name, l, d] of ux) {
    assert.equal(lightVars[name], l, `light --${name}`);
    assert.equal(dark[name], d, `dark --${name}`);
    if (l === d) assert.ok(!(name in darkVars), `--${name} is the same in dark: inherited, not redeclared`);
  }
});

// T47-T2: the @theme inline mappings and the fixed flag colours
test("T47-T2 the new tokens are Tailwind colours; the flag colours are fixed hexes", () => {
  const { all } = tokenModes();
  const inline = Object.assign({}, ...all.filter((b) => b.path.length === 1 && b.path[0] === "@theme inline").map((b) => decls(b.body)));
  for (const name of ["primary", "primary-ink", "link", "danger", "danger-text", "lift"]) {
    assert.equal(inline[`--color-${name}`], `var(--${name})`, `@theme inline --color-${name}`);
  }
  const fixed = Object.assign({}, ...all.filter((b) => b.path.length === 1 && b.path[0] === "@theme").map((b) => decls(b.body)));
  for (const [name, hex] of Object.entries(FIXED_FLAG)) {
    assert.equal(fixed[name]?.toLowerCase(), hex, `${name} is a fixed hex`);
    assert.ok(!(name in inline), `${name} is not a var: the game screen doesn't follow the theme`);
  }
});

// T47-C1: ux §3's table as the test. Each ratio must meet its minimum AND equal ux's documented number (to ux's
// own precision), so a token edit that still passes AA but changes the table shows up as a ux change.
type Row = { fg: string; bg: string; mode: "light" | "dark" | "fixed"; min: number | null; ux: number; dp: 1 | 2; where: string };
const UX_TABLE: Row[] = [
  { fg: "primary-ink", bg: "primary", mode: "light", min: 4.5, ux: 5.63, dp: 2, where: "primary buttons, checked pills, cursor (TG-49: Red to act)" },
  { fg: "primary-ink", bg: "primary", mode: "dark", min: 4.5, ux: 5.63, dp: 2, where: "primary buttons, checked pills, cursor (TG-49: Red to act)" },
  { fg: "--color-screen-paper", bg: "--color-flag-blue", mode: "fixed", min: 4.5, ux: 9.22, dp: 2, where: "map banners" },
  { fg: "link", bg: "card", mode: "light", min: 4.5, ux: 9.85, dp: 2, where: "links, Maps, the swap glyph" },
  { fg: "link", bg: "card", mode: "dark", min: 4.5, ux: 7.85, dp: 2, where: "links, Maps, the swap glyph" },
  { fg: "link", bg: "background", mode: "light", min: 4.5, ux: 9.31, dp: 2, where: "a link on the page" },
  { fg: "link", bg: "background", mode: "dark", min: 4.5, ux: 8.66, dp: 2, where: "a link on the page" },
  { fg: "accent-ink", bg: "accent", mode: "light", min: 4.5, ux: 10.13, dp: 2, where: "Book, stale banner, highlight chip" },
  { fg: "accent-ink", bg: "accent", mode: "dark", min: 4.5, ux: 10.13, dp: 2, where: "Book, stale banner, highlight chip" },
  { fg: "danger-text", bg: "card", mode: "light", min: 4.5, ux: 5.63, dp: 2, where: "alert leads, card warnings" },
  { fg: "danger-text", bg: "card", mode: "dark", min: 4.5, ux: 7.39, dp: 2, where: "alert leads, card warnings" },
  { fg: "danger-text", bg: "background", mode: "light", min: 4.5, ux: 5.31, dp: 2, where: "TG-49: Red on Paper passes, unlike Red on Mint" },
  { fg: "danger-text", bg: "background", mode: "dark", min: 4.5, ux: 8.16, dp: 2, where: "a red line on the page" },
  { fg: "brand", bg: "background", mode: "light", min: 4.5, ux: 5.31, dp: 2, where: "TG-49: the Red h1 at any size" },
  { fg: "brand", bg: "background", mode: "dark", min: 4.5, ux: 6.68, dp: 2, where: "the dark h1" },
  { fg: "danger", bg: "frame", mode: "light", min: null, ux: 2.65, dp: 2, where: "the alert lining, decorative (never text, C2)" },
  { fg: "danger", bg: "frame", mode: "dark", min: null, ux: 5.31, dp: 2, where: "the alert lining, decorative (never text, C2)" },
  { fg: "lift", bg: "background", mode: "light", min: 3, ux: 9.31, dp: 2, where: "the box's hard shadow (decorative, but it reads as an edge)" },
  { fg: "lift", bg: "background", mode: "dark", min: 3, ux: 8.66, dp: 2, where: "the box's hard shadow (decorative, but it reads as an edge)" },
  { fg: "frame", bg: "background", mode: "light", min: 3, ux: 14.1, dp: 1, where: "the frame defines every control" },
  { fg: "frame", bg: "card", mode: "light", min: 3, ux: 14.9, dp: 1, where: "the frame defines every control" },
  { fg: "frame", bg: "card", mode: "dark", min: 3, ux: 15.8, dp: 1, where: "the frame defines every control" },
  { fg: "focus", bg: "card", mode: "light", min: 3, ux: 14.9, dp: 1, where: "focus around a Red or Yellow control" },
  { fg: "focus", bg: "background", mode: "light", min: 3, ux: 14.1, dp: 1, where: "focus around a Red or Yellow control" },
  { fg: "focus", bg: "card", mode: "dark", min: 3, ux: 11.4, dp: 1, where: "focus around a Red or Yellow control" },
  { fg: "focus", bg: "background", mode: "dark", min: 3, ux: 12.6, dp: 1, where: "focus around a Red or Yellow control" },
];

test("T47-C1 ux §3's contrast table holds, number for number, in both themes", () => {
  const { lightVars, dark, all } = tokenModes();
  const fixed = Object.assign({}, ...all.filter((b) => b.path.length === 1 && b.path[0] === "@theme").map((b) => decls(b.body)));
  for (const row of UX_TABLE) {
    const vars: Record<string, string> = row.mode === "light" ? lightVars : row.mode === "dark" ? dark : fixed;
    const [fg, bg] = [vars[row.fg]?.toLowerCase(), vars[row.bg]?.toLowerCase()];
    assert.ok(fg && bg, `${row.mode}: ${row.fg} and ${row.bg} are set (${row.where})`);
    const ratio = contrast(fg, bg);
    const label = `${row.mode} ${row.fg} on ${row.bg} = ${ratio.toFixed(3)} (${row.where})`;
    if (row.min !== null) assert.ok(ratio >= row.min, `${label}: below ${row.min}`);
    assert.ok(Math.abs(ratio - row.ux) < (row.dp === 2 ? 0.01 : 0.05), `${label}: ux §3 says ${row.ux}`);
  }
});

// T47-C2/C3: every colour pair written in the code is one ux §3 or T4 approved. Class literals are scanned, tokens
// grouped by variant prefix (has-checked:, md:, …), and each bg-X with a text-Y in the same group is a pair.
const COLOUR_NAMES = [
  "background", "foreground", "muted", "card", "frame", "border", "brand", "brand-ink", "accent", "accent-ink", "focus",
  "primary", "primary-ink", "link", "danger", "danger-text", "lift", "screen", "screen-paper", "screen-ink", "screen-muted",
  "flag-blue", "flag-red", "flag-yellow",
];
const colourOf = (token: string, prop: "bg" | "text" | "border") => {
  const m = token.match(new RegExp(`^${prop}-(.+)$`));
  return m && COLOUR_NAMES.includes(m[1]) ? m[1] : null;
};
/** The colour pairs in one class literal: [fg, bg] for every bg-X and text-Y sharing a variant prefix. */
function colourPairs(literal: string): [fg: string, bg: string][] {
  const groups = new Map<string, { bg: string[]; text: string[] }>();
  for (const token of tokensOf(literal.replace(/^["'`]|["'`]$/g, ""))) {
    const cut = token.lastIndexOf(":");
    const [prefix, bareToken] = cut < 0 ? ["", token] : [token.slice(0, cut), token.slice(cut + 1)];
    const g = groups.get(prefix) ?? { bg: [], text: [] };
    const bg = colourOf(bareToken, "bg");
    const text = colourOf(bareToken, "text");
    if (bg) g.bg.push(bg);
    if (text) g.text.push(text);
    groups.set(prefix, g);
  }
  return [...groups.values()].flatMap((g) => g.text.flatMap((fg) => g.bg.map((bg) => [fg, bg] as [string, string])));
}
const APPROVED_PAIRS = new Set([
  ...TEXT_PAIRS.map(([fg, bg]) => `${fg}/${bg}`),
  ...SCREEN_PAIRS.map(([fg, bg]) => `${fg.replace("--color-", "")}/${bg.replace("--color-", "")}`),
]);
// ux §3 rules, per file: red text only where ux puts it (alert leads and the card warning lines)
const DANGER_TEXT_FILES = ["src/components/pixel/classes.ts", "src/components/TripCard.tsx", "src/components/LegCard.tsx",
  "src/components/PlanResults.tsx", "src/components/ItineraryView.tsx", "src/components/ItineraryList.tsx", "src/components/LastMile.tsx"];

test("T47-C2 every colour pair in the code is approved; red text and Blue links only where ux puts them", async () => {
  const { PX } = await loadPixel();
  const sources: [string, string[]][] = [
    ...tsxFiles().filter((u) => !inPixel(u)).map((u) => [relative(u), stringLiterals(readFileSync(u, "utf8"))] as [string, string[]]),
    ["src/components/pixel/classes.ts", flatPX(PX).map(([, v]) => v)],
  ];
  for (const [file, literals] of sources) {
    for (const literal of literals) {
      for (const [fg, bg] of colourPairs(literal)) {
        assert.ok(APPROVED_PAIRS.has(`${fg}/${bg}`), `${file}: text-${fg} on bg-${bg} isn't a ux §3 / T4 pair: ${literal}`);
      }
      const t = tokensOf(literal.replace(/^["'`]|["'`]$/g, "")).map(bare);
      if (t.includes("text-danger-text")) assert.ok(DANGER_TEXT_FILES.includes(file), `${file}: red text outside ux's places: ${literal}`);
      if (t.includes("text-link")) {
        assert.ok(!t.some((x) => ["bg-primary", "bg-danger", "bg-accent"].includes(x)), `${file}: a link on a flag fill: ${literal}`);
      }
      if (t.includes("bg-danger")) {
        assert.ok(!t.some((x) => colourOf(x, "text")), `${file}: bg-danger is never a text surface: ${literal}`);
      }
    }
  }
});

test("T47-C3 the pair scanner finds pairs per variant group and ignores sizes", () => {
  assert.deepEqual(colourPairs('"bg-primary text-primary-ink"'), [["primary-ink", "primary"]]);
  assert.deepEqual(colourPairs('"has-checked:bg-primary has-checked:text-primary-ink bg-card"'), [["primary-ink", "primary"]]);
  assert.deepEqual(colourPairs('"bg-card text-sm text-center font-bold"'), []);
  assert.deepEqual(colourPairs('"bg-primary text-link"'), [["link", "primary"]]);
  assert.ok(!APPROVED_PAIRS.has("link/primary"), "a link on Blue is not approved");
  assert.ok(!APPROVED_PAIRS.has("foreground/primary"), "Ink on the Red button is not approved");
  assert.ok(APPROVED_PAIRS.has("screen-paper/flag-blue"), "the map banner pair is approved");
});

// T47-F1: no literal flag (RA 8491, ux §0.5)
// TG-49: primary is Flag Red; Blue is the link and the lift (hard shadow)
const BLUE = ["flag-blue", "link", "lift"];
const RED = ["primary", "danger", "danger-text", "flag-red"];
const YELLOW = ["accent", "flag-yellow"];
function flagProblems(literal: string): string[] {
  const t = tokensOf(literal.replace(/^["'`]|["'`]$/g, "")).map(bare);
  const families = new Set<string>();
  for (const x of t) {
    const c = colourOf(x, "bg") ?? colourOf(x, "border") ?? (x.startsWith("shadow-[") && /var\(--danger\)/.test(x) ? "danger" : null);
    if (!c) continue;
    if (BLUE.includes(c)) families.add("blue");
    if (RED.includes(c)) families.add("red");
    if (YELLOW.includes(c) && (x.includes("flag-") || families.size)) families.add("yellow");
  }
  const out: string[] = [];
  if (families.has("blue") && families.has("red")) out.push("Blue and Red fills or borders in one element");
  const flagFills = t.filter((x) => /^(bg|border)-flag-/.test(x));
  if (new Set(flagFills.map((x) => x.replace(/^(bg|border)-/, ""))).size > 1) out.push("two flag colours in one element");
  return out;
}

test("T47-F1 no element combines flag colours; no flag gradient, triangle or sun on Blue or Red", async () => {
  const { PX } = await loadPixel();
  for (const url of tsxFiles()) {
    const source = readFileSync(url, "utf8");
    for (const literal of stringLiterals(source)) assert.deepEqual(flagProblems(literal), [], `${relative(url)}: ${literal}`);
    assert.doesNotMatch(source, /linear-gradient/i, `${relative(url)}: no gradients`);
    for (const m of source.matchAll(/<([A-Za-z][\w.]*)\b[^>]*\bbg-(primary|flag-blue|danger|flag-red)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
      assert.doesNotMatch(m[3], /deco-sun-stars/, `${relative(url)}: the sun and stars on a Blue or Red field`);
    }
  }
  for (const [path, value] of flatPX(PX)) assert.deepEqual(flagProblems(value), [], `PX.${path}`);
  const css = read("src/app/globals.css");
  assert.doesNotMatch(css, /linear-gradient[^;]*(#0038a8|#ce1126|#fcd116|flag-)/i, "no flag gradient");
  for (const m of css.matchAll(/polygon\(([^)]*)\)/g)) {
    assert.ok(m[1].split(",").length !== 3, `no triangle clip-path: polygon(${m[1]})`);
  }
  // the checker itself
  assert.deepEqual(flagProblems('"bg-primary border-flag-red"'), [], "TG-49: primary is Red, so this is one colour");
  assert.deepEqual(flagProblems('"bg-flag-blue border-flag-yellow"'), ["two flag colours in one element"]);
  assert.deepEqual(flagProblems('"pixel-box bg-card shadow-[inset_0_0_0_3px_var(--danger),5px_5px_0_0_var(--danger)]"'), [], "the Red lining alone is fine");
  assert.deepEqual(flagProblems('"bg-flag-blue shadow-[inset_0_0_0_3px_var(--danger)]"'), ["Blue and Red fills or borders in one element"]);
  assert.deepEqual(flagProblems('"bg-primary border-flag-blue"'), ["Blue and Red fills or borders in one element"], "TG-49: primary is Red");
});

// The colour PRs keep classes.ts's rule in its header, now with Blue (ux §5)
test("T47-B1 classes.ts says never to put a control on a Blue surface; PixelBox takes the alert tones", () => {
  assert.match(read(`${PIXEL}classes.ts`), /Never put a control on a bg-accent, bg-brand or bg-primary surface/);
  const box = primitive("PixelBox");
  assert.match(box, /tone\?: "alert" \| "alertText"/);
  assert.match(box, /cx\(PX\.box\.skin, tone && PX\.box\[tone\], className \?\? PX\.box\.layout\)/, "a tone joins the skin, never the layout");
});
