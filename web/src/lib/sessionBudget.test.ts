// TG-62 G0: the Budget panel's types and client (plan §2), and the budget fields on the wallet and guide types.
// Run with `npm test` (node --test, Node 22.18+ type stripping). The type-only checks below are checked by `tsc --noEmit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionBudget } from "./sessionBudget.ts";
import type { Expense, ExpenseBodyV2, ExpensePatch, Wallet, WalletBudget } from "./wallet.ts";
import type { Guide } from "./guide.ts";

const SLUG = "a".repeat(32);

// ---------------------------------------------------------------- the shapes (tsc checks these against the types)

const OK: SessionBudget = {
  state: "ok",
  member_count: 4,
  total_centavos: 1_800_000,
  lines: [
    { key: "meals", item: "E2E meals", estimate: "1,500 to 2,200", min: 1500, max: 2200, readable: true, spent: 1_200_000, spent_each: 300_000 },
    { key: "misc", item: "E2E misc", estimate: "depends", min: null, max: null, readable: false, spent: 0, spent_each: 0 },
  ],
  not_in_budget: { count: 1, spent: 400_000 },
  unsorted: { count: 2, spent: 200_000, removed: 1 },
  members: [{ member_id: "m1", name: "Ana", share_lines: 300_000, share_total: 450_000 }],
};
const TWO_TRIPS: SessionBudget = { state: "two_trips", member_count: 3, total_centavos: 900, lines: [], not_in_budget: null, unsorted: null, members: [] };
const NO_WALLET: SessionBudget = { state: "no_wallet", member_count: 0, total_centavos: 0, lines: [], not_in_budget: null, unsorted: null, members: [] };

const BUDGET: WalletBudget = { trip_name: "E2E trip", lines: [{ key: "meals", item: "E2E meals", category: "food" }, { key: "misc", item: "E2E misc", category: null }] };
const EXPENSE: Pick<Expense, "budget_key"> = { budget_key: "_none" };
const WALLET: Pick<Wallet, "budget"> = { budget: BUDGET };
const OLD_WALLET: Pick<Wallet, "budget"> = {}; // a wallet saved before TG-62 has no budget
const ADD: ExpenseBodyV2 = { mode: "equal", paid_by: "a", amount_centavos: 1000, note: "E2E", inputs: [{ member_id: "a", value: 1 }], category: "food", budget_key: "meals" };
const EDIT: ExpensePatch = { ...ADD, budget_key: null, version: 2 };
const OLD_ADD: ExpenseBodyV2 = { mode: "equal", paid_by: "a", amount_centavos: 1000, note: "E2E", inputs: [{ member_id: "a", value: 1 }] }; // no budget_key: G27
const ROW: Guide["budget"]["rows"][number] = { item: "E2E meals", estimate: "1,500", key: "meals", category: "food" };
const OLD_ROW: Guide["budget"]["rows"][number] = { item: "E2E meals", estimate: "1,500" }; // a plan stored before the backfill

test("the typed fixtures are what the API sends", () => {
  assert.equal(OK.lines.length, 2);
  assert.deepEqual([TWO_TRIPS.lines, NO_WALLET.members], [[], []]);
  assert.equal(EXPENSE.budget_key, "_none");
  assert.equal(WALLET.budget?.lines[1].category, null);
  assert.equal(OLD_WALLET.budget, undefined);
  assert.equal(EDIT.budget_key, null);
  assert.ok(!("budget_key" in OLD_ADD));
  assert.deepEqual([ROW.key, OLD_ROW.key], ["meals", undefined]);
});

// ---------------------------------------------------------------- getBudget

type Sent = { url: string; method: string; cache: RequestCache | undefined };
async function withFetch<T>(answer: Response | Error, run: (sent: Sent[]) => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  const sent: Sent[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url, method: init?.method ?? "GET", cache: init?.cache });
    if (answer instanceof Error) throw answer;
    return answer;
  }) as typeof fetch;
  try {
    return await run(sent);
  } finally {
    globalThis.fetch = real;
  }
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("getBudget: a GET of the trip's budget, never cached by the browser", async () => {
  const { getBudget } = await import("./sessionBudget.ts");
  const { API_URL } = await import("./api.ts");
  await withFetch(json(200, OK), async (sent) => {
    assert.deepEqual(await getBudget(SLUG), { ok: true, budget: OK });
    assert.deepEqual(sent, [{ url: `${API_URL}/sessions/${SLUG}/budget`, method: "GET", cache: "no-store" }]);
  });
});

test("getBudget: the slug is encoded", async () => {
  const { getBudget } = await import("./sessionBudget.ts");
  await withFetch(json(200, TWO_TRIPS), async (sent) => {
    assert.deepEqual(await getBudget("a/b?c"), { ok: true, budget: TWO_TRIPS });
    assert.ok(sent[0].url.endsWith("/sessions/a%2Fb%3Fc/budget"), sent[0].url);
  });
});

test("getBudget: no signal is offline", async () => {
  const { getBudget } = await import("./sessionBudget.ts");
  await withFetch(new TypeError("Failed to fetch"), async () => {
    assert.deepEqual(await getBudget(SLUG), { ok: false, why: "offline" });
  });
});

test("getBudget: the flag off is 404 feature_off, which is off", async () => {
  const { getBudget } = await import("./sessionBudget.ts");
  await withFetch(json(404, { detail: "feature_off" }), async () => {
    assert.deepEqual(await getBudget(SLUG), { ok: false, why: "off" });
  });
});

test("getBudget: any other refusal or a bad answer is failed", async () => {
  const { getBudget } = await import("./sessionBudget.ts");
  const answers = [
    json(404, { detail: "Not Found" }), // an unknown trip (TG-58's 404)
    json(404, null),
    new Response("not json", { status: 404 }),
    json(422, { detail: [{ msg: "x" }] }),
    json(429, { detail: "rate_limited" }),
    json(500, { detail: "boom" }),
    json(503, null),
    new Response("not json", { status: 200 }),
  ];
  for (const answer of answers) {
    await withFetch(answer, async () => {
      assert.deepEqual(await getBudget(SLUG), { ok: false, why: "failed" }, String(answer.status));
    });
  }
});
