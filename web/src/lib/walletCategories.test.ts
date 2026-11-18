// TG-66 W2: the wallet's Categories box, web side. Run with `npm test` (node --test, Node 22.18+ type stripping).
// Plan §3 B25; ux.md §7 and the 66-07-list and 66-07b-person shots. Computed on the web from WalletOut, with no endpoint.
// Names and amounts are made up. The module is imported dynamically, so before it exists each test fails on its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Category, Expense, Wallet } from "./wallet.ts";

type Mod = typeof import("./walletCategories.ts");
const C = (await import("./walletCategories.ts").catch(() => ({}))) as Mod;

const WEB = new URL("../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, WEB), "utf8").replaceAll("&apos;", "'");

const ANA = "m-ana";
const BEN = "m-ben";
const CARLA = "m-carla";
const DAN = "m-dan";
const PEOPLE = [ANA, BEN, CARLA, DAN];

let n = 0;
/** An expense split by the given shares; the amount is their sum, as the server keeps it. */
function expense(category: Category | null | undefined, split: Record<string, number>): Expense {
  const shares = Object.entries(split).map(([member_id, share_centavos]) => ({ member_id, share_centavos }));
  return {
    id: `e-${++n}`,
    paid_by: ANA,
    amount_centavos: shares.reduce((a, s) => a + s.share_centavos, 0),
    note: `Made-up expense ${n}`,
    created_at: "2026-11-06T05:00:00Z",
    shares,
    ...(category === undefined ? {} : { category }),
  };
}
const even = (total: number) => Object.fromEntries(PEOPLE.map((m) => [m, total / 4]));

/** The 66-07-list numbers: ₱18,000 in all, 3 expenses with no category. */
function shotWallet(): Wallet {
  const expenses = [
    expense("transport", even(180000)),
    expense("transport", even(98000)),
    expense("hotel", even(640000)),
    expense("food", { [ANA]: 141200, [BEN]: 141200, [CARLA]: 141200, [DAN]: 88400 }),
    expense("activities", even(160000)),
    expense("other", { [BEN]: 24000, [CARLA]: 24000 }),
    expense(null, even(18000)),
    expense(null, { [ANA]: 72000, [BEN]: 0 }),
    expense(undefined, { [ANA]: 4800, [CARLA]: 36000, [DAN]: 31200 }), // an old copy, saved before TG-66, has no category key
  ];
  return wallet(expenses);
}

function wallet(expenses: Expense[]): Wallet {
  const share = (m: string) => expenses.reduce((a, e) => a + (e.shares.find((s) => s.member_id === m)?.share_centavos ?? 0), 0);
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
    expenses,
    settlements: [],
    balances: PEOPLE.map((m) => ({ member_id: m, paid_centavos: 0, share_centavos: share(m), net_centavos: 0 })),
    transfers: [],
    total_centavos: expenses.reduce((a, e) => a + e.amount_centavos, 0),
    rev: 1,
  };
}

test("TG66-W2-C1 the five categories in fixed order, and null reads 'No category yet' (ux §2, §7)", () => {
  assert.deepEqual(C.CATEGORIES.map((c) => [c.key, c.label]), [
    ["transport", "Transport"],
    ["hotel", "Hotel"],
    ["food", "Food"],
    ["activities", "Activities"],
    ["other", "Other"],
  ]);
  assert.equal(C.categoryLabel("food"), "Food");
  assert.equal(C.categoryLabel(null), "No category yet");
  assert.equal(C.categoryLabel(undefined), "No category yet");
});

test("TG66-W2-C2 Everyone: the 66-07-list table, every row even at ₱0, Each = Total over the wallet's people", () => {
  const t = C.categoryTable(shotWallet());
  assert.deepEqual(
    t.rows.map((r) => [r.label, C.tableAmount(r.total), C.tableAmount(r.each)]),
    [
      ["Transport", "2,780", "695"],
      ["Hotel", "6,400", "1,600"],
      ["Food", "5,120", "1,280"],
      ["Activities", "1,600", "400"],
      ["Other", "480", "120"],
      ["No category yet", "1,620", "405"],
    ],
  );
  assert.deepEqual([C.tableAmount(t.total), C.tableAmount(t.each)], ["18,000", "4,500"]);
  const empty = C.categoryTable(wallet([]));
  assert.equal(empty.rows.length, 6, "the table never jumps");
  assert.ok(empty.rows.every((r) => r.total === 0 && r.each === 0));
});

test("TG66-W2-C3 one person: their part of each expense by category, summing to their share (66-07b-person)", () => {
  const w = shotWallet();
  const t = C.personTable(w, ANA);
  assert.deepEqual(
    t.rows.map((r) => [r.label, C.tableAmount(r.total)]),
    [
      ["Transport", "695"],
      ["Hotel", "1,600"],
      ["Food", "1,412"],
      ["Activities", "400"],
      ["Other", "0"],
      ["No category yet", "813"],
    ],
  );
  assert.equal(t.total, w.balances.find((b) => b.member_id === ANA)!.share_centavos);
  assert.equal(C.personTable(w, "m-not-here").total, 0);
});

test("TG66-W2-C4 B25: over seeded random wallets, the rows sum to total_centavos, and each person's rows to their share_centavos", () => {
  let seed = 66;
  const rand = (k: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % k;
  };
  const cats: (Category | null | undefined)[] = ["transport", "hotel", "food", "activities", "other", null, undefined];
  for (let round = 0; round < 300; round++) {
    const expenses = Array.from({ length: rand(12) }, () => {
      const split: Record<string, number> = {};
      for (const m of PEOPLE) if (rand(3)) split[m] = rand(500000);
      return expense(cats[rand(cats.length)], split);
    });
    const w = wallet(expenses);
    const all = C.categoryTable(w);
    assert.equal(all.rows.reduce((a, r) => a + r.total, 0), w.total_centavos);
    assert.equal(all.total, w.total_centavos);
    for (const b of w.balances) {
      const p = C.personTable(w, b.member_id);
      assert.equal(p.rows.reduce((a, r) => a + r.total, 0), b.share_centavos);
      assert.equal(p.total, b.share_centavos);
    }
  }
});

test("TG66-W2-C5 Each rounds half up to the centavo, in integers; amounts show without ₱, centavos only when there are some", () => {
  assert.deepEqual([C.eachOf(100, 3), C.eachOf(5, 2), C.eachOf(1, 2), C.eachOf(0, 4), C.eachOf(450, 0)], [33, 3, 1, 0, 0]);
  assert.deepEqual([C.tableAmount(115150), C.tableAmount(1), C.tableAmount(0), C.tableAmount(10000000)], ["1,151.50", "0.01", "0", "100,000"]);
});

test("TG66-W2-C6 Show for: Everyone, then this phone's person first as '(you)', then the wallet's order", () => {
  const w = shotWallet();
  assert.deepEqual(C.showForOptions(w, CARLA), [
    { value: "", label: "Everyone" },
    { value: CARLA, label: "Carla (you)" },
    { value: ANA, label: "Ana" },
    { value: BEN, label: "Ben" },
    { value: DAN, label: "Dan" },
  ]);
  assert.deepEqual(C.showForOptions(w, null).map((o) => o.label), ["Everyone", "Ana", "Ben", "Carla", "Dan"]);
  assert.deepEqual(C.showForOptions(w, "m-gone").map((o) => o.label), ["Everyone", "Ana", "Ben", "Carla", "Dan"]);
});

test("TG66-W2-C7 the box's lines are ux §7's: the meta, the person column, the nudge and the filter line", () => {
  assert.equal(C.everyoneMeta(4), "Each is the total split over the wallet's 4 people.");
  assert.equal(C.everyoneMeta(1), "Each is the total split over the wallet's 1 person.");
  assert.equal(C.personColumn("Ana"), "Ana's share");
  assert.equal(C.personMeta("Ana"), "Ana's part of every expense, by its category: what Ana spent, whoever paid.");
  const w = shotWallet();
  assert.equal(C.uncategorizedCount(w), 3);
  assert.deepEqual(C.onlyUncategorized(w.expenses).map((e) => e.id), w.expenses.slice(6).map((e) => e.id));
  assert.deepEqual(C.nudge(3), { text: "3 expenses have no category yet.", link: "Show them" });
  assert.deepEqual(C.nudge(1), { text: "1 expense has no category yet.", link: "Show it" });
  assert.equal(C.nudge(0), null);
  assert.deepEqual(C.showingLine(3), { text: "Showing 3 expenses with no category.", link: "Show all" });
  assert.deepEqual(C.showingLine(1), { text: "Showing 1 expense with no category.", link: "Show all" });
});

test("TG66-W2-C8 CategoryBox: a table with a caption, th scopes and a th Total row, from the helpers (ux §7, §10)", () => {
  const src = read("src/components/wallet/CategoryBox.tsx");
  for (const fn of ["categoryTable(", "personTable(", "showForOptions(", "tableAmount(", "nudge(", "everyoneMeta(", "personMeta(", "personColumn("]) assert.ok(src.includes(fn), fn);
  for (const s of ["Categories", "Show for", "Category (₱)", "Total", "Each", "<caption", 'scope="col"', 'scope="row"', "<select"]) assert.ok(src.includes(s), s);
  assert.match(src, /onShowUncategorized/, "the list's filter is the parent's");
  assert.ok(!src.includes("dangerouslySetInnerHTML"));
  const logs = src.match(/console\.(info|warn|error|log)\([^;]*;/g) ?? [];
  for (const l of logs) assert.doesNotMatch(l, /\.(note|name)\b|\bslug\b|\bmember/, l);
});
