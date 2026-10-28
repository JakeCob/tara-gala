// Party contract tests (TG-15): the picker's types and size limit against the API, loader and schema.
// The expected values are literals here; party.test.ts T15-P11 pins PICKER_TYPES and MAX_PARTY to the same literals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const ROOT = new URL("../../../", import.meta.url);
const PICKER = ["adult", "student", "senior", "pwd"];
const MAX = 10;

function passengerModel(py: string, file: string) {
  const cls = py.match(/class Passenger\([^)]*\):([\s\S]*?)(?=\nclass |\n\S)/)?.[1];
  assert.ok(cls, `${file}: class Passenger`);
  const literal = cls.match(/type:\s*Literal\[([^\]]+)\]/)?.[1];
  assert.ok(literal, `${file}: Passenger.type Literal`);
  return { cls, types: [...literal.matchAll(/"([^"]+)"/g)].map((m) => m[1]) };
}

function partyField(py: string, file: string) {
  const field = py.match(/party:\s*list\[Passenger\]\s*=\s*Field\(([^)]*)\)/)?.[1];
  assert.ok(field, `${file}: party: list[Passenger] = Field(...)`);
  return {
    min: Number(field.match(/min_length=(\d+)/)?.[1]),
    max: Number(field.match(/max_length=(\d+)/)?.[1]),
  };
}

// T15-K1: skips only while TG-20 isn't on main (allowed at RED, not at Gate 3; see test-plan Q2)
test("T15-K1 TG-20 planner accepts every picker type and the same party size", (t) => {
  const file = new URL("api/app/planner.py", ROOT);
  if (!existsSync(file)) return t.skip("TG-20 not merged: api/app/planner.py is missing");
  const py = readFileSync(file, "utf8");
  const { cls, types } = passengerModel(py, "planner.py");
  for (const type of PICKER) assert.ok(types.includes(type), `planner.py Passenger.type has ${type}`);
  assert.match(cls, /name:[^\n]*=\s*Field\(None\b/, "name stays optional, so [{type}] is valid");
  assert.deepEqual(partyField(py, "planner.py"), { min: 1, max: MAX });
});

// T15-K2
test("T15-K2 pre-made itinerary loader accepts every picker type and a party this big", () => {
  const py = readFileSync(new URL("data/load_premade.py", ROOT), "utf8");
  const { types } = passengerModel(py, "load_premade.py");
  for (const type of PICKER) assert.ok(types.includes(type), `load_premade.py Passenger.type has ${type}`);
  assert.ok(partyField(py, "load_premade.py").max >= MAX);
});

// T15-K3
test("T15-K3 schema passenger_type enum has every picker type", () => {
  const sql = readFileSync(new URL("supabase/schema.sql", ROOT), "utf8");
  const values = sql.match(/create type passenger_type as enum \(([^)]+)\)/)?.[1];
  assert.ok(values, "passenger_type enum");
  const types = [...values.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const type of PICKER) assert.ok(types.includes(type), `passenger_type has ${type}`);
});
