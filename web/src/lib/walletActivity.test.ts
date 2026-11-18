// TG-66 W2: the activity list, an expense's Changes and Comments, and the expense's own words (split, payers), web side.
// Run with `npm test` (node --test, Node 22.18+ type stripping). Plan §3 B23, B24, B24a, B24b; ux.md §5 and §8.
// Web has no component runner, so the three components are checked by source here; W3 wires them and runs them end to end.
// Names, notes and amounts are made up. The module is imported dynamically, so before it exists each test fails on its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Activity, Expense, Wallet } from "./wallet.ts";

type Mod = typeof import("./walletActivity.ts");
const A = (await import("./walletActivity.ts").catch(() => ({}))) as Mod;

const WEB = new URL("../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, WEB), "utf8").replaceAll("&apos;", "'");

const ANA = "m-ana";
const BEN = "m-ben";
const CARLA = "m-carla";
const DAN = "m-dan";
const E1 = "e-lunch";
const S1 = "s-dan-ana";

function expense(over: Partial<Expense> = {}): Expense {
  return {
    id: E1,
    paid_by: ANA,
    amount_centavos: 128000,
    note: "Lunch at Good Taste",
    created_at: "2026-11-06T05:02:00Z", // Fri, Nov 6, 1:02 PM in Manila
    shares: [ANA, BEN, CARLA, DAN].map((m) => ({ member_id: m, share_centavos: 32000 })),
    mode: "equal",
    inputs: [ANA, BEN, CARLA, DAN].map((m) => ({ member_id: m, value: 1 })),
    items: [],
    charges: [],
    payers: [],
    category: null,
    version: 1,
    updated_at: null,
    comment_count: 0,
    ...over,
  };
}

function wallet(over: Partial<Wallet> = {}): Wallet {
  return {
    share_slug: "a".repeat(32),
    name: "Made-up trip",
    created_at: "2026-11-05T00:00:00Z",
    members: [
      { id: ANA, name: "Ana" },
      { id: BEN, name: "Ben" },
      { id: CARLA, name: "Carla" },
      { id: DAN, name: "Dan" },
    ],
    expenses: [expense()],
    settlements: [{ id: S1, from_member: DAN, to_member: ANA, amount_centavos: 65000, created_at: "2026-11-08T08:12:00Z", has_proof: true }],
    balances: [],
    transfers: [],
    total_centavos: 128000,
    rev: 9,
    ...over,
  };
}

/** The activity row's snapshot of an expense (options §5): the expense's own fields, never a comment. */
const snap = (e: Expense) => ({
  amount_centavos: e.amount_centavos,
  note: e.note,
  category: e.category ?? null,
  paid_by: e.paid_by,
  payers: e.payers ?? [],
  mode: e.mode ?? null,
  inputs: e.inputs ?? [],
  items: e.items ?? [],
  charges: e.charges ?? [],
  shares: e.shares,
  version: e.version ?? 1,
});

let nextId = 1;
function row(over: Partial<Activity>): Activity {
  return {
    id: nextId++,
    at: "2026-11-06T05:02:00Z",
    actor: null,
    action: "expense_add",
    expense_id: null,
    settlement_id: null,
    member_id: null,
    before: null,
    after: null,
    ...over,
  };
}

const shares = (pairs: [string, number][]) => pairs.map(([member_id, share_centavos]) => ({ member_id, share_centavos }));
const inputs = (pairs: [string, number][]) => pairs.map(([member_id, value]) => ({ member_id, value }));

// The ux.md 66-04-items bill, as plan §2 pins it
const ITEMIZED = expense({
  note: "Dinner at Hill Station",
  mode: "itemized",
  amount_centavos: 118800,
  inputs: [],
  items: [
    { seq: 1, name: "Pinikpikan", price_centavos: 42000, who: [BEN, ANA] },
    { seq: 2, name: "Strawberry taho", price_centavos: 12000, who: [CARLA] },
    { seq: 3, name: "Grilled tilapia", price_centavos: 38000, who: [DAN, CARLA, BEN] },
    { seq: 4, name: "Rice", price_centavos: 16000, who: [ANA, BEN, CARLA, DAN] },
  ],
  charges: [{ kind: "service", basis: "percent", value: 1000 }],
  shares: shares([[ANA, 27501], [BEN, 41434], [CARLA, 31533], [DAN, 18332]]),
});
const SHARES_221 = expense({
  mode: "shares",
  inputs: inputs([[CARLA, 1], [ANA, 2], [DAN, 0], [BEN, 2]]), // out of wallet order on purpose
  shares: shares([[ANA, 51200], [BEN, 51200], [CARLA, 25600], [DAN, 0]]),
  payers: [{ member_id: BEN, paid_centavos: 48000 }, { member_id: ANA, paid_centavos: 80000 }],
  version: 3,
  comment_count: 2,
  category: "food",
});

// ---------------------------------------------------------------- the expense's own words

test("TG66-W2-1 the card's split words, per mode; ratios and people in wallet order (ux §5)", () => {
  const w = wallet();
  assert.equal(A.splitLabel(expense(), w), "Equally among 4");
  assert.equal(A.splitLabel(SHARES_221, w), "Shares 2:2:1", "a 0 share isn't in the ratio");
  assert.equal(A.splitLabel(ITEMIZED, w), "Items, 4 · service 10%");
  assert.equal(
    A.splitLabel(expense({ mode: "itemized", items: ITEMIZED.items, charges: [{ kind: "service", basis: "percent", value: 1000 }, { kind: "vat", basis: "amount", value: 12000 }] }), w),
    "Items, 4 · service 10% · VAT ₱120",
  );
  assert.equal(A.splitLabel(expense({ mode: "exact", inputs: inputs([[ANA, 100000], [BEN, 28000]]) }), w), "Amounts");
  assert.equal(A.splitLabel(expense({ mode: "percent", inputs: inputs([[BEN, 3000], [ANA, 4000], [CARLA, 3000]]) }), w), "Percent 40:30:30");
  assert.equal(A.splitLabel(expense({ mode: "percent", inputs: inputs([[ANA, 3333], [BEN, 3333], [CARLA, 3334]]) }), w), "Percent 33.33:33.33:33.34");
  assert.equal(A.splitLabel(expense({ mode: "adjust", inputs: inputs([[ANA, 20000], [BEN, 0]]) }), w), "Equal + extra");
});

test("TG66-W2-2 a legacy expense (no mode) reads as Equally when its shares are the equal split of its people, else Amounts (B22's rule)", () => {
  const w = wallet();
  const legacy = (s: [string, number][], amount: number, paid_by = ANA) =>
    expense({ mode: undefined, inputs: undefined, items: undefined, charges: undefined, payers: undefined, version: undefined, amount_centavos: amount, paid_by, shares: shares(s) });
  assert.equal(A.splitLabel(legacy([[ANA, 334], [BEN, 333], [CARLA, 333]], 1000), w), "Equally among 3");
  assert.equal(A.splitLabel(legacy([[BEN, 334], [ANA, 333], [CARLA, 333]], 1000, BEN), w), "Equally among 3", "the payer's odd centavo is still equal");
  assert.equal(A.splitLabel(legacy([[ANA, 333], [BEN, 334], [CARLA, 333]], 1000), w), "Amounts", "the odd centavo on the wrong person isn't the equal split");
  assert.equal(A.splitLabel(legacy([[ANA, 70000], [BEN, 30000]], 100000), w), "Amounts");
});

test("TG66-W2-3 the card's meta line: the split, then edited, then the comment count (ux §5, §11)", () => {
  const w = wallet();
  assert.equal(A.cardMeta(SHARES_221, w), "Shares 2:2:1 · edited · 2 comments");
  assert.equal(A.cardMeta(expense(), w), "Equally among 4");
  assert.equal(A.cardMeta(expense({ comment_count: 1 }), w), "Equally among 4 · 1 comment");
  assert.equal(A.cardMeta(expense({ version: 2 }), w), "Equally among 4 · edited");
  assert.deepEqual([1, 2, 3, 4, 7].map(A.editedWords), ["", "edited", "edited twice", "edited 3 times", "edited 6 times"]);
  assert.deepEqual([0, 1, 2].map(A.commentsWords), ["", "1 comment", "2 comments"]);
});

test("TG66-W2-4 Paid by: one name, two, or two and N more; the details give each payer's amount (ux §4)", () => {
  const w = wallet();
  assert.equal(A.payersWords(expense(), w), "Ana");
  assert.equal(A.payersWords(SHARES_221, w), "Ana and Ben", "wallet order, not the payers' order");
  assert.equal(A.payersDetail(SHARES_221, w), "Ana ₱800 and Ben ₱480");
  assert.equal(A.payersDetail(expense(), w), "Ana");
  const three = expense({ payers: [{ member_id: CARLA, paid_centavos: 38000 }, { member_id: ANA, paid_centavos: 50000 }, { member_id: BEN, paid_centavos: 40000 }] });
  assert.equal(A.payersWords(three, w), "Ana, Ben and 1 more");
  assert.equal(A.payersDetail(three, w), "Ana ₱500, Ben ₱400 and Carla ₱380");
  assert.equal(A.payersWords(expense({ paid_by: "m-gone" }), w), "Someone");
});

test("TG66-W2-5 the details' split heading and one row per person, per mode (ux §5)", () => {
  const w = wallet();
  const rows = (e: Expense) => A.splitRows(e, w).map((r) => `${r.name}: ${r.detail}`);
  assert.equal(A.splitHeading(SHARES_221, w), "Split by shares, 5 in all");
  assert.deepEqual(rows(SHARES_221), ["Ana: 2 shares · ₱512", "Ben: 2 shares · ₱512", "Carla: 1 share · ₱256", "Dan: 0 shares · ₱0"]);

  const among3 = expense({ amount_centavos: 96000, inputs: inputs([[ANA, 1], [CARLA, 1], [BEN, 1]]), shares: shares([[ANA, 32000], [BEN, 32000], [CARLA, 32000]]) });
  assert.equal(A.splitHeading(among3, w), "Split equally among 3");
  assert.deepEqual(rows(among3), ["Ana: ₱320", "Ben: ₱320", "Carla: ₱320"], "only the people in it");

  const pct = expense({ mode: "percent", inputs: inputs([[ANA, 4000], [BEN, 4000], [CARLA, 2000]]), shares: shares([[ANA, 51200], [BEN, 51200], [CARLA, 25600]]) });
  assert.equal(A.splitHeading(pct, w), "Split by percent");
  assert.deepEqual(rows(pct), ["Ana: 40% · ₱512", "Ben: 40% · ₱512", "Carla: 20% · ₱256"]);

  const adj = expense({ amount_centavos: 100000, mode: "adjust", inputs: inputs([[ANA, 20000], [BEN, 0], [CARLA, -5000]]), shares: shares([[ANA, 48334], [BEN, 28333], [CARLA, 23333]]) });
  assert.equal(A.splitHeading(adj, w), "Split equally, plus extras");
  assert.deepEqual(rows(adj), ["Ana: +₱200 · ₱483.34", "Ben: ₱283.33", "Carla: −₱50 · ₱233.33"]);

  const exact = expense({ mode: "exact", inputs: inputs([[ANA, 100000], [BEN, 28000]]), shares: shares([[ANA, 100000], [BEN, 28000]]) });
  assert.equal(A.splitHeading(exact, w), "Split by amounts");
  assert.deepEqual(rows(exact), ["Ana: ₱1,000", "Ben: ₱280"]);

  assert.equal(A.splitHeading(ITEMIZED, w), "Split by items");
  assert.deepEqual(rows(ITEMIZED), ["Ana: ₱275.01", "Ben: ₱414.34", "Carla: ₱315.33", "Dan: ₱183.32"]);
});

test("TG66-W2-6 an itemized bill lists its items, people in wallet order, then its charges as written (ux §3, §5)", () => {
  const w = wallet();
  assert.deepEqual(A.itemRows(ITEMIZED, w), [
    "Pinikpikan ₱420 · Ana, Ben",
    "Strawberry taho ₱120 · Carla",
    "Grilled tilapia ₱380 · Ben, Carla, Dan",
    "Rice ₱160 · Ana, Ben, Carla, Dan",
  ]);
  assert.equal(A.chargeLabel({ kind: "service", basis: "percent", value: 1000 }), "Service charge 10%");
  assert.equal(A.chargeLabel({ kind: "service", basis: "percent", value: 1250 }), "Service charge 12.5%");
  assert.equal(A.chargeLabel({ kind: "vat", basis: "amount", value: 12000 }), "VAT, other charges ₱120");
});

// ---------------------------------------------------------------- Changes (B23)

const deepFreeze = <T,>(o: T): T => {
  if (o && typeof o === "object") {
    Object.values(o).forEach(deepFreeze);
    Object.freeze(o);
  }
  return o;
};

test("TG66-W2-7 B23: Changes is a pure diff of before and after, one entry per field, in ux §5's order", () => {
  const w = wallet();
  const before = deepFreeze(snap(expense({ amount_centavos: 118000, shares: shares([[ANA, 29500], [BEN, 29500], [CARLA, 29500], [DAN, 29500]]) })));
  const after = deepFreeze(snap(expense()));
  assert.deepEqual(A.changes(before, after, w), [{ field: "amount", before: "₱1,180", after: "₱1,280" }], "an equal split's shares follow the amount: not a split change");
  assert.deepEqual(A.changes(after, after, w), []);

  const toShares = A.changes(after, snap(SHARES_221), w).map((c) => [c.field, c.before, c.after]);
  assert.deepEqual(toShares, [
    ["category", "No category yet", "Food"],
    ["split", "Equally", "Shares 2:2:1"],
    ["payers", "Ana", "Ana and Ben"],
  ]);

  const among3 = snap(expense({ inputs: inputs([[ANA, 1], [BEN, 1], [CARLA, 1]]) }));
  assert.deepEqual(A.changes(after, among3, w), [{ field: "split", before: "Equally among 4", after: "Equally among 3" }], "same mode: the full words");

  const exactA = snap(expense({ mode: "exact", inputs: inputs([[ANA, 100000], [BEN, 28000]]) }));
  const exactB = snap(expense({ mode: "exact", inputs: inputs([[ANA, 90000], [BEN, 38000]]) }));
  assert.deepEqual(A.changes(exactA, exactB, w), [{ field: "split" }], "the same words both sides: the field, with no arrow");

  const everything = A.changes(
    snap(expense({ amount_centavos: 108000, note: "Lunch", mode: "itemized", inputs: [], items: ITEMIZED.items!.slice(0, 3), charges: [] })),
    snap(expense({ amount_centavos: 118800, note: "Dinner at Hill Station", category: "food", mode: "itemized", inputs: [], items: ITEMIZED.items, charges: ITEMIZED.charges, paid_by: BEN })),
    w,
  );
  assert.deepEqual(everything, [
    { field: "amount", before: "₱1,080", after: "₱1,188" },
    { field: "note", before: '"Lunch"', after: '"Dinner at Hill Station"' },
    { field: "category", before: "No category yet", after: "Food" },
    { field: "payers", before: "Ana", after: "Ben" },
    { field: "items", before: "3 items, ₱920", after: "4 items, ₱1,080" },
    { field: "charges", before: "none", after: "service 10%" },
  ]);
});

test("TG66-W2-8 B23: a legacy expense's first edit diffs from its inferred mode, so saving it unchanged as Equally is no split change", () => {
  const w = wallet();
  const legacy = { ...snap(expense()), mode: null, inputs: [] };
  assert.deepEqual(A.changes(legacy, snap(expense()), w), []);
  assert.deepEqual(A.changes(legacy, snap(expense({ note: "Lunch, Good Taste" })), w), [{ field: "note", before: '"Lunch at Good Taste"', after: '"Lunch, Good Taste"' }]);
  const legacyExact = { ...snap(expense({ shares: shares([[ANA, 70000], [BEN, 58000]]) })), mode: null, inputs: [] };
  assert.deepEqual(A.changes(legacyExact, snap(expense({ mode: "exact", inputs: inputs([[ANA, 70000], [BEN, 58000]]), shares: shares([[ANA, 70000], [BEN, 58000]]) })), w), []);
});

test("TG66-W2-9 a Changes line: up to 2 fields, then ', and N more change(s)' (ux §5)", () => {
  const two = [{ field: "split", before: "Equally", after: "Shares 2:2:1" }, { field: "payers", before: "Ana", after: "Ana and Ben" }] as const;
  assert.equal(A.changeLine("Ben", [...two]), "Ben changed the split: Equally → Shares 2:2:1. Paid by: Ana → Ana and Ben.");
  const amount = { field: "amount", before: "₱1,180", after: "₱1,280" } as const;
  const note = { field: "note", before: '"Lunch"', after: '"Lunch at Good Taste"' } as const;
  assert.equal(A.changeLine("Ana", [amount]), "Ana changed the amount: ₱1,180 → ₱1,280.");
  assert.equal(A.changeLine("Ana", [amount, note, two[0]]), 'Ana changed the amount: ₱1,180 → ₱1,280. The note: "Lunch" → "Lunch at Good Taste", and 1 more change.');
  assert.equal(A.changeLine("Ana", [amount, note, ...two]), 'Ana changed the amount: ₱1,180 → ₱1,280. The note: "Lunch" → "Lunch at Good Taste", and 2 more changes.');
  assert.equal(A.changeLine("Ana", [{ field: "split" }]), "Ana changed the split.");
  assert.equal(A.changeLine("Ana", [amount, { field: "items" }]), "Ana changed the amount: ₱1,180 → ₱1,280. The items changed.");
});

test("TG66-W2-10 an expense's Changes, newest first, ending with 'added it'; a legacy expense shows only its edits", () => {
  const w = wallet({ expenses: [SHARES_221] });
  const v1 = expense({ amount_centavos: 118000, shares: shares([[ANA, 29500], [BEN, 29500], [CARLA, 29500], [DAN, 29500]]) });
  const v2 = expense({ version: 2 });
  const v3 = SHARES_221;
  const add = row({ action: "expense_add", actor: BEN, expense_id: E1, at: "2026-11-06T05:02:00Z", after: snap(v1) });
  const edit1 = row({ action: "expense_edit", actor: ANA, expense_id: E1, at: "2026-11-06T05:10:00Z", before: snap(v1), after: snap(v2) });
  const edit2 = row({ action: "expense_edit", actor: BEN, expense_id: E1, at: "2026-11-06T05:40:00Z", before: snap(v2), after: snap(v3) });
  const other = row({ action: "expense_add", actor: DAN, expense_id: "e-other", after: snap(expense({ note: "Taxi" })) });
  const comment = row({ action: "comment_add", actor: CARLA, expense_id: E1 });
  const page = [comment, edit2, other, edit1, add].sort((a, b) => b.id - a.id);

  const lines = A.historyLines(page, SHARES_221, w).map((l) => [`${l.who} ${l.rest}`, A.dayTime(l.at)]);
  assert.deepEqual(lines, [
    ["Ben changed the category: No category yet → Food. The split: Equally → Shares 2:2:1, and 1 more change.", "Fri, Nov 6, 1:40 PM"],
    ["Ana changed the amount: ₱1,180 → ₱1,280.", "Fri, Nov 6, 1:10 PM"],
    ["Ben added it: ₱1,180, Equally among 4.", "Fri, Nov 6, 1:02 PM"],
  ]);
  assert.deepEqual(A.historyLines([edit2, edit1], SHARES_221, w).map((l) => l.who), ["Ben", "Ana"], "no add row: only the edits");
  assert.equal(A.historyLines([row({ ...add, id: 999, actor: null })], v1, w)[0].who, "Someone");
});

test("TG66-W2-11 the details' Added line: who added it when the history is loaded, the Manila time, and the edit count", () => {
  const w = wallet({ expenses: [SHARES_221] });
  const add = row({ action: "expense_add", actor: BEN, expense_id: E1, after: snap(SHARES_221) });
  assert.equal(A.addedLine(SHARES_221, [add], w), "Added by Ben, Fri, Nov 6, 1:02 PM · edited twice");
  assert.equal(A.addedLine(SHARES_221, null, w), "Added Fri, Nov 6, 1:02 PM · edited twice", "offline, or not loaded yet");
  assert.equal(A.addedLine(expense(), [], w), "Added Fri, Nov 6, 1:02 PM", "a legacy expense has no add row");
  assert.equal(A.addedLine(expense(), [{ ...add, actor: null }], w), "Added by Someone, Fri, Nov 6, 1:02 PM");
});

// ---------------------------------------------------------------- the activity list (ux §8)

test("TG66-W2-12 one line per action, in ux §8's words; the who is its own part; never a comment's text", () => {
  const deleted = snap(expense({ id: "e-ice", note: "Ice cream", amount_centavos: 12000 }));
  const delRow = row({ action: "expense_delete", actor: ANA, expense_id: "e-ice", before: deleted });
  const w = wallet();
  const known = [delRow];
  const text = (r: Activity) => A.lineText(A.activityLine(r, w, known));
  const pay = { from_member: DAN, to_member: ANA, amount_centavos: 65000 };
  const v1 = snap(expense({ amount_centavos: 118000 }));

  assert.equal(text(row({ action: "expense_add", actor: BEN, expense_id: E1, after: v1 })), "Ben added Lunch at Good Taste, ₱1,180.");
  assert.equal(text(row({ action: "expense_edit", actor: ANA, expense_id: E1, before: v1, after: snap(expense()) })), "Ana changed Lunch at Good Taste: amount ₱1,180 → ₱1,280.");
  assert.equal(
    text(row({ action: "expense_edit", actor: BEN, expense_id: E1, before: snap(expense()), after: snap({ ...SHARES_221, category: null }) })),
    "Ben changed Lunch at Good Taste: split Equally → Shares 2:2:1, and 1 more change.",
  );
  assert.equal(text(delRow), "Ana deleted Ice cream, ₱120.");
  assert.equal(text(row({ action: "comment_add", actor: CARLA, expense_id: E1 })), "Carla commented on Lunch at Good Taste.");
  assert.equal(text(row({ action: "comment_delete", actor: BEN, expense_id: E1 })), "Ben deleted a comment on Lunch at Good Taste.");
  assert.equal(text(row({ action: "comment_add", actor: BEN, expense_id: "e-ice" })), "Ben commented on Ice cream.", "a deleted expense's note from its delete row");
  assert.equal(text(row({ action: "comment_add", actor: BEN, expense_id: "e-unknown" })), "Ben commented on an expense that was deleted.");
  assert.equal(text(row({ action: "settle", actor: DAN, settlement_id: S1, after: pay })), "Dan marked a payment: Dan paid Ana ₱650, with proof.");
  assert.equal(text(row({ action: "settle_undo", actor: ANA, settlement_id: S1, after: pay })), "Ana undid a payment: Dan paid Ana ₱650.");
  assert.equal(text(row({ action: "proof_add", actor: DAN, settlement_id: S1, after: pay })), "Dan added proof for Dan paid Ana ₱650.");
  assert.equal(text(row({ action: "proof_change", actor: DAN, settlement_id: S1, after: pay })), "Dan changed the proof for Dan paid Ana ₱650.");
  assert.equal(text(row({ action: "proof_remove", actor: DAN, settlement_id: S1, after: pay })), "Dan removed the proof for Dan paid Ana ₱650.");
  assert.equal(text(row({ action: "member_join", member_id: DAN })), "Dan joined the wallet.");
  assert.equal(text(row({ action: "expense_add", actor: null, expense_id: E1, after: v1 })), "Someone added Lunch at Good Taste, ₱1,180.");
  assert.equal(text(row({ action: "expense_add", actor: "m-not-here", expense_id: E1, after: v1 })), "Someone added Lunch at Good Taste, ₱1,180.");

  const line = A.activityLine(row({ action: "expense_add", actor: BEN, expense_id: E1, after: v1 }), w, known);
  assert.equal(line.who, "Ben");
  const link = line.segs.find((s) => typeof s !== "string");
  assert.deepEqual(link, { note: "Lunch at Good Taste", expenseId: E1 }, "a live expense's note opens its details");
  assert.ok(A.activityLine(delRow, w, known).segs.every((s) => typeof s === "string"), "a deleted expense's note is plain text");
});

test("TG66-W2-13 B24b: ', with proof' comes from the settlement as it is now, and goes once the payment is undone", () => {
  const pay = { from_member: DAN, to_member: ANA, amount_centavos: 65000 };
  const settle = row({ action: "settle", actor: DAN, settlement_id: S1, after: pay });
  const line = (w: Wallet) => A.lineText(A.activityLine(settle, w, []));
  assert.equal(line(wallet()), "Dan marked a payment: Dan paid Ana ₱650, with proof.");
  assert.equal(line(wallet({ settlements: [] })), "Dan marked a payment: Dan paid Ana ₱650.", "undone");
  assert.equal(line(wallet({ settlements: [{ ...wallet().settlements[0], has_proof: false }] })), "Dan marked a payment: Dan paid Ana ₱650.", "no proof now");
});

test("TG66-W2-14 B24: the list groups by Manila day, newest first, with Manila times", () => {
  const late = row({ id: 50, at: "2026-11-07T16:30:00Z" }); // Sun, Nov 8, 12:30 AM in Manila
  const evening = row({ id: 49, at: "2026-11-07T15:59:00Z" }); // Sat, Nov 7, 11:59 PM
  const morning = row({ id: 48, at: "2026-11-07T01:15:00Z" }); // Sat, Nov 7, 9:15 AM
  const groups = A.groupByDay([late, evening, morning]);
  assert.deepEqual(groups.map((g) => [g.label, g.rows.map((r) => r.id)]), [["Sun, Nov 8", [50]], ["Sat, Nov 7", [49, 48]]]);
  assert.deepEqual([late, evening, morning].map((r) => A.timeOnly(r.at)), ["12:30 AM", "11:59 PM", "9:15 AM"]);
  assert.deepEqual(A.groupByDay([]), []);
});

const page = (from: number, to: number, at = "2026-11-07T01:00:00Z") => Array.from({ length: from - to + 1 }, (_, i) => row({ id: from - i, at }));
const ids = (s: { rows: Activity[] }) => s.rows.map((r) => r.id);

test("TG66-W2-15 B24: pages merge newest first with no duplicates; a short page means there's nothing older", () => {
  assert.equal(A.ACTIVITY_PAGE, 15);
  const first = A.mergeActivity(null, { rev: 30, rows: page(30, 16) }, false);
  assert.deepEqual([ids(first).length, first.rev, first.more], [15, 30, true]);
  assert.equal(A.oldestId(first), 16);
  const older = A.mergeActivity(first, { rev: 30, rows: page(17, 3) }, true); // overlaps 17 and 16
  assert.deepEqual(ids(older), page(30, 3).map((r) => r.id));
  assert.equal(older.more, true);
  const last = A.mergeActivity(older, { rev: 30, rows: page(2, 1) }, true);
  assert.deepEqual([ids(last).length, last.more, A.oldestId(last)], [30, false, 1]);
  assert.equal(A.mergeActivity(null, { rev: 3, rows: page(3, 1) }, false).more, false);
  assert.equal(A.oldestId(A.mergeActivity(null, { rev: 0, rows: [] }, false)), undefined);
  // A refresh after a write brings the newest rows, and keeps the older pages already on screen
  const fresh = A.mergeActivity(last, { rev: 32, rows: page(32, 18) }, false);
  assert.deepEqual([ids(fresh)[0], ids(fresh).length, fresh.rev, fresh.more], [32, 32, 32, false]);
});

test("TG66-W2-16 B24: an older answer never replaces newer rows (the TG-54/65 rule)", () => {
  const now = A.mergeActivity(null, { rev: 32, rows: page(32, 18) }, false);
  const stale = A.mergeActivity(now, { rev: 30, rows: page(30, 16) }, false);
  assert.equal(stale.rev, 32);
  assert.deepEqual(ids(stale).slice(0, 2), [32, 31], "the newer rows stay");
  assert.equal(stale, now, "a lower rev changes nothing, so React keeps the same state");
});

test("TG66-W2-17 B24a: a comment list is replaced only by an answer with rev ≥ its own, so a deleted comment never comes back", () => {
  const c = (id: string, body: string) => ({ id, expense_id: E1, author: CARLA, body, created_at: "2026-11-06T05:38:00Z" });
  const c1 = c("c1", "TESTCOMMENT one");
  const c2 = c("c2", "TESTCOMMENT two");
  const loaded = A.mergeComments(null, { rev: 7, comments: [c1, c2] });
  const afterDelete = A.mergeComments(loaded, A.commentsFromWrite({ wallet: wallet({ rev: 8 }), comments: [c1] }));
  assert.deepEqual(afterDelete, { rev: 8, comments: [c1] });
  const oldGet = A.mergeComments(afterDelete, { rev: 7, comments: [c1, c2] }); // left before the delete, landed after it
  assert.equal(oldGet, afterDelete, "the deleted comment doesn't come back");
  const c3 = c("c3", "TESTCOMMENT three");
  assert.deepEqual(A.mergeComments(afterDelete, { rev: 8, comments: [c1, c3] }).comments, [c1, c3], "an equal rev replaces (>=, not >)");
  assert.deepEqual(A.mergeComments(afterDelete, { rev: 9, comments: [c1, c2] }).comments, [c1, c2], "a newer one replaces");
  assert.equal(A.commentsFromWrite({ wallet: wallet({ rev: undefined }), comments: [] }).rev, 0);
});

test("TG66-W2-18 the comment box counts down only from 250, by characters as the server counts them (ux §5)", () => {
  assert.equal(A.COMMENT_MAX, 300);
  assert.equal(A.commentsLeft("x".repeat(249)), "");
  assert.equal(A.commentsLeft("x".repeat(250)), "50 left");
  assert.equal(A.commentsLeft("x".repeat(288)), "12 left");
  assert.equal(A.commentsLeft("x".repeat(300)), "0 left");
  assert.equal(A.commentsLeft("🙂".repeat(290)), "10 left", "one emoji is one character for the server");
  assert.equal(A.commentTooLong("🙂".repeat(300)), false);
  assert.equal(A.commentTooLong("x".repeat(301)), true);
});

// ---------------------------------------------------------------- loading one expense's history (plan §2 addendum)

type Answer = Awaited<ReturnType<Mod["loadExpenseHistory"]>>;
type Opts = { before?: number; expenseId?: string; limit?: number };
function fakeApi(pages: Activity[][], fail?: "offline") {
  const calls: Opts[] = [];
  return {
    calls,
    api: {
      activity: async (_slug: string, opts?: Opts) => {
        calls.push(opts ?? {});
        if (fail) return { ok: false as const, why: fail };
        return { ok: true as const, rev: 40, rows: pages[calls.length - 1] ?? [] };
      },
    },
  };
}

test("TG66-W2-19 an expense's history is one filtered ask (expense_id, limit 50), and Changes keeps only its add and edit rows", async () => {
  const add = row({ id: 12, action: "expense_add", actor: BEN, expense_id: E1, after: snap(expense()) });
  const edit = row({ id: 20, action: "expense_edit", actor: ANA, expense_id: E1, before: snap(expense()), after: snap(expense({ note: "Lunch!" })) });
  const comment = row({ id: 21, action: "comment_add", actor: CARLA, expense_id: E1 });
  const gone = row({ id: 22, action: "comment_delete", actor: CARLA, expense_id: E1 });
  const { api, calls } = fakeApi([[gone, comment, edit, add]]);
  const r = (await A.loadExpenseHistory(api, "a".repeat(32), expense())) as Extract<Answer, { ok: true }>;
  assert.equal(r.ok, true);
  assert.equal(r.complete, true);
  assert.deepEqual(calls, [{ expenseId: E1, limit: 50 }]);
  assert.deepEqual(r.rows.map((x) => x.id), [20, 12], "newest first, add and edit only");
  const none = fakeApi([[]]);
  const r0 = (await A.loadExpenseHistory(none.api, "a".repeat(32), expense())) as Extract<Answer, { ok: true }>;
  assert.deepEqual([r0.complete, r0.rows], [true, []], "a legacy expense never edited: rows: [], not an error");
});

test("TG66-W2-20 past 50 rows it pages with before, and stops at a short page", async () => {
  const edits = (from: number, to: number) =>
    Array.from({ length: from - to + 1 }, (_, i) => row({ id: from - i, action: "expense_edit", actor: ANA, expense_id: E1, before: snap(expense()), after: snap(expense()) }));
  const { api, calls } = fakeApi([edits(120, 71), edits(70, 21), edits(20, 1)]);
  const r = (await A.loadExpenseHistory(api, "a".repeat(32), expense())) as Extract<Answer, { ok: true }>;
  assert.deepEqual(calls, [{ expenseId: E1, limit: 50 }, { expenseId: E1, limit: 50, before: 71 }, { expenseId: E1, limit: 50, before: 21 }]);
  assert.deepEqual([r.complete, r.rows.length, r.rows[0].id, r.rows.at(-1)?.id], [true, 120, 120, 1]);
});

test("TG66-W2-21 the history load stops at its page cap (not complete) and reports a failure as the wallet client does", async () => {
  const full = (n: number) => Array.from({ length: 50 }, (_, i) => row({ id: n - i, action: "expense_edit", expense_id: E1, before: snap(expense()), after: snap(expense()) }));
  const capped = fakeApi([full(1000), full(950), full(900), full(850)]);
  const r = (await A.loadExpenseHistory(capped.api, "a".repeat(32), expense(), 3)) as Extract<Answer, { ok: true }>;
  assert.deepEqual([r.ok, r.complete, capped.calls.length, r.rows.length], [true, false, 3, 150]);
  const off = fakeApi([], "offline");
  assert.deepEqual(await A.loadExpenseHistory(off.api, "a".repeat(32), expense()), { ok: false, why: "offline" });
});

test("TG66-W2-22 the history load logs counts only: no note, name, slug or member id", async () => {
  const logged: unknown[][] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => void logged.push(args);
  try {
    const add = row({ id: 5, action: "expense_add", actor: BEN, expense_id: E1, after: snap(expense({ note: "TESTPLACE lunch" })) });
    await A.loadExpenseHistory(fakeApi([[add]]).api, "a".repeat(32), expense({ note: "TESTPLACE lunch" }));
  } finally {
    console.info = original;
  }
  assert.ok(logged.length >= 1, "one line per load");
  const text = JSON.stringify(logged);
  for (const secret of ["TESTPLACE", "Ben", BEN, E1, "a".repeat(32)]) assert.ok(!text.includes(secret), secret);
});

test("TG66-W2-29 walletApi.activity: the wallet-wide default is unchanged; opts add before, expense_id and limit", async () => {
  const { walletApi } = await import("./wallet.ts");
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (u: string) => {
    urls.push(String(u));
    return new Response(JSON.stringify({ rev: 3, rows: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const W = "a".repeat(32);
    assert.deepEqual(await walletApi.activity(W), { ok: true, rev: 3, rows: [] });
    await walletApi.activity(W, 12); // TG66-4's older call shape still works
    await walletApi.activity(W, { before: 12 });
    await walletApi.activity(W, { expenseId: "e/1 x", limit: 50 });
    await walletApi.activity(W, { expenseId: E1, limit: 50, before: 71 });
    assert.deepEqual(
      urls.map((u) => u.slice(u.indexOf("/wallets/"))),
      [
        `/wallets/${W}/activity?limit=15`,
        `/wallets/${W}/activity?before=12&limit=15`,
        `/wallets/${W}/activity?before=12&limit=15`,
        `/wallets/${W}/activity?expense_id=e%2F1%20x&limit=50`,
        `/wallets/${W}/activity?before=71&expense_id=${E1}&limit=50`,
      ],
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("TG66-W2-30 addendum: a snapshot key the web doesn't know (TG-62's budget_key) changes no Changes line and fails nothing", () => {
  const w = wallet();
  const before = snap(expense({ amount_centavos: 118000 }));
  const after = snap(expense());
  const plain = A.changes(before, after, w);
  assert.deepEqual(A.changes({ ...before, budget_key: "meals" }, { ...after, budget_key: "pasalubong" }, w), plain);
  assert.deepEqual(A.changes({ ...before, budget_key: "meals" }, after, w), plain);
  assert.deepEqual(A.changes(after, { ...after, budget_key: "meals" }, w), []);
});

test("TG66-W2-31 addendum: lists diff by member_id, seq or kind, never by position", () => {
  const w = wallet();
  const a = snap(expense({ mode: "itemized", inputs: [], items: ITEMIZED.items, charges: [{ kind: "service", basis: "percent", value: 1000 }, { kind: "vat", basis: "amount", value: 12000 }], payers: SHARES_221.payers, shares: ITEMIZED.shares }));
  const b = {
    ...a,
    items: [...a.items].reverse().map((i) => ({ ...i, who: [...i.who].reverse() })),
    charges: [...a.charges].reverse(),
    payers: [...a.payers].reverse(),
    shares: [...a.shares].reverse(),
  };
  assert.deepEqual(A.changes(a, b, w), []);
  const s = snap(SHARES_221);
  assert.deepEqual(A.changes(s, { ...s, inputs: [...s.inputs].reverse() }, w), []);
  const renamed = { ...a, items: a.items.map((i) => (i.seq === 2 ? { ...i, name: "Ube taho" } : i)) };
  assert.deepEqual(A.changes(a, renamed, w), [{ field: "items" }], "same count and total, different item: the field with no arrow");
});

// ---------------------------------------------------------------- the components, by source

const details = () => read("src/components/wallet/ExpenseDetails.tsx");
const activity = () => read("src/components/wallet/ActivityList.tsx");

test("TG66-W2-23 ExpenseDetails: a native modal dialog named by the note, Close first, Escape closes (ux §5, §10)", () => {
  const src = details();
  assert.match(src, /<dialog\b/);
  assert.match(src, /\.showModal\(\)/);
  assert.match(src, /aria-labelledby=\{titleId\}/);
  assert.match(src, /w-\[min\(28rem,calc\(100%-1rem\)\)\]/);
  assert.match(src, /overflow-y-auto/);
  const close = src.search(/>\s*Close\s*</);
  const heading = src.search(/<h2 id=\{titleId\}/);
  assert.ok(close > 0 && heading > 0 && close < heading, "Close comes before the heading in the DOM, so showModal focuses it");
});

test("TG66-W2-24 ExpenseDetails uses the helpers for every line, and leaves the expense writes to its parent", () => {
  const src = details();
  for (const fn of ["splitHeading(", "splitRows(", "itemRows(", "chargeLabel(", "payersDetail(", "addedLine(", "historyLines(", "loadExpenseHistory(", "mergeComments(", "commentsFromWrite(", "commentsLeft("])
    assert.ok(src.includes(fn), fn);
  for (const call of ["walletApi.comments(", "walletApi.addComment(", "walletApi.deleteComment("]) assert.ok(src.includes(call), call);
  for (const call of ["walletApi.deleteExpense", "walletApi.editExpense", "walletApi.addExpense"]) assert.ok(!src.includes(call), `${call} is W3's, through onDelete/onEdit`);
  assert.ok(!src.includes("dangerouslySetInnerHTML"));
});

test("TG66-W2-25 ExpenseDetails' copy is ux.md's, word for word", () => {
  const src = details();
  for (const s of [
    "Changes",
    "Comments",
    "Needs signal.",
    "Everyone with the wallet link sees it.",
    "Add a comment as ",
    "Add a comment",
    "Post",
    "Edit",
    "Delete expense",
    "Delete this comment for everyone?",
    "It stays in the activity list.",
    "This one has more than one payer, so it can't be edited yet. You can delete it and add it again.",
    "Comment posted.",
    "Comment deleted.",
    "Comments aren't switched on right now.",
    "This expense has 50 comments, the most it can hold.",
  ])
    assert.ok(src.includes(s), s);
  assert.match(src, /aria-label=\{`Delete \$\{[^}]+\}'s comment`\}/);
});

test("TG66-W2-26 ExpenseDetails offline: Edit, Delete and Post are aria-disabled, never disabled, and the activity isn't fetched", () => {
  const src = details();
  assert.match(src, /online/);
  const disabledOnly = src.match(/(?<![-\w])disabled=\{/g) ?? [];
  assert.equal(disabledOnly.length, 0, "aria-disabled keeps them in the tab order (ux §5, TG-61)");
  assert.ok((src.match(/aria-disabled=/g) ?? []).length >= 3);
  assert.match(src, /multiPayer/, "the WALLET_MULTI_PAYER rule (S4) is a prop");
});

test("TG66-W2-27 ActivityList: day headings as h3, Show older, the empty, offline and Someone lines (ux §8)", () => {
  const src = activity();
  for (const fn of ["mergeActivity(", "groupByDay(", "activityLine(", "timeOnly(", "oldestId(", "walletApi.activity("]) assert.ok(src.includes(fn), fn);
  for (const s of [
    "Activity",
    "Show older",
    "Nothing yet. Adds, changes and payments show here.",
    "Activity needs signal.",
    `"Someone" is a phone that hasn't picked who it is. Activity from before this update isn't listed.`,
  ])
    assert.ok(src.includes(s), s);
  assert.match(src, /<h3\b/);
  assert.ok(!src.includes("dangerouslySetInnerHTML"));
});

test("TG66-W2-28 the components' logs carry counts and outcomes only: no note, name, body, slug or id", () => {
  for (const [file, src] of [["ExpenseDetails", details()], ["ActivityList", activity()]] as const) {
    const lines = src.match(/console\.(info|warn|error|log)\([^;]*;/g) ?? [];
    assert.ok(lines.length >= 1, `${file} logs its loads and writes`);
    for (const l of lines) {
      assert.match(l, /\[tg-wallet\]/, l);
      assert.doesNotMatch(l, /\.(note|name|body|id|share_slug)\b|\bslug\b|\bnameOf\(|\bdraft\b|\bmember/, `${file}: ${l}`);
    }
  }
});

test("TG66-W2-32 ux review M1: a failed Delete expense is said inside the details, in ux's words", () => {
  assert.equal(A.deleteFailure({ why: "not_found", detail: "expense_gone" }), "This expense was already deleted.");
  assert.equal(
    A.deleteFailure({ why: "rejected", detail: "expense_changed" }),
    "Someone changed this expense while you were looking. Check it, then delete again if you still want to.",
  );
  assert.match(A.deleteFailure({ why: "offline" }), /No signal/);
  assert.match(A.deleteFailure({ why: "server" }), /server had a problem/);
  const src = details();
  assert.match(src, /onDelete: \(expense: Expense\) => Promise<true \| WalletFailed>/, "onDelete hands back the failure");
  const remove = src.slice(src.indexOf("async function remove()"), src.indexOf("function edit()"));
  assert.match(remove, /setNotice\(\{ text: deleteFailure\(r\), error: true \}\)/, "into the dialog's own notice");
  assert.match(remove, /if \(r === true\) return close\(\)/, "only a delete that worked closes the dialog");
  assert.match(src, /\{deleting \? "Deleting\.\.\." : "Delete expense"\}/, "S4: the label while it's out");
});

test("TG66-W2-33 ux review S2 and S3: the comment box is described by its count line, and the 300 limit is counted one way", () => {
  const src = details();
  assert.match(src, /<textarea[^>]*aria-describedby=\{commentHint\}/);
  assert.match(src, /<p id=\{commentHint\}/);
  assert.doesNotMatch(src, /maxLength=/, "no UTF-16 maxLength beside the code-point counter");
  assert.match(src, /commentTooLong\(body\)/);
});

test("TG66-W2-34 review S1: a full refresh that doesn't reach the newest row on screen replaces the list, so no rows are skipped", () => {
  const onScreen = A.mergeActivity(null, { rev: 100, rows: page(100, 86) }, false);
  const jump = A.mergeActivity(onScreen, { rev: 120, rows: page(120, 106) }, false);
  assert.deepEqual([ids(jump)[0], ids(jump).at(-1), ids(jump).length, jump.more, jump.rev], [120, 106, 15, true, 120]);
  assert.equal(A.oldestId(jump), 106, "Show older asks below 106, so 105 to 101 come next");
  const filled = A.mergeActivity(jump, { rev: 120, rows: page(105, 91) }, true);
  assert.deepEqual(ids(filled), page(120, 91).map((r) => r.id));
  const touching = A.mergeActivity(onScreen, { rev: 114, rows: page(114, 100) }, false);
  assert.deepEqual([ids(touching).length, touching.more], [29, true], "a page that reaches the newest row merges as before");
  const short = A.mergeActivity(onScreen, { rev: 103, rows: page(103, 101) }, false);
  assert.deepEqual(ids(short).slice(0, 4), [103, 102, 101, 100], "a short page is everything newer: it merges");
});

test("TG66-W2-35 a comment delete names who did it: by goes as ?by= (A2's shape), and is left out when the phone hasn't picked", async () => {
  const { walletApi } = await import("./wallet.ts");
  const calls: { url: string; method?: string; body?: unknown }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (u: string, init?: RequestInit) => {
    calls.push({ url: String(u), method: init?.method, body: init?.body });
    return new Response(JSON.stringify({ wallet: wallet(), comments: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const W = "a".repeat(32);
    await walletApi.deleteComment(W, E1, "c1", BEN);
    await walletApi.deleteComment(W, E1, "c1", null);
    await walletApi.deleteComment(W, E1, "c1");
    await walletApi.deleteComment(W, E1, "c/1", "m b");
    assert.deepEqual(
      calls.map((c) => [c.method, c.url.slice(c.url.indexOf("/wallets/")), c.body]),
      [
        ["DELETE", `/wallets/${W}/expenses/${E1}/comments/c1?by=${BEN}`, undefined],
        ["DELETE", `/wallets/${W}/expenses/${E1}/comments/c1`, undefined],
        ["DELETE", `/wallets/${W}/expenses/${E1}/comments/c1`, undefined],
        ["DELETE", `/wallets/${W}/expenses/${E1}/comments/c%2F1?by=m%20b`, undefined],
      ],
    );
  } finally {
    globalThis.fetch = original;
  }
  const src = details();
  assert.match(src, /walletApi\.deleteComment\(slug, expense\.id, commentId, me\)/, "Details sends this phone's person");
  assert.match(src, /walletApi\.addComment\(slug, expense\.id, \{ body, by: me \}\)/, "as the post does, in its body");
});
