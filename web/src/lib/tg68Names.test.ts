// TG-68 part 6 (ux.md §6, audit #5, TG-67 N4): no Baguio defaults. The trip and wallet names start empty with a
// placeholder, and the pin example is city-neutral. The bottom tab, the home hero and the share text stay (after the trip).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planFailureMessage, tripProblem } from "./trip.ts";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8").replaceAll("&apos;", "'");
const PLACEHOLDER = 'placeholder="Like Sagada, Nov 25"';
const HINT = "In Google Maps, press and hold the spot, then copy the two numbers it shows.";
const ERROR = "Those numbers aren't a pin. Paste the two numbers Google Maps shows, with a comma between.";

test("TG68-M1 New trip: the name starts empty, with the placeholder in the muted colour; the label stays Trip name", () => {
  const src = read("src/components/TripHome.tsx");
  assert.match(src, /const \[name, setName\] = useState\(""\);/, "the name starts empty");
  assert.doesNotMatch(src, /useState\("Baguio trip"\)/, "no Baguio default");
  const input = src.slice(src.indexOf('<span className="font-semibold">Trip name</span>'), src.indexOf("/>", src.indexOf('<span className="font-semibold">Trip name</span>')));
  assert.ok(input.includes(PLACEHOLDER), "the placeholder");
  assert.match(input, /className=\{cx\(PX\.input, "placeholder:text-muted"\)\}|className=\{`\$\{PX\.input\} placeholder:text-muted`\}/, "muted");
  assert.match(input, /value=\{name\}/);
});

test("TG68-M2 New wallet: the same", () => {
  const src = read("src/components/WalletHome.tsx");
  assert.match(src, /const \[tripName, setTripName\] = useState\(""\);/, "the name starts empty");
  assert.doesNotMatch(src, /useState\("Baguio trip"\)/, "no Baguio default");
  const label = '<span className="font-semibold">{amb ? AMBAGAN_WORDS.nameLabel : "Trip name"}</span>'; // TG-72: flag off is today's label
  const input = src.slice(src.indexOf(label), src.indexOf("/>", src.indexOf(label)));
  assert.ok(src.includes(label), "the label");
  assert.ok(input.includes('placeholder={amb ? AMBAGAN_WORDS.namePlaceholder : "Like Sagada, Nov 25"}'), "the placeholder");
  assert.match(input, /className=\{cx\(PX\.input, "placeholder:text-muted"\)\}|className=\{`\$\{PX\.input\} placeholder:text-muted`\}/, "muted");
});

test("TG68-M3 an empty name gets today's refusal: tripProblem's, and WalletHome's own check", () => {
  assert.equal(tripProblem("", "2026-11-25", "2026-11-29"), "Give the trip a name.");
  assert.equal(tripProblem("   ", "2026-11-25", "2026-11-29"), "Give the trip a name.");
  assert.match(read("src/components/WalletHome.tsx"), /if \(!name\) return setError\(amb \? AMBAGAN_WORDS\.nameEmpty : "Give the trip a name\."\);/); // TG-72: flag off is today\'s
});

test("TG68-M4 the pin hint and the pin error are city-neutral, the same in all three places", () => {
  const input = read("src/components/PlaceInput.tsx");
  assert.ok(input.includes(`<span className={PX.meta}>${HINT}</span>`), "the hint under Pin");
  assert.ok(input.includes(`setPinProblem("${ERROR}")`), "the empty pin's error");
  assert.equal(planFailureMessage({ why: "rejected", detail: "bad_pin" }), ERROR, "the server's bad_pin");
  for (const p of ["src/components/PlaceInput.tsx", "src/lib/trip.ts"]) assert.doesNotMatch(read(p), /16\.4138/, `${p}: no Baguio pin`);
});
