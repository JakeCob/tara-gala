// TG-49 placard: the "Tara Gala" logo as a jeepney route sign (owner: "look like a jeepney placard", then "remove the
// manila - baguio" and look like the painted black signs in data/img). Run with `npm test` (node --test, type stripping).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const WEB = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB), "utf8");

test("PL1 the sign: a black board, the name one word per line, lime over red, fixed in both themes", () => {
  const css = read("src/app/globals.css");
  assert.match(css, /--color-sign-board: #000000; --color-sign-lime: #afff00; --color-sign-red: #fc354c;/);
  const board = css.match(/@utility placard \{([^}]*)\}/)?.[1] ?? "";
  assert.match(board, /background: var\(--color-sign-board\)/);
  assert.doesNotMatch(board, /border:|box-shadow/, "a flat painted board: no frame, trim or shadow");
  const letters = css.match(/@utility placard-letters \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(letters, /width: min-content/, "each word on its own line");
  assert.match(letters, /color: var\(--color-sign-red\)/);
  assert.match(letters, /&::first-line \{ color: var\(--color-sign-lime\); \}/);
  assert.doesNotMatch(letters, /text-shadow/, "flat letters, no outline");
  for (const body of [board, letters]) {
    assert.doesNotMatch(body, /var\(--(background|foreground|card|frame|brand|lift)\)/, "no theme tokens: a painted sign doesn't change in dark mode");
  }
});

test("PL2 Placard: no route line; lg is a block that can hold the h1", () => {
  const src = read("src/components/pixel/Placard.tsx");
  assert.doesNotMatch(src, /use client/);
  assert.doesNotMatch(src, /Manila|Baguio|ROUTE/, "the owner removed the route line");
  assert.match(src, /<div className=\{PX\.placardLg\}>\{children\}<\/div>/, "an h1 can't sit in a span");
  assert.match(src, /<span className=\{PX\.placard\}>\{children\}<\/span>/, "the header's sign sits inside a link");
  assert.match(read("src/components/pixel/index.ts"), /export \{ Placard \} from "\.\/Placard";/);
});

test("PL3 the header logo and the title screen's h1 are both on the sign; the name stays one plain 'Tara Gala'", () => {
  assert.match(
    read("src/components/SiteHeader.tsx"),
    /<Link href="\/" className=\{PX\.logo\}>\s*<Placard size="sm">\s*<span className=\{PX\.placardName\}>Tara Gala<\/span>\s*<\/Placard>\s*<\/Link>/,
  );
  assert.match(
    read("src/components/landing/TitleScreen.tsx"),
    /<Placard size="lg">\s*<PageTitle titleScreen id="landing-title">\s*Tara Gala\s*<\/PageTitle>\s*<\/Placard>/,
  );
});

test("PL4 both names wear the sign's letters in Cubao's tall cut, and the header link is still a 44px target", async () => {
  const { PX } = await import(new URL("src/components/pixel/classes.ts", WEB).href);
  for (const name of [PX.placardName, PX.titleWordmark]) {
    assert.match(name, /\bplacard-letters\b/);
    assert.match(name, /\bfont-pixel\b/);
    assert.doesNotMatch(name, /\bwhitespace-nowrap\b/, "the name must break between the words");
  }
  assert.match(PX.logo, /\bmin-h-11\b/);
  assert.match(PX.logo, /\bfocus-pixel\b/);
});
