// Responsive layout tests (TG-44): tablet and desktop use the width, phones keep exactly today's layout.
// Static source guards (no component runner), as in TG-15/21/22/43. Run with `npm test` (node --test).
//
// Two kinds of guard (TG-44 review-plan delta, finding 1):
// - permanent: S1, S2, H1, F1, L1, I1's wrapper, D1, U1, P2, P3, P4. They hold on main for good.
// - PR-scoped fences: P1, X1, X2 and I1's "unchanged" half compare this branch with origin/main. Once TG-44 is on
//   main they skip (fenceDone), so later PRs can change these files on purpose.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const WEB = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB), "utf8");

type PXShape = Record<string, unknown> & { shell?: string; h1: string };
async function loadPX(): Promise<PXShape> {
  return (await import(new URL("src/components/pixel/classes.ts", WEB).href)).PX;
}

// ---- git helpers (base-diff guards) ----

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
/** The file at origin/main, or null when origin/main isn't fetched (or the file is new). */
function base(path: string): string | null {
  try {
    return git("show", `origin/main:web/${path}`);
  } catch {
    return null;
  }
}
/** PR-scoped fences skip without origin/main, and for good once TG-44 itself is on main. */
function fenceSkipped(t: TestContext): boolean {
  if (!gitOk("rev-parse", "--verify", "-q", "origin/main")) {
    t.skip("origin/main not fetched; run `git fetch origin` before npm test");
    return true;
  }
  if (gitOk("cat-file", "-e", "origin/main:web/src/lib/responsive.test.ts")) {
    t.skip("TG-44 merged: PR-scoped fence");
    return true;
  }
  return false;
}

// ---- class strings ----

const OLD_MAIN = "mx-auto w-full max-w-md flex-1 px-4 py-6 flex flex-col gap-5";
const SHELL = `${OLD_MAIN} md:max-w-3xl md:px-6 md:py-8 lg:max-w-5xl lg:px-8 xl:max-w-6xl`;
const RESPONSIVE = /^(md|lg|xl):/;

/** The value of every className: "…" literals, plus the string literals and template static parts in {…}. */
function classStrings(source: string, shell?: string): string[] {
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
  // <PageShell> is a <main className={PX.shell}> (S1 pins PX.shell)
  if (shell !== undefined) out.push(...Array(source.match(/<PageShell>/g)?.length ?? 0).fill(shell));
  return out;
}
const tokens = (s: string) => s.split(/\s+/).filter(Boolean);
/** A class string as a phone sees it: responsive tokens dropped. */
const phone = (s: string) => tokens(s).filter((t) => !RESPONSIVE.test(t)).join(" ");

// The files TG-44 changes (plan §2.4), without classes.ts (S1/S2/B5 pin it), the new PageShell.tsx and tests
const CHANGED = [
  "src/app/page.tsx",
  "src/app/plan/page.tsx",
  "src/app/baguio/page.tsx",
  "src/app/i/[slug]/page.tsx",
  "src/components/OfflineBanner.tsx",
  "src/components/ServiceWorkerManager.tsx",
  "src/components/TripSearch.tsx",
  "src/components/PlanForm.tsx",
  "src/components/LastMile.tsx",
  "src/components/WorldSheet.tsx",
];
const SCOPE = [...CHANGED, "src/components/pixel/classes.ts", "src/components/pixel/PageShell.tsx"];
const scopeSources = () => SCOPE.filter((p) => existsSync(new URL(p, WEB))).map((p) => [p, read(p)] as const);
const PAGES = CHANGED.slice(0, 4);

// ---- S1, S2: the shell and the page title ----

test("TG44-S1 PX.shell widens the phone <main> with md/lg/xl tokens only, and every page renders <PageShell>", async () => {
  const PX = await loadPX();
  assert.equal(PX.shell, SHELL, "ux §2 shell");
  assert.equal(phone(PX.shell!), OLD_MAIN, "the phone tokens, in order, are today's <main> string");
  const shell = read("src/components/pixel/PageShell.tsx");
  assert.match(shell, /export function PageShell\(\{ children \}: \{ children: ReactNode \}\)/, "children only, no className prop");
  assert.match(shell, /return <main className=\{PX\.shell\}>\{children\}<\/main>;/);
  assert.doesNotMatch(shell, /use client|\buse(State|Effect|Ref|Memo|Callback|Reducer|SyncExternalStore)\b/);
  assert.match(read("src/components/pixel/index.ts"), /^export \{ PageShell \} from "\.\/PageShell";$/m);
  for (const page of PAGES) {
    const src = read(page);
    assert.equal(src.match(/<PageShell>/g)?.length, 1, `${page}: one <PageShell>`);
    assert.doesNotMatch(src, /<main\b/, `${page}: no hand-written <main>`);
    assert.match(src, /import \{[^}]*\bPageShell\b[^}]*\} from "@\/components\/pixel";/, page);
  }
  assert.match(
    read("src/components/OfflineBanner.tsx"),
    /<p className="mx-auto w-full max-w-md px-4 py-2 text-sm leading-snug md:max-w-3xl md:px-6 lg:max-w-5xl lg:px-8 xl:max-w-6xl">/,
    "the banner text lines up with the shell",
  );
});

test("TG44-S2 PX.h1 steps up from md", async () => {
  const PX = await loadPX();
  assert.equal(PX.h1, "font-pixel text-[2rem] leading-tight font-bold text-brand md:text-[2.5rem]");
});

// ---- H1, F1, L1, I1, D1, U1: the per-page layouts ----

test("TG44-H1 home: form left, results right from md; the links stay after TripSearch", () => {
  const search = read("src/components/TripSearch.tsx");
  assert.match(
    search,
    /return \(\s*<div className="flex flex-col gap-4 md:grid md:grid-cols-\[20rem_minmax\(0,1fr\)\] md:grid-rows-\[auto_1fr\] md:gap-6 md:items-start lg:grid-cols-\[22rem_minmax\(0,1fr\)\] lg:gap-8">/,
  );
  assert.match(search, /<PixelBox as="form" onSubmit=\{onSearch\} className="p-4 flex flex-col gap-3 md:row-span-2">/);
  assert.match(search, /<ul className="flex flex-col gap-3 md:grid md:grid-cols-\[repeat\(auto-fill,minmax\(20rem,1fr\)\)\] md:gap-4">/);
  assert.match(search, /<div aria-live="polite" className="flex flex-col gap-1 empty:-mt-4">/, "the live wrapper is unchanged");
  const page = read("src/app/page.tsx");
  // TG-46: the tagline moved to the hero, on its fixed light screen; the two links became the quick actions
  assert.match(read("src/components/landing/Hero.tsx"), /<p className="text-sm font-semibold text-screen-ink">Manila to Baguio buses/);
  const at = page.indexOf("<TripSearch />");
  assert.ok(at > 0 && page.indexOf("<QuickActions />") > at, "the quick actions come after TripSearch in the DOM (tab order = visual order)");
  assert.match(page, /<footer className="mt-auto pt-6 text-xs text-muted">/, "the footer is unchanged");
});

const WRAP = '<div className="contents md:flex md:flex-col md:gap-4">';
test("TG44-F1 /plan: two columns from md, picker left, fields right, through contents wrappers", () => {
  const src = read("src/components/PlanForm.tsx");
  assert.match(src, /<form noValidate onSubmit=\{onSubmit\} className="flex flex-col gap-4 md:grid md:grid-cols-2 md:gap-6 md:items-start lg:gap-8"/);
  const at = [...src.matchAll(new RegExp(WRAP.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))].map((m) => m.index!);
  assert.equal(at.length, 2, "exactly two column wrappers");
  const [first, second] = at;
  assert.match(src.slice(first + WRAP.length), /^\s*<PartyStage\b/, "column 1 starts with the stage");
  const picker = src.indexOf("<PartyPicker");
  assert.ok(picker > first && picker < second, "the picker is in column 1");
  assert.match(src.slice(second + WRAP.length), /^\s*(\{\/\*[\s\S]*?\*\/\}\s*)?<fieldset disabled=\{busy\} role="none" className="contents">/, "column 2 starts with the fields");
  assert.ok(src.indexOf("<PremadeResults") > second, "the ready-made results are in column 2");
  assert.ok(src.indexOf("<PlanErrorBox") > second && src.indexOf('<p role="status"') > second);
});

test("TG44-L1 /baguio: the picker is capped, the destination groups are a grid from md", () => {
  const src = read("src/components/LastMile.tsx");
  assert.match(src, /<fieldset className="m-0 min-w-0 border-0 p-0 flex flex-col gap-2 md:max-w-xl">/);
  assert.match(
    src,
    /\{groups\.length > 0 && \(\s*<div className="contents md:grid md:grid-cols-\[repeat\(auto-fill,minmax\(20rem,1fr\)\)\] md:gap-x-6 md:gap-y-8 md:items-start">\s*\{groups\.map\(/,
    "the groups wrapper renders only with groups, so it never adds an empty flex gap",
  );
  // the reading measure on the running text (plan §2.4)
  assert.match(src, /<p className="text-sm text-muted md:max-w-prose">Loading routes\.\.\.<\/p>/);
  assert.match(src, /<p className="text-sm text-muted md:max-w-prose">\{legs\[0\]\.confirm_note\}<\/p>/);
  assert.match(src, /<PixelBox as="p" className="p-4 text-sm md:max-w-prose">No routes on file yet/);
  assert.match(src, /<p className="md:max-w-prose">Could not reach the server/);
  assert.match(read("src/app/baguio/page.tsx"), /<p className="text-sm text-muted md:max-w-prose">Jeeps, taxis and walks/);
});

const I_WRAP = '<div className="contents md:flex md:flex-col md:gap-5 md:mx-auto md:w-full md:max-w-md">';
test("TG44-I1 /i: the whole page is one centred max-w-md column from md (the map world stays W = 416)", () => {
  const src = read("src/app/i/[slug]/page.tsx");
  const at = src.indexOf(I_WRAP);
  assert.ok(at > 0, "the column wrapper");
  const inner = src.slice(at, src.indexOf("</PageShell>"));
  assert.ok(inner.includes("<PageTitle>Your trip</PageTitle>") && inner.includes("<Suspense"), "the title and the plan are inside it");
  assert.match(inner, /<\/div>\s*$/, "it closes right before </PageShell>");
});

test("TG44-I1 /i: OverworldMap and ItineraryList are unchanged (PR-scoped fence)", (t) => {
  if (fenceSkipped(t)) return;
  for (const path of ["src/components/OverworldMap.tsx", "src/components/ItineraryList.tsx"]) {
    assert.equal(read(path), base(path), `${path} is unchanged against origin/main`);
  }
});

test("TG44-D1 the sheet stays the native dialog, centred from md", () => {
  const src = read("src/components/WorldSheet.tsx");
  const cls = src.match(/<dialog\b[\s\S]*?className="([^"]*)"/)?.[1] ?? "";
  const t = tokens(cls);
  for (const keep of ["m-0", "mt-auto", "mx-auto", "mb-4", "w-[calc(100%-2rem)]", "max-w-md", "max-h-[70dvh]"]) {
    assert.ok(t.includes(keep), `the phone sheet keeps ${keep}`);
  }
  assert.ok(t.includes("md:my-auto"), "centred from md");
  assert.match(src, /onClick=\{\(e\) => e\.target === e\.currentTarget && e\.currentTarget\.close\(\)\}/, "a backdrop tap still closes it");
  assert.match(read("src/components/OverworldMap.tsx"), /\.showModal\(\)/, "still opened with showModal()");
});

test("TG44-U1 the update prompt sits bottom-right from lg; the phone keeps its centred card", () => {
  const src = read("src/components/ServiceWorkerManager.tsx");
  const cls = src.match(/<div className="(fixed [^"]*drop-shadow[^"]*)">/)?.[1] ?? "";
  const t = tokens(cls);
  for (const keep of ["fixed", "inset-x-4", "bottom-4", "z-20", "mx-auto", "max-w-md"]) assert.ok(t.includes(keep), keep);
  for (const add of ["lg:left-auto", "lg:right-8", "lg:w-[28rem]"]) assert.ok(t.includes(add), add);
});

// ---- P1: phones unchanged (PR-scoped fence) ----

test("TG44-P1 every class string, as a phone sees it, equals origin/main's (PR-scoped fence)", async (t) => {
  if (fenceSkipped(t)) return;
  const PX = await loadPX();
  for (const path of CHANGED) {
    const was = base(path);
    assert.ok(was !== null, `${path} exists on origin/main`);
    const norm = (list: string[]) => list.map(phone).filter((s) => s !== "" && s !== "contents").sort();
    // The base side treats a literal <main …> the same way (it's a className="…" string already)
    assert.deepEqual(norm(classStrings(read(path), PX.shell)), norm(classStrings(was)), `${path}: a phone sees the same classes`);
  }
});

test("TG44-P1 the fence's normaliser catches what it must (self-test)", () => {
  const norm = (src: string) => classStrings(src).map(phone).filter((s) => s !== "" && s !== "contents").sort();
  assert.deepEqual(norm('<div className="flex gap-4 md:grid">'), ["flex gap-4"]);
  assert.deepEqual(norm('<div className="contents md:flex">'), [], "a bare contents wrapper is phone-invisible");
  assert.deepEqual(norm('<div className="contents gap-4 md:flex">'), ["contents gap-4"], "a contents wrapper with a stray phone token is caught");
  assert.deepEqual(norm("<p className={`${PX.meta} tabular-nums md:max-w-prose`}>"), ["tabular-nums"]);
  assert.deepEqual(norm('<p className={ok ? PX.meta : "sr-only"}>'), ["sr-only"]);
  assert.deepEqual(classStrings("<PageShell>", "x y md:z").map(phone), ["x y"]);
});

// RED audit gap A: P1 compares class strings only, so it can't see a new element (a wrapper with only responsive
// classes, or an unclassed <div>). This is P1's element half. tg-test3's prototype, as given.
/** Every JSX element a phone sees: tag names, skipping bare `contents` wrappers and counting <PageShell> as <main>.
 *  Non-JSX `<x` (TS generics) is the same text on both sides, so it cancels out. */
function phoneElements(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/<([A-Za-z][\w.]*)\b((?:[^>"'{]|"[^"]*"|'[^']*'|\{(?:[^{}]|\{[^{}]*\})*\})*)\/?>/g)) {
    const [, tag, attrs] = m;
    const cls = attrs.match(/className="([^"]*)"/)?.[1];
    if (tag === "div" && cls !== undefined && phone(cls) === "contents") continue;
    out.push(tag === "PageShell" ? "main" : tag);
  }
  return out.sort();
}
test("TG44-P1b no element appears or disappears for a phone (PR-scoped fence)", (t) => {
  if (fenceSkipped(t)) return;
  for (const path of CHANGED) {
    const was = base(path);
    assert.ok(was !== null, path);
    assert.deepEqual(phoneElements(read(path)), phoneElements(was), `${path}: a phone sees the same elements`);
  }
});

// ---- P2, P3, P4: permanent fences ----

test("TG44-P2 only md, lg and xl breakpoints; nothing is hidden or shown by width", () => {
  for (const [path, src] of scopeSources()) {
    const all = [...classStrings(src), ...[...src.matchAll(/"([^"]*)"/g)].map((m) => m[1])].flatMap(tokens);
    for (const tok of all) {
      assert.doesNotMatch(tok, /^(sm|2xl|max-[\w-]+|min-\[[^\]]*\]|portrait|landscape|@[\w-]*|\[@media[^\]]*\]):/, `${path}: ${tok}`);
      assert.doesNotMatch(tok, /^(md|lg|xl):(hidden|block|sr-only|not-sr-only|invisible|sticky)$/, `${path}: ${tok} (content parity)`);
    }
    assert.doesNotMatch(src, /@container/, path);
  }
});

test("TG44-P3 display: contents only on plain wrapper divs", () => {
  const allowed = [
    '<fieldset disabled={busy} role="none" className="contents">', // PlanForm (TG-21)
    '<div key={label} className="contents">', // WorldSheet's <dl> rows (TG-22)
  ];
  for (const [path, src] of scopeSources()) {
    for (const m of src.matchAll(/<(\w+)\b((?:[^>"{]|"[^"]*"|\{[^}]*\})*?)className="contents(?:\s[^"]*)?"((?:[^>"{]|"[^"]*"|\{[^}]*\})*?)>/g)) {
      if (allowed.includes(m[0])) continue;
      const attrs = m[2] + m[3];
      assert.equal(m[1], "div", `${path}: contents on <${m[1]}>`);
      assert.doesNotMatch(attrs, /\bid=|\baria-|\brole=|\bon[A-Z]/, `${path}: a contents div carries semantics or handlers: ${m[0]}`);
    }
  }
});

test("TG44-P4 tab order is visual order: no grid or flex reordering", () => {
  for (const [path, src] of scopeSources()) {
    for (const tok of classStrings(src).flatMap(tokens)) {
      assert.doesNotMatch(tok, /(^|:)-?(order|col-start|col-end|row-start|row-end)-/, `${path}: ${tok}`);
    }
  }
});

// ---- X1, X2: nothing else moves (PR-scoped fences) ----

test("TG44-X1 the service worker, globals, config, packages, API, schema and the map are untouched (PR-scoped fence)", (t) => {
  if (fenceSkipped(t)) return;
  const paths = [
    "web/package.json",
    "web/package-lock.json",
    "web/public/sw.js",
    "web/next.config.ts",
    "web/src/app/globals.css",
    "web/src/components/OverworldMap.tsx",
    "web/src/components/ItineraryList.tsx",
    "api",
    "supabase",
  ];
  const changed = git("diff", "--name-only", "origin/main", "--", ...paths.map((p) => `../${p}`)).trim();
  assert.equal(changed, "", `changed: ${changed}`);
});

// The three pixelTheme.test.ts hunks plan §3.2 allows (B5's PXShape and EXPECTED_PX)
const H1_OLD = '  h1: "font-pixel text-[2rem] leading-tight font-bold text-brand",';
const ALLOWED_ADDED = [
  /^  shell: string;( \/\/ .*)?$/,
  /^  \/\/ TG-44 ux §2\b.*$/,
  new RegExp(`^  shell: "${SHELL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}",$`),
  /^  h1: "font-pixel text-\[2rem\] leading-tight font-bold text-brand md:text-\[2\.5rem\]",$/,
];

test("TG44-X2 the only existing test edited is pixelTheme.test.ts, with exactly plan §3.2's hunks (PR-scoped fence)", (t) => {
  if (fenceSkipped(t)) return;
  const changed = git("diff", "--name-only", "origin/main", "--", ".").split("\n").filter((f) => f.startsWith("web/src/lib/"));
  for (const f of changed) {
    assert.ok(["web/src/lib/pixelTheme.test.ts", "web/src/lib/responsive.test.ts"].includes(f), `${f} must not change`);
  }
  const diff = git("diff", "-U0", "origin/main", "--", "src/lib/pixelTheme.test.ts").split("\n");
  const removed = diff.filter((l) => l.startsWith("-") && !l.startsWith("---")).map((l) => l.slice(1));
  const added = diff.filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
  if (removed.length === 0 && added.length === 0) return; // RED: B5 isn't edited until the shell lands
  assert.deepEqual(removed, [H1_OLD], "only the h1 line is replaced");
  assert.equal(added.length, ALLOWED_ADDED.length, `added lines: ${added.join(" | ")}`);
  for (const re of ALLOWED_ADDED) assert.ok(added.some((l) => re.test(l)), `an added line matches ${re}`);
});

// RED audit gap B: P1 only covers its 10 files, so a phone change elsewhere (TripCard, a pixel primitive) would pass.
// tg-test3's prototype, as given.
test("TG44-X3 only plan §2.4's files change under web/src (PR-scoped fence)", (t) => {
  if (fenceSkipped(t)) return;
  const allowed = new Set([...SCOPE, "src/components/pixel/index.ts", "src/lib/responsive.test.ts", "src/lib/pixelTheme.test.ts"].map((p) => `web/${p}`));
  const changed = [
    ...git("diff", "--name-only", "origin/main", "--", "../web/src").split("\n"),
    ...git("ls-files", "--others", "--exclude-standard", "--", "../web/src").split("\n").map((f) => `web/${f}`),
  ].filter((f) => f && f !== "web/");
  for (const f of changed) assert.ok(allowed.has(f), `${f} is outside plan §2.4`);
});
