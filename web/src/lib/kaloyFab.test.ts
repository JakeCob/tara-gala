// TG-75 the floating Ask Kaloy button on the trip page (owner, 2026-11-24): bottom-right, above the phones' tab bar,
// "Ask Kaloy" with his face; opens the same chat with no need to tap Edit the plan; stays offline (the chat says it
// needs signal); hidden while the chat is open. With it on, the plain Ask Kaloy in each World goes; the ones that ask
// about a place or a stop stay. Behind NEXT_PUBLIC_KALOY_FAB (needs NEXT_PUBLIC_KALOY). Read from the source, in the
// style of kaloy.test.ts. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { FLAG_DEFAULTS, readFlags } from "./flags.ts";

const WEB = new URL("../../", import.meta.url);
const ROOT = new URL("../../../", import.meta.url);
const read = (path: string) => {
  assert.ok(existsSync(new URL(path, WEB)), `${path} exists`);
  return readFileSync(new URL(path, WEB), "utf8");
};

test("KF1 NEXT_PUBLIC_KALOY_FAB: default off, a literal read, documented in README section 7 and web/.env.example", () => {
  assert.equal(FLAG_DEFAULTS.kaloyFab, false);
  const before = process.env.NEXT_PUBLIC_KALOY_FAB;
  try {
    delete process.env.NEXT_PUBLIC_KALOY_FAB;
    assert.equal(readFlags().kaloyFab, false);
    process.env.NEXT_PUBLIC_KALOY_FAB = "true";
    assert.equal(readFlags().kaloyFab, true);
  } finally {
    if (before === undefined) delete process.env.NEXT_PUBLIC_KALOY_FAB;
    else process.env.NEXT_PUBLIC_KALOY_FAB = before;
  }
  assert.match(read("src/lib/flags.ts"), /kaloyFab: parseFlag\(process\.env\.NEXT_PUBLIC_KALOY_FAB, FLAG_DEFAULTS\.kaloyFab\)/);
  const readme = readFileSync(new URL("README.md", ROOT), "utf8");
  const row = readme.slice(readme.indexOf("## 7.")).split("\n").find((line) => line.includes("`NEXT_PUBLIC_KALOY_FAB`"));
  assert.ok(row, "README section 7 has a row for NEXT_PUBLIC_KALOY_FAB");
  assert.ok(row.includes("`false`"), "default false");
  assert.match(read(".env.example"), /^NEXT_PUBLIC_KALOY_FAB=false$/m);
});

test("KF2 the button: Ask Kaloy with his idle face, fixed bottom-right above the tab bar, logs from=fab", () => {
  const fab = read("src/components/KaloyFab.tsx");
  assert.match(fab, /<KaloySprite pose="idle"/);
  assert.match(fab, /\{KALOY_WORDS\.ask\}/);
  assert.match(fab, /fixed/);
  assert.match(fab, /right-4/);
  assert.match(fab, /bottom-\[calc\(5\.25rem\+env\(safe-area-inset-bottom\)\)\]/, "clear of the phones' tab bar");
  assert.match(fab, /md:bottom-6/, "no tab bar from md: the corner");
  assert.match(fab, /console\.info\("\[tg-trip\] chat open from=fab"\)/);
  assert.doesNotMatch(fab, /online|disabled/, "it stays offline: the chat itself says it needs signal");
});

test("KF3 the trip page: shown only with both flags, a chat for this plan, a plan on screen, and the chat closed", () => {
  const trip = read("src/components/TripView.tsx");
  assert.match(trip, /const fab = flags\.kaloy && flags\.kaloyFab && !!chatTools && !!shown;/);
  assert.match(trip, /\{fab && !chatting && <KaloyFab onOpen=\{\(\) => chatTools\?\.open\(null\)\} \/>\}/);
  assert.match(trip, /\{fab && <div aria-hidden="true" className="h-20" \/>\}/, "room at the page's end so it never covers Delete the trip");
  assert.doesNotMatch(trip, /fab[^\n]*editing/, "no need to tap Edit the plan first");
});

test("KF4 with the button on, the plain Ask Kaloy in each World goes; the place and stop ones stay", () => {
  const map = read("src/components/LevelMap.tsx");
  assert.match(map, /\{editor\.chat && !\(flags\.kaloy && flags\.kaloyFab\) && \(/);
  assert.match(map, /console\.info\("\[tg-trip\] chat open from=map"\)/, "flag off, the World button is today's");
  assert.doesNotMatch(read("src/components/PlaceInput.tsx"), /kaloyFab/);
  assert.doesNotMatch(read("src/components/StopChange.tsx"), /kaloyFab/);
});

test("KF5 every Kaloy sprite is saved for offline at install, in the data cache the sprite route reads (sad Kaloy offline)", async () => {
  const { KALOY_POSES, KALOY_WALK, kaloySprite } = await import("./kaloy.ts");
  const sw = read("public/sw.js");
  const list = sw.match(/const PRECACHE_SPRITES = (\[[^\]]*\]);/);
  assert.ok(list, "sw.js has PRECACHE_SPRITES");
  const sprites: string[] = JSON.parse(list[1]);
  for (const name of [...KALOY_POSES.map((p) => kaloySprite(p)), ...KALOY_WALK]) {
    const path = `/sprites/${name}.svg`;
    assert.ok(sprites.includes(path), path);
    assert.ok(existsSync(new URL(`public${path}`, WEB)), `${path} exists`);
  }
  assert.match(sw, /if \(url\.pathname\.startsWith\("\/sprites\/"\)\) return \{ strategy: "stale-while-revalidate", cache: "data" \};/);
  assert.match(sw, /const data = await caches\.open\(names\.data\);/);
  assert.match(sw, /PRECACHE_SPRITES\.map\(/);
  assert.match(sw, /precached pages=\$\{pageCount\} static=\$\{staticCount\} sprites=\$\{spriteCount\}/);
});
