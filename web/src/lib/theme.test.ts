// TG-51 light and dark switch. Run with `npm test` (node --test, Node 22.18+ type stripping).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { THEME_BOOT, THEME_KEY, effectiveTheme, nextTheme, parseTheme } from "./theme.ts";

const WEB = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB), "utf8");

test("TH1 only light and dark are saved choices", () => {
  assert.equal(parseTheme("light"), "light");
  assert.equal(parseTheme("dark"), "dark");
  for (const bad of [null, undefined, "", "Dark", "auto", "system", 1, {}]) assert.equal(parseTheme(bad), null, String(bad));
});

test("TH2 the switch flips the theme on screen; no choice follows the phone", () => {
  assert.equal(nextTheme("light"), "dark");
  assert.equal(nextTheme("dark"), "light");
  assert.equal(effectiveTheme(null, true), "dark");
  assert.equal(effectiveTheme(null, false), "light");
  assert.equal(effectiveTheme("light", true), "light");
  assert.equal(effectiveTheme("dark", false), "dark");
});

// The boot script runs before React, so check what it does, not how it reads
function boot(stored: string | null, throws = false) {
  const dataset: Record<string, string> = {};
  const localStorage = {
    getItem: (key: string) => {
      if (throws) throw new Error("SecurityError");
      return key === THEME_KEY ? stored : null;
    },
  };
  runInNewContext(THEME_BOOT, { localStorage, document: { documentElement: { dataset } } });
  return dataset.theme;
}

test("TH3 the boot script applies a saved choice and ignores anything else", () => {
  assert.equal(boot("dark"), "dark");
  assert.equal(boot("light"), "light");
  assert.equal(boot(null), undefined);
  assert.equal(boot("<img onerror=x>"), undefined);
  assert.equal(boot(null, true), undefined, "blocked storage never breaks the page");
});

test("TH4 layout runs the boot script in <head> and mounts the switch on every page", () => {
  const layout = read("src/app/layout.tsx");
  assert.match(layout, /<head>\s*(\{\/\*[^]*?\*\/\}\s*)?<script dangerouslySetInnerHTML=\{\{ __html: THEME_BOOT \}\} \/>\s*<\/head>/);
  assert.match(layout, /<html\b[^>]*\bsuppressHydrationWarning\b[^>]*>/);
  assert.match(layout, /\{children\}\s*<ThemeToggle \/>/);
});

test("TH5 the switch is a labelled switch, saves on this device only and logs no theme or storage contents", () => {
  const src = read("src/components/ThemeToggle.tsx");
  assert.match(src, /role="switch"/);
  assert.match(src, /aria-checked=\{dark\}/);
  assert.match(src, />\s*Dark mode\s*</);
  assert.match(src, /localStorage\.setItem\(THEME_KEY, next\)/);
  assert.doesNotMatch(src, /fetch\(|sessionStorage|indexedDB/);
  for (const call of src.match(/console\.\w+\([^)]*\)/g) ?? []) {
    assert.doesNotMatch(call, /next|theme\b(?!:)|event/, call);
  }
  assert.doesNotMatch(src, /outline-none|rounded-|ring-/, "T14's focus and shape rules");
});
