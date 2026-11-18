// TG-66 W3: the wallet screen's wiring. Run with `npm test`. Plan §3 B26 (a 409 shows the newer expense and a message,
// never a lost edit), B27 (the rev rule for write answers too), B28 (flags off: today's screen and bodies), B28a (each
// feature_off line from what was sent, and Save as Amounts), B28b (several payers with WALLET_MULTI_PAYER off), B28c
// (ProofDialog's `by` and its GET through the rev rule; in walletProof.test.ts and wallet.test.ts), plus ux.md §6, §7
// and §9's lines and tg-ux2's carry-overs (W2 S1: focus back to an activity note). The pure logic is walletView.ts;
// WalletView.tsx is checked by source (node can't render TSX) and end to end (E1 to E5, the TG-58 kit).
// The module is loaded per test, so before it exists each test fails on its own instead of the whole file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Expense, ExpensePatch, Wallet, WalletResult } from "./wallet.ts";

const load = () => import("./walletView.ts");
const WEB = new URL("../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, WEB), "utf8").replaceAll("&apos;", "'");
const VIEW = "src/components/WalletView.tsx";

// Made-up people, in wallet order
const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const C = "00000000-0000-4000-8000-000000000003";
const D = "00000000-0000-4000-8000-000000000004";
const SLUG = "e".repeat(32);
const OFF = { walletSplits: false, walletMultiPayer: false, walletActivity: false };
const ON = { walletSplits: true, walletMultiPayer: true, walletActivity: true };

function expense(over: Partial<Expense> = {}): Expense {
  return {
    id: "e1",
    paid_by: A,
    amount_centavos: 128000,
    note: "Lunch at TESTPLACE",
    created_at: "2026-11-06T05:02:00Z",
    shares: [A, B, C, D].map((m) => ({ member_id: m, share_centavos: 32000 })),
    mode: "equal",
    inputs: [A, B, C, D].map((m) => ({ member_id: m, value: 1 })),
    category: "food",
    version: 1,
    ...over,
  };
}
function wallet(expenses: Expense[], rev = 5): Wallet {
  return {
    share_slug: SLUG,
    name: "Made-up trip",
    created_at: "2026-11-06T04:00:00Z",
    members: [
      { id: A, name: "Ana" },
      { id: B, name: "Ben" },
      { id: C, name: "Carla" },
      { id: D, name: "Dan" },
    ],
    expenses,
    settlements: [],
    balances: [],
    transfers: [],
    total_centavos: expenses.reduce((a, e) => a + e.amount_centavos, 0),
    rev,
  };
}
const patch = (over: Partial<ExpensePatch> = {}) =>
  ({ mode: "equal", paid_by: A, amount_centavos: 128000, note: "Lunch at TESTPLACE", category: "food", by: A, inputs: [], version: 1, ...over }) as ExpensePatch;

// ---------------------------------------------------------------- B28: which parts show, by flag

test("W3-V1 B28 flags off shows today's screen: no compact cards, Categories or Activity; each flag adds its part", async () => {
  const { screenParts } = await load();
  // `by` isn't a part: the manager's decision (plan §2 addendum) sends ?by= whenever a person is picked, flags or not
  assert.deepEqual(screenParts(OFF), { compactCards: false, categories: false, activity: false });
  assert.deepEqual(screenParts(ON), { compactCards: true, categories: true, activity: true });
  assert.deepEqual(screenParts({ ...OFF, walletSplits: true }), { compactCards: true, categories: true, activity: false }, "Edit lives in Details");
  assert.deepEqual(screenParts({ ...OFF, walletActivity: true }), { compactCards: true, categories: false, activity: true }, "Comments live in Details");
  assert.deepEqual(screenParts({ ...OFF, walletMultiPayer: true }), { compactCards: true, categories: false, activity: false }, "Paid by Ana ₱800 and Ben ₱480 is in Details");
});

// ---------------------------------------------------------------- B26: someone else saved first

test("W3-V2 B26 a 409 expense_changed reloads the form with their version and says what they changed; nothing is lost silently", async () => {
  const { editOutcome } = await load();
  const mine = expense();
  const theirs = expense({ mode: "shares", inputs: [{ member_id: A, value: 2 }, { member_id: B, value: 2 }, { member_id: C, value: 1 }], version: 2 });
  const now = wallet([theirs], 9);
  const r: WalletResult = { ok: false, why: "rejected", detail: "expense_changed", wallet: now };
  const out = editOutcome(r, patch(), mine, "Ben");
  assert.equal(out.kind, "changed");
  if (out.kind !== "changed") return;
  assert.equal(out.wallet, now, "the wallet as it is now goes on screen (through the rev rule)");
  assert.equal(out.expense, theirs, "the form reopens on their version");
  assert.equal(
    out.alert,
    "Someone changed this expense while you were editing. The form now shows their version, so your change isn't saved. Ben changed the split: Equally → Shares 2:2:1. Make your change again if it's still needed.",
  );
  const unknown = editOutcome(r, patch(), mine, null);
  assert.ok(unknown.kind === "changed" && unknown.alert.includes(" Someone changed the split: Equally → Shares 2:2:1. "), "no actor known: Someone");
});

test("W3-V3 B26 an expense deleted meanwhile (404 expense_gone, or a 409 whose wallet no longer has it) goes back to Add", async () => {
  const { editOutcome } = await load();
  const now = wallet([], 9);
  for (const r of [
    { ok: false, why: "not_found", detail: "expense_gone", wallet: now },
    { ok: false, why: "rejected", detail: "expense_changed", wallet: now },
  ] as WalletResult[]) {
    const out = editOutcome(r, patch(), expense(), null);
    assert.deepEqual(out, { kind: "gone", wallet: now, alert: "This expense was deleted, so there's nothing to save." });
  }
});

test("W3-V4 a saved edit says `Changes saved.`; other refusals keep the form open with ux §9's line", async () => {
  const { editOutcome } = await load();
  const w = wallet([expense({ version: 2 })], 6);
  assert.deepEqual(editOutcome({ ok: true, wallet: w }, patch(), expense(), null), { kind: "saved", wallet: w, text: "Changes saved." });
  const off = editOutcome({ ok: false, why: "not_found", detail: "feature_off" }, patch(), expense(), null);
  assert.deepEqual(off, { kind: "refused", alert: "Editing isn't switched on right now. Your changes weren't saved.", asAmounts: false });
  const pct = editOutcome({ ok: false, why: "rejected", detail: "percent_total" }, patch({ mode: "percent" } as Partial<ExpensePatch>), expense(), null);
  assert.deepEqual(pct, { kind: "refused", alert: "The percents need to add up to 100%.", asAmounts: false });
  const offline = editOutcome({ ok: false, why: "offline" }, patch(), expense(), null);
  assert.deepEqual(offline, { kind: "refused", alert: "No signal, so this wasn't saved. Try again when you're back online.", asAmounts: false });
});

// ---------------------------------------------------------------- B28a: feature_off, from what was sent

test("W3-V5 B28a a feature_off line is picked from what was sent, in ux §9's table order: edit, several payers, the split", async () => {
  const { featureOffLine } = await load();
  const edit = featureOffLine({ edit: true, body: patch({ mode: "percent", payers: [{ member_id: A, paid_centavos: 1 }] } as Partial<ExpensePatch>) });
  assert.deepEqual(edit, { text: "Editing isn't switched on right now. Your changes weren't saved.", asAmounts: false });
  const payers = featureOffLine({ edit: false, body: { mode: "shares", payers: [{ member_id: A, paid_centavos: 80000 }, { member_id: B, paid_centavos: 48000 }], amount_centavos: 128000, note: "x", inputs: [] } as never });
  assert.deepEqual(payers, { text: "More than one payer isn't switched on right now. Pick one person under Paid by.", asAmounts: false });
  const names: [string, string][] = [["percent", "Percent"], ["shares", "Shares"], ["adjust", "Equal + extra"], ["itemized", "Items"]];
  for (const [mode, name] of names) {
    assert.deepEqual(featureOffLine({ edit: false, body: { mode, paid_by: A, note: "x" } as never }), {
      text: `The ${name} split isn't switched on right now. Equally and Amounts still work.`,
      asAmounts: true,
    }, mode);
  }
  // Equally or Amounts with the flag off is accepted by the server (category dropped), so a feature_off there is an odd
  // answer: say what failed in general terms, never a split line
  const odd = featureOffLine({ edit: false, body: { mode: "equal", paid_by: A, note: "x" } as never });
  assert.equal(odd.asAmounts, false);
  assert.doesNotMatch(odd.text, /split isn't switched on/);
});

// ---------------------------------------------------------------- an add's answer

test("W3-V6 an add says `Expense added.`, or ux §9's dropped-category line when a picked category came back null", async () => {
  const { addOutcome } = await load();
  const before = wallet([expense({ id: "old" })], 4);
  const sentFood = { mode: "equal", paid_by: A, amount_centavos: 1000, note: "Taxi", category: "food", by: A, inputs: [] } as never;
  const kept = wallet([expense({ id: "new", category: "food" }), expense({ id: "old" })], 5);
  assert.deepEqual(addOutcome(before, sentFood, { ok: true, wallet: kept }), { ok: true, wallet: kept, text: "Expense added." });
  const dropped = wallet([expense({ id: "new", category: null }), expense({ id: "old" })], 5);
  assert.deepEqual(addOutcome(before, sentFood, { ok: true, wallet: dropped }), {
    ok: true,
    wallet: dropped,
    text: "Added. Categories aren't switched on right now, so it has no category yet.",
  });
  const legacy = { paid_by: A, amount_centavos: 1000, note: "Taxi", split_among: [A] } as never;
  assert.deepEqual(addOutcome(before, legacy, { ok: true, wallet: dropped }), { ok: true, wallet: dropped, text: "Expense added." }, "nothing picked, nothing dropped");
});

test("W3-V7 an add's refusal: ux §9's split lines, item_no_one named from the form's own item, feature_off by what was sent", async () => {
  const { addOutcome } = await load();
  const before = wallet([], 4);
  const items = { mode: "itemized", paid_by: A, note: "x", items: [{ name: "Pinikpikan", price_centavos: 1, who: [A] }, { name: "Strawberry taho", price_centavos: 1, who: [] }], charges: [] } as never;
  assert.deepEqual(addOutcome(before, items, { ok: false, why: "rejected", detail: "item_no_one", seq: 2 }), { ok: false, alert: "Pick who had Strawberry taho.", asAmounts: false });
  assert.deepEqual(addOutcome(before, items, { ok: false, why: "rejected", detail: "item_no_one", seq: 9 }), { ok: false, alert: "Pick who had each item.", asAmounts: false });
  assert.deepEqual(addOutcome(before, items, { ok: false, why: "not_found", detail: "feature_off" }), {
    ok: false,
    alert: "The Items split isn't switched on right now. Equally and Amounts still work.",
    asAmounts: true,
  });
  assert.deepEqual(addOutcome(before, items, { ok: false, why: "rejected", detail: "amount_mismatch" }), { ok: false, alert: "The amount doesn't match the items. Check them and try again.", asAmounts: false });
  assert.deepEqual(addOutcome(before, items, { ok: false, why: "rejected", detail: "wallet_full" }), { ok: false, alert: "This wallet is full: it holds up to 500 expenses.", asAmounts: false }, "today's lines stay");
});

// ---------------------------------------------------------------- ux §6 and §7

test("W3-V8 the edit header's `Added by <who>` comes from the expense's add row, when the activity has it", async () => {
  const { addedBy } = await load();
  const w = wallet([expense()]);
  const row = (action: string, actor: string | null, id: number) => ({ id, at: "2026-11-06T05:02:00Z", actor, action, expense_id: "e1", settlement_id: null, member_id: null, before: null, after: null });
  assert.equal(addedBy([row("expense_edit", A, 9), row("expense_add", B, 3)] as never, w), "Ben");
  assert.equal(addedBy([row("expense_add", null, 3)] as never, w), "Someone");
  assert.equal(addedBy([row("expense_edit", A, 9)] as never, w), null, "no add row (a legacy expense): the header says Added <when>");
});

test("W3-V9 ux §7 the nudge's filter: only the expenses with no category, and its line", async () => {
  const { visibleExpenses } = await load();
  const list = [expense({ id: "a", category: null }), expense({ id: "b" }), expense({ id: "c", category: undefined })];
  assert.deepEqual(visibleExpenses(list, false).map((e) => e.id), ["a", "b", "c"]);
  assert.deepEqual(visibleExpenses(list, true).map((e) => e.id), ["a", "c"]);
});

// ---------------------------------------------------------------- WalletView, by source

test("W3-V10 WalletView mounts W1's form and W2's parts, each behind its flag, and keeps today's cards with the flags off", () => {
  const src = read(VIEW);
  assert.match(src, /from "@\/components\/wallet\/ExpenseForm"/);
  assert.match(src, /from "@\/components\/wallet\/ExpenseDetails"/);
  assert.match(src, /from "@\/components\/wallet\/ActivityList"/);
  assert.match(src, /from "@\/components\/wallet\/CategoryBox"/);
  assert.match(src, /screenParts\(flags\)/);
  assert.match(src, /parts\.categories && <CategoryBox\b/);
  assert.match(src, /parts\.activity && <ActivityList\b/);
  assert.doesNotMatch(src, /function ExpenseForm\(/, "the inline form is gone: W1's is the one form");
  // Today's card, flags off: the shares line and its own Delete, as at a1c4299
  assert.match(src, /e\.shares\.map\(\(s\) => `\$\{nameOf\(s\.member_id\)\} \$\{formatPeso\(s\.share_centavos\)\}`\)\.join\(" · "\)/);
  assert.match(src, /aria-label=\{`Delete \$\{e\.note\}`\}/);
  // The compact card: Details named by the note
  assert.match(src, /aria-label=\{`Details of \$\{e\.note\}`\}/);
  assert.match(src, /cardMeta\(e, wallet\)/);
});

test("W3-V11 B28b and offline: Details gets the three flags and the phone's signal; Edit hands the form its expense", () => {
  const src = read(VIEW);
  assert.match(src, /<ExpenseDetails\b[\s\S]*?splits=\{flags\.walletSplits\}[\s\S]*?\/>/);
  assert.match(src, /<ExpenseDetails\b[\s\S]*?multiPayer=\{flags\.walletMultiPayer\}[\s\S]*?\/>/);
  assert.match(src, /<ExpenseDetails\b[\s\S]*?activity=\{flags\.walletActivity\}[\s\S]*?\/>/);
  assert.match(src, /<ExpenseDetails\b[\s\S]*?online=\{online\}[\s\S]*?\/>/);
  assert.match(src, /useSyncExternalStore\(subscribeOnline/, "navigator.onLine, kept live");
  assert.match(src, /<ExpenseForm\b[\s\S]*?flags=\{flags\}[\s\S]*?\/>/);
  assert.match(src, /key=\{formKey\}/, "a 409 remounts the form on their version");
});

test("W3-V12 B27: every wallet a write brings back lands through one path, with the rev rule; GETs through afterGet", () => {
  const src = read(VIEW);
  assert.equal(src.match(/setLoad\(/g)?.length, 2, "afterGet's GET and landWallet: nothing else sets the wallet");
  const land = src.slice(src.indexOf("function landWallet("), src.indexOf("}", src.indexOf("setLoad(", src.indexOf("function landWallet("))));
  assert.match(land, /shownAt\.current = Date\.now\(\);[\s\S]*setLoad\(\(prev\) => afterWrite\(prev, next\)\)/, "marked new, then the rev rule");
  for (const caller of ["async function write(", "function proofSaved(", "onWallet={"]) assert.ok(src.includes(caller), caller);
  assert.ok((src.match(/landWallet\(/g)?.length ?? 0) >= 5, "write, proofSaved, comments, a 409's wallet and a refused delete's wallet");
});

test("W3-V13 W2 S1 (tg-ux2): closing Details puts focus back on what opened it, an activity note or the card's Details", () => {
  const src = read(VIEW);
  assert.match(src, /opener\.current = /);
  assert.match(src, /onClosed=\{[\s\S]{0,200}opener\.current/);
  assert.match(src, /isConnected/, "an opener that has gone (the line re-rendered) falls back to the card's Details");
});

test("W3-V14 ux §6: Edit scrolls to the form and hands it focus; Cancel or a save goes back to the expense's Details", () => {
  const src = read(VIEW);
  assert.match(src, /getElementById\("add-title"\)[\s\S]{0,120}scrollIntoView/);
  assert.match(src, /`details-\$\{/, "each card's Details has an id to come back to");
  assert.ok(src.includes('"Changes saved."') || read("src/lib/walletView.ts").includes('"Changes saved."'));
});

test("W3-V15 the form's alert (a 409, a deleted-meanwhile or a feature_off) sits in the form, with Save as Amounts under it", () => {
  const src = read(VIEW);
  assert.match(src, /notice=\{/);
  assert.match(src, /Save as Amounts/);
  assert.match(src, /asAmounts\(\)/);
});

test("W3-V16 logs: wallet writes and the new paths log outcomes and counts only, never a name, note, amount or member id", () => {
  for (const f of [VIEW, "src/lib/walletView.ts"]) {
    for (const [, args] of read(f).matchAll(/console\.\w+\(([^;]*)\);/g)) {
      const values = args.replace(/^\s*"[^"]*"/, ""); // the values after the format string
      assert.doesNotMatch(args, /(?<!err\.)\bname\b|\bnote\b|\bslug\b|\blabel\b|amount_centavos|member_id/, `${f}: ${args}`);
      assert.doesNotMatch(values, /\bme\b|\bby\b/, `${f}: a member id in a log: ${args}`);
    }
  }
  assert.match(read(VIEW), /console\.info\("\[tg-wallet\] expense edit ok=%s/);
});
