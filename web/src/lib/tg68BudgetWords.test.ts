// TG-68 part 4 (ux.md §4, TG-62 GW1 review N1 and N2): the removed line reads "Removed from the plan" in Changes and
// the feed (Details keeps its words), and the moved-line refusal names the category it moved to. Names are made up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { budgetRefusal, detailsLine, lineLabel } from "./budgetLines.ts";
import * as A from "./walletActivity.ts";
import type { Expense, Wallet, WalletBudget } from "./wallet.ts";

const BUDGET: WalletBudget = {
  trip_name: "Sagada barkada (made up)",
  lines: [
    { key: "meals", item: "Meals, 4 days", category: "food" },
    { key: "jeep", item: "Jeep to Echo Valley", category: "transport" },
    { key: "guide", item: "Cave guide", category: "other" },
    { key: "loose", item: "Pasalubong", category: null }, // no category: listed under Other
  ],
};
const refuse = budgetRefusal as (code: string | undefined, budget?: WalletBudget | null, key?: string | null, category?: string | null) => string | null;
const MOVED = (cat: string) => `That budget line is under ${cat} in the plan now. Pick the line again, or leave it for later.`;

const expense = (over: Partial<Expense>): Expense => ({
  id: "e-dinner", paid_by: "m-ana", amount_centavos: 90000, note: "Dinner", created_at: "2026-11-25T11:00:00Z",
  shares: [{ member_id: "m-ana", share_centavos: 90000 }], mode: "equal", inputs: [{ member_id: "m-ana", value: 1 }],
  items: [], charges: [], payers: [], category: "food", version: 1, updated_at: null, comment_count: 0, ...over,
});
const wallet = (over: Partial<Wallet>): Wallet => ({
  share_slug: "a".repeat(32), name: "Made-up trip", created_at: "2026-11-24T00:00:00Z",
  members: [{ id: "m-ana", name: "Ana" }, { id: "m-ben", name: "Ben" }], expenses: [], settlements: [], balances: [], transfers: [],
  total_centavos: 0, rev: 3, ...over,
});

test("TG68-N1a lineLabel: a key the plan no longer has reads `Removed from the plan`", () => {
  assert.equal(lineLabel(BUDGET, "van"), "Removed from the plan");
  assert.equal(lineLabel(BUDGET, "meals"), "Meals, 4 days", "a line on file: its item");
  assert.equal(lineLabel(BUDGET, "_none"), "Not in the budget");
  assert.equal(lineLabel(BUDGET, null), "Not sorted yet");
});

test("TG68-N1b Changes and the feed read it (ux §4's examples)", () => {
  const w = wallet({ budget: BUDGET });
  const v1 = expense({ budget_key: "van" }); // the plan no longer has it
  const v2 = { ...v1, budget_key: null, version: 2 };
  assert.equal(A.changeLine("Ana", A.changes(v1, v2, w)), "Ana changed the budget line: Removed from the plan → Not sorted yet.");
  const v3 = { ...v1, category: "transport" as const, budget_key: null, version: 2 };
  assert.match(A.changeLine("Ben", A.changes(v1, v3, w)), /\. The budget line: Removed from the plan → Not sorted yet\.$/);
});

test("TG68-N1c Details keeps `A line no longer in the plan`, as a meta line", () => {
  assert.deepEqual(detailsLine(BUDGET, "van"), { text: "A line no longer in the plan", meta: true });
});

test("TG68-N2a budget_line_category names the category the sent line is under now, from the answer's wallet", () => {
  assert.equal(refuse("budget_line_category", BUDGET, "guide"), MOVED("Other"));
  assert.equal(refuse("budget_line_category", BUDGET, "jeep"), MOVED("Transport"));
  assert.equal(refuse("budget_line_category", BUDGET, "meals"), MOVED("Food"));
  assert.equal(refuse("budget_line_category", BUDGET, "loose"), MOVED("Other"), "a line with no category is listed under Other");
});

test("TG68-N2b no wallet in the answer, or the key isn't in it: today's `under another category`", () => {
  const today = MOVED("another category");
  assert.equal(refuse("budget_line_category"), today);
  assert.equal(refuse("budget_line_category", null, "guide"), today);
  assert.equal(refuse("budget_line_category", BUDGET, "van"), today, "not in the reloaded wallet");
  assert.equal(refuse("budget_line_category", BUDGET, null), today);
  assert.equal(refuse("budget_line_category", BUDGET, "_none"), today);
});

test("TG68-N2c unknown_budget_line is unchanged, and anything else is still null", () => {
  const cases: [WalletBudget | undefined, string | undefined][] = [[undefined, undefined], [BUDGET, "guide"]];
  for (const [budget, key] of cases) {
    assert.equal(refuse("unknown_budget_line", budget, key), "That budget line isn't in the plan any more. Pick another, or leave it for later.");
    assert.equal(refuse("percent_total", budget, key), null);
  }
});

const view = () => readFileSync(new URL("../components/WalletView.tsx", import.meta.url), "utf8");
const lineRefusal = () => {
  const src = view();
  const i = src.indexOf("async function lineRefusal(");
  assert.ok(i > 0, "WalletView has lineRefusal");
  return src.slice(i, src.indexOf("\n  }\n", i));
};

test("TG68-N2d the add and the edit both word a line refusal through lineRefusal, with the lines and the key the form sent", () => {
  const src = view();
  assert.equal(src.split("await lineRefusal(r, body)").length - 1, 2, "the add and the edit");
  assert.match(lineRefusal(), /budgetRefusal\(answer\.detail, answer\.wallet\?\.budget, sentLine\(body\), sentCategory\(body\)\)/);
});

test("TG68-N2e GA1's budget_line_category answer carries no wallet (wallets.py _refuse), so the lines are read again first", () => {
  const fn = lineRefusal();
  assert.match(fn, /if \(!r\.wallet && r\.detail === "budget_line_category"\) \{/, "only when the answer has none, and only for the moved line");
  assert.match(fn, /await walletApi\.get\(slug\)/);
  assert.match(fn, /if \(fresh\.ok\) answer = \{ \.\.\.r, wallet: fresh\.wallet \};/, "a failed read keeps the fallback");
  assert.match(fn, /console\.info\("\[tg-wallet\] expense line reread ok=%s"/, "logged, with no key or name");
  assert.match(view(), /if \(lineAlert\) return refuseLine\(lineAlert\.text, lineAlert\.r\);/, "refuseLine lands the wallet read");
});

test("TG68-N2f named only when the read's category differs from the one the form sent: a stale copy says `another category`", () => {
  // tg-ux2's answer 3 (2026-11-21): the worker's saved copy can still list the old category; never `under Food` to Food
  const today = MOVED("another category");
  assert.equal(refuse("budget_line_category", BUDGET, "meals", "food"), today, "the read still lists the line under Food");
  assert.equal(refuse("budget_line_category", BUDGET, "jeep", "transport"), today);
  assert.equal(refuse("budget_line_category", BUDGET, "loose", "other"), today, "no category is listed under Other");
  assert.equal(refuse("budget_line_category", BUDGET, "loose", null), today, "no category sent, none in the read");
  assert.equal(refuse("budget_line_category", BUDGET, "guide", null), today, "no category sent reads as Other too");
  assert.equal(refuse("budget_line_category", BUDGET, "guide", "food"), MOVED("Other"), "it differs: named");
  assert.equal(refuse("budget_line_category", BUDGET, "meals", "hotel"), MOVED("Food"));
  assert.equal(refuse("budget_line_category", BUDGET, "meals", null), MOVED("Food"), "no category sent: the plan's Food differs");
});

test("TG68-N2g sentCategory: the category a body sent, as the API reads it (missing is none)", async () => {
  const L = (await import("./budgetLines.ts")) as Record<string, unknown>;
  const sent = L.sentCategory as (body: object) => string | null;
  assert.equal(typeof sent, "function", "budgetLines exports sentCategory");
  assert.equal(sent({ note: "Dinner", category: "food", budget_key: "meals" }), "food");
  assert.equal(sent({ note: "Dinner", category: null, budget_key: "meals" }), null);
  assert.equal(sent({ note: "Dinner", budget_key: "meals" }), null, "today's body has none");
});
