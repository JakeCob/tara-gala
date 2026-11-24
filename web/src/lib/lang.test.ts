// TG-74 the language picker, area 1 (tabs, header, title screen). Owner decisions 2026-11-23: English and Tagalog
// first, each in its own name; Ilokano and Bisaya hidden until a native speaker checks them; the first visit follows the
// phone; the choice is kept on the phone. Behind NEXT_PUBLIC_LANG_PICKER; off renders today's pages. Read from the
// source, in the style of kaloyFab.test.ts. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { FLAG_DEFAULTS, readFlags } from "./flags.ts";
import { LANGS, LANG_BOOT, LANG_KEY, WORDS, parseLang, phoneLang } from "./lang.ts";
import { visibleTabs } from "./tabs.ts";
import { EN } from "./words/en.ts";
import { TL } from "./words/tl.ts";

const WEB = new URL("../../", import.meta.url);
const ROOT = new URL("../../../", import.meta.url);
const read = (path: string) => {
  assert.ok(existsSync(new URL(path, WEB)), `${path} exists`);
  return readFileSync(new URL(path, WEB), "utf8");
};

test("LP1 NEXT_PUBLIC_LANG_PICKER: default off, a literal read, documented in README section 7 and web/.env.example", () => {
  assert.equal(FLAG_DEFAULTS.langPicker, false);
  const before = process.env.NEXT_PUBLIC_LANG_PICKER;
  try {
    delete process.env.NEXT_PUBLIC_LANG_PICKER;
    assert.equal(readFlags().langPicker, false);
    process.env.NEXT_PUBLIC_LANG_PICKER = "true";
    assert.equal(readFlags().langPicker, true);
  } finally {
    if (before === undefined) delete process.env.NEXT_PUBLIC_LANG_PICKER;
    else process.env.NEXT_PUBLIC_LANG_PICKER = before;
  }
  assert.match(read("src/lib/flags.ts"), /langPicker: parseFlag\(process\.env\.NEXT_PUBLIC_LANG_PICKER, FLAG_DEFAULTS\.langPicker\)/);
  const readme = readFileSync(new URL("README.md", ROOT), "utf8");
  const row = readme.slice(readme.indexOf("## 7.")).split("\n").find((line) => line.includes("`NEXT_PUBLIC_LANG_PICKER`"));
  assert.ok(row, "README section 7 has a row for NEXT_PUBLIC_LANG_PICKER");
  assert.ok(row.includes("`false`"), "default false");
  assert.match(read(".env.example"), /^NEXT_PUBLIC_LANG_PICKER=false$/m);
});

test("LP2 the picker offers English and Tagalog, each in its own name; Ilokano and Bisaya stay hidden", () => {
  assert.deepEqual(LANGS, [{ code: "en", name: "English" }, { code: "tl", name: "Tagalog" }]);
  assert.deepEqual(Object.keys(WORDS), ["en", "tl"]);
  for (const hidden of [/Ilokano/i, /Bisaya/i, /Cebuano/i, /Filipino/i]) assert.doesNotMatch(read("src/components/LangPicker.tsx"), hidden);
});

test("LP3 one dictionary per language, the same keys; a missing Tagalog key fails tsc", () => {
  const keys = (words: object) => Object.entries(words).flatMap(([section, inner]) => Object.keys(inner).map((k) => `${section}.${k}`));
  assert.deepEqual(keys(TL), keys(EN));
  for (const [section, inner] of Object.entries(TL)) {
    for (const [key, value] of Object.entries(inner)) assert.ok(typeof value === "string" && value.trim(), `${section}.${key}`);
  }
  assert.match(read("src/lib/words/tl.ts"), /^\} satisfies Words;$/m);
  // Ambagan stays Ambagan in every language (owner); Baguio is a place name
  assert.equal(TL.tabs.ambagan, "Ambagan");
  assert.equal(TL.title.ambagan, "Ambagan");
  assert.equal(TL.tabs.baguio, "Baguio");
  // every tab has its words
  for (const tab of visibleTabs(true, { around: true, ambagan: true })) assert.equal(EN.tabs[tab.word], tab.label, tab.href);
});

test("LP4 the Tagalog words are the area 1 draft (_team/tickets/TG-74/words-tl-area1.md)", () => {
  assert.deepEqual(TL.tabs, { nav: "Pangunahing menu", buses: "Bus", plan: "Plan", baguio: "Baguio", around: "Libot", trip: "Trip", ambagan: "Ambagan" });
  assert.deepEqual(TL.header, { darkMode: "Dark mode", on: "On", off: "Off" });
  assert.deepEqual(TL.picker, { label: "Wika", choose: "Pumili ng wika" });
  assert.deepEqual(TL.title, {
    tagline: "Bus pa-probinsya, diretso galing sa operators.",
    pressStart: "Press start",
    findBuses: "Maghanap ng bus",
    planTrip: "Magplano ng trip",
    gettingAround: "Paano mag-libot",
    myTrip: "Trip ko",
    ambagan: "Ambagan",
  });
});

test("LP5 the phone's language: Filipino or Tagalog first gives Tagalog, anything else English", () => {
  for (const tags of [["fil-PH"], ["fil"], ["tl"], ["tl-PH", "en-US"], [" FIL_ph "]]) assert.equal(phoneLang(tags), "tl", tags.join());
  for (const tags of [["en-US"], ["en-PH", "fil-PH"], ["ceb"], [""], []]) assert.equal(phoneLang(tags), "en", tags.join());
  assert.equal(phoneLang(null), "en");
  assert.equal(parseLang("tl"), "tl");
  assert.equal(parseLang("en"), "en");
  for (const bad of [null, undefined, "", "TL", "fil", "ilo", "<img onerror=x>", 1]) assert.equal(parseLang(bad), null, String(bad));
});

// The boot script runs before React, so check what it does, not how it reads
function boot(stored: string | null, languages: string[], opts: { throws?: boolean } = {}) {
  const store = new Map<string, string>(stored === null ? [] : [[LANG_KEY, stored]]);
  const logs: string[] = [];
  const html: { lang: string; dataset: Record<string, string> } = { lang: "en", dataset: {} };
  const localStorage = {
    getItem: (key: string) => {
      if (opts.throws) throw new Error("SecurityError");
      return store.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (opts.throws) throw new Error("SecurityError");
      store.set(key, value);
    },
  };
  const console = { info: (...args: unknown[]) => logs.push(args.map(String).join(" ")) };
  runInNewContext(LANG_BOOT, { localStorage, console, navigator: { languages, language: languages[0] }, document: { documentElement: html } });
  return { lang: html.lang, data: html.dataset.lang, saved: store.get(LANG_KEY) ?? null, logs };
}

test("LP6 the boot script: a saved choice wins; the first visit follows the phone, saves it and logs source=phone", () => {
  assert.deepEqual(boot("tl", ["en-US"]), { lang: "tl", data: "tl", saved: "tl", logs: [] });
  assert.deepEqual(boot("en", ["fil-PH"]), { lang: "en", data: "en", saved: "en", logs: [] });
  assert.deepEqual(boot(null, ["fil-PH", "en-US"]), {
    lang: "tl", data: "tl", saved: "tl", logs: ["[tg-lang] pick from=%s to=%s source=%s none tl phone"],
  });
  assert.deepEqual(boot(null, ["en-US"]), { lang: "en", data: "en", saved: "en", logs: ["[tg-lang] pick from=%s to=%s source=%s none en phone"] });
  assert.equal(boot("<img onerror=x>", ["tl"]).data, "tl", "anything else saved is ignored");
  const blocked = boot(null, ["fil"], { throws: true });
  assert.equal(blocked.data, "tl", "blocked storage still follows the phone");
  assert.equal(blocked.saved, null);
});

test("LP7 layout: the boot script only with the flag on, after the theme's; <html lang=\"en\"> stays the prerender", () => {
  const layout = read("src/app/layout.tsx");
  assert.match(layout, /\{flags\.langPicker && <script dangerouslySetInnerHTML=\{\{ __html: LANG_BOOT \}\} \/>\}/);
  assert.match(layout, /<html lang="en" [^>]*suppressHydrationWarning>/);
  assert.doesNotMatch(layout, /cookies\(|headers\(/, "no cookie render: pages stay prerendered");
});

test("LP8 Say: the flag off is plain English text; on, every language in a span and CSS shows the one matching data-lang", () => {
  const say = read("src/components/Say.tsx");
  assert.doesNotMatch(say, /use client|\buse(State|Effect|SyncExternalStore)\b/, "server and client components both use it");
  assert.match(say, /if \(!flags\.langPicker\) return w\(WORDS\.en\);/);
  assert.match(say, /<span data-lang-only="en">\{w\(WORDS\.en\)\}<\/span>\s*<span data-lang-only="tl">\{w\(WORDS\.tl\)\}<\/span>/);
  const css = read("src/app/globals.css");
  assert.match(css, /^html:not\(\[data-lang="tl"\]\) \[data-lang-only="tl"\], html\[data-lang="tl"\] \[data-lang-only="en"\] \{ display: none; \}$/m);
});

test("LP9 the header: the 🌐 picker left of Dark mode with the flag on; off, today's markup", () => {
  const header = read("src/components/SiteHeader.tsx");
  assert.match(header, /\{flags\.langPicker \? \([^]*?<div className="ml-auto flex items-center gap-2">\s*<LangPicker place="header" \/>\s*<ThemeToggle \/>\s*<\/div>\s*\) : \(\s*<div className="ml-auto">\s*<ThemeToggle \/>\s*<\/div>\s*\)\}/);
  for (const f of ["src/components/SiteHeader.tsx", "src/components/TabBar.tsx"]) {
    const src = read(f);
    assert.match(src, /<Say w=\{\(d\) => d\.tabs\[tab\.word\]\} \/>/, f);
    assert.match(src, /aria-label=\{words\.tabs\.nav\}/, f);
  }
  const theme = read("src/components/ThemeToggle.tsx");
  for (const key of ["darkMode", "on", "off"]) assert.ok(theme.includes(`<Say w={(d) => d.header.${key}} />`), key);
});

test("LP10 the title screen: a 🌐 Language row at the end of the start menu with the flag on", () => {
  const title = read("src/components/landing/TitleScreen.tsx");
  assert.match(title, /\{flags\.langPicker && \(\s*<li>\s*<LangPicker place="title" \/>\s*<\/li>\s*\)\}\s*<\/ul>/);
  for (const key of ["tagline", "pressStart", "findBuses", "planTrip", "gettingAround", "myTrip", "ambagan"]) {
    assert.ok(title.includes(`<Say w={(d) => d.title.${key}} />`), key);
  }
  const css = read("src/app/globals.css");
  assert.match(css, /& button:is\(:hover, :focus-visible\) \[data-cursor\] \{ visibility: visible; \}/, "the row's cursor shows like a link's");
  assert.match(css, /^\[data-blink="off"\] button:focus-visible \[data-blinks\] \{ opacity: 1; \}$/m);
});

test("LP11 the picker: a labelled 🌐 disclosure, each choice pressed or not, in its own language; Escape and outside taps close", () => {
  const src = read("src/components/LangPicker.tsx");
  assert.match(src, /aria-label=\{words\.picker\.choose\}/);
  assert.match(src, /<span aria-hidden="true">🌐<\/span>/);
  assert.match(src, /aria-expanded=\{open\}/);
  assert.match(src, /aria-pressed=\{lang === choice\.code\}/);
  assert.match(src, /lang=\{choice\.code\}/);
  assert.match(src, /event\.key !== "Escape"/);
  assert.match(src, /document\.addEventListener\("pointerdown", onDown\)/);
  assert.match(src, /<Say w=\{\(d\) => d\.picker\.label\} \/>/);
  assert.match(src, /PX\.btn\.icon\.skin/, "a 44px square: no crowding at 380");
});

test("LP12 a pick changes <html lang data-lang>, is saved on this phone only and logs from, to and source=picker", () => {
  const src = read("src/components/useLang.ts");
  assert.match(src, /document\.documentElement\.dataset\.lang = next;\s*document\.documentElement\.lang = next;/);
  assert.match(src, /localStorage\.setItem\(LANG_KEY, next\)/);
  assert.match(src, /console\.info\("\[tg-lang\] pick from=%s to=%s source=%s", from, next, "picker"\)/);
  assert.match(src, /useSyncExternalStore\(subscribe, current, \(\) => "en"\)/);
  assert.match(src, /event\.key !== LANG_KEY/, "another tab's pick is followed");
  for (const f of ["src/components/useLang.ts", "src/components/LangPicker.tsx", "src/lib/lang.ts"]) {
    assert.doesNotMatch(read(f), /document\.cookie|fetch\(|sessionStorage|router\.push/, f);
  }
});
