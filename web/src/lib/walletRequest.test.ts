// TG-66 W1: the expense form's model (walletRequest.ts) and its components. Run with `npm test`.
// Plan §3 B18a (the body the add sends, by flag: today's byte for byte with WALLET_SPLITS off), B19 (switching modes keeps
// the amount and the people), B20 (itemized: the amount is computed; an item with nobody blocks Save), B21 (several
// payers: `₱X left to place`), B22 (a legacy expense reopens as Equally or Amounts), and ux.md §3/§4's status lines.
// The form's components are checked by source here (node can't render TSX); W3 wires them into WalletView.
// The module is loaded per test, so before it exists each test fails on its own instead of the whole file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Expense, Member } from "./wallet.ts";

const load = () => import("./walletRequest.ts");
const WEB = new URL("../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, WEB), "utf8").replaceAll("&apos;", "'");

// Made-up people, in wallet order
const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const C = "00000000-0000-4000-8000-000000000003";
const D = "00000000-0000-4000-8000-000000000004";
const MEMBERS: Member[] = [
  { id: A, name: "Ana" },
  { id: B, name: "Ben" },
  { id: C, name: "Carla" },
  { id: D, name: "Dan" },
];
const OFF = { walletSplits: false, walletMultiPayer: false };
const SPLITS = { walletSplits: true, walletMultiPayer: false };
const ALL = { walletSplits: true, walletMultiPayer: true };
const NOTE = "Lunch at TESTPLACE";

async function form(patch: Record<string, unknown> = {}) {
  const m = await load();
  return { ...m.emptyForm(A), amount: "1,280", note: ` ${NOTE} `, ...patch } as ReturnType<typeof m.emptyForm>;
}

function body(r: { ok: true; body: unknown } | { ok: false; problem: string }) {
  assert.equal(r.ok, true, r.ok ? "" : r.problem);
  return (r as { body: unknown }).body;
}

// The 66-04-items bill (ux.md, plan §2)
const BILL = [
  { key: "i1", name: "Pinikpikan", price: "420", who: [A, B] },
  { key: "i2", name: "Strawberry taho", price: "120", who: [C] },
  { key: "i3", name: "Grilled tilapia", price: "380", who: [B, C, D] },
  { key: "i4", name: "Rice", price: "160", who: [A, B, C, D] },
];

// ---------------------------------------------------------------- B18a: flags off sends today's body, byte for byte

test("W1-R1 B18a flags off, Equally: today's body as a pinned string (WalletView.tsx at a1c4299, line 87)", async () => {
  const { buildBody } = await load();
  const everyone = await form();
  assert.equal(
    JSON.stringify(body(buildBody(everyone, MEMBERS, OFF, A))),
    `{"paid_by":"${A}","amount_centavos":128000,"note":"${NOTE}","split_among":["${A}","${B}","${C}","${D}"]}`,
  );
  const withoutDan = await form({ out: [D], paidBy: B });
  assert.equal(
    JSON.stringify(body(buildBody(withoutDan, MEMBERS, OFF, A))),
    `{"paid_by":"${B}","amount_centavos":128000,"note":"${NOTE}","split_among":["${A}","${B}","${C}"]}`,
  );
});

test("W1-R2 B18a flags off, Amounts: today's shares body, zero shares left out (lines 91 to 96)", async () => {
  const { buildBody } = await load();
  const s = await form({ mode: "exact", exact: { [A]: "400", [B]: "880", [D]: "0" } });
  assert.equal(
    JSON.stringify(body(buildBody(s, MEMBERS, OFF, A))),
    `{"paid_by":"${A}","amount_centavos":128000,"note":"${NOTE}","shares":[{"member_id":"${A}","share_centavos":40000},{"member_id":"${B}","share_centavos":88000}]}`,
  );
});

test("W1-R3 B18a flags off: no mode, by, category or payers, whatever the form holds", async () => {
  const { buildBody } = await load();
  const s = await form({ category: "food", several: true, paid: { [A]: "800", [B]: "480" } });
  const sent = JSON.stringify(body(buildBody(s, MEMBERS, OFF, A)));
  for (const key of ["mode", "by", "category", "payers", "inputs"]) assert.ok(!sent.includes(`"${key}"`), key);
  assert.ok(sent.startsWith(`{"paid_by":"${A}",`), "the select's payer");
});

test("W1-R4 flags off: the new modes aren't sent at all (the form doesn't offer them)", async () => {
  const { buildBody } = await load();
  for (const mode of ["percent", "shares", "adjust", "itemized"]) {
    const r = buildBody(await form({ mode }), MEMBERS, OFF, A);
    assert.equal(r.ok, false, mode);
  }
});

// ---------------------------------------------------------------- the v2 bodies (flags on)

test("W1-R5 WALLET_SPLITS on: Equally and Amounts send v2 with the mode, inputs, category and by", async () => {
  const { buildBody } = await load();
  assert.deepEqual(body(buildBody(await form({ category: "food", out: [D] }), MEMBERS, SPLITS, A)), {
    mode: "equal",
    paid_by: A,
    amount_centavos: 128000,
    note: NOTE,
    category: "food",
    by: A,
    inputs: [A, B, C].map((m) => ({ member_id: m, value: 1 })),
  });
  assert.deepEqual(body(buildBody(await form({ mode: "exact", exact: { [A]: "400", [B]: "880", [C]: "0" } }), MEMBERS, SPLITS, null)), {
    mode: "exact",
    paid_by: A,
    amount_centavos: 128000,
    note: NOTE,
    category: null,
    by: null,
    inputs: [
      { member_id: A, value: 40000 },
      { member_id: B, value: 88000 },
    ],
  });
});

test("W1-R6 WALLET_SPLITS on: Percent in basis points, Shares as weights, Equal + extra as among with each extra", async () => {
  const { buildBody } = await load();
  const pct = await form({ mode: "percent", percent: { [A]: "40", [B]: "33.33", [C]: "26.67", [D]: "" } });
  assert.deepEqual((body(buildBody(pct, MEMBERS, SPLITS, A)) as { inputs: unknown }).inputs, [
    { member_id: A, value: 4000 },
    { member_id: B, value: 3333 },
    { member_id: C, value: 2667 },
  ]);
  const shares = await form({ mode: "shares", shares: { [A]: 2, [B]: 2, [C]: 1, [D]: 0 } });
  const sb = body(buildBody(shares, MEMBERS, SPLITS, A)) as { mode: string; inputs: unknown };
  assert.equal(sb.mode, "shares");
  assert.deepEqual(sb.inputs, [
    { member_id: A, value: 2 },
    { member_id: B, value: 2 },
    { member_id: C, value: 1 },
  ]);
  const adjust = await form({ mode: "adjust", out: [C], extras: { [A]: "200", [B]: "-50.50", [C]: "999" } });
  const ab = body(buildBody(adjust, MEMBERS, SPLITS, A)) as { mode: string; inputs: unknown };
  assert.equal(ab.mode, "adjust");
  assert.deepEqual(ab.inputs, [
    { member_id: A, value: 20000 },
    { member_id: B, value: -5050 },
    { member_id: D, value: 0 },
  ], "the rows are among; someone left out sends no extra");
});

test("W1-R7 WALLET_SPLITS on: Items sends the items in order, who in wallet order, the charges, and the computed amount", async () => {
  const { buildBody } = await load();
  const s = await form({
    mode: "itemized",
    amount: "1,200",
    category: "food",
    items: [{ key: "x", name: " Pinikpikan ", price: "420", who: [B, A] }, ...BILL.slice(1)],
    service: "10%",
    vat: "",
  });
  assert.deepEqual(body(buildBody(s, MEMBERS, SPLITS, A)), {
    mode: "itemized",
    paid_by: A,
    amount_centavos: 118800,
    note: NOTE,
    category: "food",
    by: A,
    items: [
      { name: "Pinikpikan", price_centavos: 42000, who: [A, B] },
      { name: "Strawberry taho", price_centavos: 12000, who: [C] },
      { name: "Grilled tilapia", price_centavos: 38000, who: [B, C, D] },
      { name: "Rice", price_centavos: 16000, who: [A, B, C, D] },
    ],
    charges: [{ kind: "service", basis: "percent", value: 1000 }],
  });
  const vat = await form({ mode: "itemized", items: BILL, service: "", vat: "120" });
  assert.deepEqual((body(buildBody(vat, MEMBERS, SPLITS, A)) as { charges: unknown }).charges, [{ kind: "vat", basis: "amount", value: 12000 }]);
});

test("W1-R8 B18a WALLET_MULTI_PAYER off: never payers; on: payers in wallet order, and one payer stays paid_by", async () => {
  const { buildBody } = await load();
  const several = await form({ several: true, paid: { [B]: "480", [A]: "800", [C]: "" } });
  const off = JSON.stringify(body(buildBody(several, MEMBERS, SPLITS, A)));
  assert.ok(!off.includes('"payers"'), off);
  assert.ok(off.includes(`"paid_by":"${A}"`));
  const on = body(buildBody(several, MEMBERS, ALL, A)) as Record<string, unknown>;
  assert.deepEqual(on.payers, [
    { member_id: A, paid_centavos: 80000 },
    { member_id: B, paid_centavos: 48000 },
  ]);
  assert.ok(!("paid_by" in on), "paid_by or payers, not both");
  const justBen = await form({ several: true, paid: { [B]: "1,280" } });
  const one = body(buildBody(justBen, MEMBERS, ALL, A)) as Record<string, unknown>;
  assert.equal(one.paid_by, B);
  assert.ok(!("payers" in one));
});

test("W1-R9 WALLET_SPLITS off with WALLET_MULTI_PAYER on: several payers go as v2 equal or exact, with no category", async () => {
  const { buildBody } = await load();
  const s = await form({ category: "food", several: true, paid: { [A]: "800", [B]: "480" } });
  const sent = body(buildBody(s, MEMBERS, { walletSplits: false, walletMultiPayer: true }, A)) as Record<string, unknown>;
  assert.equal(sent.mode, "equal");
  assert.ok(Array.isArray(sent.payers));
  assert.ok(!("category" in sent) || sent.category === null);
  const single = JSON.stringify(body(buildBody(await form(), MEMBERS, { walletSplits: false, walletMultiPayer: true }, A)));
  assert.ok(single.startsWith(`{"paid_by":"${A}","amount_centavos":128000,"note":"${NOTE}","split_among":`), "one payer: today's body");
});

test("W1-R10 an edit is the v2 body plus the version the form opened with; edits need WALLET_SPLITS", async () => {
  const { buildPatch } = await load();
  const s = await form({ mode: "shares", shares: { [A]: 1, [B]: 1, [C]: 1, [D]: 1 } });
  const patch = body(buildPatch(s, MEMBERS, SPLITS, A, 3)) as Record<string, unknown>;
  assert.equal(patch.version, 3);
  assert.equal(patch.mode, "shares");
  // An Equally form, which buildBody takes with the flags off: only buildPatch's own flag check can refuse it (audit S4)
  const equally = await form();
  assert.equal((body(buildPatch(equally, MEMBERS, SPLITS, A, 3)) as { mode: string }).mode, "equal");
  assert.deepEqual(buildPatch(equally, MEMBERS, OFF, A, 3), { ok: false, problem: "Editing isn't switched on right now. Your changes weren't saved." });
  assert.equal(buildPatch(equally, MEMBERS, { walletSplits: false, walletMultiPayer: true }, A, 3).ok, false);
});

// ---------------------------------------------------------------- B19: switching modes

test("W1-R11 B19 switching modes keeps the amount, note, category, payer and people, and each mode's own values", async () => {
  const { switchMode, checkForm } = await load();
  let s = await form({ category: "food", paidBy: B, out: [D], exact: { [A]: "500" } });
  s = switchMode(s, "shares");
  assert.equal(s.mode, "shares");
  assert.deepEqual([s.amount, s.note, s.category, s.paidBy, s.out], ["1,280", ` ${NOTE} `, "food", B, [D]]);
  const shares = checkForm(s, MEMBERS, SPLITS).shares;
  assert.deepEqual(shares, { [A]: 42667, [B]: 42667, [C]: 42666, [D]: 0 }, "Shares starts at 1 each for the people ticked; the 2 leftover centavos go to the payer (Ben), then Ana");
  s = switchMode(switchMode(s, "adjust"), "exact");
  assert.deepEqual(s.exact, { [A]: "500" }, "what was typed in Amounts comes back");
  s = switchMode(s, "equal");
  assert.deepEqual(s.out, [D]);
  assert.equal(checkForm(s, MEMBERS, SPLITS).amount, 128000);
});

// ---------------------------------------------------------------- B20: Items

test("W1-R12 B20 Items: the amount is the items plus charges, whatever was typed; the vector's shares; ux's totals block", async () => {
  const { checkForm } = await load();
  const s = await form({ mode: "itemized", amount: "1,200", items: BILL, service: "10%" });
  const c = checkForm(s, MEMBERS, SPLITS);
  assert.equal(c.ok, true, c.problem ?? "");
  assert.equal(c.amount, 118800);
  assert.deepEqual(c.shares, { [A]: 27501, [B]: 41434, [C]: 31533, [D]: 18332 });
  assert.deepEqual(c.bill, {
    items: 108000,
    charges: [{ label: "Service charge 10%", amount: 10800 }],
    total: 118800,
    typedBefore: "You typed ₱1,200.00 before. The items come to ₱1,188.00, so ₱12.00 isn't on any item.",
  });
  const same = checkForm(await form({ mode: "itemized", amount: "1,188", items: BILL, service: "10%" }), MEMBERS, SPLITS);
  assert.equal(same.bill?.typedBefore, null, "no check line when they match");
  const vat = checkForm(await form({ mode: "itemized", amount: "", items: BILL, vat: "120" }), MEMBERS, SPLITS);
  assert.deepEqual(vat.bill?.charges, [{ label: "VAT, other charges ₱120", amount: 12000 }]);
  assert.equal(vat.amount, 120000);
});

test("W1-R13 B20 an item with nobody blocks Save with `Pick who had <item>.`", async () => {
  const { checkForm, buildBody } = await load();
  const s = await form({ mode: "itemized", items: [BILL[0], { ...BILL[1], who: [] }, { ...BILL[2], who: [] }] });
  const c = checkForm(s, MEMBERS, SPLITS);
  assert.equal(c.ok, false);
  assert.equal(c.problem, "Pick who had Strawberry taho.", "the first such item");
  const r = buildBody(s, MEMBERS, SPLITS, A);
  assert.deepEqual(r, { ok: false, problem: "Pick who had Strawberry taho." });
});

test("W1-R14 Items refusals use ux.md §9's copy before the server sees them", async () => {
  const { checkForm } = await load();
  const problem = async (patch: Record<string, unknown>) => checkForm(await form({ mode: "itemized", ...patch }), MEMBERS, SPLITS).problem;
  assert.equal(await problem({ items: [{ ...BILL[0], price: "0" }] }), "The items come to ₱0. Type a price for at least one.");
  assert.equal(await problem({ items: BILL, service: "101%" }), "A service charge or VAT can't be more than 100%.");
  assert.equal(
    await problem({ items: [{ ...BILL[0], price: "60,000" }, { ...BILL[1], price: "40,000" }], vat: "1" }),
    "The items come to more than ₱100,000, the most one expense can be.",
  );
  assert.equal(await problem({ items: [] }), "Add an item, with its price and who had it.");
});

test("W1-R15 addItem adds an empty row with a fresh key, up to 40; removeItem drops one", async () => {
  const { addItem, removeItem, emptyForm } = await load();
  let s = emptyForm(A);
  const n = s.items.length;
  s = addItem(s);
  assert.equal(s.items.length, n + 1);
  const last = s.items[s.items.length - 1];
  assert.deepEqual([last.name, last.price, last.who], ["", "", []]);
  assert.equal(new Set(s.items.map((i) => i.key)).size, s.items.length, "keys are unique");
  while (s.items.length < 40) s = addItem(s);
  assert.equal(addItem(s).items.length, 40, "40 items is the limit");
  assert.equal(removeItem(s, s.items[0].key).items.length, 39);
});

// ---------------------------------------------------------------- B21: several payers

test("W1-R16 B21 several payers: `₱X left to place.` blocks Save until it's 0; then `Paid in full.`", async () => {
  const { checkForm } = await load();
  const short = checkForm(await form({ several: true, paid: { [A]: "800", [B]: "200" } }), MEMBERS, ALL);
  assert.equal(short.payerLine, "₱280 left to place.");
  assert.equal(short.ok, false);
  assert.equal(short.problem, "₱280 left to place.");
  const over = checkForm(await form({ several: true, paid: { [A]: "800", [B]: "520" } }), MEMBERS, ALL);
  assert.equal(over.payerLine, "₱40 more than the amount.");
  assert.equal(over.ok, false);
  const full = checkForm(await form({ several: true, paid: { [A]: "800", [B]: "480" } }), MEMBERS, ALL);
  assert.equal(full.payerLine, "Paid in full.");
  assert.equal(full.ok, true, full.problem ?? "");
  const flagOff = checkForm(await form({ several: true, paid: { [A]: "800" } }), MEMBERS, SPLITS);
  assert.equal(flagOff.payerLine, null, "with WALLET_MULTI_PAYER off the select's payer counts");
  assert.equal(flagOff.ok, true);
});

test("W1-R17 several payers: the first payer in wallet order takes the leftover; `Just one person paid` keeps them", async () => {
  const { checkForm, justOnePayer } = await load();
  const s = await form({ amount: "10.01", paidBy: A, several: true, paid: { [C]: "5", [B]: "5.01" } });
  assert.deepEqual(checkForm(s, MEMBERS, ALL).shares, { [A]: 250, [B]: 251, [C]: 250, [D]: 250 }, "Ben, first in wallet order");
  const one = justOnePayer(s, MEMBERS);
  assert.equal(one.several, false);
  assert.equal(one.paidBy, B);
});

// ---------------------------------------------------------------- B22: reopening an expense

function expense(patch: Partial<Expense>): Expense {
  return { id: "e1", paid_by: A, amount_centavos: 100000, note: NOTE, created_at: "2026-11-06T05:02:00Z", shares: [], ...patch };
}

test("W1-R18 B22 a legacy expense reopens as Equally when its shares are splitEqual over its people in wallet order", async () => {
  const { formFromExpense } = await load();
  const s = formFromExpense(
    expense({ paid_by: B, amount_centavos: 1000, shares: [{ member_id: C, share_centavos: 333 }, { member_id: A, share_centavos: 333 }, { member_id: B, share_centavos: 334 }] }),
    MEMBERS,
  );
  assert.equal(s.mode, "equal");
  assert.deepEqual(s.out, [D]);
  assert.deepEqual([s.amount, s.note, s.paidBy, s.category], ["10", NOTE, B, null]);
});

test("W1-R19 B22 a legacy expense reopens as Amounts otherwise, with each share", async () => {
  const { formFromExpense } = await load();
  const s = formFromExpense(expense({ shares: [{ member_id: A, share_centavos: 50000 }, { member_id: B, share_centavos: 30050 }, { member_id: C, share_centavos: 19950 }] }), MEMBERS);
  assert.equal(s.mode, "exact");
  assert.deepEqual(s.exact, { [A]: "500", [B]: "300.50", [C]: "199.50" });
  // ₱10.01 among A, B, C, paid by A: splitEqual gives A and B 334. The old API's order-given rule could store B and C.
  const tie = formFromExpense(expense({ amount_centavos: 1001, shares: [{ member_id: A, share_centavos: 333 }, { member_id: B, share_centavos: 334 }, { member_id: C, share_centavos: 334 }] }), MEMBERS);
  assert.equal(tie.mode, "exact", "not wallet order's split, so Amounts");
});

test("W1-R20 a v2 expense reopens with its mode and inputs, and saving it unchanged sends the same inputs", async () => {
  const { formFromExpense, buildPatch } = await load();
  const cases: Partial<Expense>[] = [
    { mode: "equal", inputs: [A, B, D].map((m) => ({ member_id: m, value: 1 })) },
    { mode: "exact", inputs: [{ member_id: A, value: 60000 }, { member_id: C, value: 40000 }] },
    { mode: "percent", inputs: [{ member_id: A, value: 3333 }, { member_id: B, value: 3333 }, { member_id: C, value: 3334 }] },
    { mode: "shares", inputs: [{ member_id: A, value: 2 }, { member_id: B, value: 20 }] },
    { mode: "adjust", inputs: [{ member_id: A, value: 20000 }, { member_id: B, value: -5050 }, { member_id: D, value: 0 }] },
  ];
  for (const c of cases) {
    const e = expense({ ...c, category: "hotel", version: 4 });
    const s = formFromExpense(e, MEMBERS);
    assert.equal(s.mode, c.mode);
    assert.equal(s.category, "hotel");
    const p = body(buildPatch(s, MEMBERS, SPLITS, A, e.version!)) as Record<string, unknown>;
    assert.deepEqual([p.mode, p.inputs, p.amount_centavos, p.version], [c.mode, c.inputs, 100000, 4], c.mode!);
  }
});

test("W1-R21 an itemized expense and one with several payers reopen as saved", async () => {
  const { formFromExpense, buildPatch } = await load();
  const items = [
    { seq: 1, name: "Pinikpikan", price_centavos: 42000, who: [A, B] },
    { seq: 2, name: "Rice", price_centavos: 16000, who: [A, B, C, D] },
  ];
  const charges = [
    { kind: "service" as const, basis: "percent" as const, value: 1250 },
    { kind: "vat" as const, basis: "amount" as const, value: 1050 },
  ];
  const e = expense({ mode: "itemized", amount_centavos: 66300, items, charges, payers: [{ member_id: A, paid_centavos: 30000 }, { member_id: B, paid_centavos: 36300 }] });
  const s = formFromExpense(e, MEMBERS);
  assert.deepEqual([s.mode, s.service, s.vat, s.several], ["itemized", "12.5%", "10.50", true]);
  assert.deepEqual(s.paid, { [A]: "300", [B]: "363" });
  const p = body(buildPatch(s, MEMBERS, ALL, A, 1)) as Record<string, unknown>;
  assert.deepEqual(p.items, items.map(({ name, price_centavos, who }) => ({ name, price_centavos, who })));
  assert.deepEqual(p.charges, charges);
  assert.deepEqual(p.payers, e.payers);
  assert.equal(p.amount_centavos, 66300);
});

// ---------------------------------------------------------------- ux.md §3: each mode's status line

test("W1-R22 the status lines (ux.md §3), from the same numbers as the 66-03 shots", async () => {
  const { checkForm } = await load();
  const line = async (patch: Record<string, unknown>) => checkForm(await form(patch), MEMBERS, SPLITS);
  assert.equal((await line({})).status, "Odd centavos go to whoever paid first.");
  const amounts = await line({ mode: "exact", exact: { [A]: "400", [B]: "300", [C]: "300" } });
  assert.equal(amounts.status, "₱280 left to assign.");
  assert.equal(amounts.ok, false);
  assert.equal(amounts.problem, "₱280 left to assign.", "Add is refused with the status line as the reason");
  assert.equal((await line({ mode: "exact", exact: { [A]: "400", [B]: "300", [C]: "620" } })).status, "₱40 too much.");
  assert.equal((await line({ mode: "exact", exact: { [A]: "400", [B]: "300", [C]: "580" } })).status, "Adds up.");
  assert.equal((await line({ mode: "percent", percent: { [A]: "40", [B]: "20", [C]: "20" } })).status, "20% left to assign.");
  assert.equal((await line({ mode: "percent", percent: { [A]: "40", [B]: "20", [C]: "20", [D]: "25" } })).status, "5% too much.");
  const pct = await line({ mode: "percent", percent: { [A]: "40", [B]: "20", [C]: "20", [D]: "20" } });
  assert.equal(pct.status, "Adds up to 100%.");
  assert.deepEqual(pct.shares, { [A]: 51200, [B]: 25600, [C]: 25600, [D]: 25600 });
  const shares = await line({ mode: "shares", shares: { [A]: 2, [B]: 2, [C]: 1, [D]: 0 } });
  assert.equal(shares.status, "5 shares · ₱256 a share");
  assert.deepEqual(shares.shares, { [A]: 51200, [B]: 51200, [C]: 25600, [D]: 0 });
  const none = await line({ mode: "shares", shares: { [A]: 0, [B]: 0, [C]: 0, [D]: 0 } });
  assert.deepEqual([none.status, none.ok, none.problem], ["Give someone at least 1 share.", false, "Give someone at least 1 share."]);
  const extra = await line({ mode: "adjust", extras: { [A]: "200" } });
  assert.equal(extra.status, "₱200 in extras, then ₱1,080 split equally over 4.");
  assert.deepEqual(extra.shares, { [A]: 47000, [B]: 27000, [C]: 27000, [D]: 27000 });
  const tooBig = await line({ mode: "adjust", extras: { [A]: "1,300" } });
  assert.deepEqual([tooBig.status, tooBig.ok], ["The extras are more than the amount.", false]);
});

test("W1-R23 today's checks keep today's words: no amount, no note, nobody to split with", async () => {
  const { checkForm } = await load();
  assert.equal(checkForm(await form({ amount: "" }), MEMBERS, OFF).problem, "Enter an amount, like 450 or 1,151.50.");
  assert.equal(checkForm(await form({ note: "  " }), MEMBERS, OFF).problem, "Say what it was for, like Taxi to Burnham Park.");
  assert.equal(checkForm(await form({ out: [A, B, C, D] }), MEMBERS, OFF).problem, "Pick at least one person to split it with.");
  assert.equal(checkForm(await form({ mode: "exact", exact: { [A]: "abc" } }), MEMBERS, OFF).problem, "Check the amounts: pesos, like 300 or 150.50.");
});

test("W1-R24 the input parsers: signed pesos, percents to basis points, and a charge as pesos or a percent", async () => {
  const { parseSignedPeso, parsePercentBp, parseCharge } = await load();
  assert.equal(parseSignedPeso("200"), 20000);
  assert.equal(parseSignedPeso("-50.50"), -5050);
  assert.equal(parseSignedPeso("−1,000"), -100000, "the typographic minus too");
  assert.equal(parseSignedPeso(""), 0, "an empty extra is no extra");
  assert.equal(parseSignedPeso("1.234"), null);
  assert.equal(parsePercentBp("33.33"), 3333);
  assert.equal(parsePercentBp("12.5"), 1250);
  assert.equal(parsePercentBp("100"), 10000);
  assert.equal(parsePercentBp(""), 0);
  for (const bad of ["33.333", "101", "-1", "abc", "1e2"]) assert.equal(parsePercentBp(bad), null, bad);
  assert.deepEqual(parseCharge("10%"), { basis: "percent", value: 1000 });
  assert.deepEqual(parseCharge(" 12.5 % "), { basis: "percent", value: 1250 });
  assert.deepEqual(parseCharge("120"), { basis: "amount", value: 12000 });
  assert.deepEqual(parseCharge("101%"), { basis: "percent", value: 10100 }, "over 100% is the split's charge_too_big, with its own line");
  assert.equal(parseCharge(""), null);
  assert.equal(parseCharge("0"), null, "nothing to charge");
  assert.equal(parseCharge("ten"), undefined, "not a charge: the form says so");
});

test("W1-R25 Save as Amounts (ux.md §9): the preview's shares as Amounts, the same money", async () => {
  const { checkForm, saveAsAmounts, buildBody } = await load();
  const s = await form({ mode: "itemized", amount: "", items: BILL, service: "10%" });
  const preview = checkForm(s, MEMBERS, ALL).shares!;
  const t = saveAsAmounts(s, preview);
  assert.equal(t.mode, "exact");
  assert.equal(t.amount, "1188");
  assert.deepEqual(t.items, s.items, "the items stay in the form");
  const sent = body(buildBody(t, MEMBERS, SPLITS, A)) as { mode: string; amount_centavos: number; inputs: { member_id: string; value: number }[] };
  assert.equal(sent.mode, "exact");
  assert.equal(sent.amount_centavos, 118800);
  assert.deepEqual(Object.fromEntries(sent.inputs.map((i) => [i.member_id, i.value])), preview);
});

// ---------------------------------------------------------------- the components, by source

const FORM = "src/components/wallet/ExpenseForm.tsx";
const ITEMS = "src/components/wallet/ItemsEditor.tsx";
const PAYERS = "src/components/wallet/PayersEditor.tsx";

test("W1-R26 ExpenseForm: the money comes from walletRequest, never its own arithmetic", () => {
  const src = read(FORM);
  for (const name of ["checkForm", "buildBody", "buildPatch", "switchMode"]) assert.match(src, new RegExp(`\\b${name}\\(`), name);
  assert.match(src, /from "@\/lib\/walletRequest"/);
  for (const banned of [/splitEqual\(/, /allocate\(/, /leftToAssign\(/, /Math\.round/, /parseFloat/]) assert.doesNotMatch(src, banned);
});

test("W1-R27 ExpenseForm: ux.md §2's controls and copy, in fieldsets with legends", () => {
  const src = read(FORM);
  for (const s of [
    "Amount",
    "What for",
    "The items plus charges",
    "Category",
    "Paid by",
    "Several people...",
    "Split",
    "Equal + extra",
    "Add expense",
    "Saving...",
    "Save changes",
    "Cancel",
    "Edit an expense",
    "Changes show to everyone and are kept in its history.",
    "Type what each person owes.",
    "Up to 2 decimals, like 33.33.",
    "Someone who had twice as much gets 2.",
    "Add an extra for anyone who had more. A minus takes some off.",
  ]) {
    assert.ok(src.includes(s), s);
  }
  for (const label of ["Transport", "Hotel", "Food", "Activities", "Other"]) assert.ok(src.includes(`"${label}"`), label);
  for (const legend of ["Category", "Split"]) assert.match(src, new RegExp(`<legend[^>]*>\\s*${legend}\\s*</legend>`), legend);
  assert.match(src, /One share less for \$\{/, "the stepper's names (TG-15's pattern)");
  assert.match(src, /aria-disabled=\{/, "a stepper at its end is aria-disabled, not disabled");
  assert.match(src, /aria-live="polite"/, "the status line is a polite live region");
  assert.match(src, /readOnly/, "Items makes the amount read-only");
});

test("W1-R28 ExpenseForm with the flags off keeps today's form: Equally and Custom amounts, no category, no new modes", () => {
  const src = read(FORM);
  assert.ok(src.includes("Custom amounts"), "today's pill name, flags off");
  assert.match(src, /walletSplits/);
  assert.match(src, /walletMultiPayer/);
});

test("W1-R29 ItemsEditor: each item is a name, Remove, a price and a named group of person pills", () => {
  const src = read(ITEMS);
  for (const s of ["Add an item", "Price", "Service charge", "VAT, other charges", "Each person", "Total"]) assert.ok(src.includes(s), s);
  assert.match(src, /role="group"/);
  assert.match(src, /`Who had \$\{/);
  assert.match(src, /`Remove \$\{/);
  assert.match(src, /maxLength=\{40\}/);
  assert.ok(src.includes("For a senior or PWD discount, type that item's price after the discount."));
  assert.ok(src.includes("If VAT is already in the prices, leave it empty."));
});

test("W1-R30 PayersEditor: a ₱ field per member, the left-to-place line, and Just one person paid", () => {
  const src = read(PAYERS);
  assert.ok(src.includes("Just one person paid"));
  assert.match(src, /aria-live="polite"/);
  assert.match(src, /inputMode="decimal"/);
});

test("W1-R31 logs (plan §2, CLAUDE rules): the form logs counts and the mode only, never a name, note, item or amount", () => {
  for (const f of [FORM, ITEMS, PAYERS]) {
    const src = read(f);
    const lines = src.split("\n").filter((l) => /console\.(log|info|warn|error)/.test(l));
    for (const l of lines) {
      assert.match(l, /\[tg-wallet\]/, `${f}: ${l.trim()}`);
      assert.doesNotMatch(l, /\b(note|name|amount|price|paid|body)\b(?!s?=%)/, `${f}: ${l.trim()}`);
    }
  }
  assert.match(read(FORM), /console\.info\("\[tg-wallet\] expense form/, "the form says what it did");
});

test("W1-R32 B22 a legacy reopen compares in wallet order, not the shares' stored order (audit S5)", async () => {
  const { formFromExpense } = await load();
  // ₱10.01 among Ana, Ben and Carla, paid by Dan. Today's order-given rule stored Carla 334, Ben 334, Ana 333; in wallet
  // order the equal split is Ana 334, Ben 334, Carla 333, so it isn't Equally: it reopens as Amounts, with each share
  const s = formFromExpense(
    expense({ paid_by: D, amount_centavos: 1001, shares: [{ member_id: C, share_centavos: 334 }, { member_id: B, share_centavos: 334 }, { member_id: A, share_centavos: 333 }] }),
    MEMBERS,
  );
  assert.equal(s.mode, "exact");
  assert.deepEqual(s.exact, { [A]: "3.33", [B]: "3.34", [C]: "3.34" });
  assert.equal(s.paidBy, D);
});

// ---------------------------------------------------------------- tg-ux2's UX review M1 and M2 (added in GREEN)

test("W1-R33 ux M1: an item with nobody gets its own line once it has a name or a price; a fresh row stays quiet", async () => {
  const { itemLine } = await load();
  assert.equal(itemLine({ key: "a", name: "", price: "", who: [] }, 0), null, "an empty row doesn't shout");
  assert.equal(itemLine({ key: "a", name: " Pinikpikan ", price: "", who: [] }, 0), "Pick who had Pinikpikan.");
  assert.equal(itemLine({ key: "a", name: "", price: "120", who: [] }, 1), "Pick who had item 2.");
  assert.equal(itemLine({ key: "a", name: "Rice", price: "160", who: [A] }, 3), null);
});

test("W1-R34 ux M1: in Items, the status line says why there's no bill, and is empty once there is one", async () => {
  const { checkForm } = await load();
  const status = async (patch: Record<string, unknown>) => {
    const c = checkForm(await form({ mode: "itemized", ...patch }), MEMBERS, SPLITS);
    return [c.status, c.bill === null];
  };
  assert.deepEqual(await status({ items: [BILL[0], { ...BILL[1], who: [] }] }), ["Pick who had Strawberry taho.", true]);
  assert.deepEqual(await status({ items: [BILL[0], { key: "n", name: "", price: "", who: [] }] }), ["Give item 2 a name.", true]);
  assert.deepEqual(await status({ items: [{ ...BILL[0], price: "0" }] }), ["The items come to ₱0. Type a price for at least one.", true]);
  assert.deepEqual(await status({ items: BILL, service: "10%" }), [null, false]);
  assert.deepEqual(await status({ items: BILL, service: "10%", note: "" }), [null, false], "the note isn't the bill's problem");
});

test("W1-R35 ux M2: payer and price fields have their own names", () => {
  assert.match(read(PAYERS), /aria-label=\{`What \$\{m\.name\} paid`\}/);
  assert.match(read(ITEMS), /aria-label=\{`Price of \$\{label\(it, i\)\}`\}/);
  assert.doesNotMatch(read(ITEMS), /placeholder="(10%|0 or 12%)"/, "ux S1: no charge placeholders that read like values");
});

test("W1-R36 tg-review2 nit 1: an editing form always saves through buildPatch, so with WALLET_SPLITS off it's refused, never added", () => {
  const src = read(FORM);
  assert.match(src, /const edit = !!editing;/);
  assert.match(src, /edit \? buildPatch\(/);
});

// ---------------------------------------------------------------- TG-70 O2: a queued row's failed line, and its body back in the form

const QID = "22222222-2222-4222-8222-222222222222";
function queued(patch: Record<string, unknown> = {}, bodyPatch: Record<string, unknown> = {}) {
  return {
    id: QID,
    slug: "a".repeat(32),
    body: { id: QID, mode: "equal", paid_by: A, amount_centavos: 45000, note: "Taxi (made up)", category: null, by: A, inputs: [{ member_id: A, value: 1 }], ...bodyPatch },
    savedAt: "2026-11-26T02:00:00.000Z",
    tries: 2,
    nextAt: "2026-11-26T02:00:30.000Z",
    state: "failed",
    ...patch,
  } as never;
}

test("T70-L19 B19a failedLine: the table's rows, in order", async () => {
  const { failedLine } = (await load()) as Awaited<ReturnType<typeof load>> & { failedLine: (q: unknown) => string };
  const ANY = "Couldn't send. Put it in the form to check it, or remove it.";
  // 404 feature_off: FAILED_OFF, never "This wallet link doesn't work"
  assert.equal(failedLine(queued({ why: "not_found", detail: "feature_off" })), "Couldn't send. That kind of split is switched off right now. Put it in the form to save it another way, or remove it.");
  // 404 any other detail: the wallet is gone
  assert.equal(failedLine(queued({ why: "not_found" })), "Couldn't send. This wallet link doesn't work. Check it with whoever shared it.");
  assert.equal(failedLine(queued({ why: "not_found", detail: "wallet_not_found" })), "Couldn't send. This wallet link doesn't work. Check it with whoever shared it.");
  // DETAIL's codes
  assert.equal(failedLine(queued({ why: "rejected", detail: "wallet_full" })), "Couldn't send. This wallet is full: it holds up to 500 expenses.");
  assert.equal(failedLine(queued({ why: "rejected", detail: "unknown_member" })), "Couldn't send. That person isn't in this wallet any more. Reload and try again.");
  assert.equal(failedLine(queued({ why: "rejected", detail: "shares_mismatch" })), "Couldn't send. The amounts don't add up to the total.", "DETAIL comes before SPLIT_COPY");
  // a split code
  assert.equal(failedLine(queued({ why: "rejected", detail: "percent_total" })), "Couldn't send. The percents need to add up to 100%.");
  assert.equal(failedLine(queued({ why: "rejected", detail: "payers_mismatch" })), "Couldn't send. What people paid needs to add up to the amount.");
  // an item code names the item from the stored body
  const items = { mode: "itemized", items: [{ name: "Pinikpikan", price_centavos: 42000, who: [A] }, { name: "Strawberry taho", price_centavos: 12000, who: [] }], charges: [] };
  assert.equal(failedLine(queued({ why: "rejected", detail: "item_no_one", seq: 2 }, items)), "Couldn't send. Pick who had Strawberry taho.");
  assert.equal(failedLine(queued({ why: "rejected", detail: "item_no_one", seq: 9 }, items)), "Couldn't send. Pick who had each item.");
  // everything else
  for (const detail of ["id_taken", undefined, "something_new", "unknown_budget_line", "budget_line_category", "toString", "constructor", "__proto__"]) {
    assert.equal(failedLine(queued({ why: "rejected", ...(detail ? { detail } : {}) })), ANY, String(detail));
  }
  // failureMessage's generic default is never used for a queued row
  for (const q of [queued({ why: "rejected", detail: "nope" }), queued({ why: "rejected" })]) {
    assert.doesNotMatch(failedLine(q), /That didn't save/);
  }
});

test("T70-L15 formFromBody: buildBody(formFromBody(body)) is the body again, for all six modes, several payers, category and line", async () => {
  const { buildBody, formFromBody } = (await load()) as Awaited<ReturnType<typeof load>> & { formFromBody: (b: unknown, m: Member[]) => unknown };
  const { withBudgetKey, sentLine } = await import("./budgetLines.ts");
  const forms = [
    await form({ category: "food" }),
    await form({ out: [D], paidBy: B, category: "transport" }),
    await form({ mode: "exact", exact: { [A]: "400", [B]: "880", [C]: "0" } }),
    await form({ mode: "percent", percent: { [A]: "40", [B]: "33.33", [C]: "26.67", [D]: "" } }),
    await form({ mode: "shares", shares: { [A]: 2, [B]: 2, [C]: 1, [D]: 0 } }),
    await form({ mode: "adjust", out: [C], extras: { [A]: "200", [B]: "-50.50" } }),
    await form({ mode: "itemized", items: BILL, service: "10%", vat: "" }),
    await form({ mode: "itemized", items: BILL, service: "", vat: "120" }),
    await form({ category: "food", several: true, paid: { [A]: "800", [B]: "480" } }),
    await form({ mode: "percent", percent: { [A]: "50", [B]: "50" }, several: true, paid: { [B]: "1,000", [C]: "280" } }),
  ];
  for (const [i, f] of forms.entries()) {
    for (const line of [null, "food-1", "_none"]) {
      const built = withBudgetKey(body(buildBody(f, MEMBERS, ALL, B)) as object, { on: true, line });
      const sent = { ...built, id: QID };
      const back = formFromBody(sent, MEMBERS) as Parameters<typeof buildBody>[0];
      assert.equal(JSON.stringify(back).includes(QID), false, `form ${i}: the id never goes into the form`);
      const again = withBudgetKey(body(buildBody(back, MEMBERS, ALL, B)) as object, { on: true, line: sentLine(sent) });
      assert.deepEqual(again, built, `form ${i}, line ${line}`);
    }
  }
});
