// Party state tests (TG-15): the pure picker module. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_PARTY,
  DISCOUNT_NOTE,
  MAX_PARTY,
  PICKER_TYPES,
  TYPE_HINT,
  TYPE_LABEL,
  add,
  addLabel,
  canAdd,
  canRemove,
  counts,
  isPickerType,
  partySummary,
  remove,
  removeLabel,
  type Party,
} from "./party.ts";
import { PASSENGER_TYPES, type PassengerType } from "./sprites.ts";

const source = readFileSync(new URL("./party.ts", import.meta.url), "utf8");

function freeze(p: { type: string }[]): Party {
  for (const x of p) Object.freeze(x);
  return Object.freeze(p) as Party;
}

function party(...types: PassengerType[]): Party {
  return freeze(types.map((type) => ({ type })));
}

function fill(n: number, type: PassengerType = "adult"): Party {
  return party(...Array<PassengerType>(n).fill(type));
}

// Deterministic PRNG for T15-P9
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// T15-P1 (B1)
test("T15-P1 default party is one adult and can't be emptied", () => {
  assert.deepEqual(DEFAULT_PARTY, [{ type: "adult" }]);
  assert.equal(canAdd(DEFAULT_PARTY), true);
  assert.equal(canRemove(DEFAULT_PARTY, "adult"), false);
});

// T15-P2 (B2)
test("T15-P2 add appends in order and returns a new array", () => {
  const start = freeze([{ type: "adult" }]);
  const one = add(start, "senior");
  const two = add(freeze([...one]), "student");
  assert.notEqual(one, start);
  assert.notEqual(two, one);
  assert.deepEqual(start, [{ type: "adult" }], "input unchanged");
  assert.deepEqual(one, [{ type: "adult" }, { type: "senior" }]);
  assert.deepEqual(two, [{ type: "adult" }, { type: "senior" }, { type: "student" }]);
});

// T15-P3 (B2, B4)
test("T15-P3 add stops at MAX_PARTY and returns the same array", () => {
  const p9 = fill(9);
  assert.equal(canAdd(p9), true);
  const p10 = freeze([...add(p9, "pwd")]);
  assert.equal(p10.length, 10);
  assert.equal(canAdd(p10), false);
  for (const t of PICKER_TYPES) assert.equal(add(p10, t), p10, `add ${t} at 10`);
});

// T15-P4
test("T15-P4 there is no per-type limit", () => {
  let p: Party = DEFAULT_PARTY;
  p = remove(add(p, "senior"), "adult");
  for (let i = 0; i < 9; i++) p = add(freeze([...p]), "senior");
  assert.equal(p.length, 10);
  assert.equal(counts(p).senior, 10);
});

// T15-P5 (B3)
test("T15-P5 remove takes the last-added passenger of that type", () => {
  const input = party("adult", "senior", "adult", "senior", "pwd");
  const out = remove(input, "senior");
  assert.notEqual(out, input);
  assert.deepEqual(out, [{ type: "adult" }, { type: "senior" }, { type: "adult" }, { type: "pwd" }]);
  assert.equal(out[1], input[1], "the first senior is the one kept");
});

// T15-P6 (B3)
test("T15-P6 remove with a zero count returns the same array", () => {
  const input = party("adult", "adult");
  assert.equal(canRemove(input, "pwd"), false);
  assert.equal(remove(input, "pwd"), input);
});

// T15-P7 (B3)
test("T15-P7 remove never empties the party", () => {
  const input = party("senior");
  assert.equal(canRemove(input, "senior"), false);
  assert.equal(remove(input, "senior"), input);
});

// T15-P8 (B4)
test("T15-P8 counts always has the 4 picker keys and ignores other types", () => {
  assert.deepEqual(counts(DEFAULT_PARTY), { adult: 1, student: 0, senior: 0, pwd: 0 });
  const saved = freeze([{ type: "adult" }, { type: "child" }, { type: "<b>x</b>" }, { type: "pwd" }]);
  const c = counts(saved);
  assert.deepEqual(Object.keys(c).sort(), ["adult", "pwd", "senior", "student"]);
  assert.deepEqual(c, { adult: 1, student: 0, senior: 0, pwd: 1 });
});

// T15-P9 (B2 to B4)
test("T15-P9 invariants hold over 2,000 seeded random add/remove sequences", () => {
  const rand = mulberry32(15);
  for (let run = 0; run < 2000; run++) {
    let p: Party = DEFAULT_PARTY;
    const model = [...p];
    const ops = 1 + Math.floor(rand() * 30);
    for (let i = 0; i < ops; i++) {
      const t = PICKER_TYPES[Math.floor(rand() * PICKER_TYPES.length)];
      const isAdd = rand() < 0.55;
      const before = freeze([...p]);
      const allowed = isAdd ? canAdd(before) : canRemove(before, t);
      const next = isAdd ? add(before, t) : remove(before, t);
      assert.equal(next === before, !allowed, `run ${run} op ${i}: same ref iff the predicate is false`);
      if (allowed && isAdd) model.push(next[next.length - 1]);
      if (allowed && !isAdd) model.splice(model.map((x) => x.type).lastIndexOf(t), 1);
      assert.equal(next.length, model.length);
      next.forEach((x, j) => assert.equal(x, model[j], `run ${run} op ${i}: survivors keep add order`));
      assert.ok(next.length >= 1 && next.length <= MAX_PARTY);
      const c = counts(next);
      assert.equal(c.adult + c.student + c.senior + c.pwd, next.length);
      assert.ok(next.every((x) => PICKER_TYPES.includes(x.type)));
      p = next;
    }
  }
});

// T15-P10 (B6)
test("T15-P10 the emitted shape is [{type}] with no name", () => {
  const p = add(DEFAULT_PARTY, "senior");
  assert.equal(JSON.stringify(p), '[{"type":"adult"},{"type":"senior"}]');
  for (const x of p) {
    assert.deepEqual(Object.keys(x), ["type"]);
    assert.ok(Object.values(x).every((v) => v !== undefined));
  }
});

// T15-P11 (N1)
test("T15-P11 MAX_PARTY and PICKER_TYPES match TG-20 and TG-33", () => {
  assert.equal(MAX_PARTY, 10);
  assert.deepEqual(PICKER_TYPES, ["adult", "student", "senior", "pwd"]);
  assert.deepEqual([...PICKER_TYPES], [...PASSENGER_TYPES]);
});

// T15-P12 (B6): the @ts-expect-error below is checked by `npx tsc --noEmit`
test("T15-P12 Passenger has only a type, and child is not a picker type", () => {
  assert.match(source, /export type Passenger\s*=\s*\{\s*(readonly\s+)?type:\s*PassengerType;?\s*\}/);
  // @ts-expect-error child is not a PassengerType in the picker
  const withChild = () => add(DEFAULT_PARTY, "child");
  assert.equal(typeof withChild, "function");
});

// T15-P13
test("T15-P13 party.ts is pure: no clock, randomness or module state", () => {
  const p = party("adult", "senior", "pwd");
  assert.deepEqual(add(p, "student"), add(p, "student"));
  assert.equal(partySummary(p), partySummary(p));
  assert.doesNotMatch(source, /\bDate\b/);
  assert.doesNotMatch(source, /Math\.random/);
  assert.doesNotMatch(source, /^(let|var)\s/m);
});

// T15-P14
test("T15-P14 removing from a full mixed party allows adding again", () => {
  const p10 = party("adult", "pwd", "senior", "student", "adult", "senior", "pwd", "student", "adult", "senior");
  assert.equal(canAdd(p10), false);
  const p9 = remove(p10, "student");
  assert.equal(p9.length, 9);
  assert.equal(canAdd(p9), true);
});

// T15-S1..S8 (B5, ux §4)
test("T15-S1 mixed party summary", () => {
  assert.equal(partySummary(party("adult", "adult", "senior")), "Party of 3: 2 adults, 1 senior.");
});

test("T15-S2 default party summary", () => {
  assert.equal(partySummary(DEFAULT_PARTY), "Party of 1: 1 adult.");
});

test("T15-S3 singular and plural for each type; PWD has no plural s", () => {
  const cases: [PassengerType, string, string][] = [
    ["adult", "1 adult", "2 adults"],
    ["student", "1 student", "2 students"],
    ["senior", "1 senior", "2 seniors"],
    ["pwd", "1 PWD", "2 PWD"],
  ];
  for (const [t, one, two] of cases) {
    assert.equal(partySummary(party(t)), `Party of 1: ${one}.`);
    assert.equal(partySummary(party(t, t)), `Party of 2: ${two}.`);
  }
});

test("T15-S4 parts follow adult, student, senior, PWD whatever the add order", () => {
  assert.equal(
    partySummary(party("pwd", "senior", "student", "adult")),
    "Party of 4: 1 adult, 1 student, 1 senior, 1 PWD.",
  );
});

test("T15-S5 zero counts are skipped", () => {
  assert.equal(partySummary(party("pwd", "pwd")), "Party of 2: 2 PWD.");
});

test("T15-S6 the full sentence appears at 10 only", () => {
  assert.equal(partySummary(fill(10)), "Party of 10: 10 adults. Party is full (10 max).");
  assert.equal(partySummary(fill(9)), "Party of 9: 9 adults.");
});

test("T15-S7 saved data with child or unknown types never prints the raw type", () => {
  assert.equal(partySummary([{ type: "adult" }, { type: "child" }, { type: "child" }]), "Party of 3: 1 adult, 2 children.");
  assert.equal(partySummary([{ type: "child" }]), "Party of 1: 1 child.");
  assert.equal(partySummary([{ type: "<b>x</b>" }]), "Party of 1: 1 other.");
  assert.equal(partySummary([{ type: "x" }, { type: "y" }]), "Party of 2: 2 others.");
  assert.equal(
    partySummary([{ type: "zz" }, { type: "child" }, { type: "pwd" }, { type: "adult" }]),
    "Party of 4: 1 adult, 1 PWD, 1 child, 1 other.",
  );
});

test("T15-S8 an empty party has a pinned summary (Q3)", () => {
  assert.equal(partySummary([]), "No passengers.");
});

// T15-L1..L5 (ux §4)
test("T15-L1 type labels", () => {
  assert.deepEqual(TYPE_LABEL, { adult: "Adult", student: "Student", senior: "Senior", pwd: "PWD" });
});

test("T15-L2 type hints", () => {
  assert.deepEqual(TYPE_HINT, {
    adult: "Regular fare",
    student: "With school ID",
    senior: "With senior citizen ID",
    pwd: "With PWD ID",
  });
});

test("T15-L3 stepper aria-labels", () => {
  assert.deepEqual(PICKER_TYPES.map(addLabel), ["Add an adult", "Add a student", "Add a senior", "Add a PWD passenger"]);
  assert.deepEqual(PICKER_TYPES.map(removeLabel), [
    "Remove an adult",
    "Remove a student",
    "Remove a senior",
    "Remove a PWD passenger",
  ]);
});

test("T15-L4 discount note is exact", () => {
  assert.equal(
    DISCOUNT_NOTE,
    "Student, senior and PWD fares need a valid ID at the terminal. Some operators don't give these discounts on online bookings.",
  );
});

test("T15-L5 copy invents no fares, ages or operator rules", () => {
  assert.ok(DISCOUNT_NOTE.length > 0);
  assert.equal(Object.keys(TYPE_HINT).length, 4);
  for (const text of [DISCOUNT_NOTE, ...Object.values(TYPE_HINT)]) {
    assert.doesNotMatch(text, /[0-9%₱]/, text);
    assert.doesNotMatch(text, /Victory|Genesis|Solid North|Joy/i, text);
    assert.doesNotMatch(text, /\b(age|aged|years?|old)\b/i, text);
  }
});

// T15-SP5: types without a sprite get a tag only
test("T15-SP5 only picker types get a chibi; child and unknown types don't", () => {
  for (const t of ["adult", "student", "senior", "pwd"]) assert.equal(isPickerType(t), true, t);
  for (const t of ["child", "", "Adult", "<b>x</b>", "constructor", "toString"]) {
    assert.equal(isPickerType(t), false, JSON.stringify(t));
  }
});

// T15-K4
test("T15-K4 party.ts never writes a name key", () => {
  assert.doesNotMatch(source, /\bname\s*[:?]/);
});

// T15-X1
test("T15-X1 party.ts is a plain module", () => {
  for (const line of source.match(/^\s*import\b.*$/gm) ?? []) {
    assert.match(line, /^import type \{[^}]*\} from "\.\/sprites\.ts";$/, `only a type import from sprites: ${line}`);
  }
  assert.doesNotMatch(source, /\bimport\s*\(/);
  assert.doesNotMatch(source, /@\//);
  assert.doesNotMatch(source, /<\/[A-Za-z]|\/>/);
  assert.doesNotMatch(source, /use client/);
  assert.doesNotMatch(source, /\benum\s/);
  assert.doesNotMatch(source, /\bnamespace\s/);
});
