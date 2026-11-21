// TG-68 part 2 (ux.md §2, TG-67 N3): a distance that rounds to 0 km reads "under 1 km", never "about 0 km". One helper.
// `import *`: before kmFrom exists, a named import would stop the whole file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as lines from "./planLines.ts";

const L = lines as typeof lines & { kmFrom?: (km: number, city?: string) => string; atStart?: (s: string) => string };
const kmFrom = (km: number, city?: string) => {
  assert.equal(typeof L.kmFrom, "function", "planLines exports kmFrom");
  return L.kmFrom!(km, city);
};
const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("TG68-K1 kmFrom: under 0.5 km is `under 1 km from <city>`; from 0.5 it's `about N km`, rounded", () => {
  assert.equal(kmFrom(0, "Sagada"), "under 1 km from Sagada");
  assert.equal(kmFrom(0.3, "Sagada"), "under 1 km from Sagada");
  assert.equal(kmFrom(0.49, "Baguio"), "under 1 km from Baguio");
  assert.equal(kmFrom(0.5, "Sagada"), "about 1 km from Sagada");
  assert.equal(kmFrom(2.6, "Sagada"), "about 3 km from Sagada");
  assert.equal(kmFrom(3, "Baguio"), "about 3 km from Baguio");
  assert.equal(kmFrom(0.2), "under 1 km from Baguio", "a missing city is Baguio, like the other lines");
});

test("TG68-K2 pinLine: a pin under 0.5 km reads under 1 km, pasted or from a link, Sagada or Baguio", () => {
  const pin = (pin_source: "typed" | "link", km: number, city?: string) => lines.pinLine({ pin_source, lat: 17.08, lng: 120.9, km_from_baguio: km }, city)?.lead;
  assert.equal(pin("typed", 0.3, "Sagada"), "Pin you pasted, under 1 km from Sagada.");
  assert.equal(pin("link", 0.1, "Sagada"), "Pinned from your link, under 1 km from Sagada.");
  assert.equal(pin("typed", 0.4), "Pin you pasted, under 1 km from Baguio.");
  assert.equal(pin("typed", 3, "Sagada"), "Pin you pasted, about 3 km from Sagada.", "1 km and up as today");
  assert.equal(pin("link", 3), "Pinned from your link, about 3 km from Baguio.");
});

test("TG68-K3 PlaceInput's two lines use kmFrom (the sentence-start one capitalised); no km is rounded by hand there", () => {
  const src = read("src/components/PlaceInput.tsx");
  assert.equal(src.match(/kmFrom\(s\.km_from_baguio, editor\.city\)/g)?.length, 2, "both lines");
  assert.doesNotMatch(src, /Math\.round\(s\.km_from_baguio\)/, "no hand-rounded km");
  assert.doesNotMatch(src, /About \$\{|about \$\{/, "no hand-written about");
  assert.match(src, /`, \$\{kmFrom\(s\.km_from_baguio, editor\.city\)\}`/, "mid-sentence: lower case");
  assert.match(src, /atStart\(kmFrom\(s\.km_from_baguio, editor\.city\)\)/, "sentence start: capitalised");
  assert.equal(L.atStart?.("under 1 km from Sagada"), "Under 1 km from Sagada");
  assert.equal(L.atStart?.("about 3 km from Sagada"), "About 3 km from Sagada");
});
