// Picker UI guards (TG-15): sprite use and static checks on the components, read as text. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { CHIBI_FRAMES, SPRITES, chibi, spriteSrc, type SpriteName } from "./sprites.ts";
import { PICKER_TYPES } from "./party.ts";
import { UI } from "../components/planUi.ts";

const WEB = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB), "utf8");

const picker = read("src/components/PartyPicker.tsx");
const stage = read("src/components/PartyStage.tsx");
const useSpawn = read("src/components/useSpawn.ts");
const form = read("src/components/PlanForm.tsx");
const page = read("src/app/plan/page.tsx");
const home = read("src/app/page.tsx");
const planUi = read("src/components/planUi.ts");
const NEW_UI = {
  "PartyPicker.tsx": picker,
  "PartyStage.tsx": stage,
  "useSpawn.ts": useSpawn,
  "PlanForm.tsx": form,
  "plan/page.tsx": page,
  "planUi.ts": planUi,
};

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
  for (const b of tags(picker, "button")) assert.match(b, /\btype="button"/, b);
});

test("T15-G2 steppers are 44px icon buttons with hidden glyphs", () => {
  const buttons = tags(picker, "button");
  assert.equal(buttons.length, 2, "a − and a + per row, rendered from PICKER_TYPES");
  for (const b of buttons) {
    assert.match(b, /className=\{UI\.iconBtn\}/, `one swap point for TG-42's <PixelButton variant="icon">: ${b}`);
  }
  assert.match(UI.iconBtn, /\bmin-h-11\b/);
  assert.match(UI.iconBtn, /\bmin-w-11\b/);
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
  const h2 = picker.match(/<h2\b[^>]*\bid=\{([^}]+)\}[^>]*>\s*(\{"Who's travelling\?"\}|Who&apos;s travelling\?)\s*<\/h2>/);
  assert.ok(h2, "<h2 id={…}>Who's travelling?</h2>");
  assert.match(picker, new RegExp(`role="group" aria-labelledby=\\{${h2[1].replace(/[$()[\]{}.*+?^|\\]/g, "\\$&")}\\}`), "the list is named by the h2");
  assert.match(picker, /className=\{UI\.h2\}/);
  assert.match(picker, /className=\{UI\.box\}/);
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
  assert.match(stage, /isPickerType\([^)]*\)\s*\?\s*spriteSrc\(chibi\(/, "child and unknown types get a tag only (T15-SP5, audit N1)");
  assert.equal((stage.match(/spriteSrc\(chibi\(/g) ?? []).length, 1, "the only chibi src is the guarded one");
  assert.match(stage, /\{src && \(/, "the chibi img renders only with a src");
  assert.match(stage, /\$\{UI\.screenChip\}/);
});

test("T15-G6 stage grid and sizes", () => {
  assert.match(stage, /\bgrid-cols-5\b/);
  assert.match(stage, /fixedRows[^\n]*"grid-rows-\[repeat\(2,5\.5rem\)\]"/);
  assert.match(stage, /width=\{64\}\s+height=\{64\}/);
  assert.match(stage, /width=\{24\}\s+height=\{24\}/);
});

// T15-G7: the 1× chibi plate in each row
test("T15-G7 row chibi is 32px on a screen-paper plate", () => {
  assert.match(picker, /\$\{UI\.plate\}/);
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
  assert.match(page, /<h1 className=\{UI\.h1\}>Plan your trip<\/h1>/);
  assert.equal((page.match(/<h1\b/g) ?? []).length, 1);
  assert.ok(
    tags(page, "Link").some((t) => /href="\/"/.test(t) && /className=\{UI\.backLink\}/.test(t)),
    '<Link href="/" className={UI.backLink}>',
  );
  assert.match(page, /<span aria-hidden(="true")?>←(&nbsp;)?<\/span>\s*Back to bus search/);
  assert.match(page, /title:\s*"Plan your trip · Tara Gala"/);
  assert.match(page, /<PlanForm\s*\/>/);
  assert.doesNotMatch(home, /["'`]\/plan\b/, "TG-21 adds the link");
});

// Review finding 1 (TG-42 guard: font-pixel only inside components/pixel/) and the v2 bans. TG-42 PR A isn't on
// main, so per the manager the look lives in planUi.ts, one key per PR A primitive, until TG-42 swaps it.
test("T15-G10 new UI: no font-pixel, v1 shapes or hex; v2 look kept in planUi.ts", () => {
  for (const [file, src] of Object.entries(NEW_UI)) {
    assert.doesNotMatch(src, /font-pixel/, `${file}: TG-42's PageTitle / SectionTitle own the pixel font`);
    assert.doesNotMatch(src, /rounded-(?!none\b)|\bring-|shadow-lg|text-\[#|outline-none|outline-hidden/, file);
    assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b/, `${file}: no hex colours`);
  }
  for (const [file, src] of Object.entries({ "PartyPicker.tsx": picker, "PartyStage.tsx": stage, "plan/page.tsx": page })) {
    assert.doesNotMatch(src, /\bborder-\d|\bbg-card\b|\bshadow-\[/, `${file}: frames and fills come from planUi.ts`);
  }
});

test("T15-G11 planUi.ts is a plain module of class strings with pixel focus", () => {
  assert.doesNotMatch(planUi, /^\s*import\b/m);
  assert.doesNotMatch(planUi, /use client|<\/[A-Za-z]|\/>/);
  for (const key of ["iconBtn", "backLink"] as const) {
    assert.match(UI[key], /focus-visible:outline-3/, key);
    assert.match(UI[key], /\bmin-h-11\b/, key);
  }
  assert.match(UI.iconBtn, /aria-disabled:opacity-60/, "dimmed at the limit, like pixel-btn");
  assert.match(UI.pixelated, /image-rendering:pixelated/);
});

// T15-X2 (N3): no animation library
test("T15-X2 no animation or motion package", () => {
  const pkg = JSON.parse(read("package.json"));
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  for (const n of names) {
    assert.doesNotMatch(n, /motion|gsap|spring|lottie|anime|animate|tailwind-merge/, n);
  }
});
