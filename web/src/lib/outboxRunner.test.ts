// TG-70 O3 (plan Rev 3 §3 O3, B14, B14a, B15 to B19, B20a, B24; review-plan D1, D3): the sender that runs on any open
// page, as a plain function so node can run it. OutboxRunner.tsx only wires the events and the timer to it. It uses O2's
// outbox.ts (afterSend, due) and outboxStore.ts's shape, with a fake store and a fake send. Names are made up.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Queued, QueuedBody } from "./outbox.ts";
import type { OutboxStore } from "./outboxStore.ts";
import type { Wallet, WalletResult } from "./wallet.ts";

type Deps = {
  store: OutboxStore;
  send: (slug: string, body: QueuedBody, opts: { timeoutMs: number }) => Promise<WalletResult>;
  onLine: () => boolean;
  now: () => number;
  dispatch: (e: Record<string, unknown>) => void;
  sending: Set<string>;
};
type Runner = { run: (trigger: boolean) => Promise<number | null> };

const load = async () => {
  const path = "./outboxRunner.ts"; // not a literal: tsc mustn't resolve it before GREEN
  const m = (await import(path).catch(() => null)) as Record<string, unknown> | null;
  assert.ok(m, "outboxRunner.ts exists");
  assert.equal(typeof m.outboxRunner, "function", "it exports outboxRunner(deps)");
  return m as { outboxRunner: (d: Deps) => Runner; SEND_TIMEOUT_MS: number; OUTBOX_EVENT: string; OUTBOX_KICK: string };
};

const NOW = Date.parse("2026-11-26T07:42:00+08:00");
const SLUG = "a".repeat(32);
const ID = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const iso = (ms: number) => new Date(ms).toISOString();

const body = (n: number, over: Partial<QueuedBody> = {}): QueuedBody =>
  ({ id: ID(n), mode: "equal", paid_by: "m-ana", amount_centavos: 45000, note: `Taxi to Echo Valley ${n} (made up)`, category: "transport",
     by: "m-ana", inputs: [{ member_id: "m-ana", value: 1 }, { member_id: "m-ben", value: 1 }], ...over }) as QueuedBody;
const row = (n: number, over: Partial<Queued> = {}): Queued => ({
  id: ID(n), slug: SLUG, body: body(n), savedAt: iso(NOW - (100 - n) * 1000), tries: 1, nextAt: iso(NOW - 1000), state: "waiting", ...over,
});
const wallet = (ids: string[]): Wallet =>
  ({ share_slug: SLUG, name: "E2E wallet (made up)", created_at: iso(NOW), members: [{ id: "m-ana", name: "Ana (made up)" }, { id: "m-ben", name: "Ben (made up)" }],
     expenses: ids.map((id) => ({ id })), settlements: [], balances: [], transfers: [], total_centavos: 0, rev: 7 }) as unknown as Wallet;
const ok = (ids: string[]): WalletResult => ({ ok: true, wallet: wallet(ids) });

function fakeStore(rows: Queued[]) {
  const m = new Map(rows.map((r) => [r.id, r]));
  const calls: string[] = [];
  const store: OutboxStore & { rows: Map<string, Queued>; calls: string[]; failList?: boolean } = {
    rows: m,
    calls,
    held: new Set<string>(),
    async queue(r) { calls.push(`queue ${r.id}`); m.set(r.id, r); },
    async list() {
      if (store.failList) throw new Error("no-indexeddb");
      return [...m.values()].sort((a, b) => a.savedAt.localeCompare(b.savedAt));
    },
    async remove(id) { calls.push(`remove ${id}`); m.delete(id); },
    async update(r) { calls.push(`update ${r.id} ${r.state}`); m.set(r.id, r); },
  };
  return store;
}

/** A send that answers from a list, and records each call and how many ran at once. */
function fakeSend(answers: ((slug: string, b: QueuedBody) => WalletResult | Promise<WalletResult>)[]) {
  const calls: { slug: string; body: QueuedBody; opts: { timeoutMs: number } }[] = [];
  let inFlight = 0;
  let most = 0;
  const send = async (slug: string, b: QueuedBody, opts: { timeoutMs: number }) => {
    calls.push({ slug, body: b, opts });
    inFlight++;
    most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    const next = answers.shift();
    const answer = next ? await next(slug, b) : ok([b.id]);
    inFlight--;
    return answer;
  };
  return { send, calls, most: () => most };
}

let events: Record<string, unknown>[] = [];
let logged: string[] = [];
const originalInfo = console.info;
beforeEach(() => {
  events = [];
  logged = [];
  console.info = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
});
afterEach(() => {
  console.info = originalInfo;
});
const deps = (store: OutboxStore, send: Deps["send"], onLine: () => boolean = () => true, sending = new Set<string>()): Deps => ({
  store, send, onLine, now: () => NOW, dispatch: (e) => void events.push(e), sending,
});

test("T70-U1a oldest first, one at a time (an await in the loop, never two in flight), each with 15 s and its own id", async () => {
  const { outboxRunner, SEND_TIMEOUT_MS } = await load();
  assert.equal(SEND_TIMEOUT_MS, 15000);
  const store = fakeStore([row(3), row(1), row(2)]);
  const s = fakeSend([]);
  await outboxRunner(deps(store, s.send)).run(true);
  assert.deepEqual(s.calls.map((c) => c.body.id), [ID(1), ID(2), ID(3)], "oldest savedAt first");
  assert.equal(s.most(), 1, "one at a time");
  assert.ok(s.calls.every((c) => c.opts.timeoutMs === 15000 && c.slug === SLUG));
  assert.equal(store.rows.size, 0, "each sent row leaves the outbox");
});

test("T70-U1b S1/B14a: a trigger sends a row waiting out its backoff, the timer doesn't; a 429's holdUntil holds both", async () => {
  const { outboxRunner } = await load();
  const later = { nextAt: iso(NOW + 4 * 60_000) };
  const held429 = { nextAt: iso(NOW + 60_000), holdUntil: iso(NOW + 60_000) }; // a 429 row: nextAt is at least its Retry-After
  for (const [trigger, want] of [[true, [ID(1)]], [false, []]] as const) {
    const store = fakeStore([row(1, later), row(2, held429)]);
    const s = fakeSend([]);
    await outboxRunner(deps(store, s.send)).run(trigger);
    assert.deepEqual(s.calls.map((c) => c.body.id), want, `trigger=${trigger}`);
  }
});

test("T70-U1c B20a: a row whose Remove confirm is open (store.held) is skipped, even when it's held during the run", async () => {
  const { outboxRunner } = await load();
  const store = fakeStore([row(1), row(2), row(3)]);
  store.held.add(ID(2));
  const s = fakeSend([
    (_s, b) => {
      store.held.add(ID(3)); // the confirm opens while row 1 is sending
      return ok([b.id]);
    },
  ]);
  await outboxRunner(deps(store, s.send)).run(true);
  assert.deepEqual(s.calls.map((c) => c.body.id), [ID(1)]);
  assert.ok(store.rows.has(ID(2)) && store.rows.has(ID(3)), "held rows stay");
});

test("T70-U1d D1: navigator.onLine is read at the try's start and end; online at either marks a thrown fetch mayHaveLanded", async () => {
  const { outboxRunner } = await load();
  const cases: [boolean[], boolean][] = [[[true, false], true], [[false, true], true], [[false, false], false]];
  for (const [seq, landed] of cases) {
    const store = fakeStore([row(1)]);
    const reads = [...seq];
    const s = fakeSend([() => ({ ok: false, why: "offline" })]);
    await outboxRunner(deps(store, s.send, () => reads.shift() ?? false)).run(true);
    assert.equal(reads.length, 0, `onLine read twice for ${seq}`);
    assert.equal(store.rows.get(ID(1))?.mayHaveLanded === true, landed, `online ${seq}`);
    assert.equal(store.rows.get(ID(1))?.state, "waiting");
  }
});

test("T70-U1e sent and replayedGone: the row leaves, and the event carries the slug, id, outcome and the answer's wallet", async () => {
  const { outboxRunner, OUTBOX_EVENT } = await load();
  assert.equal(OUTBOX_EVENT, "tg-outbox");
  const store = fakeStore([row(1), row(2)]);
  const s = fakeSend([(_s, b) => ok([b.id]), () => ok([])]);
  await outboxRunner(deps(store, s.send)).run(true);
  assert.equal(store.rows.size, 0);
  const done = events.filter((e) => e.outcome !== "sending" && e.outcome !== "end");
  assert.deepEqual(done.map((e) => [e.slug, e.id, e.outcome]), [[SLUG, ID(1), "sent"], [SLUG, ID(2), "replayedGone"]]);
  assert.ok(done.every((e) => (e.wallet as Wallet | undefined)?.rev === 7), "the wallet, for landWallet's rev rule");
  assert.ok(done.every((e) => (e.row as Queued | undefined)?.id === e.id), "the row, for the sent lines");
});

test("T70-U1f each try says `sending` first (the chip), and a run that sent anything ends with one `end`", async () => {
  const { outboxRunner } = await load();
  const store = fakeStore([row(1), row(2)]);
  await outboxRunner(deps(store, fakeSend([]).send)).run(true);
  assert.deepEqual(events.map((e) => e.outcome), ["sending", "sent", "sending", "sent", "end"]);
  assert.deepEqual(events.slice(0, 2).map((e) => e.id), [ID(1), ID(1)]);
  events = [];
  await outboxRunner(deps(fakeStore([]), fakeSend([]).send)).run(true);
  assert.deepEqual(events, [], "nothing due: no events");
});

test("T70-U1g retry: kept as waiting with one more try; no signal ends the run, a 5xx doesn't", async () => {
  const { outboxRunner } = await load();
  let store = fakeStore([row(1), row(2)]);
  let s = fakeSend([() => ({ ok: false, why: "offline" })]);
  await outboxRunner(deps(store, s.send, () => false)).run(true);
  assert.deepEqual(s.calls.map((c) => c.body.id), [ID(1)], "the rest wait for the next trigger");
  assert.equal(store.rows.get(ID(1))?.tries, 2);
  assert.ok(Date.parse(store.rows.get(ID(1))!.nextAt) > NOW, "a new nextAt");
  store = fakeStore([row(1), row(2)]);
  s = fakeSend([() => ({ ok: false, why: "server" })]);
  await outboxRunner(deps(store, s.send)).run(true);
  assert.deepEqual(s.calls.map((c) => c.body.id), [ID(1), ID(2)]);
  assert.equal(store.rows.get(ID(1))?.mayHaveLanded, true, "a 5xx may have landed (B11b)");
});

test("T70-U1h B18 dropLine: sent again at once with budget_key null and the same id; then sent", async () => {
  const { outboxRunner } = await load();
  const store = fakeStore([row(1, { body: body(1, { budget_key: "taxi" }) })]);
  const s = fakeSend([() => ({ ok: false, why: "rejected", detail: "unknown_budget_line" }), (_s, b) => ok([b.id])]);
  await outboxRunner(deps(store, s.send)).run(true);
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[1].body.id, ID(1));
  assert.equal(s.calls[1].body.budget_key, null);
  assert.equal(store.rows.size, 0);
  const done = events.filter((e) => e.outcome !== "sending" && e.outcome !== "end").map((e) => e.outcome);
  assert.deepEqual(done, ["dropLine", "sent"]);
  assert.equal((events.find((e) => e.outcome === "sent")?.row as Queued).lineDropped, true, "the sent line says the line was dropped");
});

test("T70-U1i B19 failed: kept as failed, and never sent again by a trigger or the timer", async () => {
  const { outboxRunner } = await load();
  const store = fakeStore([row(1)]);
  const s = fakeSend([() => ({ ok: false, why: "rejected", detail: "wallet_full" })]);
  const runner = outboxRunner(deps(store, s.send));
  assert.equal(await runner.run(true), null, "nothing waiting: no timer");
  assert.equal(store.rows.get(ID(1))?.state, "failed");
  await runner.run(true);
  await runner.run(false);
  assert.equal(s.calls.length, 1);
});

test("T70-U1j the timer: ms until the earliest waiting row's nextAt or holdUntil, at least 1 s; null when nothing waits", async () => {
  const { outboxRunner } = await load();
  const store = fakeStore([row(1, { nextAt: iso(NOW + 90_000) }), row(2, { nextAt: iso(NOW + 30_000) }), row(3, { state: "failed" })]);
  assert.equal(await outboxRunner(deps(store, fakeSend([]).send)).run(false), 30_000);
  const held = fakeStore([row(1, { nextAt: iso(NOW + 120_000), holdUntil: iso(NOW + 120_000) })]);
  assert.equal(await outboxRunner(deps(held, fakeSend([]).send)).run(true), 120_000, "a 429's Retry-After");
  const due = fakeStore([row(1)]);
  due.held.add(ID(1));
  assert.equal(await outboxRunner(deps(due, fakeSend([]).send)).run(false), 1000, "a held, due row: not a busy loop");
});

test("T70-U1k B23/B24: with no IndexedDB a run sends nothing and resolves; an empty outbox is one list()", async () => {
  const { outboxRunner } = await load();
  const store = fakeStore([row(1)]);
  store.failList = true;
  const s = fakeSend([]);
  assert.equal(await outboxRunner(deps(store, s.send)).run(true), null);
  assert.equal(s.calls.length, 0);
});

test("T70-U1l B17 in one tab: runs asked while one is running don't send a row twice", async () => {
  const { outboxRunner } = await load();
  const store = fakeStore([row(1), row(2)]);
  const s = fakeSend([]);
  const runner = outboxRunner(deps(store, s.send));
  await Promise.all([runner.run(true), runner.run(true), runner.run(false)]);
  assert.deepEqual(s.calls.map((c) => c.body.id).sort(), [ID(1), ID(2)]);
});

test("T70-U14a the runner's logs are counts and outcomes only: no slug-free leak of an id, a note or a name", async () => {
  const { outboxRunner } = await load();
  const store = fakeStore([row(1), row(2)]);
  const s = fakeSend([() => ({ ok: false, why: "server" })]);
  await outboxRunner(deps(store, s.send)).run(true);
  assert.ok(logged.some((l) => /\[tg-outbox\] runner start due=2/.test(l)), logged.join("\n"));
  assert.ok(logged.some((l) => /\[tg-outbox\] send outcome=retry tries=2/.test(l)));
  assert.ok(logged.some((l) => /\[tg-outbox\] send outcome=sent tries=\d+/.test(l)));
  for (const l of logged) assert.doesNotMatch(l, /1111-4111|Taxi|Ana|Ben|m-ana/, l);
});

// ---------------------------------------------------------------- tg-review's O3 code review M1 (review-code-O3.md)

test("T70-U1m a row removed during an earlier row's send is never sent (the store is read again before each send)", async () => {
  const { outboxRunner } = await load();
  const store = fakeStore([row(1), row(2)]);
  const s = fakeSend([
    (_s, b) => {
      store.rows.delete(ID(2)); // Remove, then Remove in the confirm, while row 1 is in flight
      return ok([b.id]);
    },
  ]);
  await outboxRunner(deps(store, s.send)).run(true);
  assert.deepEqual(s.calls.map((c) => c.body.id), [ID(1)]);
  assert.equal(store.rows.size, 0);
});

test("T70-U1n a retry never puts back a row removed while it was in flight", async () => {
  const { outboxRunner } = await load();
  for (const answer of [{ ok: false, why: "server" }, { ok: false, why: "rejected", detail: "wallet_full" }, { ok: false, why: "rejected", detail: "unknown_budget_line" }] as WalletResult[]) {
    const store = fakeStore([row(1, { body: body(1, { budget_key: "taxi" }) })]);
    const s = fakeSend([
      () => {
        store.rows.delete(ID(1)); // removed in another tab while this send ran
        return answer;
      },
    ]);
    await outboxRunner(deps(store, s.send)).run(true);
    assert.equal(store.rows.has(ID(1)), false, `not put back after ${JSON.stringify(answer)}`);
    assert.equal(s.calls.length, 1, "a dropLine isn't resent either");
  }
});

test("T70-U1o the row in flight is in the page's sending set for exactly its send, so a box that mounts mid-run knows", async () => {
  const { outboxRunner } = await load();
  const sending = new Set<string>();
  const seen: string[][] = [];
  const store = fakeStore([row(1), row(2)]);
  const s = fakeSend([(_s, b) => { seen.push([...sending]); return ok([b.id]); }, (_s, b) => { seen.push([...sending]); return ok([b.id]); }]);
  await outboxRunner(deps(store, s.send, () => true, sending)).run(true);
  assert.deepEqual(seen, [[ID(1)], [ID(2)]]);
  assert.equal(sending.size, 0, "cleared after each send");
  const failing = fakeStore([row(3)]);
  await outboxRunner(deps(failing, async () => { throw new Error("boom"); }, () => true, sending)).run(true).catch(() => null);
  assert.equal(sending.size, 0, "cleared even when a send throws");
});
