// The landing page on `/` (TG-46 PR A): structure, copy, theme and asset guards on the new sections, plus the pure
// ready-made view and the banner's two-GET honesty (S5). Static source guards (no component runner), as in TG-15/21/
// 22/43/44. Every module under test is loaded inside its test, so a missing file fails that test only.
// The title screen is PR B: nothing here pins it.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { decodePng, paletteProblems } from "./png.testutil.ts";
import { PALETTE } from "./pixelSvg.ts";
import { bannerReducer, initialBanner, type BannerEvent, type BannerState } from "./offline.ts";
import type { PremadeResult, PremadeSummary } from "./api.ts";

const WEB = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB), "utf8");
const has = (path: string) => existsSync(new URL(path, WEB));
function source(path: string): string {
  assert.ok(has(path), `${path} exists`);
  return read(path);
}
async function load<T>(path: string): Promise<T> {
  assert.ok(has(path), `${path} exists`);
  return import(new URL(path, WEB).href) as Promise<T>;
}

const LANDING = "src/components/landing/";
const SECTIONS = ["Hero", "QuickActions", "PremadeTrips", "HowItWorks", "Trust", "SectionStripe"];
const sectionPath = (name: string) => `${LANDING}${name}.tsx`;
/** The new landing files that exist (the guards over "every new file" run on these). */
const landingFiles = () => (has(LANDING) ? readdirSync(new URL(LANDING, WEB)).filter((f) => f.endsWith(".tsx")).map((f) => `${LANDING}${f}`) : []);

/** JSX text as a reader sees it: entities decoded, {" "} spacers and line breaks collapsed to single spaces. */
function visibleText(src: string): string {
  return src
    .replace(/\{"\s*"\}/g, " ")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&rsquo;/g, "’")
    .replace(/\s+/g, " ");
}
const copyIn = (paths: string[]) => visibleText(paths.map(source).join("\n"));

// ---- class strings (the same reading as TG-44's responsive.test.ts) ----
function classStrings(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/className="([^"]*)"/g)) out.push(m[1]);
  // A class list held in a module constant and used as className={NAME} is scanned too (audit: QuickActions' TILE)
  const consts = new Map([...src.matchAll(/^const (\w+) = "([^"]*)";/gm)].map((m) => [m[1], m[2]] as [string, string]));
  for (const m of src.matchAll(/className=\{(\w+)\}/g)) if (consts.has(m[1])) out.push(consts.get(m[1])!);
  for (const m of src.matchAll(/className=\{/g)) {
    let depth = 1;
    let i = m.index! + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
      i++;
    }
    const expr = src.slice(start, i - 1);
    for (const s of expr.matchAll(/"([^"]*)"|'([^']*)'/g)) out.push(s[1] ?? s[2]);
    for (const tpl of expr.matchAll(/`([^`]*)`/g)) for (const part of tpl[1].split(/\$\{[^}]*\}/)) out.push(part);
  }
  return out;
}
const tokens = (s: string) => s.split(/\s+/).filter(Boolean);

// ================================================================ T46-L: structure

test("T46-L1 page.tsx: one shell holding the sections in reading order; TG-44's two links are gone", () => {
  const page = source("src/app/page.tsx");
  assert.equal(page.match(/<PageShell>/g)?.length, 1);
  const order = ["<Hero />", "<TripSearch />", "<QuickActions />", "<PremadeTrips />", "<HowItWorks />", "<Trust />", "<HomeDecor />", "<footer"];
  const at = order.map((tag) => {
    assert.equal(page.split(tag).length - 1, 1, `${tag} appears exactly once`);
    return page.indexOf(tag);
  });
  for (let i = 1; i < at.length; i++) assert.ok(at[i] > at[i - 1], `${order[i]} comes after ${order[i - 1]} (DOM order is visual order)`);
  assert.ok(page.indexOf("</PageShell>") > at.at(-1)!, "the footer is inside the shell");
  assert.doesNotMatch(page, /<PixelLink\b[^>]*href="\/(baguio|plan)"/, "the quick actions replace TG-44's two links");
  assert.doesNotMatch(page, /<header\b/, "the old header is replaced by the hero");
  // The footer (ux §5.7): TG-14's class string kept; the second line added
  assert.match(page, /<footer className="mt-auto pt-6 text-xs text-muted">/);
  const footer = visibleText(page.slice(page.indexOf("<footer")));
  assert.ok(footer.includes("Directions to your terminal are on each trip."));
  assert.ok(footer.includes("Tara Gala isn't affiliated with any bus operator. Ingat sa biyahe!"));
  assert.doesNotMatch(page, /Title screen|data-title/, "the replay button is PR B");
});

test("T46-L2 one h1, in the hero, that the title screen can focus later; section headings are SectionTitles", () => {
  const files = ["src/app/page.tsx", ...SECTIONS.map(sectionPath)].map(source);
  const titles = files.join("\n").match(/<PageTitle\b[^>]*>/g) ?? [];
  assert.equal(titles.length, 1, "exactly one PageTitle across page.tsx and landing/*");
  assert.doesNotMatch(files.join("\n"), /<h1\b/, "no hand-written h1");
  const hero = source(sectionPath("Hero"));
  assert.match(hero, /<PageTitle onScreen id="landing-title" tabIndex=\{-1\}>Tara Gala<\/PageTitle>/);
  for (const name of ["PremadeTrips", "HowItWorks", "Trust"]) {
    assert.match(source(sectionPath(name)), /<SectionTitle\b[^>]*\bid="[\w-]+"/, `${name} has an h2 with an id`);
    assert.doesNotMatch(source(sectionPath(name)), /<h[1-6]\b/, `${name}: headings go through SectionTitle`);
  }
});

test("T46-L2 PageTitle gains onScreen, id and tabIndex; PX.h1Screen is PX.h1 with screen-ink", async () => {
  const { PX } = await load<{ PX: Record<string, string> }>("src/components/pixel/classes.ts");
  assert.equal(PX.h1Screen, "font-pixel text-[1.75rem] leading-tight font-normal text-screen-ink md:text-[2.25rem]"); // TG-49
  assert.equal(PX.h1.replace("text-brand", "text-screen-ink"), PX.h1Screen, "the same title, on the fixed light screen");
  const src = source("src/components/pixel/PageTitle.tsx");
  assert.match(src, /onScreen\s*\?\s*PX\.h1Screen\s*:\s*PX\.h1/);
  assert.match(src, /\bid\?: string/);
  assert.match(src, /\btabIndex\?: number/);
  assert.match(src, /\bonScreen\?: boolean/);
  assert.doesNotMatch(src, /use client/);
});

test("T46-L3 quick actions: a named nav of three neutral card links; Find buses jumps to the date input", () => {
  const src = source(sectionPath("QuickActions"));
  assert.match(src, /<nav aria-label="Quick actions">/);
  assert.match(src, /<ul\b/);
  const hrefs = [...src.matchAll(/<PixelCardLink\b[^>]*\bhref="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, ["#travel-date", "/plan", "/baguio"]);
  const plan = src.indexOf('href="/plan"');
  assert.match(src.slice(0, plan), /\{formMode\(flags\) !== "none" && \(\s*<li\b[^>]*>\s*<PixelCardLink\b[^>]*$/, "Plan a trip only when the planner is on");
  for (const [, arrow] of src.matchAll(/<span([^>]*)>→<\/span>/g)) assert.match(arrow, /aria-hidden/, "the → is decorative");
  assert.ok((src.match(/>→</g)?.length ?? 0) >= 1, "the tiles end with an arrow (one shared tile body may write it once)");
  assert.match(source("src/components/TripSearch.tsx"), /<input\b[^>]*\bid="travel-date"/, "the Find buses target");
});

test("T46-L8 activating Find buses moves focus to the date input, not just the scroll (manager GREEN follow-up)", () => {
  // next/link's in-page jump scrolls but leaves focus on the link, so a keyboard user would Tab on from it. A link's
  // Enter fires click too, so one click listener covers both.
  const src = source("src/components/TripSearch.tsx");
  assert.match(src, /const DATE_ID = "travel-date";/);
  assert.match(src, /<input\b[^>]*\bid="travel-date"/, "the id stays literal (T46-L3)");
  const effect = src.match(/useEffect\(\(\) => \{([\s\S]*?)\n {2}\}, \[\]\);/)?.[1] ?? "";
  assert.ok(effect, "a mount-only effect");
  assert.match(effect, /document\.addEventListener\("click", (\w+)\);[\s\S]*return \(\) => document\.removeEventListener\("click", \1\);/, "added once, removed on unmount");
  assert.match(effect, /\.closest\(`a\[href="#\$\{DATE_ID\}"\]`\)/, "any in-page link to the input, the quick action's included");
  assert.match(effect, /document\.getElementById\(DATE_ID\)\?\.focus\(\)/);
  assert.doesNotMatch(effect, /preventDefault/, "the link still scrolls and sets the hash");
  assert.match(source(sectionPath("QuickActions")), /<PixelCardLink href="#travel-date"/);
});

test("T46-L9 the jump leaves the whole form, from the From / To row, clear of the sticky offline banner (ux ruling 2)", () => {
  // scroll-mt-44 is 176px (ux-review ruling 2): above the input sit the label (about 24px) and the From / To row, and
  // the whole form clears the banner (58px at 380, two lines)
  const src = source("src/components/TripSearch.tsx");
  const input = src.match(/<input\b[^>]*\bid="travel-date"[\s\S]*?\/>/)?.[0] ?? "";
  assert.ok(input, "the date input");
  assert.match(input, /className=\{cx\(PX\.input, "scroll-mt-44"\)\}/);
});

test("T46-L4 the hero: a fixed light screen with decorative art; its text is screen-ink", () => {
  const src = source(sectionPath("Hero"));
  assert.doesNotMatch(src, /use client|\buse(State|Effect|Ref|Memo|Callback|Reducer|SyncExternalStore)\b/, "a server component");
  assert.match(src, /\bpixel-frame bg-screen\b/);
  const img = src.match(/<img\b[^>]*src=\{spriteSrc\("hero-scene"\)\}[^>]*\/>/)?.[0] ?? "";
  assert.ok(img, "the hero-scene image");
  for (const attr of [/alt=""/, /aria-hidden="true"/, /draggable=\{false\}/, /width=\{640\}/, /height=\{246\}/, /\bpixelated\b/, /fetchPriority="high"/]) {
    assert.match(img, attr, `hero img ${attr}`);
  }
  assert.match(src, /<p className="text-sm font-semibold text-screen-ink">Manila to Baguio buses, straight from the operators\.<\/p>/);
  assert.doesNotMatch(src, /text-brand|text-foreground|text-muted|text-link/, "the hero is a fixed light screen (ux §0)");
  // The trio: decorative and static. TG-49 shows it at every width, since the scene is 2x everywhere now
  assert.match(src, /<div aria-hidden="true" className="absolute bottom-1 left-3 flex gap-1">/);
  assert.match(src, /CAST\.heroTrio/);
});

test("T46-L5 ready-made trips: a client section, fed by the cached list, with secondary links only", () => {
  const src = source(sectionPath("PremadeTrips"));
  assert.match(src, /^"use client";/);
  assert.match(src, /fetchPremade\(/);
  // navigator is undefined in the server prerender, so the online read may be guarded.
  assert.match(src, /landingPremadeView\(\w+, [^;]*navigator\.onLine/);
  // Every call, the rendered one included, passes the browser's online state (audit E1: offline shows the offline copy)
  const calls = src.split("landingPremadeView(").slice(1).map((c) => c.slice(0, c.indexOf(")")));
  assert.ok(calls.length >= 2, "the effect's log call and the render call");
  for (const args of calls) assert.match(args, /navigator\.onLine/, `landingPremadeView(${args})`);
  assert.match(src, /useEffect\(/);
  assert.match(src, /if \(!flags\.premadeItineraries\) return null;/);
  assert.match(src, /<section aria-labelledby="ready-made-trips"/);
  assert.match(src, /<SectionTitle id="ready-made-trips">Ready-made trips<\/SectionTitle>/);
  assert.match(src, /<PixelLink variant="secondary" href=\{card\.href\} aria-describedby=\{/);
  assert.match(src, /<PixelButton variant="secondary"[^>]*>\s*Try again\s*<\/PixelButton>/);
  assert.doesNotMatch(src, /variant="primary"/);
  assert.match(src, /console\.info\("\[tg-landing\] premade state=%s count=%d", /, "one log line per load (plan §7)");
  for (const m of src.matchAll(/console\.\w+\(([^;]*)\);/g)) assert.doesNotMatch(m[1], /href|url|slug|spot_names|budget/i, m[0]);
  assert.ok(source("src/app/page.tsx").indexOf("<PremadeTrips />") > source("src/app/page.tsx").indexOf("<TripSearch />"), "mounted after the form");
});

test("T46-L10 Try again keeps keyboard focus in the section (tg-review S2)", () => {
  // retry() unmounts the failed block with the focused button in it: focus the state area first, or focus falls to body
  const src = source(sectionPath("PremadeTrips"));
  const ref = src.match(/const (\w+) = useRef<HTMLDivElement>\(null\);/)?.[1];
  assert.ok(ref, "a ref for the state area");
  assert.match(src, new RegExp(`<div ref=\\{${ref}\\} tabIndex=\\{-1\\}`), "the state area can take focus, but isn't a Tab stop");
  const body = src.match(/function retry\(\) \{([\s\S]*?)\n {2}\}/)?.[1] ?? "";
  const focus = body.indexOf(`${ref}.current?.focus()`), reset = body.indexOf("setResult(null)");
  assert.ok(focus >= 0 && reset >= 0, "retry() focuses the state area and resets the result");
  assert.ok(focus < reset, "focus moves before the failed block (and its button) unmounts");
  const area = src.slice(src.indexOf(`<div ref={${ref}}`));
  for (const state of ['"loading"', '"failed"', '"list"']) assert.ok(area.includes(`view.state === ${state}`), `${state} renders inside the state area`);
});

test("T46-L6 how it works and trust: server sections named by their h2; the steps are an ordered list", () => {
  for (const name of ["HowItWorks", "Trust"]) {
    const src = source(sectionPath(name));
    assert.doesNotMatch(src, /use client/, name);
    const label = src.match(/<section aria-labelledby="([\w-]+)"/)?.[1];
    assert.ok(label, `${name}: a section named by its heading`);
    assert.match(src, new RegExp(`<SectionTitle id="${label}">`), name);
    assert.match(src, /<SectionStripe \/>/, `${name}: the stripe under the heading`);
  }
  const how = source(sectionPath("HowItWorks"));
  assert.match(how, /<ol\b/);
  for (const n of ["1.", "2.", "3."]) assert.match(how, new RegExp(`<span aria-hidden="true"[^>]*>${n.replace(".", "\\.")}</span>`), `step ${n} is decorative`);
  assert.match(source(sectionPath("PremadeTrips")), /<SectionStripe \/>/);
  // TG-49: bg-lift (Flag Blue in light, the light Blue tint in dark), so the rule shows on the dark page
  assert.equal(source(sectionPath("SectionStripe")).match(/<div\b[^>]*\/>/)?.[0], '<div aria-hidden="true" className="mt-1 h-[3px] w-12 bg-lift" />');
});

// ================================================================ T46-C: copy (ux §5)

test("T46-C2 the hero and the quick actions say exactly ux §5.1 and §5.3", () => {
  const text = copyIn([sectionPath("Hero"), sectionPath("QuickActions")]);
  for (const s of [
    "Manila to Baguio buses, straight from the operators.", // the owner's S1 call: honest, no "every"
    "Find buses", "Every trip on file, with fares and where to book.",
    "Plan a Baguio trip", "Tell us who's coming and your vibe. Tara!",
    "In Baguio?", "Jeeps, taxis and walks from the terminal.",
  ]) assert.ok(text.includes(s), s);
});

test("T46-C3 the ready-made section says exactly ux §5.4, in every state", () => {
  const text = copyIn([sectionPath("PremadeTrips")]);
  for (const s of [
    "Ready-made trips",
    "No time to plan? Tara, pick one. Each is built only from buses and spots on file.",
    "Loading trip ideas...",
    "No ready-made trips on file yet.",
    "Ready-made trips need a connection the first time. Open this page once with signal and they'll be saved.",
    "Could not load trip ideas. Check your connection and try again.",
    "Try again", "See this trip",
  ]) assert.ok(text.includes(s), s);
});

test("T46-C4 how it works and trust say exactly ux §5.5, and claim nothing we can't back", () => {
  const text = copyIn([sectionPath("HowItWorks"), sectionPath("Trust")]);
  for (const s of [
    "How it works",
    "Search", "Pick a date. See the buses on file, with fares and booking links.",
    "Plan", "Tell us who's coming and what you're into, or pick a ready-made trip.",
    "Go offline", "Open your trip once with signal. It stays on your phone for the mountain roads.",
    "Why you can trust it",
    "Times come from the operators' own booking sites.", // S1
    "Every trip shows a Checked date, so you know how fresh it is.",
    "Works offline once you've opened it.",
    "Bus times can change. Always confirm with the operator before you travel.",
  ]) assert.ok(text.includes(s), s);
  assert.doesNotMatch(text, /every bus|all (the )?operators|all buses|complete schedule/i, "honesty (plan A6)");
});

// ================================================================ T46-K: theme (TG-47 rules), targets, scanners

test("T46-K1/K2/K5 tokens only; no blue-and-red fill together; no decorative red or yellow; no flag-blue on the landing", () => {
  const files = landingFiles();
  assert.ok(files.length >= SECTIONS.length, "the landing sections exist");
  for (const path of files) {
    const src = read(path);
    assert.doesNotMatch(src, /#[0-9a-f]{3,8}\b|\brgba?\(/i, `${path}: no raw colour`);
    for (const cls of classStrings(src)) {
      const t = tokens(cls).map((x) => x.split(":").pop()!);
      // TG-49: primary is Red; lift is Blue
      const blue = t.some((x) => /^(bg|text|border)-(flag-blue|link|lift)\b/.test(x));
      const red = t.some((x) => /^(bg|text|border)-(primary|danger|danger-text|flag-red)\b/.test(x));
      assert.ok(!(blue && red), `${path}: "${cls}" pairs blue and red`);
    }
    assert.doesNotMatch(src, /\b(bg|text|border)-flag-(red|yellow)\b|\bbg-danger\b/, `${path}: no decorative red or yellow (ux §0)`);
    assert.doesNotMatch(src, /\bbg-flag-blue\b/, `${path}: the landing's Blue is the lift token (TG-49)`);
  }
});

test("T46-K3/K4 no primary on the landing (the search submit stays the one); controls are the 44px primitives", () => {
  for (const path of [...landingFiles(), "src/app/page.tsx"]) {
    const src = read(path);
    assert.doesNotMatch(src, /variant="primary"/, `${path}: one Blue primary per screen, and it's TripSearch's`);
    assert.doesNotMatch(src, /<(a|button)\b/, `${path}: links and buttons go through PixelLink/PixelButton/PixelCardLink`);
  }
});

test("T46-K6 the fixed light screens (hero, sprite plates) use screen tokens for text", () => {
  for (const path of landingFiles()) {
    const src = read(path);
    for (const m of src.matchAll(/className=\{?[`"][^`"]*\bbg-screen(-paper)?\b[^`"]*[`"]/g)) {
      assert.doesNotMatch(m[0], /\btext-(foreground|muted)\b/, `${path}: ${m[0]}`);
    }
  }
});

test("T46-P2x TG-44's breakpoint, contents and order rules hold on the new files", () => {
  for (const path of landingFiles()) {
    const src = read(path);
    for (const tok of classStrings(src).flatMap(tokens)) {
      assert.doesNotMatch(tok, /^(sm|2xl|max-[\w-]+|min-\[[^\]]*\]|portrait|landscape|@[\w-]*|\[@media[^\]]*\]):/, `${path}: ${tok}`);
      assert.doesNotMatch(tok, /(^|:)-?(order|col-start|col-end|row-start|row-end)-/, `${path}: ${tok} (TG-44 P4)`);
    }
    // Width-based visibility (D4): only on decorative elements that carry no text and no control. A class string
    // shows or hides by width when it has md:hidden-like tokens, or an unprefixed `hidden` with a md:block-like one.
    const byWidth = (cls: string) => {
      const t = tokens(cls);
      return t.some((x) => /^(md|lg|xl):(hidden|sr-only|not-sr-only|invisible|visible)$/.test(x)) ||
        (t.includes("hidden") && t.some((x) => /^(md|lg|xl):(block|flex|grid|inline|inline-flex|inline-block|contents)$/.test(x)));
    };
    // ...and only written literally on its element, where the checks below can see it (audit P2c: a constant escaped)
    for (const cls of classStrings(src)) {
      if (byWidth(cls)) assert.ok(src.includes(`className="${cls}"`), `${path}: "${cls}" hides or shows by width outside a literal className`);
    }
    for (const m of src.matchAll(/<(\w+)\b([^>]*className="([^"]*)"[^>]*)>/g)) {
      if (!byWidth(m[3])) continue;
      const [whole, tag, attrs] = m;
      assert.match(attrs, /aria-hidden="true"/, `${path}: ${whole} hides or shows by width but isn't decorative`);
      if (whole.endsWith("/>")) continue;
      const close = src.indexOf(`</${tag}>`, m.index! + whole.length);
      const inner = src.slice(m.index! + whole.length, close);
      assert.doesNotMatch(inner, /<(a|button|input|Link|Pixel(Button|Link|CardLink|Choice))\b/, `${path}: a control inside width-hidden decor`);
      // Strip JSX expressions innermost-first (a .map(... => (...)) holds a ">"), then the tags.
      let bare = inner;
      for (let prev = ""; prev !== bare; ) [prev, bare] = [bare, bare.replace(/\{[^{}]*\}/g, "")];
      assert.doesNotMatch(bare.replace(/<[^>]*>/g, ""), /[A-Za-z]/, `${path}: text inside width-hidden decor`);
    }
    for (const m of src.matchAll(/<(\w+)\b([^>]*)className="contents(?:\s[^"]*)?"([^>]*)>/g)) {
      assert.equal(m[1], "div", `${path}: contents on <${m[1]}>`);
      assert.doesNotMatch(m[2] + m[3], /\bid=|\baria-|\brole=|\bon[A-Z]/, `${path}: ${m[0]}`);
    }
  }
});

// ================================================================ T46-S: sprites and the hero art

test("T46-S2 every sprite the landing names is in TG-33's manifest", async () => {
  const { SPRITES } = await load<{ SPRITES: Record<string, unknown> }>("src/lib/sprites.ts");
  const names = new Set<string>();
  for (const path of [...landingFiles(), "src/lib/landingCast.ts"].filter(has)) {
    const src = read(path);
    for (const m of src.matchAll(/(?:spriteSrc\(|SPRITES\[)"([^"]+)"/g)) names.add(m[1]);
    for (const m of src.matchAll(/"((?:vehicle|mode|tile|ui|deco|place|chibi|hero)-[a-z0-9-]+)"/g)) names.add(m[1]);
  }
  assert.ok(names.has("hero-scene") && names.has("vehicle-bus") && names.has("mode-jeep") && names.has("ui-badge-verified") && names.has("tile-mountain"));
  for (const n of names) assert.ok(Object.hasOwn(SPRITES, n), `${n} is a SPRITES key`);
});

test("T46-S3 hero-scene: 320×123 PNG art in the palette, pinned, within its size budget", async () => {
  const { SPRITES, PNG_ART } = await load<{ SPRITES: Record<string, { w: number; h: number }>; PNG_ART: Set<string> }>("src/lib/sprites.ts");
  assert.deepEqual(SPRITES["hero-scene"], { w: 320, h: 123 });
  assert.ok(PNG_ART.has("hero-scene"), "listed as PNG art");
  const path = "public/sprites/hero-scene.png";
  assert.ok(has(path), path);
  const buf = readFileSync(new URL(path, WEB));
  assert.equal(createHash("sha256").update(buf).digest("hex"), "4e302fb868e48f7fc95711d2a61209e1339bccb57b7803982b69dc353e6ab76d", "the approved art, byte for byte");
  // 8 KB, not TG-33's 4 KB: that limit is for the 24-64px ART_DROP sprites; this is one 320×123 scene
  assert.ok(buf.length <= 8192, `${buf.length} bytes`);
  const png = decodePng(buf);
  assert.deepEqual([png.w, png.h], [320, 123]);
  for (const c of png.chunks) assert.ok(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"].includes(c), `chunk ${c}`);
  // The original 6 only: TG-47's 11 are for art listed in sprites.test.ts NEW_ART_11, and the hero isn't (pixelSvg.ts
  // keeps the original 6 first)
  assert.deepEqual(paletteProblems(png, Object.values(PALETTE).slice(0, 6)), []);
  assert.match(read("sprites-src/art-prompts.md"), /\bhero-scene\b/, "an art-prompts row");
});

test("T46-L7 the cast: every landing chibi slot maps to a manifest sprite (the seam TG-48's looks swap into)", async () => {
  const cast = await load<{ CAST: Record<string, unknown>; castSprite: (s: { type: string; index: number; frame: string }) => string }>("src/lib/landingCast.ts");
  const { SPRITES, PASSENGER_TYPES } = await load<{ SPRITES: Record<string, unknown>; PASSENGER_TYPES: readonly string[] }>("src/lib/sprites.ts");
  // ux §5.1, §5.3 and §5.5
  assert.deepEqual(cast.CAST, {
    heroTrio: [
      { type: "adult", index: 1, frame: "idle-1" },
      { type: "senior", index: 0, frame: "idle-1" },
      { type: "student", index: 1, frame: "idle-1" },
    ],
    planTile: { type: "adult", index: 0, frame: "wave" },
    planStep: { type: "senior", index: 1, frame: "idle-1" },
  });
  const slots = Object.values(cast.CAST).flat() as { type: string; index: number; frame: string }[];
  for (const slot of slots) {
    assert.ok(PASSENGER_TYPES.includes(slot.type), slot.type);
    assert.ok(Object.hasOwn(SPRITES, cast.castSprite(slot)), `${JSON.stringify(slot)} -> ${cast.castSprite(slot)}`);
  }
  const src = read("src/lib/landingCast.ts");
  assert.doesNotMatch(src, /use client|from "@\/|\bfetch\(|<\/?[A-Za-z][\w.]*[\s>/]/, "a plain module");
});

test("T48-C1 the landing cast draws TG-48 looks, by lookFor, and repeats no look already on the page", async () => {
  const cast = await load<{ CAST: Record<string, unknown>; castSprite: (s: { type: string; index: number; frame: string }) => string }>("src/lib/landingCast.ts");
  const { lookFor } = await load<{ lookFor: (type: string, index: number) => string | null }>("src/lib/party.ts");
  const { HOME_ROW } = await load<{ HOME_ROW: readonly { name: string }[] }>("src/lib/homeDecor.ts");
  const c = cast.CAST as Record<string, { type: string; index: number; frame: string } | { type: string; index: number; frame: string }[]>;
  // The trio proposed in the TG-48 build log (tg-ux2 OK pending): casual man (light), lola and schoolboy (Kayumanggi)
  assert.deepEqual((c.heroTrio as { type: string; index: number; frame: string }[]).map(cast.castSprite), [
    "chibi-adult-casual-m-idle-1",
    "chibi-senior-lola-idle-1",
    "chibi-student-boy-idle-1",
  ]);
  assert.equal(cast.castSprite(c.planTile as { type: string; index: number; frame: string }), "chibi-adult-casual-f-wave");
  assert.equal(cast.castSprite(c.planStep as { type: string; index: number; frame: string }), "chibi-senior-lolo-idle-1");
  const slots = Object.values(c).flat();
  for (const slot of slots) {
    assert.equal(cast.castSprite(slot), `chibi-${lookFor(slot.type, slot.index)}-${slot.frame}`, `${JSON.stringify(slot)} by lookFor`);
    assert.doesNotMatch(cast.castSprite(slot), /^chibi-(adult|student|senior|pwd)-(idle-1|idle-2|wave)$/, "not a classic TG-33 chibi");
  }
  // One cast on `/`: the hero and tiles never repeat a look, nor the home strip's barong or Filipiniana
  const looks = slots.map((s) => lookFor(s.type, s.index));
  const strip = HOME_ROW.map((d) => d.name.match(/^chibi-(.+)-idle-1$/)?.[1]).filter((x): x is string => !!x);
  assert.deepEqual(strip, ["adult-barong", "adult-filipiniana"]);
  assert.equal(new Set([...looks, ...strip]).size, looks.length + strip.length, [...looks, ...strip].join(", "));
});

// ================================================================ T46-V: the ready-made view (pure)

type LandingCard = { title: string; dates: string; places: string; budget: string | null; href: string };
type LandingView = { state: "loading" | "list" | "empty" | "offline" | "failed" | "hidden"; cards?: LandingCard[] };
type PremadeViewModule = {
  premadeCard: (s: PremadeSummary, date: string, ret: string) => LandingCard & { matches: boolean };
  landingCard: (s: PremadeSummary) => LandingCard;
  landingPremadeView: (r: PremadeResult | null, online: boolean) => LandingView;
};
const summary = (over: Partial<PremadeSummary>): PremadeSummary =>
  ({
    share_slug: "premade-chill",
    vibe: "Chill",
    trip_date: "2026-11-06",
    return_date: "2026-11-08",
    day_count: 3,
    stop_count: 12,
    spot_names: ["Burnham Park (made up)", "Baguio Cathedral (made up)"],
    budget_php: 6000,
    ...over,
  }) as PremadeSummary;

async function view(): Promise<PremadeViewModule> {
  const m = await load<PremadeViewModule>("src/lib/premadeView.ts");
  assert.equal(typeof m.landingCard, "function", "landingCard is exported");
  assert.equal(typeof m.landingPremadeView, "function", "landingPremadeView is exported");
  return m;
}

test("T46-V1..V6 landingPremadeView maps every fetch outcome to one state", async () => {
  const { landingPremadeView } = await view();
  const a = summary({}), b = summary({ share_slug: "premade-food-trip", vibe: "Food trip" });
  assert.equal(landingPremadeView({ kind: "ok", list: [] }, true).state, "empty");
  const list = landingPremadeView({ kind: "ok", list: [a, b] }, true);
  assert.equal(list.state, "list");
  assert.deepEqual(list.cards?.map((c) => c.href), ["/i/premade-chill", "/i/premade-food-trip"], "API order");
  assert.equal(landingPremadeView({ kind: "unavailable" }, true).state, "hidden", "404 or the flag off: no section");
  assert.equal(landingPremadeView({ kind: "failed" }, false).state, "offline", "never cached and offline");
  assert.equal(landingPremadeView({ kind: "failed" }, true).state, "failed", "online but the API failed");
  assert.equal(landingPremadeView(null, true).state, "loading");
  assert.equal(landingPremadeView(null, false).state, "loading");
});

test("T46-V7 landingCard is premadeCard without the date match", async () => {
  const { landingCard, premadeCard } = await view();
  const s = summary({ share_slug: "a b/c" });
  const card = landingCard(s);
  assert.ok(!("matches" in card), "no date match on the landing");
  const expected: Partial<LandingCard & { matches: boolean }> = { ...premadeCard(s, "", "") };
  delete expected.matches;
  assert.deepEqual(card, expected);
  assert.equal(card.href, `/i/${encodeURIComponent("a b/c")}`);
  assert.equal(landingCard(summary({ budget_php: null })).budget, null);
});

// ================================================================ T46-B: the banner with two GETs on `/` (S5)

const API = "https://api.example.test";
const ev = (source: "network" | "cache" | "none", path: string, savedAt: string | null = null): BannerEvent => ({
  type: "data", source, savedAt, url: `${API}${path}`,
});
const run = (...events: BannerEvent[]) => events.reduce(bannerReducer, initialBanner(false) as BannerState);
const T1 = "2026-11-06T10:00:00.000Z", T2 = "2026-11-06T12:00:00.000Z";

test("T46-B1 cached trips stay cached when the ready-made list arrives fresh", () => {
  const s = run(ev("cache", "/trips?date=2026-11-06", T1), ev("network", "/premade-itineraries"));
  assert.equal(s.kind, "cached");
  assert.equal(s.savedAt, T1);
});

test("T46-B2 a fresh answer for the same path clears it, and the state carries no cached list", () => {
  const s = run(ev("cache", "/trips", T1), ev("network", "/trips"));
  assert.equal(s.kind, "none");
  assert.equal(s.savedAt, null);
  assert.ok(!("cached" in s), "the field is absent when empty, so TG-27's literal states still deep-equal");
});

test("T46-B3 the oldest saved time shows while both are cached; when one clears, the remaining one's time", () => {
  const both = run(ev("cache", "/trips", T2), ev("cache", "/premade-itineraries", T1));
  assert.equal(both.kind, "cached");
  assert.equal(both.savedAt, T1);
  const one = bannerReducer(both, ev("network", "/premade-itineraries"));
  assert.equal(one.kind, "cached");
  assert.equal(one.savedAt, T2, "the banner speaks for what's still on screen");
});

test("T46-B4 a miss on one path doesn't hide another path's cached answer (D8)", () => {
  const s = run(ev("cache", "/trips", T1), ev("none", "/premade-itineraries"));
  assert.equal(s.kind, "cached");
  assert.equal(s.savedAt, T1);
  assert.equal(run(ev("none", "/premade-itineraries")).kind, "miss", "a miss with nothing cached is still a miss");
  const lost = run(ev("cache", "/trips", T1), ev("none", "/trips"));
  assert.equal(lost.kind, "miss", "the cached path itself missing");
  assert.ok(!("cached" in lost));
});

test("T46-B5 a URL-less fresh answer clears everything, as before", () => {
  const s = run(ev("cache", "/trips", T1), ev("cache", "/premade-itineraries", T2), { type: "data", source: "network", savedAt: null });
  assert.equal(s.kind, "none");
  assert.ok(!("cached" in s));
});

test("T46-B6 /terminals stays supplementary (TG-27 Part B), and reset empties the cached paths", () => {
  const base = run(ev("cache", "/trips", T1));
  assert.deepEqual(bannerReducer(base, ev("network", "/terminals")), base);
  assert.deepEqual(bannerReducer(base, ev("none", "/terminals")), base);
  const reset = bannerReducer(run(ev("cache", "/trips", T1), ev("cache", "/premade-itineraries", T2)), { type: "reset", online: true });
  assert.deepEqual(reset, initialBanner(true));
});

// ================================================================ T46-X: nothing else moves (PR-scoped fences)

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
/** Like TG-44's fences: skip without origin/main, and for good once this file is on main. */
function fenceSkipped(t: TestContext): boolean {
  if (!gitOk("rev-parse", "--verify", "-q", "origin/main")) {
    t.skip("origin/main not fetched; run `git fetch origin` before npm test");
    return true;
  }
  if (gitOk("cat-file", "-e", "origin/main:web/src/lib/landing.test.ts")) {
    t.skip("TG-46 PR A merged: PR-scoped fence");
    return true;
  }
  return false;
}
const changedFiles = () => [
  ...git("diff", "--name-only", "origin/main", "--", "..").split("\n"),
  // untracked paths come relative to web/: "src/…" under web, "../x" above it
  ...git("ls-files", "--others", "--exclude-standard", "--", "..").split("\n").map((f) => (!f ? f : f.startsWith("../") ? f.slice(3) : `web/${f}`)),
].filter(Boolean);

test("T46-X1 no dependency, API, schema, data, config, service worker or manifest change (PR-scoped fence)", (t) => {
  if (fenceSkipped(t)) return;
  const banned = [/^web\/package(-lock)?\.json$/, /^api\//, /^supabase\//, /^data\//, /^web\/next\.config\./, /^web\/public\/sw\.js$/, /^web\/public\/offline\.html$/, /^web\/src\/app\/manifest\.ts$/];
  for (const f of changedFiles()) for (const re of banned) assert.doesNotMatch(f, re, `${f} must not change in PR A`);
});

test("T46-X2 only plan §2.1's files and the approved test edits change (PR-scoped fence)", (t) => {
  if (fenceSkipped(t)) return;
  const allowed = new Set([
    ...SECTIONS.map((s) => `web/${sectionPath(s)}`),
    "web/src/app/page.tsx",
    "web/src/components/TripSearch.tsx",
    "web/src/components/pixel/PageTitle.tsx",
    "web/src/components/pixel/classes.ts",
    "web/src/lib/premadeView.ts",
    "web/src/lib/offline.ts",
    "web/src/lib/landingCast.ts",
    "web/src/lib/sprites.ts",
    "web/public/sprites/hero-scene.png",
    "web/sprites-src/art-prompts.md",
    "web/src/lib/landing.test.ts",
    // plan §3.3's deliberate edits, each in its own commit
    "web/src/lib/responsive.test.ts",
    "web/src/lib/mapLinks.test.ts",
    "web/src/lib/homeDecor.test.ts",
    "web/src/lib/sprites.test.ts",
    "web/src/lib/pixelTheme.test.ts",
    // Not in plan §3.3; a scratch GREEN needed them (build log, "plan gaps"). The audit approves or strikes them:
    // T15-G9 and T21-S5 read the /plan gate from the home page, now in QuickActions; T33-17 wants a README row per sprite
    "web/src/lib/partyPicker.test.ts",
    "web/src/lib/planForm.test.ts",
    "web/public/sprites/README.md",
    // Manager GREEN follow-up (build log): Find buses moves focus to the date input. The fix is in TripSearch.tsx, which
    // is already listed above, so no file is added here
  ]);
  for (const f of changedFiles()) assert.ok(allowed.has(f), `${f} is outside PR A's plan`);
  // The edited existing tests are retargeted or recounted, never loosened (audit M76/M79): no assert goes, no count becomes >=
  for (const f of changedFiles().filter((x) => /^web\/src\/lib\/.+\.test\.ts$/.test(x) && x !== "web/src/lib/landing.test.ts")) {
    const asserts = (src: string) => src.match(/\bassert\.\w+\(/g)?.length ?? 0;
    const base = git("show", `origin/main:${f}`);
    const now = readFileSync(new URL(`../../../${f}`, import.meta.url), "utf8");
    // plan §3.3: TG44-H1's page half replaces the two-link count and class loop (2 asserts) with one QuickActions check
    const dropped = f === "web/src/lib/responsive.test.ts" ? 2 : 0;
    assert.ok(asserts(now) >= asserts(base) - dropped, `${f}: ${asserts(base)} asserts on main, ${asserts(now)} now`);
    const added = git("diff", "-U0", "origin/main", "--", `../${f}`).split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    assert.ok(added.length > 0, `${f}: the diff sees its changes`);
    for (const l of added) assert.doesNotMatch(l, /assert\.ok\([^)]*(>=|<=)\s*\d/, `${f}: a count loosened to a bound: ${l}`);
  }
});
