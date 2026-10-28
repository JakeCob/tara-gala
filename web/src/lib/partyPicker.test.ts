// Picker UI guards (TG-15): sprite use and static checks on the components, read as text. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
const NEW_UI = {
  "PartyPicker.tsx": picker,
  "PartyStage.tsx": stage,
  "useSpawn.ts": useSpawn,
  "PlanForm.tsx": form,
  "plan/page.tsx": page,
};

function walk(dir: URL, out: URL[] = []): URL[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const u = new URL(e.name + (e.isDirectory() ? "/" : ""), dir);
    if (e.isDirectory()) walk(u, out);
    else out.push(u);
  }
  return out;
}

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
  assert.doesNotMatch(picker, /<button\b/, "steppers are PixelButton (TG-43 A2)");
  for (const b of tags(picker, "PixelButton")) assert.doesNotMatch(b, /\btype="(submit|reset)"/, b);
});

test("T15-G2 steppers are 44px icon buttons with hidden glyphs", () => {
  const buttons = tags(picker, "PixelButton");
  assert.equal(buttons.length, 2, "a − and a + per row, rendered from PICKER_TYPES");
  for (const b of buttons) {
    assert.match(b, /\bvariant="icon"/, b);
    assert.doesNotMatch(b, /\bclassName=/, `the icon skin and layout stay as TG-42 made them: ${b}`);
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
  // The whole id template, not up to the first } (TG-15 Gate 3 S1)
  const title = picker.match(/<SectionTitle\b[^>]*\bid=\{(`[^`]*`|[\w.]+)\}[^>]*>\s*(\{"Who's travelling\?"\}|Who&apos;s travelling\?)\s*<\/SectionTitle>/);
  assert.ok(title, "<SectionTitle id={…}>Who's travelling?</SectionTitle>");
  const list = tags(picker, "ul").find((t) => /role="group"/.test(t)) ?? "";
  assert.ok(list.includes(`aria-labelledby={${title[1]}}`), `the list is named by the heading: ${list}`);
  assert.match(picker, /<PixelBox\b[^>]*\bas="section"/);
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
  assert.match(stage, /\bPX\.screenTag\b/);
  assert.match(root, /pixel-frame bg-screen\b/, "the stage is the fixed game screen (guide 1.3)");
  assert.doesNotMatch(stage, /\bUI\./);
});

test("T15-G6 stage grid and sizes", () => {
  assert.match(stage, /\bgrid-cols-5\b/);
  assert.match(stage, /fixedRows[^\n]*"grid-rows-\[repeat\(2,5\.5rem\)\]"/);
  assert.match(stage, /width=\{64\}\s+height=\{64\}/);
  assert.match(stage, /width=\{24\}\s+height=\{24\}/);
});

// T15-G7: the 1× chibi plate in each row
test("T15-G7 row chibi is 32px on a screen-paper plate", () => {
  assert.match(picker, /<span className=\{PX\.plate\}>\s*(\{\/\*[^*]*\*\/\}\s*)?<img\b/, "the img sits in a PX.plate span");
  const img = tags(picker, "img");
  assert.ok(img.length >= 1);
  for (const i of img) {
    assert.match(i, /alt=""/, i);
    assert.match(i, /width=\{32\}\s+height=\{32\}/, i);
    assert.match(i, /className="pixelated block"/, i);
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
test("T15-G9 PlanForm owns the party; /plan page shell; home link gated", () => {
  assert.match(form, /^"use client";/);
  assert.match(form, /useState(<[^>]+>)?\(DEFAULT_PARTY\)/);
  assert.ok(tags(form, "PartyStage").some((t) => /\bparty=\{party\}/.test(t)), "<PartyStage party={party}>");
  assert.ok(tags(form, "PartyPicker").some((t) => /\bparty=\{party\}/.test(t)), "<PartyPicker party={party}>");
  assert.doesNotMatch(page, /use client/);
  assert.match(page, /<PageTitle>Plan your trip<\/PageTitle>/);
  assert.doesNotMatch(page, /<h1\b/, "PageTitle is the h1");
  assert.ok(
    tags(page, "PixelLink").some((t) => /href="\/"/.test(t) && /variant="secondary"/.test(t)),
    '<PixelLink variant="secondary" href="/">',
  );
  assert.ok(tags(form, "PartyStage").some((t) => /\bfixedRows\b/.test(t)), "the picker's stage keeps its fixed rows (TG-15 Gate 3 S2)");
  assert.match(page, /<span aria-hidden(="true")?>←(&nbsp;)?<\/span>\s*Back to bus search/);
  assert.match(page, /title:\s*"Plan your trip · Tara Gala"/);
  assert.match(page, /<PlanForm\s*\/>/);
  // TG-21 adds the home link, shown only when a planner mode is on (T21-S5)
  assert.match(home, /formMode\(flags\) !== "none"/, "the /plan link is gated");
});

// TG-43 A2 (ux §0, §4): /plan is on @/components/pixel. No planUi, no hand-written skins, and the v2 bans stay.
const PLAN_FILES = {
  ...NEW_UI,
  "PlanFields.tsx": read("src/components/PlanFields.tsx"),
  "PlanResults.tsx": read("src/components/PlanResults.tsx"),
};

test("T15-G10 /plan builds on @/components/pixel: no planUi, no hand-written skins, no font-pixel or v1 shapes", () => {
  for (const [file, src] of Object.entries(PLAN_FILES)) {
    assert.doesNotMatch(src, /planUi/, `${file}: planUi is gone from /plan`);
    assert.doesNotMatch(src, /font-pixel/, `${file}: PageTitle / SectionTitle own the pixel font`);
    assert.doesNotMatch(src, /\bpixel-btn\b|\bpixel-box\b|border-3 border-frame/, `${file}: skins come from the primitives or PX`);
    assert.doesNotMatch(src, /rounded-(?!none\b)|\bring-|shadow-lg|text-\[#|outline-none|outline-hidden/, file);
    assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b/, `${file}: no hex colours`);
  }
  for (const file of ["PartyPicker.tsx", "plan/page.tsx", "PlanForm.tsx", "PlanFields.tsx", "PlanResults.tsx"] as const) {
    assert.match(PLAN_FILES[file], /from "@\/components\/pixel"/, `${file} imports the primitives`);
  }
});

// Replaces G11: until PR B, only the two share-page files TG-22 rewrites may still import planUi
test("T43-P5 planUi's only importers are ItineraryView and ItineraryList", () => {
  const importers = walk(new URL("src/", WEB))
    .filter((u) => /\.tsx?$/.test(u.pathname) && !u.pathname.endsWith(".test.ts"))
    .filter((u) => /from "@\/components\/planUi"|from "\.\/planUi"/.test(readFileSync(u, "utf8")))
    .map((u) => u.pathname.split("/").pop())
    .sort();
  assert.deepEqual(importers, ["ItineraryList.tsx", "ItineraryView.tsx"]);
});

// T43-P6 (A2 RED audit): G10's old frames-and-fills ban stays (plan G10) and covers every A2 file; the share page
// header and the Share button are primitives too
test("T43-P6 A2 files hand-write no frame, fill or press shadow; the share header and Share button are primitives", () => {
  const files: Record<string, string> = {
    ...PLAN_FILES,
    "i/[slug]/page.tsx": read("src/app/i/[slug]/page.tsx"),
    "ShareButton.tsx": read("src/components/ShareButton.tsx"),
  };
  for (const [file, src] of Object.entries(files)) {
    assert.doesNotMatch(src, /\bborder-[1-9]|\bbg-card\b|\bbg-stone-|\bshadow-\[|\boutline-solid\b/, `${file}: frames and fills come from PX or a primitive`);
  }
  const share = files["i/[slug]/page.tsx"];
  assert.match(share, /<PageTitle>Your trip<\/PageTitle>/);
  assert.doesNotMatch(share, /<h1\b/, "PageTitle is the h1");
  assert.ok(
    tags(share, "PixelLink").some((t) => /href="\/"/.test(t) && /variant="secondary"/.test(t)),
    '<PixelLink variant="secondary" href="/">',
  );
  const button = files["ShareButton.tsx"];
  assert.doesNotMatch(button, /<button\b/);
  assert.ok(tags(button, "PixelButton").some((t) => /variant="primary"/.test(t)), '<PixelButton variant="primary">');
  assert.match(button, /\bPX\.input\b/, "the manual copy field is PX.input");
});

// T15-X2 (N3): no animation library
test("T15-X2 no animation or motion package", () => {
  const pkg = JSON.parse(read("package.json"));
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  for (const n of names) {
    assert.doesNotMatch(n, /motion|gsap|spring|lottie|anime|animate|tailwind-merge/, n);
  }
});
