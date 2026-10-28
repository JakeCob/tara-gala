// Picker UI guards (TG-15): sprite use and static checks on the components, read as text. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { CHIBI_FRAMES, SPRITES, chibi, spriteSrc, type SpriteName } from "./sprites.ts";
import { PICKER_TYPES } from "./party.ts";
import { PX } from "../components/pixel/classes.ts";

const WEB = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB), "utf8");

const picker = read("src/components/PartyPicker.tsx");
const stage = read("src/components/PartyStage.tsx");
const useSpawn = read("src/components/useSpawn.ts");
const form = read("src/components/PlanForm.tsx");
const page = read("src/app/plan/page.tsx");
const home = read("src/app/page.tsx");
const NEW_UI = { "PartyPicker.tsx": picker, "PartyStage.tsx": stage, "useSpawn.ts": useSpawn, "PlanForm.tsx": form, "plan/page.tsx": page };

// Opening tags of a JSX element, attributes included; skips `>` inside {…} and quotes (e.g. `onClick={() => …}`)
function tags(src: string, name: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(new RegExp(`<${name}\\b`, "g"))) {
    let depth = 0;
    let quote = "";
    for (let i = m.index + 1; i < src.length; i++) {
      const ch = src[i];
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'" || ch === "`") {
        if (depth > 0 || ch === '"') quote = ch;
      } else if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) {
        out.push(src.slice(m.index, i + 1));
        break;
      }
    }
  }
  return out;
}

// T15-SP1..SP4 (TG-33 manifest)
test("T15-SP1 every picker chibi frame is in the sprite manifest", () => {
  const names = PICKER_TYPES.flatMap((t) => CHIBI_FRAMES.map((f) => chibi(t, f)));
  assert.equal(names.length, 12);
  for (const n of names) assert.ok(n in SPRITES, n);
});

test("T15-SP2 tile-grass and ui-star are in the manifest", () => {
  assert.ok("tile-grass" in SPRITES);
  assert.ok("ui-star" in SPRITES);
});

test("T15-SP3 every sprite the picker uses exists on disk", () => {
  const names: SpriteName[] = [...PICKER_TYPES.flatMap((t) => CHIBI_FRAMES.map((f) => chibi(t, f))), "tile-grass", "ui-star"];
  for (const n of names) assert.ok(existsSync(new URL(`public${spriteSrc(n)}`, WEB)), spriteSrc(n));
});

test("T15-SP4 picker sizes are whole multiples of the art", () => {
  for (const t of PICKER_TYPES) {
    for (const f of CHIBI_FRAMES) {
      const { w, h } = SPRITES[chibi(t, f)];
      assert.ok(64 % w === 0 && 64 % h === 0 && 64 / w === 64 / h, `stage 64px over ${chibi(t, f)} ${w}x${h}`);
      assert.ok(32 % w === 0 && 32 / w === 32 / h, `plate 32px over ${chibi(t, f)} ${w}x${h}`);
    }
  }
  const star = SPRITES["ui-star"];
  assert.ok(24 % star.w === 0 && 24 / star.w === 24 / star.h, `star 24px over ${star.w}x${star.h}`);
  const grass = SPRITES["tile-grass"];
  assert.ok(32 % grass.w === 0 && 32 / grass.w === 32 / grass.h, `grass 32px over ${grass.w}x${grass.h}`);
});

// T15-G1..G4: PartyPicker steppers, summary and copy
test("T15-G1 steppers: label helpers, aria-disabled, never disabled", () => {
  assert.match(picker, /addLabel\(/);
  assert.match(picker, /removeLabel\(/);
  assert.doesNotMatch(picker, /"(Add|Remove) (a|an) /, "labels come from party.ts");
  assert.match(picker, /aria-disabled=\{[^}]*canAdd\(/);
  assert.match(picker, /aria-disabled=\{[^}]*canRemove\(/);
  assert.doesNotMatch(picker, /(?<![-\w])disabled\s*[={]/, "a real disabled drops focus at the limit");
  assert.doesNotMatch(picker, /<button\b/, "steppers are PixelButton (TG-42 primitives)");
});

test("T15-G2 steppers are 44px icon buttons with hidden glyphs", () => {
  const buttons = tags(picker, "PixelButton");
  assert.ok(buttons.length >= 2, "a − and a + PixelButton");
  for (const b of buttons) {
    assert.match(b, /variant="icon"/, b);
    assert.doesNotMatch(b, /\bclassName=/, `the icon skin and layout stay as TG-42 made them: ${b}`);
    assert.doesNotMatch(b, /\btype="(submit|reset)"/, b);
  }
  assert.match(PX.btn.icon.skin, /\bmin-h-11\b/);
  assert.match(PX.btn.icon.skin, /\bmin-w-11\b/);
  assert.match(picker, /<span[^>]*aria-hidden[^>]*>\s*(−|\{"−"\})\s*<\/span>/, "− is U+2212, hidden");
  assert.match(picker, /<span[^>]*aria-hidden[^>]*>\s*(\+|\{"\+"\})\s*<\/span>/, "+ hidden");
});

test("T15-G3 a disabled stepper does nothing", () => {
  assert.match(picker, /if \(!canAdd\([^)]*\)\)[^;]*return/);
  assert.match(picker, /if \(!canRemove\([^)]*\)\)[^;]*return/);
});

test("T15-G4 live summary, groups, heading and discount note", () => {
  assert.match(picker, /<p\b[^>]*aria-live="polite"[^>]*>\s*\{[^}]*partySummary\(/);
  assert.doesNotMatch(picker, /<output\b/);
  assert.ok((picker.match(/role="group"/g) ?? []).length >= 2, "the list and each row are groups");
  for (const g of tags(picker, "\\w+").filter((x) => x.includes('role="group"'))) {
    assert.match(g, /aria-labelledby=/, g);
  }
  assert.match(picker, /<SectionTitle\b[^>]*>\s*(\{"Who's travelling\?"\}|Who&apos;s travelling\?)\s*<\/SectionTitle>/);
  assert.match(picker, /<PixelBox\b/);
  assert.match(picker, /\bDISCOUNT_NOTE\b/);
  assert.doesNotMatch(picker, /Some operators don/, "the note comes from party.ts");
});

// T15-G5, G6: PartyStage
test("T15-G5 stage is decorative and gets sprites only from the manifest", () => {
  const at = stage.search(/return\s*\(\s*</);
  const root = at < 0 ? "" : (tags(stage.slice(at), "\\w+")[0] ?? "");
  assert.match(root, /aria-hidden="true"/, `stage root: ${root}`);
  const imgs = tags(stage, "img");
  assert.ok(imgs.length >= 2, "a chibi img and a star img");
  for (const img of imgs) {
    assert.match(img, /alt=""/, img);
    assert.match(img, /pixelated/, img);
  }
  assert.match(stage, /spriteSrc\(chibi\(/);
  assert.match(stage, /spriteSrc\("tile-grass"\)/);
  assert.match(stage, /spriteSrc\("ui-star"\)/);
  assert.doesNotMatch(stage, /\/sprites\//);
  assert.match(stage, /\bisPickerType\(/, "child and unknown types get a tag only (T15-SP5)");
  assert.match(stage, /\bbg-screen\b/);
  assert.match(stage, /bg-screen-paper text-screen-ink|PX\.screenChip/);
});

test("T15-G6 stage grid and sizes", () => {
  assert.match(stage, /\bgrid-cols-5\b/);
  assert.match(stage, /fixedRows[^\n]*"grid-rows-\[repeat\(2,5\.5rem\)\]"/);
  assert.match(stage, /width=\{64\}\s+height=\{64\}/);
  assert.match(stage, /width=\{24\}\s+height=\{24\}/);
});

// T15-G7: the 1× chibi plate in each row
test("T15-G7 row chibi is 32px on a screen-paper plate", () => {
  assert.match(picker, /bg-screen-paper/);
  const img = tags(picker, "img");
  assert.ok(img.length >= 1);
  for (const i of img) {
    assert.match(i, /alt=""/, i);
    assert.match(i, /width=\{32\}\s+height=\{32\}/, i);
  }
  assert.match(picker, /spriteSrc\(chibi\([^)]*"idle-1"\)\)/);
});

// T15-G8: motion
test("T15-G8 useSpawn wraps createSpawner; frame swaps only; skip on capture", () => {
  assert.match(useSpawn, /^"use client";/);
  assert.match(useSpawn, /\bcreateSpawner\(/);
  assert.match(useSpawn, /useEffect\([\s\S]*?return\s*\(\)\s*=>[^\n]*\.dispose\(\)/, "dispose in the effect cleanup");
  assert.match(useSpawn, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
  for (const [file, src] of Object.entries(NEW_UI)) {
    assert.doesNotMatch(src, /\btransition\b|\banimate-|requestAnimationFrame|@keyframes/, file);
  }
  assert.match(form, /onPointerDownCapture=\{[^}]*skip/);
  assert.match(form, /onKeyDownCapture=\{[^}]*skip/);
  assert.match(form, /onAdd=/);
  assert.equal((form.match(/\.start\(/g) ?? []).length, 1, "start only from the add path");
  assert.doesNotMatch(form, /useEffect\(/, "no spawn on first paint");
});

// T15-G9: page and form wiring
test("T15-G9 PlanForm owns the party; /plan page shell; not linked from home", () => {
  assert.match(form, /^"use client";/);
  assert.match(form, /useState(<[^>]+>)?\(DEFAULT_PARTY\)/);
  assert.ok(tags(form, "PartyStage").some((t) => /\bparty=\{party\}/.test(t)), "<PartyStage party={party}>");
  assert.ok(tags(form, "PartyPicker").some((t) => /\bparty=\{party\}/.test(t)), "<PartyPicker party={party}>");
  assert.doesNotMatch(page, /use client/);
  assert.match(page, /<PageTitle>Plan your trip<\/PageTitle>/);
  assert.ok(
    tags(page, "PixelLink").some((t) => /variant="secondary"/.test(t) && /href="\/"/.test(t)),
    '<PixelLink variant="secondary" href="/">',
  );
  assert.match(page, /<span aria-hidden(="true")?>←(&nbsp;)?<\/span>\s*Back to bus search/);
  assert.match(page, /title:\s*"Plan your trip · Tara Gala"/);
  assert.match(page, /<PlanForm\s*\/>/);
  assert.doesNotMatch(home, /["'`]\/plan\b/, "TG-21 adds the link");
});

// Review finding 1: TG-42 guard (font-pixel only inside components/pixel/) and the v2 bans
test("T15-G10 new UI builds on TG-42 primitives: no font-pixel or v1 shapes", () => {
  for (const [file, src] of Object.entries(NEW_UI)) {
    assert.doesNotMatch(src, /font-pixel/, `${file}: use PageTitle / SectionTitle`);
    assert.doesNotMatch(src, /rounded-(?!none\b)|\bring-|shadow-lg|text-\[#|outline-none|outline-hidden/, file);
  }
  assert.match(page + picker, /from "@\/components\/pixel"/);
});

// T15-X2 (N3): no animation library
test("T15-X2 no animation or motion package", () => {
  const pkg = JSON.parse(read("package.json"));
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  for (const n of names) {
    assert.doesNotMatch(n, /motion|gsap|spring|lottie|anime|animate|tailwind-merge/, n);
  }
});
