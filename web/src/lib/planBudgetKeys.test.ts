// TG-62 GP1 (plan.md §3 G22, ux.md §4a): the budget rows' key and category through TG-61's hand editor. Every save
// sends the whole guide, so toStored must carry both on every row, not only on budget edits. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Guide } from "./guide.ts";
import { type GuideIn, budgetCategoryWord, budgetFormStart, editBudget, moveRow, toStored } from "./planEdit.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/tg61-owner-guide.json", import.meta.url), "utf8")) as { out: Guide; stored: GuideIn };
const G20 = [["meals", "food"], ["pasalubong", "other"], ["entrance", "activities"], ["taxis", "transport"]] as const;

/** The owner's plan as the API reads it once GP1 has keyed it (G20). */
function keyed(): Guide {
  const g = structuredClone(fixture.out);
  g.budget.rows = g.budget.rows.map((r, i) => ({ ...r, key: G20[i][0], category: G20[i][1] }));
  return g;
}
const keysCats = (g: GuideIn) => g.budget.rows.map((r) => [r.key, r.category]);

test("G22 toStored keeps every budget row's key and category", () => {
  const g = toStored(keyed());
  assert.deepEqual(keysCats(g), G20);
  assert.deepEqual(g.budget.rows[0], { item: "Meals and merienda, 2.5 days", estimate: "1,500 to 2,200", key: "meals", category: "food" });
});

test("G22 a stop move's body carries every budget row's key and category", () => {
  const moved = moveRow(toStored(keyed()), "d1-03", 2, null);
  assert.ok(moved, "the move applies");
  const body = JSON.parse(JSON.stringify({ guide: moved })) as { guide: GuideIn };
  assert.deepEqual(keysCats(body.guide), G20);
});

test("G22 a stored row from before the backfill goes up as it came, item and estimate only", () => {
  const g = toStored(fixture.out);
  assert.deepEqual(g.budget.rows, fixture.stored.budget.rows);
  assert.ok(g.budget.rows.every((r) => !("key" in r) && !("category" in r)));
});

test("G22 a row with a category and no key keeps its category", () => {
  const out = structuredClone(fixture.out);
  out.budget.rows[0] = { ...out.budget.rows[0], key: null, category: "food" };
  assert.deepEqual(toStored(out).budget.rows[0], { item: "Meals and merienda, 2.5 days", estimate: "1,500 to 2,200", category: "food" });
});

test("G22 editBudget: a new line has no key and carries its category", () => {
  const g = toStored(keyed());
  const out = editBudget(g, { add: { item: "Gas and tolls", estimate: "300", category: "transport" } });
  assert.deepEqual(out.budget.rows.at(-1), { item: "Gas and tolls", estimate: "300", category: "transport" });
  assert.deepEqual(keysCats(out).slice(0, 4), G20, "the other rows are untouched");
});

test("G22 editBudget: changing a line keeps its key, and its category unless one is given", () => {
  const g = toStored(keyed());
  const renamed = editBudget(g, { set: 0, row: { item: "Food, all of it", estimate: "2,000" } });
  assert.deepEqual(renamed.budget.rows[0], { item: "Food, all of it", estimate: "2,000", key: "meals", category: "food" });
  const moved = editBudget(g, { set: 1, row: { item: "Pasalubong and strawberries", estimate: "500 to 1,000", category: "food" } });
  assert.deepEqual(moved.budget.rows[1], { item: "Pasalubong and strawberries", estimate: "500 to 1,000", key: "pasalubong", category: "food" });
  assert.deepEqual(g.budget.rows[1].category, "other", "the guide it was given doesn't change");
});

test("G22 editBudget: removing a line takes its key with it", () => {
  const out = editBudget(toStored(keyed()), { remove: 3 });
  assert.deepEqual(keysCats(out), G20.slice(0, 3));
});

test("ux §4a: the line form starts at the line's category, Other when it has none, and empty for a new line", () => {
  const rows = keyed().budget.rows;
  assert.deepEqual(budgetFormStart(rows[0]), { item: "Meals and merienda, 2.5 days", estimate: "1,500 to 2,200", category: "food" });
  assert.deepEqual(budgetFormStart(fixture.out.budget.rows[0]), { item: "Meals and merienda, 2.5 days", estimate: "1,500 to 2,200", category: "other" });
  assert.deepEqual(budgetFormStart(null), { item: "", estimate: "", category: "" });
});

test("ux §4a: a listed line's category word, Other when it has none", () => {
  assert.equal(budgetCategoryWord("transport"), "Transport");
  assert.equal(budgetCategoryWord("activities"), "Activities");
  assert.equal(budgetCategoryWord(null), "Other");
  assert.equal(budgetCategoryWord(undefined), "Other");
});
