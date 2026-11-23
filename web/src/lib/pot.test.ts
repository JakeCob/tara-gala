// TG-73 P0: the pot's money on the web (pot.ts), the twin of api/app/pot_math.py. Run with `npm test`.
// Test-plan §1: every vector in api/tests/fixtures/pot_vectors.json (shared with test_pot_math.py), the seeded property
// loop over 500 random wallets, and a source guard. The module is loaded per test, so before it exists each test fails
// on its own instead of the whole file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const load = () => import("./pot.ts");
const WEB = new URL("../../", import.meta.url);
const ROOT = new URL("../", WEB);

type Vector = {
  name: string;
  each: number;
  people: { id: string; in_goal: boolean; target: number | null }[];
  ambag: { member: string; kind: "in" | "back"; amount: number; status: "sent" | "received" }[];
  spends: number[];
  treasurer: string;
  order: string[];
  expect: {
    C: number; S: number; B: number; c: Record<string, number>; pending: number; pending_count: number;
    refunds?: Record<string, number>; shortfall?: Record<string, number>; delta?: Record<string, number>; refuse?: string;
  };
};
const VECTORS = JSON.parse(readFileSync(new URL("api/tests/fixtures/pot_vectors.json", ROOT), "utf8")) as { cases: Vector[] };

const rows = (v: Vector) => ({
  people: v.people.map((p) => ({ member_id: p.id, in_goal: p.in_goal, target: p.target })),
  ambag: v.ambag.map((a) => ({ member_id: a.member, kind: a.kind, amount: a.amount, status: a.status })),
});

test("P0-W0 the shared vector file names V1 to V18 and a refusal", () => {
  const names = new Set(VECTORS.cases.map((c) => c.name.split(" ")[0]));
  for (let i = 1; i <= 18; i++) assert.ok(names.has(`V${i}`), `V${i}`);
  assert.ok(VECTORS.cases.some((c) => c.expect.refuse === "no_one_in_goal"));
});

for (const v of VECTORS.cases) {
  test(`P0-W1 vector: ${v.name}`, async () => {
    const { potNumbers, closeOut } = await load();
    const { people, ambag } = rows(v);
    const n = potNumbers(people, ambag, v.spends, v.each, v.order);
    assert.deepEqual([n.received, n.spent, n.balance], [v.expect.C, v.expect.S, v.expect.B]);
    assert.deepEqual([n.pendingCentavos, n.pendingCount], [v.expect.pending, v.expect.pending_count]);
    assert.deepEqual(Object.entries(n.contributed), Object.entries(v.expect.c), "c_i, in wallet order");
    const out = closeOut(n, v.treasurer, v.order);
    if (v.expect.refuse) {
      assert.deepEqual(out, { ok: false, error: v.expect.refuse });
      return;
    }
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.deepEqual(Object.entries(out.refunds), Object.entries(v.expect.refunds ?? {}), "T first, then wallet order");
    assert.deepEqual(Object.entries(out.shortfall), Object.entries(v.expect.shortfall ?? {}));
    assert.deepEqual(Object.entries(out.delta), Object.entries(v.expect.delta ?? {}));
    for (const x of [...Object.values(out.refunds), ...Object.values(out.delta)]) assert.ok(Number.isSafeInteger(x));
  });
}

test("P0-W2 targets: the in-goal people's own amount, or each; a custom 0 is kept", async () => {
  const { potNumbers } = await load();
  const v2 = VECTORS.cases.find((c) => c.name.startsWith("V2 "))!;
  const { people, ambag } = rows(v2);
  assert.deepEqual(potNumbers(people, ambag, v2.spends, v2.each, v2.order).targets,
    { ana: 800000, ben: 800000, carlo: 800000, bea: 500000, di: 800000 });
  assert.deepEqual(potNumbers([{ member_id: "a", in_goal: true, target: 0 }], [], [], 800000, ["a"]).targets, { a: 0 });
  const v13 = VECTORS.cases.find((c) => c.name.startsWith("V13 "))!;
  const r13 = rows(v13);
  const n13 = potNumbers(r13.people, r13.ambag, v13.spends, v13.each, v13.order);
  assert.deepEqual([n13.targets, n13.inGoal], [{ ana: 500000, ben: 500000 }, ["ana", "ben"]]);
});

test("P0-W3 caller bugs throw, as pot_math's ValueError", async () => {
  const { potNumbers, closeOut } = await load();
  const one = [{ member_id: "a", in_goal: true, target: null }];
  assert.throws(() => potNumbers(one, [{ member_id: "a", kind: "back", amount: 1, status: "sent" }], [], 100, ["a"]));
  assert.throws(() => potNumbers(one, [{ member_id: "a", kind: "back", amount: 5, status: "received" }], [], 100, ["a"]));
  assert.throws(() => potNumbers(one, [{ member_id: "z", kind: "in", amount: 5, status: "received" }], [], 100, ["a"]));
  assert.throws(() => potNumbers(one, [{ member_id: "a", kind: "in", amount: 0, status: "received" }], [], 100, ["a"]));
  assert.throws(() => potNumbers(one, [], [0], 100, ["a"]));
  assert.throws(() => closeOut(potNumbers([], [], [], 100, ["a"]), "x", ["a"]));
});

test("P0-W4 big pots stay exact: the leftover times an ambag can pass 2^53", async () => {
  const { potNumbers, closeOut } = await load();
  const order = ["a", "b", "c"];
  const people = order.map((m) => ({ member_id: m, in_goal: true, target: null }));
  const ambag = order.flatMap((m, k) =>
    Array.from({ length: 300 + k }, () => ({ member_id: m, kind: "in" as const, amount: 9_999_999, status: "received" as const })));
  const n = potNumbers(people, ambag, [7], 100, order);
  assert.ok(n.balance * n.contributed.c > Number.MAX_SAFE_INTEGER, "the product a double would round");
  const out = closeOut(n, "b", order);
  assert.ok(out.ok);
  if (!out.ok) return;
  const C = BigInt(n.received);
  const B = BigInt(n.balance);
  for (const m of order) {
    const floor = Number((B * BigInt(n.contributed[m])) / C);
    assert.ok(out.refunds[m] - floor >= 0 && out.refunds[m] - floor <= 1, m);
  }
  assert.equal(Object.values(out.refunds).reduce((x, y) => x + y, 0), n.balance);
});

function rng(seed: number) {
  let s = seed >>> 0;
  return (k: number) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s % k;
  };
}

test("P0-W5 properties over 500 random wallets (test-plan §1)", async () => {
  const { potNumbers, closeOut } = await load();
  const r = rng(7303);
  let refused = 0;
  for (let i = 0; i < 500; i++) {
    const size = 1 + r(20);
    const order = Array.from({ length: size }, (_, k) => `m${k}`);
    const people = order.filter(() => r(10) < 9).map((m) => ({ member_id: m, in_goal: r(100) < 85, target: r(3) === 0 ? r(10_000_001) : null }));
    const ambag: { member_id: string; kind: "in" | "back"; amount: number; status: "sent" | "received" }[] = [];
    for (const m of order) {
      let got = 0;
      for (let k = r(4); k > 0; k--) {
        const amount = 1 + r(10_000_000);
        const status = r(3) === 0 ? "sent" : "received";
        if (status === "received") got += amount;
        ambag.push({ member_id: m, kind: "in", amount, status });
      }
      if (got > 0 && r(100) < 15) ambag.push({ member_id: m, kind: "back", amount: 1 + r(got), status: "received" });
    }
    const total = ambag.reduce((a, x) => a + (x.status === "received" ? x.amount : 0), 0);
    const spends = Array.from({ length: r(9) }, () => 1 + r(Math.max(1, Math.floor(total / 3)) || 1_000_000));
    const t = order[r(order.length)];
    const n = potNumbers(people, ambag, spends, 100 + r(10_000_000), order);
    assert.equal(n.balance, n.received - n.spent);
    const out = closeOut(n, t, order);
    if (!out.ok) {
      assert.ok(n.balance < 0 && n.inGoal.length === 0);
      refused++;
      continue;
    }
    const sum = (x: Record<string, number>) => Object.values(x).reduce((a, b) => a + b, 0);
    assert.equal(sum(out.refunds), Math.max(n.balance, 0), `case ${i}`);
    assert.equal(sum(out.shortfall), Math.max(-n.balance, 0), `case ${i}`);
    assert.equal(sum(out.delta), 0, `case ${i}`);
    assert.deepEqual(Object.keys(out.delta), order);
    for (const v of [...Object.values(out.refunds), ...Object.values(out.shortfall)]) assert.ok(v >= 0);
    if (n.balance > 0) {
      for (const [m, got] of Object.entries(out.refunds)) {
        const floor = Number((BigInt(n.balance) * BigInt(n.contributed[m])) / BigInt(n.received));
        assert.ok(got - floor >= 0 && got - floor <= 1, `case ${i} ${m}`);
      }
    }
  }
  assert.ok(refused < 50);
});

test("P0-W6 source guard: pot.ts has no float rounding, toFixed, parseFloat or runtime import", () => {
  const src = readFileSync(new URL("src/lib/pot.ts", WEB), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(src, /Math\.(round|floor|ceil)/, "BigInt division floors; nothing else rounds");
  assert.doesNotMatch(src, /toFixed|parseFloat/);
  assert.doesNotMatch(src, /^\s*import\s+(?!type\b)/m, "pure: no runtime imports");
});
