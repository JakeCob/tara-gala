// TG-49 placard: the "Tara Gala" logo as a jeepney route signboard (owner: "look like a jeepney placard").
// Run with `npm test` (node --test, type stripping).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const WEB = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB), "utf8");

test("PL1 the sign: a cream board, a thick Ink frame, an inner trim line and a hard shadow, fixed in both themes", () => {
  const css = read("src/app/globals.css");
  const board = css.match(/@utility placard \{([^}]*)\}/)?.[1] ?? "";
  assert.ok(board, "the placard utility");
  assert.match(board, /background: var\(--color-screen-paper\)/);
  assert.match(board, /border: 3px solid var\(--color-screen-ink\)/);
  assert.match(board, /inset 0 0 0 2px var\(--color-screen-paper\), inset 0 0 0 4px var\(--color-screen-ink\)/, "the trim line inside the frame");
  assert.match(board, /3px 3px 0 0 var\(--color-screen-ink\)/, "a hard shadow");
  const letters = css.match(/@utility placard-letters \{([^}]*)\}/)?.[1] ?? "";
  assert.match(letters, /color: var\(--color-flag-red\)/);
  assert.equal((letters.match(/var\(--color-screen-ink\)/g) ?? []).length, 9, "an 8-way Ink outline plus a drop shadow");
  for (const body of [board, letters]) {
    assert.doesNotMatch(body, /var\(--(background|foreground|card|frame|brand|lift)\)/, "no theme tokens: a painted sign doesn't change in dark mode");
  }
});

test("PL2 Placard: the route line is decor, hidden from screen readers; lg is a block that can hold the h1", () => {
  const src = read("src/components/pixel/Placard.tsx");
  assert.doesNotMatch(src, /use client/);
  assert.match(src, /const ROUTE = "Manila – Baguio";/);
  assert.equal((src.match(/<span aria-hidden="true" className=\{PX\.placardRoute(Lg)?\}>\s*\{ROUTE\}\s*<\/span>/g) ?? []).length, 2);
  assert.match(src, /<div className=\{PX\.placardLg\}>/, "an h1 can't sit in a span");
  assert.match(src, /<span className=\{PX\.placard\}>/, "the header's sign sits inside a link");
  assert.match(read("src/components/pixel/index.ts"), /export \{ Placard \} from "\.\/Placard";/);
});

test("PL3 the header logo and the title screen's h1 are both on the sign; the h1 keeps its name and id", () => {
  assert.match(
    read("src/components/SiteHeader.tsx"),
    /<Link href="\/" className=\{PX\.logo\}>\s*<Placard size="sm">\s*<span className=\{PX\.placardName\}>Tara Gala<\/span>\s*<\/Placard>\s*<\/Link>/,
  );
  assert.match(
    read("src/components/landing/TitleScreen.tsx"),
    /<Placard size="lg">\s*<PageTitle titleScreen id="landing-title">\s*Tara Gala\s*<\/PageTitle>\s*<\/Placard>/,
  );
});

test("PL4 the header's name stays on one line, and its link is still a 44px target", async () => {
  const { PX } = await import(new URL("src/components/pixel/classes.ts", WEB).href);
  assert.match(PX.placardName, /\bwhitespace-nowrap\b/);
  assert.match(PX.placardName, /\bplacard-letters\b/);
  assert.match(PX.logo, /\bmin-h-11\b/);
  assert.match(PX.logo, /\bfocus-pixel\b/);
  assert.match(PX.titleWordmark, /\bplacard-letters\b/);
});
