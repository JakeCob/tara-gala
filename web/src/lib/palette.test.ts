// Flag colours in the UI (TG-47 Phase B/C): colour only, so a phone's layout can't move, plus where ux puts each colour.
// Static source guards, as in TG-44's responsive.test.ts. Run with `npm test` (node --test).
//
// - P1 and D1 are PR-scoped fences: they compare this branch with its base on origin/main, skip without origin/main,
//   and skip for good once this file is on main, so later PRs can change layouts on purpose.
// - W1 to W5 are permanent: the alert boxes, notices, map banner, Maps link and highlight chip keep their colours.
// The tokens, contrast table and pair scanner live in pixelTheme.test.ts (T47-T1, T2, C1 to C3, F1, B1).
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WEB = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB), "utf8");

// ---- git helpers (as in responsive.test.ts) ----

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: new URL(".", WEB), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}
function gitOk(...args: string[]): boolean {
  try {
    git(...args);
    return true;
  } catch {
    return false;
  }
}
/** The branch's base: where it left origin/main, so a main that moved on doesn't count as this PR's change. */
const mergeBase = () => {
  try {
    return git("merge-base", "origin/main", "HEAD").trim();
  } catch {
    // CI's shallow checkout of the PR merge commit has no merge base, but there HEAD is main + the PR: diff origin/main
    return "origin/main";
  }
};
/** The file at the base, or null when it's new. */
function base(path: string): string | null {
  try {
    return git("show", `${mergeBase()}:web/${path}`);
  } catch {
    return null;
  }
}
/** PR-scoped fences skip without origin/main, and for good once TG-47 B/C itself is on main. */
function fenceSkipped(t: TestContext): boolean {
  if (!gitOk("rev-parse", "--verify", "-q", "origin/main")) {
    t.skip("origin/main not fetched; run `git fetch origin` before npm test");
    return true;
  }
  if (gitOk("cat-file", "-e", "origin/main:web/src/lib/palette.test.ts")) {
    t.skip("TG-47 B/C merged: PR-scoped fence");
    return true;
  }
  return false;
}
/** Files under web/ that differ from the base, committed or not. */
const changedFiles = () => git("diff", "--name-only", mergeBase(), "--", ".").split("\n").filter(Boolean).map((f) => f.replace(/^web\//, ""));

// ---- the colour stripper ----

const COLOUR_NAMES = [
  "background", "foreground", "muted", "card", "frame", "border", "brand", "brand-ink", "accent", "accent-ink", "focus",
  "primary", "primary-ink", "link", "danger", "danger-text", "screen", "screen-paper", "screen-ink", "screen-muted",
  "flag-blue", "flag-red", "flag-yellow",
];
const COLOUR_UTILITY = new RegExp(`^(bg|text|border|outline|fill|stroke|decoration|ring|caret)-(${COLOUR_NAMES.join("|")})(/\\d+)?$`);
const LINING = /^shadow-\[inset_[\w.]+_var\(--danger\)\]$/; // ux §7's red lining, colour only
const tokens = (s: string) => s.split(/\s+/).filter(Boolean);
const isColour = (token: string) => {
  const bare = token.split(":").pop()!;
  return COLOUR_UTILITY.test(bare) || LINING.test(bare);
};
/** A class string with its colour tokens removed: what's left is layout, size, weight and shape. */
const colourless = (s: string) => tokens(s).filter((t) => !isColour(t)).join(" ");

/** The value of every className: "…" literals, plus the string literals and template static parts in {…} (TG-44). */
function classStrings(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/className="([^"]*)"/g)) out.push(m[1]);
  for (const m of source.matchAll(/className=\{/g)) {
    let depth = 1;
    let i = m.index! + m[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
      i++;
    }
    const expr = source.slice(start, i - 1);
    for (const s of expr.matchAll(/"([^"]*)"|'([^']*)'/g)) out.push(s[1] ?? s[2]);
    for (const tpl of expr.matchAll(/`([^`]*)`/g)) {
      for (const part of tpl[1].split(/\$\{[^}]*\}/)) out.push(part);
    }
  }
  return out;
}

// ---- JSX opening tags ----

type Tag = { name: string; attrs: string; start: number; end: number; selfClosing: boolean };
/** Every JSX opening tag, brace-aware, so `=>` and `>` inside {…} don't end it. Generics (`useState<`) are skipped. */
function openingTags(source: string): Tag[] {
  const out: Tag[] = [];
  for (const m of source.matchAll(/(?<![\w$.])<([A-Za-z][\w.]*)/g)) {
    let depth = 0;
    let quote = "";
    let i = m.index! + m[0].length;
    for (; i < source.length; i++) {
      const c = source[i];
      if (quote) {
        if (c === quote) quote = "";
      } else if (depth === 0 && (c === '"' || c === "'")) quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    const attrs = source.slice(m.index! + m[0].length, i);
    out.push({ name: m[1], attrs, start: m.index!, end: i + 1, selfClosing: attrs.trimEnd().endsWith("/") });
  }
  return out;
}
/** A tag's attribute names, in order, with {…} expressions and "…" values blanked. */
function attrNames(attrs: string): string[] {
  let flat = "";
  let depth = 0;
  for (const c of attrs) {
    if (c === "{") depth++;
    if (depth === 0) flat += c;
    if (c === "}") depth--;
  }
  flat = flat.replace(/"[^"]*"|'[^']*'/g, '""');
  return [...flat.matchAll(/([A-Za-z_][\w:-]*)\s*(?==|\s|\/|$)/g)].map((m) => m[1]);
}
/** The opening-tag sequence the fence compares. tone= is the one new prop ux allows (onScreen keeps its name). */
const tagSequence = (source: string) =>
  openingTags(source).map((t) => `${t.name}(${attrNames(t.attrs).filter((a) => a !== "tone").join(",")})`);
/** A prop's literal value on a tag: "x" for prop="x", true for a bare prop, null when absent. */
function propValue(tag: Tag, prop: string): string | true | null {
  const m = tag.attrs.match(new RegExp(`(?<![\\w-])${prop}(?:="([^"]*)")?(?=[\\s/>=]|$)`));
  return m ? (m[1] ?? true) : null;
}

/** The PX object from a classes.ts source (a plain module, T11), so the base's copy can be loaded too. */
async function pxFrom(source: string): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), "tg47-px-"));
  writeFileSync(join(dir, "classes.ts"), source);
  return (await import(new URL(`file://${join(dir, "classes.ts")}`).href)).PX;
}
function flat(node: unknown, path = ""): [string, string][] {
  if (typeof node === "string") return [[path, node]];
  return Object.entries(node as object).flatMap(([k, v]) => flat(v, path ? `${path}.${k}` : k));
}

// ---- P1: the phone layout can't move (plan §4) ----

test("T47-P1 self-test: the stripper drops colour tokens and keeps everything that moves a box", () => {
  for (const colour of ["bg-primary", "text-link", "has-checked:bg-primary", "text-danger-text", "bg-flag-blue", "text-screen-paper",
    "shadow-[inset_0_0_0_6px_var(--danger)]", "md:bg-accent", "text-accent-ink"]) {
    assert.equal(colourless(colour), "", `${colour} is colour`);
  }
  for (const layout of ["font-bold", "font-semibold", "py-1", "shadow-none", "translate-y-[3px]", "text-sm", "text-center",
    "border-2", "shadow-[3px_3px_0_0_var(--frame)]", "outline-none", "has-checked:translate-y-[3px]"]) {
    assert.equal(colourless(layout), layout, `${layout} isn't colour`);
  }
  assert.equal(colourless("pixel-frame bg-accent text-accent-ink px-2 py-1 text-sm"), "pixel-frame px-2 py-1 text-sm");
  // the tag scanner: ux's alert bar as a child, or a wrapping <span>, changes the sequence; tone= doesn't
  const box = '<PixelBox className="p-4"><p className="text-sm">{x}</p></PixelBox>';
  assert.deepEqual(tagSequence(box), ["PixelBox(className)", "p(className)"]);
  assert.deepEqual(tagSequence(box.replace("<PixelBox ", '<PixelBox tone="alert" ')), tagSequence(box));
  assert.notDeepEqual(tagSequence(box.replace("<p ", '<div className="h-1.5 bg-danger" /><p ')), tagSequence(box));
  assert.notDeepEqual(tagSequence(box.replace("<PixelBox ", '<PixelBox role="alert" ')), tagSequence(box));
  assert.deepEqual(tagSequence("const [a] = useState<string | null>(null); <a onClick={() => go(a > 1)} href=\"/\">x</a>"), ["a(onClick,href)"]);
});

test("T47-P1 changed components differ from the base in colour tokens and tone= only", (t) => {
  if (fenceSkipped(t)) return;
  // components/pixel/* are pinned exactly by B4, B5, T12 and T47-B1 in pixelTheme.test.ts; classes.ts by the PX half below
  const files = changedFiles().filter((f) => f.startsWith("src/") && f.endsWith(".tsx") && !f.startsWith("src/components/pixel/"));
  for (const file of files) {
    const before = base(file);
    assert.ok(before !== null, `${file} is new: a new component isn't a colour change`);
    const after = read(file);
    assert.deepEqual(tagSequence(after), tagSequence(before), `${file}: the element and prop sequence changed`);
    assert.deepEqual(classStrings(after).map(colourless), classStrings(before).map(colourless), `${file}: a non-colour class changed`);
    // PX references: the same keys, except the highlight chip ux §2 adds
    const refs = (s: string) => [...s.matchAll(/\bPX\.[\w.]+/g)].map((m) => m[0]);
    assert.deepEqual(refs(after).map((r) => (r === "PX.chipHighlight" ? "PX.chip" : r)), refs(before), `${file}: a PX class changed`);
    for (const tag of openingTags(after)) {
      const tone = propValue(tag, "tone");
      if (tone !== null) assert.ok(tag.name === "PixelBox" && (tone === "alert" || tone === "alertText"), `${file}: tone=${tone} on <${tag.name}>`);
    }
  }
});

test("T47-P1 PX changes colour only: every base value keeps its non-colour tokens; new keys add colour only", async (t) => {
  if (fenceSkipped(t)) return;
  const path = "src/components/pixel/classes.ts";
  const before = new Map(flat(await pxFrom(base(path) ?? "export const PX = {};")));
  const after = new Map(flat(await pxFrom(read(path))));
  for (const [key, value] of before) {
    assert.ok(after.has(key), `PX.${key} removed`);
    assert.equal(colourless(after.get(key)!), colourless(value), `PX.${key}: a non-colour token changed`);
  }
  for (const [key, value] of after) {
    if (before.has(key)) continue;
    if (key === "chipHighlight") assert.equal(colourless(value), colourless(before.get("chip")!), "chipHighlight is PX.chip recoloured");
    else assert.equal(colourless(value), "", `new PX.${key} must be colour only: ${value}`);
  }
});

test("T47-P1 globals.css changes custom properties only", (t) => {
  if (fenceSkipped(t)) return;
  const shape = (css: string) => {
    // only colour custom properties may change: --spacing, --font-* or a breakpoint would move boxes (RED audit)
    const colourProp = new RegExp(`--(?:color-[\\w-]+|${COLOUR_NAMES.join("|")})\\s*:[^;{}]*;`, "g");
    let s = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(colourProp, "");
    for (let prev = ""; prev !== s; ) [prev, s] = [s, s.replace(/[^{};]*\{\s*\}/g, "")]; // blocks left empty
    return s.replace(/\s+/g, " ").trim();
  };
  const before = base("src/app/globals.css");
  assert.ok(before, "globals.css at the base");
  assert.equal(shape(read("src/app/globals.css")), shape(before), "only colour custom properties may change");
});

// The whole-file half of the fence (RED audit): with colour taken out, a changed component is its base, comments and
// whitespace aside. It sees what the class and tag comparison can't: prop values (variant=, as=, style=), class
// constants outside className, and copy. PixelBox and SectionTitle may differ only by B1's and B4's pinned edits.
const COLOUR_TOKEN = new RegExp(
  `(?<![\\w-])(?:[\\w-]+:)*(?:(?:bg|text|border|outline|fill|stroke|decoration|ring|caret)-(?:${COLOUR_NAMES.join("|")})(?:/\\d+)?` +
    `|shadow-\\[inset_[\\w.]+_var\\(--danger\\)\\])(?![\\w-])`,
  "g",
);
const colourBlind = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}|\/\*[\s\S]*?\*\/|(?<![:"'`])\/\/[^\n]*/g, "")
    .replace(COLOUR_TOKEN, "")
    .replace(/\s+tone="(alert|alertText)"/g, "")
    .replace(/onScreen="banner"/g, "onScreen")
    .replace(/PX\.chipHighlight\b/g, "PX.chip")
    // PixelBox and SectionTitle: exactly the edits B1 and B4 pin (the tone prop, the banner branch), nothing else
    .replace(/\s*tone\?: "alert" \| "alertText";?/g, "")
    .replace(/\btone,\s*/g, "")
    .replace(/tone && PX\.box\[tone\],\s*/g, "")
    .replace(/onScreen\?: boolean \| "banner"/g, "onScreen?: boolean")
    .replace(/onScreen === "banner" \? "" : /g, "")
    .replace(/\s+/g, " ")
    .replace(/(["'`{]) /g, "$1")
    .replace(/ (["'`}])/g, "$1")
    .trim();

test("T47-P1 a changed component is its base plus colour: no prop value, class constant or copy changes", (t) => {
  if (fenceSkipped(t)) return;
  for (const file of changedFiles().filter((f) => f.startsWith("src/") && f.endsWith(".tsx"))) {
    const before = base(file);
    assert.ok(before !== null, `${file} is new: a new component isn't a colour change`);
    assert.ok(colourBlind(read(file)) === colourBlind(before), `${file}: something other than colour changed`);
  }
});

// ---- D1: no dependency, data, API or service-worker change ----

test("D1 no package, supabase, api or sw.js change; pwa.test.ts unedited", (t) => {
  if (fenceSkipped(t)) return;
  const touched = git("diff", "--name-only", mergeBase(), "--", "package.json", "package-lock.json", "public/sw.js", "src/lib/pwa.test.ts", "../supabase", "../api");
  assert.equal(touched.trim(), "", "TG-47 is colour only");
});

test("D1 the manifest theme colour is the Paper page (TG-49; Forest until then)", () => {
  assert.match(read("src/app/manifest.ts"), /theme_color:\s*"#fff8e7"/);
});

// ---- W: where ux §2 puts each colour ----

/** Every <PixelBox> in a source with its body (up to its </PixelBox>; these boxes don't nest). */
function boxes(source: string) {
  return openingTags(source)
    .filter((t) => t.name === "PixelBox")
    .map((tag) => ({ tag, body: tag.selfClosing ? "" : source.slice(tag.end, source.indexOf("</PixelBox>", tag.end)) }));
}
// ux §2 / plan §3: the error and changed boxes, found by their text. A one-sentence <PixelBox as="p"> is alertText.
const ALERT_BOXES: [file: string, marker: string, tone: "alert" | "alertText"][] = [
  ["src/components/PlanResults.tsx", "{view.message}", "alert"],
  ["src/components/PlanResults.tsx", "{LIST.failed}", "alert"],
  ["src/components/ItineraryView.tsx", "{NOT_FOUND}", "alert"],
  ["src/components/ItineraryView.tsx", "{ERROR}", "alert"],
  ["src/components/ItineraryList.tsx", "Some of this plan has changed", "alert"],
  ["src/components/ItineraryList.tsx", 'issueNotice("unknown_trip")', "alert"],
  ["src/components/LastMile.tsx", "Could not reach the server", "alert"],
  ["src/components/TripSearch.tsx", "Could not reach the schedule server", "alertText"],
  ["src/components/TicketWallet.tsx", "{notice.text}", "alertText"], // TG-50: a refused or failed save or delete
  ["src/components/TicketWallet.tsx", "can&apos;t save tickets here", "alertText"], // TG-50: no IndexedDB
  ["src/components/WalletView.tsx", "{notice.text}", "alertText"], // TG-50: a write that failed
  ["src/components/WalletView.tsx", "No signal, and this wallet", "alertText"], // TG-50: the wallet didn't load
  ["src/components/WalletHome.tsx", "{error}", "alertText"], // TG-50: start-a-wallet problems
  ["src/components/PayoutQr.tsx", "{notice.text}", "alertText"], // TG-50: a refused or failed QR save
  ["src/components/PayoutQr.tsx", "can&apos;t keep a QR here", "alertText"], // TG-50: no IndexedDB
];
const tsxFiles = () =>
  git("ls-files", "src/**/*.tsx", "src/*.tsx").split("\n").filter(Boolean).map((f) => f.replace(/^web\//, ""));

test("W1 the error and changed boxes take the red lining, and their lead sentence is red", () => {
  for (const [file, marker, tone] of ALERT_BOXES) {
    const found = boxes(read(file)).filter((b) => b.body.includes(marker));
    assert.equal(found.length, 1, `${file}: one box holds ${marker}`);
    const [{ tag, body }] = found;
    assert.equal(propValue(tag, "tone"), tone, `${file}: the ${marker} box has tone="${tone}"`);
    if (tone === "alert") {
      const lead = body.match(/<p\b[^>]*className="([^"]*)"/);
      assert.ok(lead && tokens(lead[1]).includes("text-danger-text"), `${file}: the ${marker} box's first <p> is text-danger-text`);
      assert.equal(body.match(/text-danger-text/g)?.length, 1, `${file}: only the lead is red; the body stays foreground`);
    }
  }
});

test("W1 no other box is an alert: the empty states, summaries and day boxes keep the plain frame", () => {
  let total = 0;
  for (const file of tsxFiles()) {
    for (const { tag, body } of boxes(read(file))) {
      if (propValue(tag, "tone") === null) continue;
      total++;
      assert.ok(ALERT_BOXES.some(([f, marker]) => f === file && body.includes(marker)), `${file}: an unexpected alert box: ${body.trim().slice(0, 60)}`);
    }
  }
  assert.equal(total, ALERT_BOXES.length);
});

test("W2 the share page's changed-bus and changed-ride notices are red text on the card", () => {
  for (const file of ["src/components/TripCard.tsx", "src/components/LegCard.tsx"]) {
    assert.match(read(file), /\{notice && <p className="text-sm font-semibold text-danger-text">\{notice\}<\/p>\}/, file);
  }
});

test("W3 the map banners are Cream pixel text on a Flag Blue bar", () => {
  const source = read("src/components/OverworldMap.tsx");
  const bar = openingTags(source).find((t) => /pixel-frame/.test(t.attrs) && source.slice(t.end, t.end + 200).includes("{banner.text}"));
  assert.ok(bar, "the banner bar");
  const cls = tokens(bar.attrs.match(/className="([^"]*)"/)?.[1] ?? "");
  assert.ok(cls.includes("bg-flag-blue") && !cls.includes("bg-screen-paper"), `the bar is bg-flag-blue: ${cls.join(" ")}`);
  assert.match(source, /<SectionTitle onScreen="banner" id=\{banner\.id\}>\{banner\.text\}<\/SectionTitle>/);
});

test("W4 the Maps deep link is a Blue link, like every other link", () => {
  const source = read("src/components/TerminalLinks.tsx");
  assert.match(source, /bg-card px-3 text-sm font-bold text-link\$\{/);
  assert.doesNotMatch(source, /text-brand/, "text-brand stays on the h1 only (T5)");
});

test("W5 'Matches your dates' is the Yellow highlight chip", () => {
  assert.match(read("src/components/PlanResults.tsx"), /<span className=\{PX\.chipHighlight\}>\{LIST\.match\}<\/span>/);
});

// ux §7 (RA 8491): a Blue control may sit above or below an alert box, never inside its red lining. Permanent, unlike
// P1, so it still holds after this PR merges.
test("W6 no Blue control or Blue fill inside a red-lined box", () => {
  for (const file of tsxFiles()) {
    for (const { tag, body } of boxes(read(file))) {
      if (propValue(tag, "tone") === null) continue;
      const where = `${file}: the ${body.trim().slice(0, 40)}… box`;
      assert.doesNotMatch(body, /\bvariant=(?:"primary"|\{\s*["'`]primary["'`]\s*\})/, `${where} holds a primary (Blue) button or link`);
      assert.doesNotMatch(body, /PX\.btn\.primary\b|(?<![\w:-])bg-(?:primary|flag-blue)(?![\w-])/, `${where} holds a Blue fill`);
    }
  }
  // the checker itself
  const probe = '<PixelBox tone="alert" className="p-4"><p>x</p><PixelButton variant="primary">Go</PixelButton></PixelBox>';
  assert.equal(boxes(probe).length, 1);
  assert.match(boxes(probe)[0].body, /\bvariant=(?:"primary"|\{\s*["'`]primary["'`]\s*\})/);
});

// ux review S1: the map signs' "changed" line is red on the fixed game screen, so it uses the fixed flag-red (5.26 on
// screen-paper in both themes), never danger-text, which follows the theme. The one place flag-red is text.
test("W7 the map's changed sign line is Flag Red, and text-flag-red appears nowhere else", () => {
  assert.match(read("src/components/OverworldMap.tsx"), /line === CHANGED \? "font-semibold text-flag-red" : "text-screen-muted"/);
  for (const file of tsxFiles().filter((f) => f !== "src/components/OverworldMap.tsx")) {
    assert.doesNotMatch(read(file), /(?<![\w-])text-flag-red(?![\w-])/, `${file}: text-flag-red is only for the map's sign line`);
  }
});
