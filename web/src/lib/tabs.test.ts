// TG-49 site tabs: the header from md, the bottom bar on phones. Run with `npm test` (node --test, type stripping).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { currentTab, visibleTabs } from "./tabs.ts";
import { ICON_SIZE, TAB_ICONS, iconPath } from "./pixelIcons.ts";

const WEB = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB), "utf8");

test("TB1 four tabs in order; Plan only while a planner mode is on", () => {
  assert.deepEqual(visibleTabs(true).map((t) => [t.href, t.label]), [
    ["/buses", "Buses"], ["/plan", "Plan"], ["/baguio", "Baguio"], ["/wallet", "Wallet"],
  ]);
  assert.deepEqual(visibleTabs(false).map((t) => t.href), ["/buses", "/baguio", "/wallet"]);
});

test("TB2 each page marks its tab; the title screen marks none", () => {
  const cases: [string, string | null][] = [
    ["/", null], ["/buses", "/buses"], ["/plan", "/plan"], ["/i/premade-chill", "/plan"], ["/baguio", "/baguio"],
    ["/wallet", "/wallet"], ["/tickets", "/wallet"], ["/w/0123456789abcdef0123456789abcdef", "/wallet"],
    ["/busesx", null], ["/planner", null], ["/nope", null], ["", null],
  ];
  for (const [path, tab] of cases) assert.equal(currentTab(path), tab, path);
});

test("TB3 header: the wordmark goes home, the tabs show from md, the Dark mode switch sits at the right", () => {
  const src = read("src/components/SiteHeader.tsx");
  assert.match(src, /<Link href="\/" className=\{PX\.logo\}>\s*Tara Gala\s*<\/Link>/);
  assert.match(src, /<nav aria-label="Main" className="hidden md:block">/);
  assert.match(src, /aria-current=\{current === tab\.href \? "page" : undefined\}/);
  assert.match(src, /<div className="ml-auto">\s*<ThemeToggle \/>\s*<\/div>/);
  assert.match(src, /cx\(PX\.tab, "min-h-11 gap-2 border-b-4"\)\}>\s*<TabIcon tab=\{tab\.href\} scale=\{1\} \/>/, "44px targets, a 1x icon before the label");
});

test("TB4 phones: a fixed bottom bar over the safe area, gone from md; the body leaves room for it", () => {
  const src = read("src/components/TabBar.tsx");
  assert.match(src, /<nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 border-t-3 border-frame bg-card pb-\[env\(safe-area-inset-bottom\)\] md:hidden">/);
  assert.match(src, /aria-current=\{current === tab\.href \? "page" : undefined\}/);
  assert.match(src, /cx\(PX\.tab, "min-h-16 flex-col gap-0\.5 border-t-4 pt-1 text-sm"\)\}>\s*<TabIcon tab=\{tab\.href\} scale=\{2\} \/>/, "64px targets, a 2x icon over the label");
  assert.match(read("src/app/layout.tsx"), /<body className="min-h-full flex flex-col pb-\[calc\(4\.25rem\+env\(safe-area-inset-bottom\)\)\] md:pb-0">/);
});

test("TB5 the service worker precaches /buses and its version moved", () => {
  const sw = read("public/sw.js");
  assert.match(sw, /const PRECACHE_PAGES = \[[^\]]*"\/buses"[^\]]*\];/);
  assert.doesNotMatch(sw, /const SW_VERSION = "2026-10-31\.3"/);
});

test("TB6 no page keeps a Back to bus search link to the title screen", () => {
  for (const page of ["plan", "baguio", "wallet", "tickets", "w/[slug]", "i/[slug]"]) {
    assert.doesNotMatch(read(`src/app/${page}/page.tsx`), /href="\/"/, page);
  }
  for (const page of ["tickets", "w/[slug]"]) assert.match(read(`src/app/${page}/page.tsx`), /href="\/wallet"[\s\S]*?Back to trip wallet/, page);
});

test("TB7 one 16 by 16 pixel icon per tab, drawn only with # and .", () => {
  assert.deepEqual(Object.keys(TAB_ICONS).sort(), visibleTabs(true).map((t) => t.href).sort());
  for (const [tab, rows] of Object.entries(TAB_ICONS)) {
    assert.equal(rows.length, ICON_SIZE, `${tab}: 16 rows`);
    for (const row of rows) assert.match(row, /^[#.]{16}$/, `${tab}: ${row}`);
    assert.ok(rows.join("").split("#").length - 1 > 40, `${tab}: enough ink to read at 16px`);
  }
});

test("TB8 iconPath draws each run of # as one rectangle", () => {
  assert.equal(iconPath(["#..##", ".....", "###.."]), "M0 0h1v1h-1zM3 0h2v1h-2zM0 2h3v1h-3z");
  assert.equal(iconPath(["....."]), "");
});

test("TB9 the icon is decorative, crisp and in the text colour", () => {
  const src = read("src/components/TabIcon.tsx");
  assert.match(src, /<svg aria-hidden="true"[^>]*shapeRendering="crispEdges" fill="currentColor"/);
  assert.match(src, /scale: 1 \| 2/, "whole-number scales only, so pixels stay square");
});
