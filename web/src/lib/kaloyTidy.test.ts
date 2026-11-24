// TG-75 NEXT_PUBLIC_KALOY_TIDY (owner, 2026-11-24 overnight): Kaloy's how-to example names the plan's own city (a
// Sagada plan said "add merienda after Burnham Park"), and his replies read times as the trip card does (he wrote
// "22:30" where the card says 10:30 PM). Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { FIRST_MESSAGE } from "./chat.ts";
import { FLAG_DEFAULTS, readFlags } from "./flags.ts";
import { KALOY_WORDS, clock12, firstMessageFor, kaloyHowTo } from "./kaloy.ts";

const WEB = new URL("../../", import.meta.url);
const ROOT = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB), "utf8");

test("KT1 NEXT_PUBLIC_KALOY_TIDY: default off, documented in README section 7 and web/.env.example", () => {
  assert.equal(FLAG_DEFAULTS.kaloyTidy, false);
  const before = process.env.NEXT_PUBLIC_KALOY_TIDY;
  try {
    process.env.NEXT_PUBLIC_KALOY_TIDY = "true";
    assert.equal(readFlags().kaloyTidy, true);
  } finally {
    if (before === undefined) delete process.env.NEXT_PUBLIC_KALOY_TIDY;
    else process.env.NEXT_PUBLIC_KALOY_TIDY = before;
  }
  const readme = readFileSync(new URL("README.md", ROOT), "utf8");
  assert.ok(readme.split("\n").some((l) => l.includes("`NEXT_PUBLIC_KALOY_TIDY`") && l.includes("`false`")));
  assert.match(read(".env.example"), /^NEXT_PUBLIC_KALOY_TIDY=false$/m);
});

test("KT2 the how-to names the plan's city: Baguio's as today, Sagada's Echo Valley, any other city no place", () => {
  assert.equal(kaloyHowTo("Baguio"), KALOY_WORDS.howTo);
  assert.equal(firstMessageFor("Baguio", FIRST_MESSAGE), FIRST_MESSAGE);
  const sagada = kaloyHowTo("Sagada");
  assert.match(sagada, /"add lemon pie after Echo Valley"/);
  assert.doesNotMatch(sagada, /Burnham/);
  assert.match(firstMessageFor("Sagada", FIRST_MESSAGE), /^Kumusta! .*"add lemon pie after Echo Valley"/);
  assert.doesNotMatch(kaloyHowTo("Vigan"), /Burnham|Echo Valley/);
  assert.match(kaloyHowTo("Vigan"), /"add merienda on Day 1" or "mas chill ang Day 2"/);
});

test("KT3 Sagada's example places are Sagada spots rows", () => {
  const spots = readFileSync(new URL("data/spots.csv", ROOT), "utf8").split("\n");
  for (const name of ["Echo Valley", "Sagada Lemon Pie House"]) {
    assert.ok(spots.some((l) => l.includes(`,${name},`) && l.trim().endsWith("Sagada")), name);
  }
});

test("KT4 clock12 reads 24-hour times as the trip card does, and leaves the rest alone", () => {
  assert.equal(clock12("Coda Lines leaves at 22:30."), "Coda Lines leaves at 10:30 PM.");
  assert.equal(clock12("Echo Valley 08:00-10:00, lunch 12:00, back by 00:15"), "Echo Valley 8:00 AM-10:00 AM, lunch 12:00 PM, back by 12:15 AM");
  assert.equal(clock12("Sunrise at 5:30 then 13:05"), "Sunrise at 5:30 AM then 1:05 PM");
  assert.equal(clock12("the 10:30 PM bus, 9:00 am start, 7:15AM"), "the 10:30 PM bus, 9:00 am start, 7:15AM", "already 12-hour");
  assert.equal(clock12("12:30:00 and 1.22:30 and 24:00 and 9:5"), "12:30:00 and 1.22:30 and 24:00 and 9:5", "not a clock time");
  assert.equal(clock12("Day 2: mas chill"), "Day 2: mas chill");
  assert.equal(clock12(""), "");
});

test("KT5 the chat uses them only with the flag: new replies and change lines, the how-to in both chat looks", () => {
  const chat = read("src/components/PlanChat.tsx");
  assert.match(chat, /const tidy = flags\.kaloyTidy;/);
  assert.match(chat, /const times = \(text: string\) => \(tidy \? clock12\(text\) : text\);/);
  assert.match(chat, /text: times\(out\.reply\),/);
  assert.match(chat, /changes: tidy \? out\.proposal\.changes\.map\(\(c\) => \(\{ \.\.\.c, text: clock12\(c\.text\), \.\.\.\(c\.why \? \{ why: clock12\(c\.why\) \} : \{\}\) \}\)\) : out\.proposal\.changes/);
  assert.match(chat, /<KaloyChat dialogRef=\{dialog\} endRef=\{end\} fieldId=\{fieldId\} howTo=\{howTo\}/);
  assert.match(read("src/components/KaloyChat.tsx"), /\{p\.howTo\}/);
  assert.match(read("src/components/TripView.tsx"), /\? \{\n {4}slug,\n {4}city,\n/);
  assert.ok(existsSync(new URL("src/components/PlanEditor.ts", WEB)));
  assert.match(read("src/components/PlanEditor.ts"), /\n {2}city: string;\n/);
});
