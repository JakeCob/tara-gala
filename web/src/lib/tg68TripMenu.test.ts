// TG-68 part 7 (ux.md §7, audit #6): the Trip menu row and its open panel sit above the Days row and the map, so the
// bus times are reachable without scrolling past every stop. Moved as they are: no new copy. tg-ux2's answer 1
// (2026-11-21): the menu is the whole trip's, so it goes above the day's title, pick box and tips too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const map = () => readFileSync(new URL("../components/LevelMap.tsx", import.meta.url), "utf8");
const body = () => {
  const src = map();
  const start = src.indexOf("return (", src.indexOf("export default function LevelMap("));
  return src.slice(start, src.indexOf("\n}\n", start));
};

test("TG68-T1 inside the map: entry, header, Trip menu, its open panel, the day's block, edit bar, bus warning, Days, the map, then edit mode's buttons", () => {
  const src = body();
  const at = (s: string) => {
    const n = src.indexOf(s);
    assert.ok(n > 0, `${s} is in LevelMap's render`);
    return n;
  };
  const order = [
    ["editor.entry", at("{editor && !editing && editor.entry(addPlace)}")],
    ["the plan's header", at("{copyLine && <p className={PX.meta}>{copyLine}</p>}")],
    ["Trip menu", at('<nav aria-label="Trip menu"')],
    ["Buses panel", at('{menu === "buses" && (')],
    ["Budget panel", at('{menu === "budget" &&')],
    ["To-do panel", at('{menu === "todo" &&')],
    ["Sources panel", at('{menu === "sources" &&')],
    ["Album panel", at('{menu === "album" &&')],
    ["the day's title", at("{day.title}</h3>")],
    ["the pick box", at("{day.pick && (")],
    ["the tips", at("{day.tips.length > 0 && (")],
    ["edit bar", at("{editor?.top(addPlace)}")],
    ["bus warning", at("{busNotice(warned.length)}")],
    ["Days", at('<nav aria-label="Days"')],
    ["the map", at("<section ref={screen}")],
    ["Add a stop", at("Add a stop to World {day.day}")],
  ] as const;
  for (let i = 1; i < order.length; i++) assert.ok(order[i - 1][1] < order[i][1], `${order[i - 1][0]} before ${order[i][0]}`);
});

test("TG68-T2 moved as it is: one menu, the same buttons, aria-pressed, toggling and grid; the recap still has none", () => {
  const src = map();
  assert.equal(src.split('aria-label="Trip menu"').length - 1, 1, "one menu");
  assert.match(src, /\{!recap && \(\n\s+<nav aria-label="Trip menu" className="grid grid-cols-3 gap-2 lg:flex lg:flex-wrap">/);
  assert.match(src, /\[\["buses", "Buses"\], \["budget", "Budget"\], \["todo", "To-do"\], \["sources", "Sources"\], \.\.\.\(photos \? \[\["album", "Album"\]\] : \[\]\)\]/);
  assert.match(src, /aria-pressed=\{menu === key\}/);
  assert.match(src, /setMenu\(menu === key \? null : key\);/, "the pressed button closes it");
});

test("TG68-T3 Show buses still opens Buses and scrolls to the warned bus", () => {
  assert.match(map(), /onClick=\{\(\) => \{ setMenu\("buses"\); requestAnimationFrame\(\(\) => document\.querySelector\("\[data-bus-warning\]"\)\?\.scrollIntoView\(\{ block: "center" \}\)\); \}\}/);
});

test("TG68-T4 nothing between the Days row and the map (TG-56's rule, kept)", () => {
  const src = body();
  const days = src.indexOf('<nav aria-label="Days"');
  const between = src.slice(src.indexOf("</nav>", days), src.indexOf("<section ref={screen}"));
  assert.equal(between.match(/<(PixelBox|ul|h3|p|nav)\b|menu ===/), null, between.slice(0, 200));
});
