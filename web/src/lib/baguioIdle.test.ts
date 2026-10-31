// TG-49 PR 2, item 4 (ux §3): the /baguio empty state. Source guards: the repo's tests run with no JSX.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { PNG_ART, SPRITES, type SpriteName } from "./sprites.ts";
const WEB = new URL("../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, WEB), "utf8");
const IDLE = "src/components/BaguioIdle.tsx"; const DATA = "src/lib/baguioIdle.ts"; const LM = "src/components/LastMile.tsx";
const has = (p: string) => { assert.ok(existsSync(new URL(p, WEB)), `${p} exists`); return read(p); };
type Row = { name: SpriteName; show: "all" | "md" | "min375" };
const data = async () => { has(DATA); return (await import("./baguioIdle.ts" as string)) as { BAGUIO_IDLE_ROW: readonly Row[]; BAGUIO_IDLE_SCENE_CLASS: string; BAGUIO_IDLE_COPY: { lead: string; line: string } }; };
const ROW: Row[] = [{ name: "place-terminal", show: "all" }, { name: "mode-jeep", show: "all" }, { name: "place-market", show: "md" }, { name: "mode-taxi", show: "all" }, { name: "place-cafe", show: "md" }, { name: "mode-walk", show: "all" }, { name: "place-viewpoint", show: "md" }, { name: "place-park", show: "all" }];
test("T49P2-E1 the box says exactly ux §3.3, as two plain paragraphs", async () => {
  const { BAGUIO_IDLE_COPY } = await data();
  assert.deepEqual(BAGUIO_IDLE_COPY, { lead: "Tara, pick your terminal above.", line: "We'll show the jeeps, taxis and walks from there to the top spots." });
  const s = has(IDLE);
  assert.match(s, /<PixelBox className="p-0 flex flex-col">/);
  assert.match(s, /<p className="text-base font-bold">\{BAGUIO_IDLE_COPY\.lead\}<\/p>/);
  assert.match(s, /<p className="text-sm text-muted md:max-w-prose">\{BAGUIO_IDLE_COPY\.line\}<\/p>/);
  assert.doesNotMatch(s, /<h[1-6]\b|aria-live|role=/);
});
test("T49P2-E2 only while nothing is picked; idle never comes back", () => {
  const s = read(LM);
  assert.match(s, /\{status === "idle" && <BaguioIdle \/>\}/);
  assert.equal(s.match(/<BaguioIdle\b/g)?.length, 1);
  assert.doesNotMatch(s, /setStatus\("idle"\)/);
});
test("T49P2-E3 idle asks for nothing", () => {
  for (const f of [IDLE, DATA]) assert.doesNotMatch(has(f), /\bfetch|@\/lib\/api|useEffect|useState|"use client"/, f);
  assert.doesNotMatch(has(DATA), /^\s*import\s+(?!type\b)/m, "plain data");
  const s = read(LM);
  assert.equal(s.match(/fetchLastMile\(/g)?.length, 1);
  assert.doesNotMatch(s, /useEffect/);
});
test("T49P2-E4 fieldset, box, live region; the live region is always rendered", () => {
  const s = read(LM);
  const [a, b, c] = ["</fieldset>", "<BaguioIdle", '<div aria-live="polite" className="flex flex-col gap-3">'].map((m) => s.indexOf(m));
  assert.ok(a >= 0 && a < b && b < c, `order ${a} ${b} ${c}`);
  assert.match(s.slice(b), /^<BaguioIdle \/>\}\s*<div aria-live="polite"/, "a sibling, not inside a condition");
});
test("T49P2-E5 the scene is decoration: hidden from assistive tech, inert, no focus stop", async () => {
  const { BAGUIO_IDLE_SCENE_CLASS } = await data();
  assert.equal(BAGUIO_IDLE_SCENE_CLASS, "pointer-events-none h-24 border-b-3 border-frame bg-screen pixelated flex items-end justify-center gap-2 pb-2 md:h-32 md:gap-4 lg:gap-6");
  const s = has(IDLE);
  assert.match(s, /aria-hidden="true"\s+className=\{BAGUIO_IDLE_SCENE_CLASS\}/);
  assert.match(s, /backgroundImage: `url\(\$\{spriteSrc\("tile-grass"\)\}\)`, backgroundSize: "32px"/);
  assert.doesNotMatch(s, /<a\b|<button\b|<input\b|Pixel(Button|Link|CardLink|Choice)|onClick|tabIndex/);
});
test("T49P2-E6 CSS-background spans through spriteSrc, in ux §3.2's order, with no image element or raw colour", async () => {
  const { BAGUIO_IDLE_ROW } = await data();
  assert.deepEqual(BAGUIO_IDLE_ROW, ROW);
  for (const { name } of BAGUIO_IDLE_ROW) assert.ok(Object.hasOwn(SPRITES, name) && PNG_ART.has(name), name);
  const s = has(IDLE);
  assert.doesNotMatch(s, /<img\b|\/sprites\/|#[0-9a-f]{3,8}\b|rgba?\(/i);
  assert.match(s, /backgroundImage: `url\(\$\{spriteSrc\(d\.name\)\}\)`, width: SPRITES\[d\.name\]\.w \* 2, height: SPRITES\[d\.name\]\.h \* 2/);
  assert.match(s, /SHOW_CLASS\[d\.show\]/);
});
test("T49P2-E7a width rules: only the sprites show or hide by width; TG44-P2 doesn't scan these files", () => {
  for (const f of [IDLE, DATA]) {
    const s = has(f);
    for (const [, c] of s.matchAll(/"([^"\n]*)"/g)) {
      assert.doesNotMatch(c, /(^|\s)hidden(\s|$)|(md|lg|xl):(hidden|block|sr-only|invisible)\b/, `${f}: ${c}`);
      assert.doesNotMatch(c, /(^|\s)(sm|2xl|max-[\w-]+|min-\[[^\]]*\]|portrait|landscape):/, `${f}: ${c}`);
      assert.doesNotMatch(c, /(^|[\s:])-?(order|col-start|col-end|row-start|row-end)-/, `${f}: ${c}`);
    }
  }
});
test("T49P2-E7b the row fits: ux §3.2's arithmetic, from SPRITES at 2x", async () => {
  const { BAGUIO_IDLE_ROW } = await data();
  const w = (n: SpriteName) => SPRITES[n].w * 2; const h = (n: SpriteName) => SPRITES[n].h * 2;
  const sum = (r: readonly Row[], gap: number) => r.reduce((a, d) => a + w(d.name), 0) + (r.length - 1) * gap;
  const phone = BAGUIO_IDLE_ROW.filter((d) => d.show === "all");
  assert.equal(phone.length, 5); assert.equal(BAGUIO_IDLE_ROW.length, 8);
  assert.equal(sum(phone, 8), 256); assert.ok(sum(phone, 8) <= 320 - 32 - 6);
  assert.equal(sum(BAGUIO_IDLE_ROW, 16), 480); assert.ok(480 <= 720 - 6);
  assert.equal(sum(BAGUIO_IDLE_ROW, 24), 536); assert.ok(536 <= 960 - 6);
  for (const d of BAGUIO_IDLE_ROW) assert.ok(h(d.name) <= 96 - 3 - 8, d.name);
});
test("T49P2-E12 no layout shift and no motion: fixed heights, sized spans, and T22's ban on the .ts file it skips", async () => {
  const { BAGUIO_IDLE_SCENE_CLASS } = await data();
  assert.match(BAGUIO_IDLE_SCENE_CLASS, /(^|\s)h-24(\s|$)/); assert.match(BAGUIO_IDLE_SCENE_CLASS, /(^|\s)md:h-32(\s|$)/);
  assert.doesNotMatch(BAGUIO_IDLE_SCENE_CLASS, /min-h-|h-auto/);
  assert.doesNotMatch(has(DATA), /transition|animate-|@keyframes|duration-|animation/);
});
test("T49P2-E13 the box carries no tone: W1 can't see an untracked file, so this doesn't depend on git", () => {
  assert.doesNotMatch(has(IDLE), /\btone=/);
});
