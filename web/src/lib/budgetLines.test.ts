// TG-62 GW1: the wallet's budget line, web side (budgetLines.ts). Run with `npm test`. Plan §3 G23 to G27, TG-66 ux.md
// §2 item 3 (Which budget line?), §5 (Details, Changes) and §9 (the two alerts), and tg-ux2's answers in
// TG-62/ux-arch-notes.md (2026-11-18). Made-up lines and trip. The module is loaded per test, so before it exists each
// test fails on its own instead of the whole file.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { WalletBudget } from "./wallet.ts";

const load = () => import("./budgetLines.ts");

// A made-up trip's lines, in plan order. "tips" has no category: it's listed under other.
const BUDGET: WalletBudget = {
  trip_name: "Baguio barkada (made up)",
  lines: [
    { key: "meals", item: "Meals and merienda, 2.5 days", category: "food" },
    { key: "taxis", item: "Taxis and jeeps", category: "transport" },
    { key: "pasalubong", item: "Pasalubong and strawberries", category: "food" },
    { key: "entrance", item: "Entrance fees", category: "activities" },
    { key: "tips", item: "Tips", category: null },
  ],
};

// ---------------------------------------------------------------- G23

test("GW1-L1 G23 linesFor: the category's lines in plan order, then None of these; a line with no category is under other", async () => {
  const { linesFor } = await load();
  assert.deepEqual(linesFor(BUDGET, "food"), [
    { key: "meals", item: "Meals and merienda, 2.5 days" },
    { key: "pasalubong", item: "Pasalubong and strawberries" },
    { key: "_none", item: "None of these" },
  ]);
  assert.deepEqual(linesFor(BUDGET, "other"), [
    { key: "tips", item: "Tips" },
    { key: "_none", item: "None of these" },
  ]);
  assert.deepEqual(linesFor(BUDGET, "hotel"), [{ key: "_none", item: "None of these" }], "a category with no line still offers None of these");
  assert.deepEqual(linesFor(null, "food"), [], "no budget: no row");
  assert.deepEqual(linesFor(BUDGET, null), [], "no category picked: no row");
});

test("GW1-L2 G23 lineLabel: the item, Not in the budget, Not sorted yet, or A line no longer in the plan (tg-ux2)", async () => {
  const { lineLabel } = await load();
  assert.equal(lineLabel(BUDGET, "meals"), "Meals and merienda, 2.5 days");
  assert.equal(lineLabel(BUDGET, "_none"), "Not in the budget");
  assert.equal(lineLabel(BUDGET, null), "Not sorted yet");
  assert.equal(lineLabel(BUDGET, undefined), "Not sorted yet");
  assert.equal(lineLabel(BUDGET, "van"), "A line no longer in the plan", "a key the plan no longer has: not 'Not sorted yet'");
});

test("GW1-L3 G24 the row shows only with a budget and a picked category", async () => {
  const { showLineRow } = await load();
  assert.equal(showLineRow(BUDGET, "food"), true);
  assert.equal(showLineRow(BUDGET, null), false);
  assert.equal(showLineRow(null, "food"), false);
  assert.equal(showLineRow({ trip_name: "x", lines: [] }, "food"), false, "a trip with no keyed lines");
});

// ---------------------------------------------------------------- G25 and tg-ux2's open question

test("GW1-L4 G25 edit reopens with the saved line checked; _none stays; with no budget on screen the stored key rides along unseen", async () => {
  const { initialLine } = await load();
  assert.equal(initialLine(BUDGET, "meals", "food"), "meals");
  assert.equal(initialLine(BUDGET, "tips", "other"), "tips");
  assert.equal(initialLine(BUDGET, "_none", "hotel"), "_none");
  assert.equal(initialLine(BUDGET, null, "food"), null);
  assert.equal(initialLine(null, "meals", "food"), "meals", "two trips now, or the flag off: resend the stored key (GA1 accepts it), never clear it silently");
});

test("GW1-L5 tg-ux2's question: in edit, a saved line the plan moved or removed isn't listed, none is picked, and a meta line names it", async () => {
  const { initialLine, editLineMeta, linesFor } = await load();
  // The plan moved "meals" to hotel since the expense was saved under food
  const moved: WalletBudget = { ...BUDGET, lines: BUDGET.lines.map((l) => (l.key === "meals" ? { ...l, category: "hotel" } : l)) };
  assert.equal(initialLine(moved, "meals", "food"), null, "not picked");
  assert.ok(!linesFor(moved, "food").some((l) => l.key === "meals"), "not listed under food");
  assert.equal(editLineMeta(moved, "meals", "food"), "Its line was Meals and merienda, 2.5 days, which the plan now lists under Hotel. Pick again, or leave it for later.");
  // The plan removed "meals": its item text is gone with it, so the line says so without a name
  const removed: WalletBudget = { ...BUDGET, lines: BUDGET.lines.filter((l) => l.key !== "meals") };
  assert.equal(initialLine(removed, "meals", "food"), null);
  assert.equal(editLineMeta(removed, "meals", "food"), "Its budget line isn't in the plan any more. Pick another, or leave it for later.");
  // No meta when the saved line is listed, for _none, for null, or with no budget
  for (const [b, key, cat] of [[BUDGET, "meals", "food"], [BUDGET, "_none", "food"], [BUDGET, null, "food"], [null, "meals", "food"]] as const) {
    assert.equal(editLineMeta(b, key, cat), null, `${key}`);
  }
});

test("GW1-L6 G24 changing the category clears the line (none picked); keeping it keeps the line", async () => {
  const { lineAfterCategory } = await load();
  assert.equal(lineAfterCategory(BUDGET, "meals", "food", "transport"), null);
  assert.equal(lineAfterCategory(BUDGET, "_none", "food", "transport"), null, "the new category's lines, none picked");
  assert.equal(lineAfterCategory(BUDGET, "meals", "food", null), null, "category cleared: the row hides and the line goes");
  assert.equal(lineAfterCategory(BUDGET, "meals", "food", "food"), "meals");
});

test("GW1-L6b (tg-test F1) with no budget on screen the row is hidden, so a category change never clears the line unseen", async () => {
  const { lineAfterCategory } = await load();
  // The flag on and the wallet now on two trips: budget is null. The stored key rides along, as on a reopen (L4), and
  // GA1 keeps a key it can't compare (G9c). The new web clears a line only where the person sees it (tg-ux2).
  assert.equal(lineAfterCategory(null, "meals", "food", "transport"), "meals");
  assert.equal(lineAfterCategory(null, "_none", "food", "transport"), "_none");
  assert.equal(lineAfterCategory(null, "meals", "food", null), "meals");
  assert.equal(lineAfterCategory(null, null, "food", "transport"), null);
  // A trip with no keyed lines shows no row either (L3)
  assert.equal(lineAfterCategory({ trip_name: "x", lines: [] }, "meals", "food", "transport"), "meals");
});

// ---------------------------------------------------------------- the body (G24, G25, G27)

test("GW1-L7 G27 with BUDGET_LINES off the body has no budget_key, add or edit; G24/G25 on: an add carries the pick, an edit always does", async () => {
  const { withBudgetKey } = await load();
  const v2 = { mode: "equal", paid_by: "a", amount_centavos: 100, note: "x", category: "food", by: "a", inputs: [] } as never;
  const legacy = { paid_by: "a", amount_centavos: 100, note: "x", split_among: ["a"] } as never;
  assert.equal(JSON.stringify(withBudgetKey(v2, { on: false, line: "meals" })), JSON.stringify(v2), "off: byte for byte TG-66's body");
  assert.equal(JSON.stringify(withBudgetKey(legacy, { on: true, line: "meals" })), JSON.stringify(legacy), "today's body never gets one (extra=forbid)");
  assert.deepEqual(withBudgetKey(v2, { on: true, line: "meals" }), { ...(v2 as object), budget_key: "meals" });
  assert.deepEqual(withBudgetKey(v2, { on: true, line: "_none" }), { ...(v2 as object), budget_key: "_none" });
  assert.deepEqual(withBudgetKey(v2, { on: true, line: null }), { ...(v2 as object), budget_key: null }, "an edit always sends it (Rev 1 M2): null clears");
  const patch = { ...(v2 as object), version: 3 } as never;
  assert.deepEqual(withBudgetKey(patch, { on: true, line: null }), { ...(patch as object), budget_key: null });
});

// ---------------------------------------------------------------- Details (G26) and the alerts (ux §9)

test("GW1-L8 G26 Details: the line beside the category, Not in the budget, or a meta line; nothing without a budget", async () => {
  const { detailsLine } = await load();
  assert.deepEqual(detailsLine(BUDGET, "meals"), { text: "Meals and merienda, 2.5 days", meta: false });
  assert.deepEqual(detailsLine(BUDGET, "_none"), { text: "Not in the budget", meta: false });
  assert.deepEqual(detailsLine(BUDGET, null), { text: "No budget line yet", meta: true });
  assert.deepEqual(detailsLine(BUDGET, "van"), { text: "A line no longer in the plan", meta: true });
  assert.equal(detailsLine(null, "meals"), null, "flag off, or not one trip: TG-66's Details exactly");
  assert.equal(detailsLine({ trip_name: "x", lines: [] }, null), null);
});

test("GW1-L9 ux §9: the two refusals' lines; anything else is someone else's", async () => {
  const { budgetRefusal } = await load();
  assert.equal(budgetRefusal("unknown_budget_line"), "That budget line isn't in the plan any more. Pick another, or leave it for later.");
  assert.equal(budgetRefusal("budget_line_category"), "That budget line is under another category in the plan now. Pick the line again, or leave it for later.");
  for (const other of ["percent_total", "feature_off", undefined]) assert.equal(budgetRefusal(other), null, String(other));
});

test("GW1-L11 (tg-test S1, privacy) the submit log's line word is one of four fixed words, never the key (a slug of the group's own line text)", async () => {
  const { logLine } = await load();
  const WORDS = new Set(["off", "null", "none", "line"]);
  assert.equal(logLine(false, "meals"), "off");
  assert.equal(logLine(false, null), "off");
  assert.equal(logLine(true, null), "null");
  assert.equal(logLine(true, "_none"), "none");
  assert.equal(logLine(true, "meals"), "line");
  for (const key of ["meals", "pasalubong", "tips", "van", "gas-and-tolls", "Lunch at Good Taste", "x".repeat(80), "", " "]) {
    for (const on of [true, false]) {
      const word = logLine(on, key);
      assert.ok(WORDS.has(word), `${JSON.stringify(word)} is a fixed word`);
      if (!WORDS.has(key)) assert.notEqual(word, key);
      assert.ok(!word.includes(key) || WORDS.has(key) || key.trim() === "", "no part of the key");
    }
  }
});

test("GW1-L10 the row's meta names the trip: From the plan of <trip>.", async () => {
  const { fromPlan } = await load();
  assert.equal(fromPlan(BUDGET), "From the plan of Baguio barkada (made up).");
});
