// Feature flag tests (TG-35). Run with `npm test` (node --test, Node 22.18+ type stripping).
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FLAG_DEFAULTS, parseFlag, readFlags, type Flags } from "./flags.ts";

const ENV_KEYS: Record<keyof Flags, string> = {
  plannerLive: "NEXT_PUBLIC_PLANNER_LIVE",
  premadeItineraries: "NEXT_PUBLIC_PREMADE_ITINERARIES",
  realMap: "NEXT_PUBLIC_REAL_MAP",
};

// [raw, fallback, expected]. Keep identical to CASES in api/tests/test_flags.py.
const CASES: [string | undefined, boolean, boolean][] = [
  [undefined, false, false],
  [undefined, true, true],
  ["", true, true],
  ["   ", false, false],
  ["1", false, true],
  ["true", false, true],
  [" TRUE ", false, true],
  ["yes", false, true],
  ["On", false, true],
  ["0", true, false],
  ["false", true, false],
  ["No", true, false],
  [" off ", true, false],
  ["ture", false, false],
  ["maybe", true, true],
  ["2", false, false],
  ["-1", true, true],
  ["truee", true, true],
];

const original = Object.fromEntries(Object.values(ENV_KEYS).map((k) => [k, process.env[k]]));

// Assigning undefined to process.env stores the string "undefined", so delete instead.
function setEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function clearFlagEnv() {
  for (const name of Object.values(ENV_KEYS)) setEnv(name, undefined);
}

afterEach(() => {
  for (const [name, value] of Object.entries(original)) setEnv(name, value);
});

test("defaults when unset", () => {
  clearFlagEnv();
  assert.deepEqual(FLAG_DEFAULTS, { plannerLive: false, premadeItineraries: true, realMap: false });
  assert.deepEqual(readFlags(), FLAG_DEFAULTS);
});

test("each flag can be overridden", () => {
  for (const key of Object.keys(ENV_KEYS) as (keyof Flags)[]) {
    clearFlagEnv();
    const opposite = !FLAG_DEFAULTS[key];
    setEnv(ENV_KEYS[key], String(opposite));
    assert.deepEqual(readFlags(), { ...FLAG_DEFAULTS, [key]: opposite }, String(key));
  }
});

test("parseFlag cases", () => {
  for (const [raw, fallback, expected] of CASES) {
    assert.equal(parseFlag(raw, fallback), expected, `parseFlag(${JSON.stringify(raw)}, ${fallback})`);
  }
});

test("garbage falls back silently", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const error = t.mock.method(console, "error", () => {});
  clearFlagEnv();
  setEnv("NEXT_PUBLIC_REAL_MAP", "maybe");
  assert.equal(readFlags().realMap, false);
  assert.equal(warn.mock.callCount(), 0);
  assert.equal(error.mock.callCount(), 0);
});

const source = readFileSync(new URL("./flags.ts", import.meta.url), "utf8");

test("reads each flag with a literal process.env access", () => {
  // Next inlines NEXT_PUBLIC_* only for literal member access; anything dynamic is undefined in the browser.
  for (const name of Object.values(ENV_KEYS)) {
    assert.ok(source.includes(`process.env.${name}`), name);
  }
  assert.doesNotMatch(source, /process\.env\s*\[/);
  assert.doesNotMatch(source, /=\s*process\.env\s*[;,)]/);
  assert.doesNotMatch(source, /\}\s*=\s*process\.env\b/);
});

test("flags.ts is a plain module", () => {
  assert.doesNotMatch(source, /^\s*import\b/m);
  assert.doesNotMatch(source, /\bimport\s*\(/);
  assert.doesNotMatch(source, /use client/);
  assert.doesNotMatch(source, /\benum\s/);
  assert.doesNotMatch(source, /\bnamespace\s/);
});
