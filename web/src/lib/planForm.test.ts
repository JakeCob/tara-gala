// Planner form tests (TG-21): dates, budget, vibe, payload, errors, pre-made list, reducers, copy and source guards.
// Run with `npm test`. Itinerary data below is made up for tests only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  BUDGET_MAX,
  BUDGET_MIN,
  DEADLINE_MESSAGE,
  FIELD_INPUT_ID,
  FIELD_ORDER,
  MAX_CHIPS,
  NOTE_MAX,
  NOTE_OK,
  PLAN_COPY,
  PLAN_ERROR_CODES,
  VIBE_CHIPS,
  VIBE_MAX,
  addDays,
  buildPlanRequest,
  buildVibe,
  chipLocked,
  daysBetween,
  dateBounds,
  formMode,
  formValues,
  formatBudget,
  initialDates,
  initialForm,
  initialRun,
  lengthHint,
  matchesDates,
  parseBudget,
  planErrorView,
  planFormReducer,
  planRunReducer,
  premadeCountLine,
  premadeMeta,
  premadePlaces,
  shiftReturn,
  showPremadeAction,
  sortPremade,
  statusShown,
  statusText,
  toggleChip,
  validatePlanForm,
  type FormValues,
} from "./planForm.ts";
import { dateRange, formatPeso, premadeCard } from "./premadeView.ts";
import { formatTravelDate } from "./direction.ts";
import { DEFAULT_PARTY, MAX_PARTY, PICKER_TYPES, add, type Party, type Passenger } from "./party.ts";
import type { PremadeSummary } from "./api.ts";

const WEB = new URL("../../", import.meta.url);
const ROOT = new URL("../", WEB);
const read = (path: string) => readFileSync(new URL(path, WEB), "utf8");
const readIf = (path: string) => (existsSync(new URL(path, WEB)) ? read(path) : "");
const PLANNER_PY = new URL("api/app/planner.py", ROOT);
const PREMADE_PY = new URL("api/app/premade.py", ROOT);

const TODAY = "2026-11-06";
const PLAN_DATE_MSG = "Trips can be up to 7 days. Pick a return date by Thu, Nov 12.";
const MSG = {
  date: "Pick a travel date.",
  datePast: "Pick a travel date from today onwards.",
  dateFar: "Pick a travel date within the next year.",
  ret: "Pick a return date.",
  retBefore: "Pick a return date on or after your travel date.",
  budget: "Enter a budget from ₱500 to ₱200,000, or leave it empty.",
  vibe: "Pick a vibe, or write a short note.",
  note: "Use letters, numbers and simple punctuation (, . ' & ! ? -).",
};
const GENERIC = "Something went wrong while planning. Try again, or pick a ready-made trip.";

function values(over: Partial<FormValues> = {}): FormValues {
  return { date: TODAY, returnDate: "2026-11-08", budget: "", chips: ["Food trip"], note: "", ...over };
}

function summary(slug: string, trip_date: string, return_date: string | null, over: Partial<PremadeSummary> = {}): PremadeSummary {
  return {
    share_slug: slug,
    vibe: "Food trip",
    trip_date,
    return_date,
    budget_php: 6000,
    day_count: 3,
    stop_count: 5,
    spot_names: ["Burnham Park", "Good Shepherd", "Mines View Park"],
    ...over,
  };
}

const deepFreeze = <T>(x: T): T => {
  if (x && typeof x === "object") {
    Object.values(x).forEach(deepFreeze);
    Object.freeze(x);
  }
  return x;
};

// Opening JSX tags with attributes; skips `>` inside {…} and double quotes (same scanner as TG-15's guards)
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

// --- Dates (B1 to B3, B6) ---------------------------------------------------------------------------------------

test("T21-D1 addDays and daysBetween work on date strings across year end, leap day and DST", () => {
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addDays("2026-11-08", -2), "2026-11-06");
  assert.equal(daysBetween("2026-11-06", "2026-11-08"), 2);
  assert.equal(daysBetween("2026-10-30", "2026-11-02"), 3);
  assert.equal(daysBetween("2026-11-08", "2026-11-06"), -2);
  // US DST ends on 2026-11-01, right on the trip dates; the same in every device time zone
  const code = `import("${new URL("./planForm.ts", import.meta.url).href}").then(m => console.log(JSON.stringify(
    [m.addDays("2026-10-31", 2), m.daysBetween("2026-10-31", "2026-11-02"), m.initialDates("2026-10-31"), m.lengthHint("2026-10-31", "2026-11-02")])))`;
  const outputs = ["America/Los_Angeles", "Pacific/Kiritimati", "Asia/Manila"].map((TZ) => {
    const r = spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "-e", code], {
      env: { ...process.env, TZ },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, `${TZ}: ${r.stderr}`);
    return r.stdout.trim();
  });
  assert.equal(outputs[0], JSON.stringify(["2026-11-02", 2, { date: "2026-10-31", returnDate: "2026-11-02" }, "3 days in Baguio"]));
  assert.deepEqual(new Set(outputs).size, 1, `identical in every TZ: ${outputs.join(" | ")}`);
});

test("T21-D2 initialDates defaults to a weekend trip; empty today gives empty strings", () => {
  assert.deepEqual(initialDates(TODAY), { date: TODAY, returnDate: "2026-11-08" });
  assert.deepEqual(initialDates(""), { date: "", returnDate: "" });
});

test("T21-D3 dateBounds: travel today..+365, return travel..+6, undefined for a bad travel date", () => {
  assert.deepEqual(dateBounds(TODAY, "2026-11-10"), {
    dateMin: TODAY,
    dateMax: "2027-11-06",
    returnMin: "2026-11-10",
    returnMax: "2026-11-16",
  });
  for (const bad of ["", "2026-13-01", "2026-02-30", "11/06/2026"]) {
    const b = dateBounds(TODAY, bad);
    assert.equal(b.returnMin, undefined, bad);
    assert.equal(b.returnMax, undefined, bad);
  }
  const ssr = dateBounds("", "");
  assert.equal(ssr.dateMin, undefined);
  assert.equal(ssr.dateMax, undefined);
});

test("T21-D4 shiftReturn keeps the trip length (0 to 6) and never snaps on an empty date", () => {
  assert.equal(shiftReturn("2026-11-06", "2026-11-08", "2026-11-10"), "2026-11-12");
  assert.equal(shiftReturn("2026-11-06", "2026-11-15", "2026-11-10"), "2026-11-16", "9 days clamps to 6");
  assert.equal(shiftReturn("2026-11-06", "2026-11-04", "2026-11-10"), "2026-11-10", "a negative length clamps to 0");
  assert.equal(shiftReturn("2026-11-06", "2026-11-08", ""), "2026-11-08");
  assert.equal(shiftReturn("", "2026-11-08", "2026-11-10"), "2026-11-08");
  assert.equal(shiftReturn("2026-11-06", "", "2026-11-10"), "");
  assert.equal(shiftReturn("2026-11-06", "2026-11-08", "2026-13-40"), "2026-11-08");
});

test("T21-D5 lengthHint", () => {
  assert.equal(lengthHint("2026-11-06", "2026-11-06"), "Day trip");
  assert.equal(lengthHint("2026-11-06", "2026-11-07"), "2 days in Baguio");
  assert.equal(lengthHint("2026-11-06", "2026-11-08"), "3 days in Baguio");
  assert.equal(lengthHint("2026-11-06", "2026-11-12"), "7 days in Baguio");
  assert.equal(lengthHint("2026-11-06", "2026-11-05"), null);
  assert.equal(lengthHint("", "2026-11-08"), null);
  assert.equal(lengthHint("2026-11-06", "x"), null);
});

test("T21-D6 date validation rows (live mode)", () => {
  const v = (date: string, returnDate: string) =>
    validatePlanForm(values({ date, returnDate }), TODAY, formatTravelDate, "live").map((e) => e.message);
  assert.deepEqual(v("", "2026-11-08"), [MSG.date]);
  assert.deepEqual(v("2026-11-05", "2026-11-08"), [MSG.datePast]);
  assert.deepEqual(v("2027-11-07", "2027-11-08"), [MSG.dateFar]);
  assert.deepEqual(v("2027-11-06", "2027-11-08"), [], "+365 is inclusive, as on the server");
  assert.deepEqual(v(TODAY, ""), [MSG.ret]);
  assert.deepEqual(v(TODAY, "2026-11-05"), [MSG.retBefore]);
  assert.deepEqual(v(TODAY, TODAY), [], "same-day return passes");
  assert.deepEqual(v(TODAY, "2026-11-13"), [PLAN_DATE_MSG]);
  assert.deepEqual(v(TODAY, "2026-11-12"), [], "+6 passes");
});

test("T21-D7 every error comes in page order and maps to an element id", () => {
  const errors = validatePlanForm(
    values({ date: "", returnDate: "", budget: "6k", chips: [], note: "" }),
    TODAY,
    formatTravelDate,
    "live",
  );
  assert.deepEqual(errors.map((e) => e.field), ["date", "returnDate", "budget", "vibe"]);
  const withNote = validatePlanForm(values({ date: "", budget: "6k", note: "<b>" }), TODAY, formatTravelDate, "live");
  assert.deepEqual(withNote.map((e) => e.field), ["date", "budget", "note"]);
  assert.deepEqual(FIELD_ORDER, ["date", "returnDate", "budget", "vibe", "note"]);
  for (const f of FIELD_ORDER) assert.match(FIELD_INPUT_ID[f], /^plan-[a-z0-9-]+$/, f);
  assert.equal(new Set(Object.values(FIELD_INPUT_ID)).size, FIELD_ORDER.length, "ids are unique");
});

test("T21-D8 formValues derives defaults without effects or the clock", () => {
  const realNow = Date.now;
  Date.now = () => {
    throw new Error("no Date.now in form logic");
  };
  try {
    assert.deepEqual(formValues(initialForm, TODAY), values({ chips: [] }));
    const moved = planFormReducer(initialForm, { type: "setDate", value: "2026-11-10", today: TODAY });
    assert.deepEqual([formValues(moved, TODAY).date, formValues(moved, TODAY).returnDate], ["2026-11-10", "2026-11-12"]);
    const cleared = planFormReducer(moved, { type: "setDate", value: "", today: TODAY });
    assert.deepEqual([formValues(cleared, TODAY).date, formValues(cleared, TODAY).returnDate], ["", "2026-11-12"]);
    const ret = planFormReducer(moved, { type: "setReturn", value: "2026-11-11" });
    assert.equal(formValues(ret, TODAY).returnDate, "2026-11-11");
    assert.deepEqual(formValues(initialForm, ""), values({ date: "", returnDate: "", chips: [] }), "SSR: no today yet");
  } finally {
    Date.now = realNow;
  }
});

// --- Budget (B4) ------------------------------------------------------------------------------------------------

test("T21-B-1 parseBudget accepts pesos with or without ₱, PHP, commas and spaces", () => {
  for (const raw of ["6000", "6,000", "₱6,000", "₱ 6,000", "PHP 6000", "php6000", " 6000 "]) {
    assert.deepEqual(parseBudget(raw), { ok: true, value: 6000 }, raw);
  }
  assert.deepEqual(parseBudget("500"), { ok: true, value: BUDGET_MIN });
  assert.deepEqual(parseBudget("200000"), { ok: true, value: BUDGET_MAX });
  assert.equal(BUDGET_MIN, 500);
  assert.equal(BUDGET_MAX, 200_000);
});

test("T21-B-2 an empty budget is null and left out of the payload", () => {
  assert.deepEqual(parseBudget(""), { ok: true, value: null });
  assert.deepEqual(parseBudget("   "), { ok: true, value: null });
  assert.ok(!("budget_php" in buildPlanRequest(values({ budget: "  " }), DEFAULT_PARTY)));
});

test("T21-B-3 parseBudget rejects out of range, decimals, units, signs and full-width digits", () => {
  for (const raw of ["499", "200001", "6k", "6000.5", "6,000.00", "-600", "0", "₱", "1e4", "0x1F4", "６０００"]) {
    assert.deepEqual(parseBudget(raw), { ok: false }, raw);
    const errors = validatePlanForm(values({ budget: raw }), TODAY, formatTravelDate, "live");
    assert.deepEqual(errors, [{ field: "budget", message: MSG.budget }], raw);
  }
});

test("T21-B-4 formatBudget uses PH grouping with no peso sign", () => {
  assert.equal(formatBudget(6000), "6,000");
  assert.equal(formatBudget(200000), "200,000");
  assert.equal(formatBudget(500), "500");
});

test("T21-B-5 blurBudget reformats a valid budget and leaves a bad one as typed", () => {
  const typed = planFormReducer(initialForm, { type: "setBudget", value: "₱6000" });
  assert.equal(typed.budget, "₱6000", "no reformat while typing");
  assert.equal(planFormReducer(typed, { type: "blurBudget" }).budget, "6,000");
  const bad = planFormReducer(initialForm, { type: "setBudget", value: "6k" });
  assert.equal(planFormReducer(bad, { type: "blurBudget" }).budget, "6k");
  const empty = planFormReducer(initialForm, { type: "setBudget", value: "" });
  assert.equal(planFormReducer(empty, { type: "blurBudget" }).budget, "");
});

// --- Vibe (B5) --------------------------------------------------------------------------------------------------

const PY_PATTERN = existsSync(PLANNER_PY)
  ? new RegExp(readFileSync(PLANNER_PY, "utf8").match(/vibe: str = Field\([^)]*pattern=r"([^"]+)"/)?.[1] ?? "(?!)", "u")
  : /^[\w ,.'&!?-]+$/u;
// Python's \w is Unicode; JS \w (even with the u flag) is ASCII, so translate it before matching non-ASCII text
const PY_PATTERN_JS = new RegExp(PY_PATTERN.source.replace(/\\w/g, "\\p{L}\\p{N}_"), "u");

test("T21-V1 the six chips, in order, and each fits TG-20's vibe pattern", () => {
  assert.deepEqual(VIBE_CHIPS, ["Food trip", "Chill", "Nature", "Sightseeing", "Shopping", "Cafe hopping"]);
  assert.ok(existsSync(PLANNER_PY), "TG-20 is merged: read the real pattern");
  assert.equal(String(PY_PATTERN), "/^[\\w ,.'&!?-]+$/u");
  for (const c of VIBE_CHIPS) assert.match(c, PY_PATTERN, c);
  assert.match(VIBE_CHIPS.join(", "), PY_PATTERN);
  assert.equal(MAX_CHIPS, 2);
  assert.equal(NOTE_MAX, 30);
  assert.equal(VIBE_MAX, 60);
});

test("T21-V2 toggleChip keeps chip order and stops at 2; chipLocked marks the rest", () => {
  const nature = toggleChip([], "Nature");
  const two = toggleChip(nature, "Food trip");
  assert.deepEqual(two, ["Food trip", "Nature"], "chip order, not click order");
  const frozen = deepFreeze([...two]);
  assert.equal(toggleChip(frozen, "Chill"), frozen, "a 3rd add returns the same array");
  assert.deepEqual(toggleChip(frozen, "Nature"), ["Food trip"], "removing works at the limit");
  assert.equal(chipLocked(frozen, "Chill"), true);
  assert.equal(chipLocked(frozen, "Nature"), false);
  assert.equal(chipLocked(["Food trip"], "Chill"), false);
});

test("T21-V3 buildVibe joins chips in chip order, then the trimmed note", () => {
  assert.equal(buildVibe(["Food trip", "Nature"], " strawberries   no hiking "), "Food trip, Nature, strawberries no hiking");
  assert.equal(buildVibe(["Nature", "Food trip"], ""), "Food trip, Nature");
  assert.equal(buildVibe(["Food trip"], ""), "Food trip");
  assert.equal(buildVibe([], " strawberries "), "strawberries");
  assert.equal(buildVibe(["Chill"], "   "), "Chill");
});

test("T21-V4 the worst case stays within 60 characters", () => {
  const note = "x".repeat(NOTE_MAX);
  for (const a of VIBE_CHIPS) {
    for (const b of VIBE_CHIPS) {
      if (a === b) continue;
      const v = buildVibe([a, b], note);
      assert.ok(v.length <= VIBE_MAX, `${v} (${v.length})`);
    }
  }
  assert.equal(buildVibe(["Sightseeing", "Cafe hopping"], note).length, 57);
});

test("T21-V5 NOTE_OK mirrors TG-20's characters, with Unicode letters", () => {
  for (const ok of ["Baño", "kape & ube!", "it's 2 days", "ok?", "a-b", "x_y"]) assert.match(ok, NOTE_OK, ok);
  for (const bad of ["<b>", "{x}", "100%", "a/b", '"quote"', "#tag", "ube 🍠", "a\nb"]) assert.doesNotMatch(bad, NOTE_OK, bad);
});

test("T21-V6 vibe validation rows", () => {
  const v = (chips: string[], note: string) =>
    validatePlanForm(values({ chips, note }), TODAY, formatTravelDate, "live").map((e) => e.message);
  assert.deepEqual(v([], ""), [MSG.vibe]);
  assert.deepEqual(v([], "   "), [MSG.vibe]);
  assert.deepEqual(v([], "<b>"), [MSG.note]);
  assert.deepEqual(v(["Chill"], "100%"), [MSG.note]);
  assert.deepEqual(v(["Chill"], ""), []);
  assert.deepEqual(v([], "strawberries"), []);
});

test("T21-V7 a decomposed ñ is normalised to NFC and passes", () => {
  const decomposed = "Baño";
  assert.notEqual(decomposed, "Baño");
  assert.equal(buildVibe([], decomposed), "Baño");
  assert.deepEqual(validatePlanForm(values({ chips: [], note: decomposed }), TODAY, formatTravelDate, "live"), []);
  assert.equal(buildPlanRequest(values({ chips: [], note: decomposed }), DEFAULT_PARTY).vibe, "Baño");
});

test("T21-V8 JS acceptance equals Python's rule on the same strings (expected values generated from Python)", () => {
  // python: re.fullmatch(r"[\w ,.'&!?-]+", " ".join(s.split())) and 1 <= len <= 60
  const PY: [string, boolean][] = [
    ["Food trip", true], ["Chill", true], ["Nature", true], ["Sightseeing", true], ["Shopping", true],
    ["Cafe hopping", true], ["Baño", true], ["kape & ube!", true], ["it's 2 days", true], ["ok?", true],
    ["a-b", true], ["x_y", true], ["<b>", false], ["{x}", false], ["100%", false], ["a/b", false],
    ['"quote"', false], ["#tag", false], ["ube 🍠", false], ["a\nb", true],
    ["Food trip, Nature, strawberries no hiking", true],
    ["Sightseeing, Cafe hopping, " + "x".repeat(30), true],
    ["Sightseeing, Cafe hopping, " + "x".repeat(34), false],
    ["Baño", false],
  ];
  const js = (s: string) => {
    const c = s.split(/\s+/).filter(Boolean).join(" ");
    return NOTE_OK.test(c) && c.length >= 1 && c.length <= VIBE_MAX;
  };
  for (const [s, py] of PY) assert.equal(js(s), py, JSON.stringify(s));
});

// --- Party and payload (B7) ---------------------------------------------------------------------------------------

test("T21-P1 the party is TG-15's, sent as type keys only", () => {
  let p: Party = DEFAULT_PARTY;
  for (const t of PICKER_TYPES) p = add(p, t);
  while (p.length < MAX_PARTY) p = add(p, "adult");
  const withExtras = p.map((x, i) => ({ ...x, name: `Passenger ${i}`, id: i })) as unknown as Party;
  for (const party of [DEFAULT_PARTY, p, withExtras]) {
    const body = buildPlanRequest(values(), party);
    assert.deepEqual(body.party, party.map((x) => ({ type: x.type })));
    for (const x of body.party) assert.deepEqual(Object.keys(x), ["type"]);
    assert.ok(body.party.length >= 1 && body.party.length <= MAX_PARTY);
  }
});

test("T21-P2 the payload is a snapshot: later party edits don't change it", () => {
  const party: Passenger[] = [{ type: "adult" }, { type: "senior" }];
  const body = buildPlanRequest(values(), party);
  party.push({ type: "adult" });
  party[0] = { type: "pwd" };
  assert.deepEqual(body.party, [{ type: "adult" }, { type: "senior" }]);
});

test("T21-P4 the form logic has no party rule", () => {
  assert.equal(buildPlanRequest(values(), []).party.length, 0);
  assert.deepEqual(validatePlanForm(values(), TODAY, formatTravelDate, "live"), []);
});

test("T21-R1 R2 R3 the payload has exactly TG-20's keys and types", () => {
  const withBudget = buildPlanRequest(values({ budget: "₱6,000", chips: ["Nature", "Food trip"], note: " ube  jam " }), DEFAULT_PARTY);
  assert.deepEqual(Object.keys(withBudget).sort(), ["budget_php", "date", "party", "return_date", "vibe"]);
  assert.deepEqual(withBudget, {
    date: TODAY,
    return_date: "2026-11-08",
    party: [{ type: "adult" }],
    budget_php: 6000,
    vibe: "Food trip, Nature, ube jam",
  });
  assert.ok(Number.isInteger(withBudget.budget_php));
  const noBudget = buildPlanRequest(values(), DEFAULT_PARTY);
  assert.deepEqual(Object.keys(noBudget).sort(), ["date", "party", "return_date", "vibe"]);
  assert.doesNotMatch(JSON.stringify(noBudget), /undefined|null/);
});

test("T21-R4 the note only travels in the vibe", () => {
  const body = buildPlanRequest(values({ note: "secret-ish note" }), DEFAULT_PARTY);
  const fields = Object.entries(body).filter(([k]) => k !== "vibe");
  assert.doesNotMatch(JSON.stringify(fields), /secret/);
  assert.match(body.vibe, /secret-ish note/);
});

test("T21-R5 valid boundary forms build payloads that pass a mirror of PlanRequest", () => {
  const forms: FormValues[] = [
    values(),
    values({ date: TODAY, returnDate: TODAY }),
    values({ date: "2027-11-06", returnDate: "2027-11-12" }),
    values({ date: TODAY, returnDate: "2026-11-12" }),
    values({ budget: "500" }),
    values({ budget: "200,000" }),
    values({ chips: ["Sightseeing", "Cafe hopping"], note: "x".repeat(30) }),
    values({ chips: [], note: "Baño" }),
    values({ chips: ["Chill"], note: "kape & ube!" }),
    values({ budget: "PHP 12000", chips: ["Nature"] }),
  ];
  for (const f of forms) {
    assert.deepEqual(validatePlanForm(f, TODAY, formatTravelDate, "live"), [], JSON.stringify(f));
    const b = buildPlanRequest(f, DEFAULT_PARTY);
    const keys = new Set(["date", "return_date", "party", "budget_php", "vibe"]);
    assert.ok(Object.keys(b).every((k) => keys.has(k)));
    assert.match(b.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(b.return_date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(b.return_date >= b.date && daysBetween(b.date, b.return_date) <= 6);
    assert.ok(b.date >= TODAY && daysBetween(TODAY, b.date) <= 365);
    if (b.budget_php !== undefined) assert.ok(Number.isInteger(b.budget_php) && b.budget_php >= 500 && b.budget_php <= 200_000);
    assert.ok(b.vibe.length >= 1 && b.vibe.length <= 60);
    assert.match(b.vibe, PY_PATTERN_JS);
  }
});

// --- Errors (B8) -------------------------------------------------------------------------------------------------

const PY_MESSAGES: Record<string, string> = existsSync(PLANNER_PY)
  ? Object.fromEntries(
      [...(readFileSync(PLANNER_PY, "utf8").match(/MESSAGES = \{([\s\S]*?)\n\}/)?.[1] ?? "").matchAll(/"(\w+)":\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]),
    )
  : {};
const err = (status: number, code: string, message: unknown = PY_MESSAGES[code] ?? `msg for ${code}`) => ({
  status,
  body: { detail: { code, message } },
});

test("T21-E1..E8 each TG-20 code shows the API's message with its own actions", () => {
  const rows: [number, string, boolean, boolean][] = [
    [502, "no_valid_plan", true, true],
    [502, "refused", true, true],
    [503, "llm_unavailable", true, true],
    [504, "deadline", true, true],
    [503, "daily_cap", false, true],
    [503, "not_configured", false, true],
    [429, "rate_limited", false, true],
    [422, "no_data", false, true],
  ];
  for (const [status, code, retry, premade] of rows) {
    const r = err(status, code);
    assert.deepEqual(planErrorView(r), { message: r.body.detail.message, retry, premade }, code);
  }
});

test("T21-E9 an unknown or broken answer gets the generic row", () => {
  for (const r of [
    { status: 404, body: { detail: "Not Found" } },
    { status: 500, body: { detail: "Internal Server Error" } },
    { status: 502, body: null },
    { status: 201, body: { model: "x" } },
    err(503, "brand_new_code", "Something new"),
  ]) {
    assert.deepEqual(planErrorView(r), { message: GENERIC, retry: true, premade: true }, JSON.stringify(r));
  }
});

test("T21-E10 a 422 with FastAPI's detail list", () => {
  assert.deepEqual(planErrorView({ status: 422, body: { detail: [{ loc: ["body", "vibe"], msg: "x", type: "y" }] } }), {
    message: "Some details didn't pass our checks. Check the dates, budget and vibe, and try again.",
    retry: false,
    premade: false,
  });
});

test("T21-E11..E13 network, timeout and offline", () => {
  assert.deepEqual(planErrorView("network"), {
    message: "Could not reach the planner. Check your connection and try again.",
    retry: true,
    premade: true,
  });
  assert.deepEqual(planErrorView("timeout"), { message: DEADLINE_MESSAGE, retry: true, premade: true });
  assert.equal(DEADLINE_MESSAGE, PY_MESSAGES.deadline, "the timeout text is TG-20's deadline text");
  assert.deepEqual(planErrorView("offline"), {
    message: "You're offline. Planning needs a connection.",
    retry: false,
    premade: true,
  });
});

test("T21-E14 no status codes, codes or raw detail ever reach the message", () => {
  const inputs = [
    ...Object.keys(PLAN_ERROR_CODES).map((c) => err(503, c)),
    err(503, "deadline", 42),
    err(503, "deadline", { nested: "x" }),
    { status: 404, body: { detail: "Not Found" } },
    { status: 422, body: { detail: [{ msg: "bad" }] } },
    { status: 500, body: "<html>502 Bad Gateway</html>" },
    "network" as const,
    "timeout" as const,
    "offline" as const,
  ];
  for (const r of inputs) {
    const { message } = planErrorView(r);
    assert.equal(typeof message, "string");
    assert.doesNotMatch(message, /\b[45]\d\d\b|\bdetail\b|\bcode\b|[{[]|request.?id/i, message);
    for (const code of Object.keys(PLAN_ERROR_CODES)) assert.ok(!message.includes(code), `${code} in ${message}`);
  }
  assert.deepEqual(planErrorView(err(504, "deadline", 42)), { message: GENERIC, retry: true, premade: true }, "non-string message");
});

test("T21-K1 the codes the form knows equal TG-20's MESSAGES keys", () => {
  assert.ok(Object.keys(PY_MESSAGES).length >= 8, "MESSAGES parsed from planner.py");
  assert.deepEqual(Object.keys(PLAN_ERROR_CODES).sort(), Object.keys(PY_MESSAGES).sort());
});

test("T21-K2 PremadeSummary keys equal api/app/premade.py's model", () => {
  const py = readFileSync(PREMADE_PY, "utf8").match(/class PremadeSummary\(BaseModel\):([\s\S]*?)\n\n/)?.[1] ?? "";
  const pyKeys = [...py.matchAll(/^\s+(\w+):/gm)].map((m) => m[1]).sort();
  assert.ok(pyKeys.length >= 8);
  const ts = read("src/lib/api.ts").match(/export type PremadeSummary = \{([\s\S]*?)\};/)?.[1] ?? "";
  const tsKeys = [...ts.matchAll(/(\w+)\??:/g)].map((m) => m[1]).sort();
  assert.deepEqual(tsKeys, pyKeys);
});

// --- Flags (B17 to B19, B23) -------------------------------------------------------------------------------------

test("T21-F1 formMode picks the branch from the two flags", () => {
  assert.equal(formMode({ plannerLive: true, premadeItineraries: true }), "live");
  assert.equal(formMode({ plannerLive: true, premadeItineraries: false }), "live");
  assert.equal(formMode({ plannerLive: false, premadeItineraries: true }), "premade");
  assert.equal(formMode({ plannerLive: false, premadeItineraries: false }), "none");
});

test("T21-F2 showPremadeAction needs both the error row and the flag", () => {
  for (const premade of [true, false]) {
    for (const premadeItineraries of [true, false]) {
      assert.equal(
        showPremadeAction({ message: "m", retry: true, premade }, { plannerLive: true, premadeItineraries }),
        premade && premadeItineraries,
      );
    }
  }
});

test("T21-F3 copy per mode, and the pre-made branch only checks the dates (review finding 4)", () => {
  assert.deepEqual(PLAN_COPY.live, {
    submit: "Tara, plan my trip",
    working: "Planning...",
    before: "We build your plan only from buses and spots on file.",
    workingLine: "Building your plan from buses and spots on file. This can take up to 2 minutes.",
  });
  assert.deepEqual(PLAN_COPY.premade, {
    submit: "Tara, show trip ideas",
    working: "Loading trip ideas...",
    before: "Pick from ready-made trips built from buses and spots on file.",
  });
  assert.equal(PLAN_COPY.none, "The planner isn't available yet. You can still search buses.");
  // The list ignores budget and vibe, so a bad budget or an empty vibe must not block it
  const bad = values({ budget: "6k", chips: [], note: "<b>" });
  assert.deepEqual(validatePlanForm(bad, TODAY, formatTravelDate, "premade"), []);
  assert.deepEqual(
    validatePlanForm({ ...bad, date: "2026-11-05" }, TODAY, formatTravelDate, "premade").map((e) => e.field),
    ["date"],
  );
  assert.deepEqual(
    validatePlanForm(bad, TODAY, formatTravelDate, "live").map((e) => e.field),
    ["budget", "note"],
  );
});

// --- Pre-made list (B9) and card data -----------------------------------------------------------------------------

test("T21-L1 sortPremade puts date matches first, stable, without mutating", () => {
  const list = deepFreeze([
    summary("a", "2026-11-07", "2026-11-09"),
    summary("b", TODAY, "2026-11-08"),
    summary("c", TODAY, null),
    summary("d", "2026-11-01", "2026-11-03"),
    summary("e", TODAY, "2026-11-08"),
  ]);
  assert.deepEqual(sortPremade(list, TODAY, "2026-11-08").map((s) => s.share_slug), ["b", "e", "a", "c", "d"]);
  assert.deepEqual(list.map((s) => s.share_slug), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(sortPremade([], TODAY, "2026-11-08"), []);
  assert.equal(matchesDates(list[2], TODAY, null as unknown as string), false, "a null return never matches");
  assert.equal(matchesDates(list[1], TODAY, "2026-11-08"), true);
});

test("T21-L2 premadeCountLine", () => {
  assert.equal(premadeCountLine(3, 1), "3 trip ideas · 1 matches your dates");
  assert.equal(premadeCountLine(3, 2), "3 trip ideas · 2 match your dates");
  assert.equal(premadeCountLine(1, 0), "1 trip idea · These are set for their own dates. Search buses for other days.");
  assert.equal(premadeCountLine(1, 1), "1 trip idea · 1 matches your dates");
});

test("T21-L3 premadePlaces", () => {
  assert.equal(premadePlaces(["Burnham Park", "Mines View Park"]), "Burnham Park, Mines View Park");
  assert.equal(premadePlaces(["A", "B", "C", "D"]), "A, B, C and 1 more");
  assert.equal(premadePlaces(["A", "B", "C", "D", "E"]), "A, B, C and 2 more");
  assert.equal(premadePlaces([]), "");
  const long = "A very long place name that should never be cut short anywhere";
  assert.equal(premadePlaces([long]), long);
});

test("T21-L4 premadeMeta", () => {
  assert.equal(premadeMeta(3, 5), " · 3 days · 5 stops");
  assert.equal(premadeMeta(1, 1), " · 1 day · 1 stop");
});

test("T21-L6 card data: title, chip, dates, places, budget and link", () => {
  const card = premadeCard(summary("ab/c d", TODAY, "2026-11-08", { spot_names: ["A", "B", "C", "D"] }), TODAY, "2026-11-08");
  assert.deepEqual(card, {
    title: "Food trip",
    matches: true,
    dates: "Fri, Nov 6 – Sun, Nov 8 · 3 days · 5 stops",
    places: "A, B, C and 1 more",
    budget: "Budget ₱6,000",
    href: "/i/ab%2Fc%20d",
  });
  const plain = premadeCard(summary("x", "2026-11-07", null, { vibe: null, budget_php: null }), TODAY, "2026-11-08");
  assert.equal(plain.title, "Trip idea");
  assert.equal(plain.matches, false);
  assert.equal(plain.budget, null);
  assert.equal(plain.dates, "From Sat, Nov 7 · 3 days · 5 stops");
  assert.doesNotMatch(JSON.stringify([card, plain]), /per person|fits|total|fare/i);
});

test("T21-L7 TG-23's dateRange and formatPeso (temporary copies until TG-23 merges)", () => {
  assert.equal(dateRange(TODAY, "2026-11-08"), "Fri, Nov 6 – Sun, Nov 8");
  assert.equal(dateRange(TODAY, null), "From Fri, Nov 6");
  assert.equal(dateRange(TODAY, TODAY), "Fri, Nov 6");
  assert.equal(formatPeso(6000), "₱6,000");
  assert.equal(formatPeso(6000.5), "₱6,000.50");
  assert.equal(formatPeso(null), null);
});

// --- Reducers (B10, B11) and the status region (ux §7) -----------------------------------------------------------

test("T21-RUN1 a second start while working is a no-op", () => {
  const planning = planRunReducer(initialRun, { type: "start", kind: "plan", id: 1 });
  assert.equal(planning.phase, "planning");
  assert.equal(planRunReducer(planning, { type: "start", kind: "plan", id: 2 }), planning);
  assert.equal(planRunReducer(planning, { type: "start", kind: "premade", id: 2 }), planning);
  const loading = planRunReducer(initialRun, { type: "start", kind: "premade", id: 1 });
  assert.equal(loading.phase, "loadingPremade");
  assert.equal(planRunReducer(loading, { type: "start", kind: "premade", id: 2 }), loading);
});

test("T21-RUN2 a stale result is ignored", () => {
  let s = planRunReducer(initialRun, { type: "start", kind: "plan", id: 1 });
  s = planRunReducer(s, { type: "planResult", id: 1, result: { kind: "network" } });
  s = planRunReducer(s, { type: "start", kind: "plan", id: 2 });
  assert.equal(planRunReducer(s, { type: "planResult", id: 1, result: { kind: "ok", slug: "old" } }), s);
  const done = planRunReducer(s, { type: "planResult", id: 2, result: { kind: "ok", slug: "new" } });
  assert.equal(done.phase, "opening");
  assert.equal(done.slug, "new");
  assert.equal(planRunReducer(done, { type: "premadeResult", id: 1, result: { kind: "failed" } }), done);
});

test("T21-RUN3 ok opens the plan; aborted changes nothing", () => {
  const s = planRunReducer(initialRun, { type: "start", kind: "plan", id: 7 });
  assert.deepEqual(planRunReducer(s, { type: "planResult", id: 7, result: { kind: "ok", slug: "abc123" } }), {
    phase: "opening",
    id: 7,
    slug: "abc123",
    error: null,
    premade: null,
  });
  assert.equal(planRunReducer(s, { type: "planResult", id: 7, result: { kind: "aborted" } }), s);
});

test("T21-RUN4 errors, the pre-made states, and Try again", () => {
  let s = planRunReducer(initialRun, { type: "start", kind: "plan", id: 1 });
  s = planRunReducer(s, { type: "planResult", id: 1, result: { kind: "response", ...err(504, "deadline") } });
  assert.equal(s.phase, "error");
  assert.deepEqual(s.error, planErrorView(err(504, "deadline")));
  const offline = planRunReducer(planRunReducer(initialRun, { type: "start", kind: "plan", id: 3 }), {
    type: "planResult",
    id: 3,
    result: { kind: "offline" },
  });
  assert.deepEqual(offline.error, planErrorView("offline"));
  // See ready-made trips loads the list under the error box, which stays
  const loading = planRunReducer(s, { type: "start", kind: "premade", id: 2 });
  assert.equal(loading.phase, "loadingPremade");
  assert.deepEqual(loading.error, s.error);
  const list = [summary("a", TODAY, "2026-11-08")];
  const shown = planRunReducer(loading, { type: "premadeResult", id: 2, result: { kind: "ok", list } });
  assert.equal(shown.phase, "premade");
  assert.deepEqual(shown.premade, { kind: "list", list });
  assert.deepEqual(shown.error, s.error);
  const states: [Parameters<typeof planRunReducer>[1], string][] = [
    [{ type: "premadeResult", id: 2, result: { kind: "ok", list: [] } }, "empty"],
    [{ type: "premadeResult", id: 2, result: { kind: "unavailable" } }, "unavailable"],
    [{ type: "premadeResult", id: 2, result: { kind: "failed" } }, "failed"],
  ];
  for (const [action, kind] of states) assert.equal(planRunReducer(loading, action).premade?.kind, kind);
  const again = planRunReducer(s, { type: "start", kind: "plan", id: 4 });
  assert.equal(again.phase, "planning");
  assert.equal(again.id, 4);
  assert.equal(again.error, null);
});

test("T21-RUN5 the status region text per phase", () => {
  const dates = { date: TODAY, returnDate: "2026-11-08" };
  assert.equal(statusText(initialRun, "live", dates), PLAN_COPY.live.before);
  assert.equal(statusText(initialRun, "premade", dates), PLAN_COPY.premade.before);
  assert.equal(statusText(initialRun, "none", dates), "");
  const planning = planRunReducer(initialRun, { type: "start", kind: "plan", id: 1 });
  assert.equal(statusText(planning, "live", dates), PLAN_COPY.live.workingLine);
  const loading = planRunReducer(initialRun, { type: "start", kind: "premade", id: 1 });
  assert.equal(statusText(loading, "premade", dates), "Loading trip ideas...");
  const opening = planRunReducer(planning, { type: "planResult", id: 1, result: { kind: "ok", slug: "s" } });
  assert.equal(statusText(opening, "live", dates), "Your plan is ready. Opening it...");
  assert.equal(PLAN_COPY.ready, "Your plan is ready. Opening it...");
  const failed = planRunReducer(planning, { type: "planResult", id: 1, result: { kind: "network" } });
  assert.equal(statusText(failed, "live", dates), planErrorView("network").message, "the error text is in the region too");
  const list = [summary("a", "2026-11-07", "2026-11-09"), summary("b", TODAY, "2026-11-08"), summary("c", TODAY, "2026-11-10")];
  const shown = planRunReducer(loading, { type: "premadeResult", id: 1, result: { kind: "ok", list } });
  assert.equal(statusText(shown, "premade", dates), "3 trip ideas · 1 matches your dates");
  const expectations: [string, string][] = [
    ["empty", "No ready-made trips on file yet."],
    ["unavailable", "Ready-made trips aren't available right now."],
    ["failed", "Could not load trip ideas. Check your connection and try again."],
  ];
  for (const [kind, text] of expectations) {
    const result = kind === "empty" ? { kind: "ok" as const, list: [] } : { kind: kind as "unavailable" | "failed" };
    assert.equal(statusText(planRunReducer(loading, { type: "premadeResult", id: 1, result }), "premade", dates), text);
  }
});

test("T21-RUN7 the status line goes sr-only while the error box or the list shows the same text", () => {
  const planning = planRunReducer(initialRun, { type: "start", kind: "plan", id: 1 });
  const failed = planRunReducer(planning, { type: "planResult", id: 1, result: { kind: "network" } });
  const loading = planRunReducer(failed, { type: "start", kind: "premade", id: 2 });
  const listed = planRunReducer(loading, { type: "premadeResult", id: 2, result: { kind: "failed" } });
  const opening = planRunReducer(planning, { type: "planResult", id: 1, result: { kind: "ok", slug: "s" } });
  assert.deepEqual(
    [initialRun, planning, failed, loading, listed, opening].map(statusShown),
    [true, true, false, true, false, true],
    "shown before submit and while working; hidden (sr-only) in the error and list phases",
  );
});

test("T21-RUN6 errors show only after the first submit, then follow each change", () => {
  const s0 = planFormReducer(initialForm, { type: "toggleChip", chip: "Chill" });
  assert.equal(s0.attempted, false);
  const s1 = planFormReducer(planFormReducer(initialForm, { type: "setBudget", value: "6k" }), { type: "submitted" });
  assert.equal(s1.attempted, true);
  const errorsOf = (s: typeof s1) => (s.attempted ? validatePlanForm(formValues(s, TODAY), TODAY, formatTravelDate, "live") : []);
  assert.deepEqual(errorsOf(s1).map((e) => e.field), ["budget", "vibe"]);
  const s2 = planFormReducer(s1, { type: "setBudget", value: "6000" });
  assert.deepEqual(errorsOf(s2).map((e) => e.field), ["vibe"], "the budget error clears as you type");
  const s3 = planFormReducer(s2, { type: "toggleChip", chip: "Chill" });
  assert.deepEqual(errorsOf(s3), []);
  const two = planFormReducer(planFormReducer(s3, { type: "toggleChip", chip: "Nature" }), { type: "toggleChip", chip: "Food trip" });
  assert.deepEqual(two.chips, ["Chill", "Nature"], "the 3rd chip is locked");
  const noted = planFormReducer(initialForm, { type: "setNote", value: "y".repeat(40) });
  assert.equal(noted.note.length, NOTE_MAX);
});

// --- Copy (B12) --------------------------------------------------------------------------------------------------

test("T21-C1 every pinned string from ux §8", () => {
  assert.deepEqual(PLAN_COPY.labels, {
    dates: "When are you going?",
    date: "Travel date",
    returnDate: "Return date",
    budget: "Budget (optional)",
    vibe: "What's the vibe?",
    note: "Anything else? (optional)",
  });
  assert.deepEqual(PLAN_COPY.hints, {
    budget: "For the whole group: buses, rides, food and entrance fees.",
    budgetSr: " in pesos",
    vibe: "Pick up to 2.",
    notePlaceholder: "e.g. strawberries, no hiking",
    noteLimit: "Up to 30 characters.",
  });
  assert.deepEqual(PLAN_COPY.list, {
    heading: "Trip ideas",
    match: "Matches your dates",
    see: "See this trip",
    untitled: "Trip idea",
    empty: "No ready-made trips on file yet.",
    unavailable: "Ready-made trips aren't available right now.",
    failed: "Could not load trip ideas. Check your connection and try again.",
  });
  assert.deepEqual(PLAN_COPY.actions, { tryAgain: "Try again", seePremade: "See ready-made trips", searchBuses: "Search buses" });
  for (const s of [PLAN_COPY.live.working, PLAN_COPY.premade.working, PLAN_COPY.ready]) assert.match(s, /\.\.\.$/);
  assert.doesNotMatch(JSON.stringify(PLAN_COPY), /…/, "three ASCII dots, never an ellipsis character");
});

// --- Source guards (UI rests on manual checks; these pin the rules that are easy to break) -------------------------

const form = readIf("src/components/PlanForm.tsx");
const fields = readIf("src/components/PlanFields.tsx");
const results = readIf("src/components/PlanResults.tsx");
const home = read("src/app/page.tsx");
const ui = form + fields + results;

test("T21-S1 date inputs use dateBounds, never a hard-coded date", () => {
  const dates = tags(ui, "input").filter((t) => /type="date"/.test(t));
  assert.equal(dates.length, 2, "travel and return date inputs");
  for (const t of dates) {
    assert.match(t, /\bmin=\{/, t);
    assert.match(t, /\bmax=\{/, t);
  }
  assert.match(ui, /dateBounds\(/);
  assert.doesNotMatch(ui, /["'`]\d{4}-\d{2}-\d{2}["'`]/);
  for (const f of ["date", "returnDate", "budget", "note"]) assert.match(fields, new RegExp(`id=\\{FIELD_INPUT_ID\\.${f}\\}`), f);
  // RED audit survivor V4: the note input stops at 30 characters, not only the reducer
  const note = tags(fields, "input").filter((t) => /id=\{FIELD_INPUT_ID\.note\}/.test(t));
  assert.equal(note.length, 1, "one note input");
  assert.match(note[0], /maxLength=\{NOTE_MAX\}/);
});

test("T21-S2 the payload is built from TG-15's party at submit", () => {
  assert.match(form, /useState(<[^>]+>)?\(DEFAULT_PARTY\)/, "TG-15's party state stays");
  assert.match(form, /buildPlanRequest\((?:[^()]|\([^()]*\))*\bparty\b/);
});

test("T21-S3 one noValidate form; aria-disabled submit; only a fieldset is ever disabled; one status; no loops", () => {
  assert.equal(tags(ui, "form").length, 1);
  assert.match(tags(ui, "form")[0], /\bnoValidate\b/);
  const submit = tags(ui, "button").filter((t) => /type="submit"/.test(t));
  assert.equal(submit.length, 1, "one submit button");
  assert.match(submit[0], /aria-disabled=\{/);
  for (const t of tags(ui, "\\w+")) {
    if (/(?<![-\w])disabled(?=[\s=>{/])/.test(t)) assert.match(t, /^<fieldset\b/, `only a fieldset is disabled: ${t}`);
  }
  assert.match(ui, /<fieldset\b[^>]*\bdisabled=\{/);
  assert.equal((ui.match(/role="status"/g) ?? []).length, 1);
  // Always rendered, never removed: only its class switches to sr-only (RUN7)
  assert.match(form, /<p role="status" className=\{statusShown\(run\) \? UI\.meta : "sr-only"\}>/);
  assert.doesNotMatch(ui, /animate-|setInterval|<progress\b|spinner/i);
});

test("T21-S4 validation messages are tied to their inputs, with no red", () => {
  assert.match(fields, /aria-invalid=\{/);
  assert.match(fields, /aria-describedby=\{/);
  assert.match(fields, /<p\b[^>]*\bid=\{/);
  assert.doesNotMatch(ui, /\b(text|bg|border|outline)-red-|#f00\b|#ff0000/i);
});

test("T21-S5 the branch comes from formMode; home links /plan only when a mode is on", () => {
  assert.match(form, /formMode\(flags\)/);
  assert.doesNotMatch(ui, /flags\.plannerLive/, "branch on formMode, not ad-hoc flag checks");
  assert.match(home, /formMode\(flags\) !== "none"/);
  assert.match(home, /href="\/plan"/);
  // RED audit survivors E6 and L6: the fallback button and both result dispatches exist
  assert.match(ui, /showPremadeAction\(/);
  assert.match(ui, /PLAN_COPY\.actions\.seePremade/);
  assert.match(form, /type: "planResult"/);
  assert.match(form, /type: "premadeResult"/);
  // postPlan's own result must be dispatched: the offline branch's planResult alone doesn't count
  const posted = form.match(/const (\w+) = await postPlan\(/)?.[1];
  assert.ok(posted, "postPlan's result is kept in a variable");
  assert.match(form, new RegExp(`type: "planResult",[^}]*?(?:\\bresult: ${posted}\\b|\\b${posted}\\s*\\})`), "postPlan's result is dispatched");
});

test("T21-S6 the submit handler reads a fresh Manila today", () => {
  assert.match(form, /manilaToday\(\)/, "called at submit, not only as the store snapshot");
  assert.match(form, /validatePlanForm\(/);
});

test("T21-S7 no logs, storage, raw HTML or unencoded navigation", () => {
  const files = { "planForm.ts": readIf("src/lib/planForm.ts"), "premadeView.ts": readIf("src/lib/premadeView.ts"), ui };
  for (const [name, src] of Object.entries(files)) {
    assert.doesNotMatch(src, /console\.|localStorage|sessionStorage|dangerouslySetInnerHTML/, name);
  }
  for (const push of ui.match(/router\.push\([^)]*\)?\)?/g) ?? []) {
    assert.match(push, /router\.push\(\s*(["'`]\/i\/["'`]\s*\+\s*|`\/i\/\$\{)encodeURIComponent\(/, push);
  }
  assert.match(ui, /router\.push\(/, "the live branch opens the plan");
});

test("T21-G1 planForm.ts is a plain module", () => {
  const src = readIf("src/lib/planForm.ts");
  assert.ok(src, "planForm.ts exists");
  for (const line of src.match(/^\s*import\b.*$/gm) ?? []) {
    assert.match(line, /^import type \{[^}]*\} from "\.\/(party|api|sprites|flags)\.ts";$/, line);
  }
  assert.doesNotMatch(src, /\bimport\s*\(|@\/|use client|<\/[A-Za-z]|\/>|\benum\s|\bnamespace\s/);
});

test("T21-G2 api.ts keeps only type imports, so node --test can load it; premadeView.ts imports only lib modules", () => {
  for (const line of read("src/lib/api.ts").match(/^\s*import\b.*$/gm) ?? []) assert.match(line, /^import type /, line);
  const view = readIf("src/lib/premadeView.ts");
  assert.ok(view);
  for (const line of view.match(/^\s*import\b.*$/gm) ?? []) {
    assert.match(line, /from "\.\/(direction|planForm|api)\.ts";$/, line);
  }
  assert.doesNotMatch(view, /@\/|use client|<\/[A-Za-z]|\/>/);
});

test("T21-P3 TG-15's picker and party module are left alone", () => {
  // The git diff is checked at Gate 3; here, the TG-15 seams TG-21 relies on still exist
  assert.match(read("src/components/PartyPicker.tsx"), /export default function PartyPicker\(\{ party, onChange, onAdd \}: Props\)/);
  assert.match(read("src/lib/party.ts"), /export const DEFAULT_PARTY: Party = \[\{ type: "adult" \}\];/);
});
