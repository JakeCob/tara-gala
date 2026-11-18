// TG-66 W1: the web's split preview (walletSplit.ts), the twin of api/app/wallet_splits.py. Run with `npm test`.
// Plan §2 and §3 B18: every vector in api/tests/fixtures/wallet_split_vectors.json (tg-test's, shared with A1's suite),
// integers only, plus the rounding properties of B2 on seeded random cases and a source guard against floats.
// The module is loaded per test, so before it exists each test fails on its own instead of the whole file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const load = () => import("./walletSplit.ts");
const WEB = new URL("../../", import.meta.url);
const ROOT = new URL("../", WEB);

type Vector = {
  name: string;
  mode: "equal" | "exact" | "percent" | "shares" | "adjust" | "itemized";
  amount?: number;
  inputs?: { member_id: string; value: number }[];
  items?: { name: string; price_centavos: number; who: string[] }[];
  charges?: { kind: "service" | "vat"; basis: "percent" | "amount"; value: number }[];
  payer_first: string;
  wallet_order: string[];
  expect: { amount: number; shares: Record<string, number> } | { error: string; seq?: number };
};
const VECTORS = JSON.parse(readFileSync(new URL("api/tests/fixtures/wallet_split_vectors.json", ROOT), "utf8")) as {
  members: Record<string, string>;
  cases: Vector[];
};
const [ANA, BEN, CARLA, DAN, ELI, FE] = Object.values(VECTORS.members);
const ORDER4 = [ANA, BEN, CARLA, DAN];

test("W1-S0 the shared vector file is the one A1 reads, with every mode and every split code", () => {
  assert.ok(VECTORS.cases.length >= 50, "about 60 cases (plan §2)");
  const modes = new Set(VECTORS.cases.map((c) => c.mode));
  assert.deepEqual([...modes].sort(), ["adjust", "equal", "exact", "itemized", "percent", "shares"]);
  const codes = new Set(VECTORS.cases.flatMap((c) => ("error" in c.expect ? [c.expect.error] : [])));
  for (const code of ["shares_mismatch", "percent_total", "shares_zero", "extras_too_big", "item_no_one", "too_many_items", "amount_mismatch", "items_zero", "amount_too_big", "charge_too_big"]) {
    assert.ok(codes.has(code), code);
  }
});

// B18: one test per vector, so a drift names its case
for (const v of VECTORS.cases) {
  test(`W1-S1 vector: ${v.mode}, ${v.name}`, async () => {
    const { trySplit } = await load();
    const got = trySplit(v.mode, v.amount ?? null, v.inputs ?? null, v.items ?? null, v.charges ?? null, v.payer_first, v.wallet_order);
    if ("error" in v.expect) {
      assert.equal(got.ok, false, `expected ${v.expect.error}`);
      if (got.ok) return;
      assert.equal(got.error, v.expect.error);
      assert.equal(got.seq, v.expect.seq, "item_no_one carries the item's seq (from 1); nothing else does");
    } else {
      assert.equal(got.ok, true, got.ok ? "" : `refused with ${got.error}`);
      if (!got.ok) return;
      assert.equal(got.amount, v.expect.amount);
      assert.deepEqual(got.shares, v.expect.shares);
      for (const s of Object.values(got.shares)) assert.ok(Number.isSafeInteger(s), "whole centavos only");
    }
  });
}

test("W1-S2 split() throws a SplitError with the code (and seq), as wallet_splits.split raises", async () => {
  const { split, SplitError } = await load();
  assert.throws(
    () => split("percent", 1000, [{ member_id: ANA, value: 4999 }, { member_id: BEN, value: 5000 }], null, null, ANA, ORDER4),
    (e: unknown) => e instanceof SplitError && e.code === "percent_total" && e.seq === undefined,
  );
  assert.throws(
    () => split("itemized", null, null, [{ name: "TESTITEM", price_centavos: 100, who: [ANA] }, { name: "TESTITEM2", price_centavos: 100, who: [] }], [], ANA, ORDER4),
    (e: unknown) => e instanceof SplitError && e.code === "item_no_one" && e.seq === 2,
  );
  assert.deepEqual(split("equal", 1001, [ANA, BEN, CARLA].map((m) => ({ member_id: m, value: 1 })), null, null, BEN, ORDER4), {
    amount: 1001,
    shares: { [ANA]: 334, [BEN]: 334, [CARLA]: 333 },
  });
});

test("W1-S3 allocate: floor, then the leftover one each in the order given, skipping weight 0", async () => {
  const { allocate } = await load();
  assert.deepEqual(allocate(1003, { a: 1, b: 1, c: 1, d: 1 }, ["c", "a", "b", "d"]), { a: 251, b: 251, c: 251, d: 250 });
  assert.deepEqual(allocate(102, { a: 2, b: 1, c: 1 }, ["a", "b", "c"]), { a: 52, b: 25, c: 25 }, "the payer gets +1 although 51 is whole");
  assert.deepEqual(allocate(1, { a: 0, b: 1, c: 1 }, ["a", "b", "c"]), { a: 0, b: 1, c: 0 }, "weight 0 never takes the leftover");
  assert.deepEqual(allocate(0, { a: 1, b: 3 }, ["a", "b"]), { a: 0, b: 0 });
});

test("W1-S4 charge_amount: percent in basis points rounds half up in integers; over 10000 bp is charge_too_big", async () => {
  const { chargeAmount, SplitError } = await load();
  assert.equal(chargeAmount(108000, "percent", 1000), 10800);
  assert.equal(chargeAmount(5, "percent", 1000), 1, "0.5 rounds up");
  assert.equal(chargeAmount(4, "percent", 1000), 0, "0.4 rounds down");
  assert.equal(chargeAmount(12345, "amount", 12000), 12000, "an amount is the value itself");
  assert.equal(chargeAmount(10_000_000, "percent", 10000), 10_000_000);
  assert.throws(() => chargeAmount(1000, "percent", 10001), (e: unknown) => e instanceof SplitError && e.code === "charge_too_big");
});

test("W1-S5 checkPayers (B4's rule, for the form): sum = amount, at least 2 payers, each at least 1", async () => {
  const { checkPayers, SplitError } = await load();
  assert.doesNotThrow(() => checkPayers(1280, { [ANA]: 800, [BEN]: 480 }));
  const refused = (e: unknown) => e instanceof SplitError && e.code === "payers_mismatch";
  assert.throws(() => checkPayers(1280, { [ANA]: 800, [BEN]: 479 }), refused);
  assert.throws(() => checkPayers(1280, { [ANA]: 1280 }), refused, "one payer is paid_by, not payers");
  assert.throws(() => checkPayers(1280, { [ANA]: 1280, [BEN]: 0 }), refused, "each at least 1");
});

test("W1-S6 firstPayer: the one paid_by, or the first payer in wallet order", async () => {
  const { firstPayer } = await load();
  assert.equal(firstPayer(CARLA, null, ORDER4), CARLA);
  assert.equal(firstPayer(null, { [DAN]: 100, [BEN]: 200 }, ORDER4), BEN);
  assert.equal(firstPayer(null, { [DAN]: 100, [ANA]: 0, [CARLA]: 5 }, ORDER4), CARLA, "a 0 isn't a payer");
});

test("W1-S7 equal through allocate gives today's splitEqual when the people are in wallet order (B3 on the web)", async () => {
  const { split } = await load();
  const { splitEqual } = await import("./wallet.ts");
  const people = [ANA, BEN, CARLA, DAN, ELI, FE];
  for (let amount = 1; amount <= 97; amount += 3) {
    for (let n = 1; n <= people.length; n++) {
      const among = people.slice(0, n);
      for (const payer of [ANA, CARLA, FE]) {
        const got = split("equal", amount, among.map((m) => ({ member_id: m, value: 1 })), null, null, payer, people);
        assert.deepEqual(got.shares, splitEqual(amount, among, payer), `${amount} over ${n}, payer ${payer}`);
      }
    }
  }
});

// B2 on the web: seeded, so a failure reproduces. Fewer cases than A1's 2,000 per mode: the vectors are the drift check
function rng(seed: number) {
  let s = seed >>> 0;
  return (n: number) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s % n;
  };
}

test("W1-S8 random cases: the shares sum to the amount, none below 0, each within floor(exact) and floor(exact) + 1", async () => {
  const { split } = await load();
  const r = rng(66);
  const people = [ANA, BEN, CARLA, DAN, ELI, FE];
  for (let i = 0; i < 600; i++) {
    const mode = (["equal", "percent", "shares"] as const)[i % 3];
    const n = 1 + r(people.length);
    const among = people.slice(0, n);
    const amount = 1 + r(10_000_000);
    const payer = people[r(people.length)];
    let weights: number[];
    if (mode === "equal") weights = among.map(() => 1);
    else if (mode === "shares") {
      weights = among.map(() => r(21));
      if (weights.every((w) => w === 0)) weights[0] = 1;
    } else {
      weights = among.map(() => 0);
      let left = 10000;
      for (let k = 0; k < n - 1; k++) {
        weights[k] = r(left + 1);
        left -= weights[k];
      }
      weights[n - 1] = left;
    }
    const inputs = among.map((m, k) => ({ member_id: m, value: weights[k] }));
    const { shares } = split(mode, amount, inputs, null, null, payer, people);
    const W = weights.reduce((a, b) => a + b, 0);
    assert.equal(Object.values(shares).reduce((a, b) => a + b, 0), amount, `case ${i}`);
    among.forEach((m, k) => {
      const floor = Math.floor((amount * weights[k]) / W); // < 10^11, exact in a double
      assert.ok(shares[m] >= floor && shares[m] <= floor + 1, `case ${i}: ${shares[m]} not in [${floor}, ${floor + 1}]`);
      assert.ok(shares[m] >= 0);
    });
  }
});

test("W1-S9 random itemized bills: the shares sum to the amount, and the amount is the items plus the charges", async () => {
  const { trySplit, chargeAmount } = await load();
  const r = rng(6604);
  const people = [ANA, BEN, CARLA, DAN, ELI, FE];
  for (let i = 0; i < 300; i++) {
    const items = Array.from({ length: 1 + r(12) }, (_, k) => {
      const who = people.filter(() => r(2) === 1);
      return { name: `TESTITEM${k}`, price_centavos: 1 + r(200_000), who: who.length ? who : [people[r(people.length)]] };
    });
    const charges = [
      ...(r(2) ? [{ kind: "service" as const, basis: "percent" as const, value: r(10001) }] : []),
      ...(r(2) ? [{ kind: "vat" as const, basis: "amount" as const, value: r(50_000) }] : []),
    ];
    const got = trySplit("itemized", null, null, items, charges, people[r(people.length)], people);
    assert.equal(got.ok, true, `case ${i}`);
    if (!got.ok) return;
    const S = items.reduce((a, it) => a + it.price_centavos, 0);
    const C = charges.reduce((a, c) => a + chargeAmount(S, c.basis, c.value), 0);
    assert.equal(got.amount, S + C, `case ${i}`);
    assert.equal(Object.values(got.shares).reduce((a, b) => a + b, 0), got.amount, `case ${i}`);
    for (const s of Object.values(got.shares)) assert.ok(s >= 0);
  }
});

test("W1-S10 source guard (B18): walletSplit.ts has no float rounding, toFixed, parseFloat or a division by 100", () => {
  const src = readFileSync(new URL("src/lib/walletSplit.ts", WEB), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(src, /Math\.round/);
  assert.doesNotMatch(src, /toFixed/);
  assert.doesNotMatch(src, /parseFloat/);
  assert.doesNotMatch(src, /\/\s*100\b/, "pesos are formatted elsewhere; the split is in centavos");
  assert.doesNotMatch(src, /^\s*import\s+(?!type\b)/m, "pure: no runtime imports, so the preview can't reach the network");
});
