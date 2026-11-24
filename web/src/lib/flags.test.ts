// Feature flag tests (TG-35). Run with `npm test` (node --test, Node 22.18+ type stripping).
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FLAG_DEFAULTS, parseFlag, readFlags, type Flags } from "./flags.ts";

const ENV_KEYS: Record<keyof Flags, string> = {
  plannerLive: "NEXT_PUBLIC_PLANNER_LIVE",
  premadeItineraries: "NEXT_PUBLIC_PREMADE_ITINERARIES",
  realMap: "NEXT_PUBLIC_REAL_MAP",
  serviceWorker: "NEXT_PUBLIC_SERVICE_WORKER",
  overworldMap: "NEXT_PUBLIC_OVERWORLD_MAP",
  planEditing: "NEXT_PUBLIC_PLAN_EDITING",
  walletSplits: "NEXT_PUBLIC_WALLET_SPLITS",
  walletMultiPayer: "NEXT_PUBLIC_WALLET_MULTI_PAYER",
  walletActivity: "NEXT_PUBLIC_WALLET_ACTIVITY",
  chatbotLive: "NEXT_PUBLIC_CHATBOT_LIVE",
  budgetLines: "NEXT_PUBLIC_BUDGET_LINES",
  recapLinks: "NEXT_PUBLIC_RECAP_LINKS",
  offlineExpenses: "NEXT_PUBLIC_OFFLINE_EXPENSES",
  nextUp: "NEXT_PUBLIC_NEXT_UP",
  aroundTab: "NEXT_PUBLIC_AROUND_TAB",
  ambaganTab: "NEXT_PUBLIC_AMBAGAN_TAB",
  goingTo: "NEXT_PUBLIC_GOING_TO",
  kaloy: "NEXT_PUBLIC_KALOY",
  chatGameUi: "NEXT_PUBLIC_CHAT_GAME_UI",
  kaloyFab: "NEXT_PUBLIC_KALOY_FAB",
  kaloyFabHome: "NEXT_PUBLIC_KALOY_FAB_HOME",
  chatAllCities: "NEXT_PUBLIC_CHAT_ALL_CITIES",
  langPicker: "NEXT_PUBLIC_LANG_PICKER",
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
  assert.deepEqual(FLAG_DEFAULTS, { plannerLive: false, premadeItineraries: true, realMap: false, serviceWorker: true, overworldMap: true, planEditing: false, walletSplits: false, walletMultiPayer: false, walletActivity: false, chatbotLive: false, budgetLines: false, recapLinks: false, offlineExpenses: false, nextUp: false, aroundTab: false, ambaganTab: false, goingTo: false, kaloy: false, chatGameUi: false, chatAllCities: false, kaloyFab: false, kaloyFabHome: false, langPicker: false });
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

test("the service worker kill switch is documented (TG-27)", () => {
  // Web-only flag, so api/tests/test_flags.py doesn't cover it
  const root = new URL("../../../", import.meta.url);
  const readme = readFileSync(new URL("README.md", root), "utf8");
  const section = readme.slice(readme.indexOf("## 7."));
  const row = section.split("\n").find((line) => line.includes("`NEXT_PUBLIC_SERVICE_WORKER`"));
  assert.ok(row, "README section 7 has a row for NEXT_PUBLIC_SERVICE_WORKER");
  assert.ok(row.includes("`true`"), "default true");
  const webEnv = readFileSync(new URL("web/.env.example", root), "utf8");
  assert.match(webEnv, /^NEXT_PUBLIC_SERVICE_WORKER=true$/m);
});

test("the overworld map kill switch is documented (TG-22)", () => {
  // Web-only flag: false shows TG-23's list on /i/[slug] instead of the map
  const root = new URL("../../../", import.meta.url);
  const readme = readFileSync(new URL("README.md", root), "utf8");
  const section = readme.slice(readme.indexOf("## 7."));
  const row = section.split("\n").find((line) => line.includes("`NEXT_PUBLIC_OVERWORLD_MAP`"));
  assert.ok(row, "README section 7 has a row for NEXT_PUBLIC_OVERWORLD_MAP");
  assert.ok(row.includes("`true`"), "default true");
  const webEnv = readFileSync(new URL("web/.env.example", root), "utf8");
  assert.match(webEnv, /^NEXT_PUBLIC_OVERWORLD_MAP=true$/m);
});

test("flags.ts is a plain module", () => {
  assert.doesNotMatch(source, /^\s*import\b/m);
  assert.doesNotMatch(source, /\bimport\s*\(/);
  assert.doesNotMatch(source, /use client/);
  assert.doesNotMatch(source, /\benum\s/);
  assert.doesNotMatch(source, /\bnamespace\s/);
});

test("T70-L13 NEXT_PUBLIC_OFFLINE_EXPENSES: default off, documented in README section 7 and both .env.example files", () => {
  clearFlagEnv();
  assert.equal(readFlags().offlineExpenses, false);
  setEnv("NEXT_PUBLIC_OFFLINE_EXPENSES", "true");
  assert.equal(readFlags().offlineExpenses, true);
  const root = new URL("../../../", import.meta.url);
  const readme = readFileSync(new URL("README.md", root), "utf8");
  const section = readme.slice(readme.indexOf("## 7."));
  const row = section.split("\n").find((line) => line.includes("`NEXT_PUBLIC_OFFLINE_EXPENSES`"));
  assert.ok(row, "README section 7 has a row for NEXT_PUBLIC_OFFLINE_EXPENSES");
  assert.ok(row.includes("`false`"), "default false");
  assert.ok(row.includes("WALLET_SPLITS"), "it needs the split modes on");
  for (const env of ["web/.env.example", ".env.example"]) {
    assert.match(readFileSync(new URL(env, root), "utf8"), /^NEXT_PUBLIC_OFFLINE_EXPENSES=false$/m, env);
  }
});

test("T75-G1 NEXT_PUBLIC_CHAT_GAME_UI: default off, documented in README section 7 (needs Kaloy) and web/.env.example", () => {
  clearFlagEnv();
  assert.equal(readFlags().chatGameUi, false);
  setEnv("NEXT_PUBLIC_CHAT_GAME_UI", "true");
  assert.equal(readFlags().chatGameUi, true);
  const root = new URL("../../../", import.meta.url);
  const readme = readFileSync(new URL("README.md", root), "utf8");
  const section = readme.slice(readme.indexOf("## 7."));
  const row = section.split("\n").find((line) => line.includes("`NEXT_PUBLIC_CHAT_GAME_UI`"));
  assert.ok(row, "README section 7 has a row for NEXT_PUBLIC_CHAT_GAME_UI");
  assert.ok(row.includes("`false`"), "default false");
  assert.ok(row.includes("NEXT_PUBLIC_KALOY"), "it needs Kaloy on");
  assert.match(readFileSync(new URL("web/.env.example", root), "utf8"), /^NEXT_PUBLIC_CHAT_GAME_UI=false$/m);
});
