// TG-70 O2: the outbox lib (outbox.ts, outboxStore.ts). Run with `npm test`. Made-up people and expenses only.
// test-plan.md §4 L1 to L11, L16, L17, plus plan Rev 3's B11b (mayHaveLanded), B14a (triggers and holdUntil), B20a (held)
// and review-plan D1 (online at the try's start or end) and D3 (held on the store instance, fresh per test).
// The modules are loaded per test, so before they exist each test fails on its own instead of the whole file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatPeso } from "./wallet.ts";
import type { Member, Wallet, WalletResult } from "./wallet.ts";
import type { Queued, QueuedBody } from "./outbox.ts";

const load = () => import("./outbox.ts");
const loadStore = () => import("./outboxStore.ts");

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";
const MEMBERS: Member[] = [
  { id: A, name: "Ana (made up)" },
  { id: B, name: "Ben (made up)" },
  { id: C, name: "Carla (made up)" },
];
const SLUG = "a".repeat(32);
const OTHER = "b".repeat(32);
const ID = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-11-26T02:00:00Z"); // 10:00 AM Manila
const ONLINE = { start: true, end: true };
const OFFLINE = { start: false, end: false };
const at = (now = NOW, online = ONLINE) => ({ now, online });
const iso = (ms: number) => new Date(ms).toISOString();
const S = 1000;
const MIN = 60 * S;

function body(patch: Partial<QueuedBody> = {}): QueuedBody {
  return {
    id: ID,
    mode: "equal",
    paid_by: A,
    amount_centavos: 45000,
    note: "Taxi to Echo Valley (made up)",
    category: "transport",
    by: A,
    budget_key: "transport-1",
    inputs: [
      { member_id: A, value: 1 },
      { member_id: B, value: 1 },
    ],
    ...patch,
  } as QueuedBody;
}

function row(patch: Partial<Queued> = {}): Queued {
  return {
    id: ID,
    slug: SLUG,
    body: body(),
    savedAt: iso(NOW - 10 * MIN),
    tries: 1,
    nextAt: iso(NOW - S),
    state: "waiting",
    why: "offline",
    ...patch,
  };
}

const wallet = (ids: string[], rev = 5) =>
  ({
    share_slug: SLUG,
    name: "E2E wallet (made up)",
    created_at: iso(NOW),
    members: MEMBERS,
    expenses: ids.map((id) => ({ id, paid_by: A, amount_centavos: 45000, note: "x", created_at: iso(NOW), shares: [] })),
    settlements: [],
    balances: [],
    transfers: [],
    total_centavos: 0,
    rev,
  }) as Wallet;
const ok = (ids: string[]): WalletResult => ({ ok: true, wallet: wallet(ids) });
const offline: WalletResult = { ok: false, why: "offline" };
const timedOut: WalletResult = { ok: false, why: "offline", timedOut: true };
const server: WalletResult = { ok: false, why: "server" };
const limited = (retryAfter?: number): WalletResult => ({ ok: false, why: "rate_limited", ...(retryAfter === undefined ? {} : { retryAfter }) });
const rejected = (detail?: string): WalletResult => ({ ok: false, why: "rejected", ...(detail === undefined ? {} : { detail }) });
const notFound = (detail?: string): WalletResult => ({ ok: false, why: "not_found", ...(detail === undefined ? {} : { detail }) });

// ---------------------------------------------------------------- L1 the id

test("T70-L1 newExpenseId is a v4 uuid, unique over 1000 calls", async () => {
  const { newExpenseId } = await load();
  const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const ids = new Set(Array.from({ length: 1000 }, () => newExpenseId()));
  assert.equal(ids.size, 1000);
  for (const id of ids) assert.match(id, v4);
});

test("T70-L1 newExpenseId without crypto.randomUUID still makes a v4, from getRandomValues", async () => {
  const { newExpenseId } = await load();
  const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  let calls = 0;
  const noUuid = {
    getRandomValues: <T extends ArrayBufferView | null>(a: T) => {
      calls++;
      return globalThis.crypto.getRandomValues(a as unknown as Uint8Array) as unknown as T;
    },
  };
  const ids = new Set(Array.from({ length: 200 }, () => newExpenseId(noUuid as unknown as Crypto)));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, v4);
  assert.ok(calls >= 200, "the fallback used getRandomValues");
});

// ---------------------------------------------------------------- L2, L3 queue or not, and when to try again

test("T70-L2 shouldQueue: offline, server and rate_limited only", async () => {
  const { shouldQueue } = await load();
  for (const r of [offline, timedOut, server, limited(), limited(120)]) assert.equal(shouldQueue(r), true, JSON.stringify(r));
  for (const r of [notFound(), notFound("feature_off"), rejected(), rejected("wallet_full"), ok([ID])]) assert.equal(shouldQueue(r), false, JSON.stringify(r));
});

test("T70-L3 backoff: 30 s, 60 s, 2 min, 5 min, then the 5 min cap; Retry-After can only make it longer", async () => {
  const { backoff } = await load();
  assert.deepEqual([0, 1, 2, 3, 4, 9].map((t) => backoff(t)), [30 * S, 60 * S, 2 * MIN, 5 * MIN, 5 * MIN, 5 * MIN]);
  assert.equal(backoff(0, 600), 600 * S, "600 s beats 30 s");
  assert.equal(backoff(0, 1), 30 * S, "1 s doesn't lower it");
  assert.equal(backoff(3, 120), 5 * MIN);
});

// ---------------------------------------------------------------- B11b may have landed (M1, D1)

test("T70-L4m mayHaveLanded: a timeout, a 5xx, or a throw while online at the try's start or end", async () => {
  const { mayHaveLanded } = await load();
  assert.equal(mayHaveLanded(timedOut, OFFLINE), true, "the timeout's abort");
  assert.equal(mayHaveLanded(server, OFFLINE), true, "a 5xx");
  assert.equal(mayHaveLanded(offline, ONLINE), true, "threw while online");
  assert.equal(mayHaveLanded(offline, { start: true, end: false }), true, "D1: the signal dropped mid-request");
  assert.equal(mayHaveLanded(offline, { start: false, end: true }), true, "online at the end");
  assert.equal(mayHaveLanded(offline, OFFLINE), false, "threw while offline the whole try");
  assert.equal(mayHaveLanded(limited(120), ONLINE), false, "a 429 comes before the insert (F1)");
  assert.equal(mayHaveLanded(rejected("wallet_full"), ONLINE), false);
  assert.equal(mayHaveLanded(ok([ID]), ONLINE), false);
});

test("T70-L4q queuedRow: the Save's own try is try 1, waiting, next try in 30 s", async () => {
  const { queuedRow } = await load();
  const q = queuedRow(SLUG, body(), offline as never, at(NOW, OFFLINE));
  assert.deepEqual(q, { id: ID, slug: SLUG, body: body(), savedAt: iso(NOW), tries: 1, nextAt: iso(NOW + 30 * S), state: "waiting", why: "offline" });
  assert.equal(queuedRow(SLUG, body(), timedOut as never, at(NOW, OFFLINE)).mayHaveLanded, true);
  assert.equal(queuedRow(SLUG, body(), server as never, at()).mayHaveLanded, true);
  assert.equal(queuedRow(SLUG, body(), offline as never, at(NOW, { start: true, end: false })).mayHaveLanded, true, "D1");
  const held = queuedRow(SLUG, body(), limited(120) as never, at());
  assert.equal(held.nextAt, iso(NOW + 120 * S));
  assert.equal(held.holdUntil, iso(NOW + 120 * S));
  assert.equal("mayHaveLanded" in held, false);
  assert.equal("holdUntil" in queuedRow(SLUG, body(), limited() as never, at()), false, "no Retry-After, no hold");
});

// ---------------------------------------------------------------- L4 afterSend

test("T70-L4 afterSend sent: ok and the wallet has the id; replayedGone: ok and it doesn't", async () => {
  const { afterSend } = await load();
  assert.equal(afterSend(row(), ok([ID, "x"]), at()).kind, "sent");
  assert.equal(afterSend(row(), ok(["x"]), at()).kind, "replayedGone");
});

test("T70-L4 afterSend retry: each of shouldQueue's three, tries + 1, nextAt = now + backoff(tries)", async () => {
  const { afterSend, backoff } = await load();
  for (const [r, why] of [[offline, "offline"], [server, "server"], [limited(), "rate_limited"]] as const) {
    const out = afterSend(row({ tries: 2 }), r, at(NOW, OFFLINE));
    assert.equal(out.kind, "retry", why);
    assert.equal(out.row.tries, 3);
    assert.equal(out.row.state, "waiting");
    assert.equal(out.row.why, why);
    assert.equal(out.row.nextAt, iso(NOW + backoff(2)));
    assert.deepEqual(out.row.body, body(), "the queued body never changes on a retry");
  }
});

test("T70-L4 afterSend retry after a 429 with Retry-After: holdUntil and nextAt wait it out; a later retry drops the hold", async () => {
  const { afterSend } = await load();
  const out = afterSend(row({ tries: 1 }), limited(600), at());
  assert.equal(out.row.nextAt, iso(NOW + 600 * S));
  assert.equal(out.row.holdUntil, iso(NOW + 600 * S));
  const later = afterSend(out.row, offline, at(NOW + 11 * MIN, OFFLINE));
  assert.equal(later.kind, "retry");
  assert.equal("holdUntil" in later.row, false);
});

test("T70-L4 afterSend dropLine: a line refusal drops budget_key to null once, same id, everything else the same", async () => {
  const { afterSend } = await load();
  for (const code of ["unknown_budget_line", "budget_line_category"]) {
    const out = afterSend(row(), rejected(code), at());
    assert.equal(out.kind, "dropLine", code);
    assert.equal(out.row.lineDropped, true);
    assert.equal(out.row.state, "waiting");
    assert.equal(out.row.id, ID);
    assert.deepEqual(out.row.body, { ...body(), budget_key: null });
    // the second line refusal is a failure, never another drop (no loop)
    const again = afterSend(out.row, rejected(code), at());
    assert.equal(again.kind, "failed", `${code} twice`);
    assert.equal(again.row.detail, code);
  }
});

test("T70-L4 afterSend failed: every other refusal stops, keeps why and detail, and is never waiting", async () => {
  const { afterSend } = await load();
  const cases: [WalletResult, string, string | undefined][] = [
    [rejected("wallet_full"), "rejected", "wallet_full"],
    [notFound("feature_off"), "not_found", "feature_off"],
    [notFound(), "not_found", undefined],
    [rejected("unknown_member"), "rejected", "unknown_member"],
    [rejected("id_taken"), "rejected", "id_taken"],
    [rejected("percent_total"), "rejected", "percent_total"],
    [rejected(), "rejected", undefined], // a Pydantic 422: no code
  ];
  for (const [r, why, detail] of cases) {
    const out = afterSend(row({ tries: 2 }), r, at());
    assert.equal(out.kind, "failed", JSON.stringify(r));
    assert.equal(out.row.state, "failed");
    assert.equal(out.row.why, why);
    assert.equal(out.row.detail, detail);
    assert.equal(out.row.tries, 3);
  }
  const item = afterSend(row({ body: body() }), { ok: false, why: "rejected", detail: "item_no_one", seq: 2 }, at());
  assert.equal(item.row.seq, 2, "item_no_one keeps its item's seq for pickWhoHad");
});

test("T70-L4m afterSend: mayHaveLanded sticks across retries, a route refusal clears it, a Pydantic 422 keeps it (B11b)", async () => {
  const { afterSend } = await load();
  const maybe = row({ mayHaveLanded: true });
  assert.equal(afterSend(maybe, offline, at(NOW, OFFLINE)).row.mayHaveLanded, true, "an offline retry keeps it");
  assert.equal(afterSend(maybe, limited(60), at()).row.mayHaveLanded, true, "a later 429 doesn't clear it");
  assert.equal(afterSend(row(), server, at()).row.mayHaveLanded, true, "a 5xx sets it");
  assert.equal(afterSend(row(), timedOut, at(NOW, OFFLINE)).row.mayHaveLanded, true, "a timeout sets it");
  assert.equal(afterSend(row(), offline, at(NOW, { start: true, end: false })).row.mayHaveLanded, true, "D1");
  assert.equal("mayHaveLanded" in afterSend(row(), offline, at(NOW, OFFLINE)).row, false, "offline throughout: not set");
  for (const r of [rejected("wallet_full"), notFound("feature_off"), notFound(), rejected("id_taken"), rejected("percent_total"), rejected("unknown_budget_line")]) {
    assert.equal("mayHaveLanded" in afterSend(maybe, r, at()).row, false, `cleared by ${JSON.stringify(r)}`);
  }
  assert.equal(afterSend(maybe, rejected(), at()).row.mayHaveLanded, true, "a Pydantic 422 (the rollback case, N4) keeps it");
});

// ---------------------------------------------------------------- L5 due, B14a triggers, B20a held

test("T70-L5 due (the timer): waiting rows whose nextAt has passed, oldest savedAt first, ties in stored order", async () => {
  const { due } = await load();
  const rows = [
    row({ id: "w3", savedAt: iso(NOW - 1 * MIN) }),
    row({ id: "w1", savedAt: iso(NOW - 9 * MIN) }),
    row({ id: "later", savedAt: iso(NOW - 8 * MIN), nextAt: iso(NOW + 4 * MIN) }),
    row({ id: "failed", savedAt: iso(NOW - 20 * MIN), state: "failed" }),
    row({ id: "tieA", savedAt: iso(NOW - 5 * MIN) }),
    row({ id: "tieB", savedAt: iso(NOW - 5 * MIN) }),
    row({ id: "now", savedAt: iso(NOW - 2 * MIN), nextAt: iso(NOW) }),
  ];
  assert.deepEqual(due(rows, NOW).map((r) => r.id), ["w1", "tieA", "tieB", "now", "w3"]);
});

test("T70-L5 due with a trigger (S1): every waiting row even in backoff, except one inside a 429's holdUntil", async () => {
  const { due } = await load();
  const rows = [
    row({ id: "backoff", savedAt: iso(NOW - 3 * MIN), nextAt: iso(NOW + 4 * MIN) }),
    row({ id: "held429", savedAt: iso(NOW - 2 * MIN), nextAt: iso(NOW + 2 * MIN), holdUntil: iso(NOW + 2 * MIN) }),
    row({ id: "past429", savedAt: iso(NOW - 1 * MIN), nextAt: iso(NOW - S), holdUntil: iso(NOW - S) }),
    row({ id: "failed", state: "failed" }),
  ];
  assert.deepEqual(due(rows, NOW, { trigger: true }).map((r) => r.id), ["backoff", "past429"]);
  assert.deepEqual(due(rows, NOW).map((r) => r.id), ["past429"], "the timer alone uses nextAt");
});

test("T70-L5 due skips held rows (B20a: a Remove confirm is open), with or without a trigger", async () => {
  const { due } = await load();
  const rows = [row({ id: "open" }), row({ id: "free" })];
  const held = new Set(["open"]);
  assert.deepEqual(due(rows, NOW, { held }).map((r) => r.id), ["free"]);
  assert.deepEqual(due(rows, NOW, { trigger: true, held }).map((r) => r.id), ["free"]);
});

test("T70-L6 forWallet: only that wallet's rows, waiting and failed, oldest first", async () => {
  const { forWallet } = await load();
  const rows = [
    row({ id: "b", savedAt: iso(NOW - 1 * MIN), state: "failed" }),
    row({ id: "other", slug: OTHER }),
    row({ id: "a", savedAt: iso(NOW - 5 * MIN) }),
  ];
  assert.deepEqual(forWallet(rows, SLUG).map((r) => r.id), ["a", "b"]);
  assert.deepEqual(forWallet(rows, "c".repeat(32)), []);
});

// ---------------------------------------------------------------- L7 the strings, word for word (ux.md §6)

test("T70-L7 every ux.md §6 string, word for word", async () => {
  const m = await load();
  assert.equal(m.QUEUED, "No signal, so it's saved here. It sends by itself once there's signal, while Tara Gala is open here.");
  assert.equal(m.OFFLINE_CUE, "No signal: this will wait here and send later.");
  assert.equal(m.BOX_TITLE, "Waiting for signal");
  assert.equal(m.boxTitle(2), "Waiting for signal (2)");
  assert.equal(m.boxTitle(1), "Waiting for signal (1)");
  assert.equal(m.BOX_INTRO, "Saved here only. They send by themselves once there's signal, while Tara Gala is open here. Balances and Settle up count them once they're sent.");
  assert.equal(m.WHERE_NOTE, "\"Here\" means this browser. Messenger, Safari, Chrome and the home-screen app each keep their own list, so open Tara Gala the same way again to send these.");
  assert.equal(m.CHIP_WAITING, "Waiting for signal");
  assert.equal(m.CHIP_SENDING, "Sending...");
  assert.equal(m.FAILED, "Couldn't send. ");
  assert.equal(m.FAILED_ANY, "Couldn't send. Put it in the form to check it, or remove it.");
  assert.equal(m.FAILED_OFF, "Couldn't send. That kind of split is switched off right now. Put it in the form to save it another way, or remove it.");
  assert.equal(m.MAYBE_LANDED, "A try may have reached the wallet already. Check Expenses before you put it in the form.");
  assert.equal(m.NO_NOTE, "An expense");
  assert.equal(m.TO_FORM, "Put it in the form");
  assert.equal(m.FORM_BUSY, "Finish or clear the form first.");
  assert.equal(m.REMOVE, "Remove");
  assert.equal(m.REMOVE_ASK, "Remove this expense? It was never sent, so nobody else has it.");
  assert.equal(m.REMOVE_ASK_MAYBE, "Remove this expense? A try may have reached the wallet without an answer coming back. Check Expenses for it first, so it isn't added twice.");
  assert.equal(m.REMOVE_KEEP, "Keep it");
  assert.equal(m.REMOVED, "Removed.");
  assert.equal(m.BANNER_WAIT, "expenses you add will wait here");
});

test("T70-L7 removeAsk: REMOVE_ASK, or REMOVE_ASK_MAYBE for a row that may have landed (B20)", async () => {
  const { removeAsk, REMOVE_ASK, REMOVE_ASK_MAYBE } = await load();
  assert.equal(removeAsk(row()), REMOVE_ASK);
  assert.equal(removeAsk(row({ state: "failed", why: "rejected", detail: "wallet_full" })), REMOVE_ASK);
  assert.equal(removeAsk(row({ mayHaveLanded: true })), REMOVE_ASK_MAYBE);
  assert.equal(removeAsk(row({ state: "failed", why: "rejected", mayHaveLanded: true })), REMOVE_ASK_MAYBE);
});

// ---------------------------------------------------------------- L8 sentLines (B15, B16, B18, B27)

test("T70-L8 sentLines: one sent, several sent, gone, line dropped, in that order, with the wallet's ₱ format", async () => {
  const { sentLines } = await load();
  const taxi = row();
  const lunch = row({ id: "l", body: body({ id: "l", note: "Lunch at Yoghurt House (made up)", amount_centavos: 138000 }) });
  const taho = row({ id: "t", body: body({ id: "t", note: "Taho (made up)", amount_centavos: 15050 }) });
  assert.deepEqual(sentLines([], formatPeso), []);
  assert.deepEqual(sentLines([{ kind: "sent", row: taxi }], formatPeso), ["Sent. Taxi to Echo Valley (made up), ₱450, is in the wallet now."]);
  assert.deepEqual(sentLines([{ kind: "sent", row: lunch }], formatPeso), ["Sent. Lunch at Yoghurt House (made up), ₱1,380, is in the wallet now."]);
  assert.deepEqual(sentLines([{ kind: "sent", row: taho }], formatPeso), ["Sent. Taho (made up), ₱150.50, is in the wallet now."]);
  assert.deepEqual(
    sentLines([{ kind: "sent", row: taxi }, { kind: "sent", row: lunch }, { kind: "sent", row: taho }], formatPeso),
    ["Sent 3 waiting expenses. They're in the wallet now."],
  );
  assert.deepEqual(sentLines([{ kind: "replayedGone", row: taxi }], formatPeso), ["Taxi to Echo Valley (made up), ₱450, was already sent, and someone deleted it since."]);
  assert.deepEqual(sentLines([{ kind: "sent", row: { ...taxi, lineDropped: true } }], formatPeso), [
    "Sent Taxi to Echo Valley (made up), ₱450, without its budget line, because the plan's lines changed. Pick one in Details.",
  ]);
  // mixed, sent in another order: SENT_MANY (2), then the line dropped, then gone
  const mixed = sentLines(
    [{ kind: "replayedGone", row: taho }, { kind: "sent", row: taxi }, { kind: "sent", row: { ...lunch, lineDropped: true } }, { kind: "sent", row: taho }],
    formatPeso,
  );
  assert.deepEqual(mixed, [
    "Sent 2 waiting expenses. They're in the wallet now.",
    "Sent Lunch at Yoghurt House (made up), ₱1,380, without its budget line, because the plan's lines changed. Pick one in Details.",
    "Taho (made up), ₱150.50, was already sent, and someone deleted it since.",
  ]);
});

test("T70-L8 B27 a note with no text reads An expense, never 'Sent. , ₱450'", async () => {
  const { sentLines } = await load();
  for (const note of ["", "   "]) {
    const blank = row({ body: body({ note }) });
    assert.deepEqual(sentLines([{ kind: "sent", row: blank }], formatPeso), ["Sent. An expense, ₱450, is in the wallet now."]);
    assert.deepEqual(sentLines([{ kind: "replayedGone", row: blank }], formatPeso), ["An expense, ₱450, was already sent, and someone deleted it since."]);
  }
});

// ---------------------------------------------------------------- L9 to L11 the card and Settle up

test("T70-L9 paidBy: one payer, several, and an unknown member", async () => {
  const { paidBy } = await load();
  assert.equal(paidBy(body(), MEMBERS), "Ana (made up) paid");
  const two = body({ paid_by: undefined, payers: [{ member_id: B, paid_centavos: 30000 }, { member_id: A, paid_centavos: 15000 }] } as never);
  delete (two as { paid_by?: string }).paid_by;
  assert.equal(paidBy(two, MEMBERS), "Ben (made up) and 1 more paid");
  const three = { ...two, payers: [{ member_id: C, paid_centavos: 15000 }, { member_id: A, paid_centavos: 15000 }, { member_id: B, paid_centavos: 15000 }] } as QueuedBody;
  assert.equal(paidBy(three, MEMBERS), "Carla (made up) and 2 more paid");
  assert.equal(paidBy(body({ paid_by: "00000000-0000-4000-8000-0000000000ff" } as never), MEMBERS), "Someone paid");
});

test("T70-L10 savedAt: the time today, the date too on another day, always Manila, whatever the phone's TZ", async () => {
  const { savedAt } = await load();
  const original = process.env.TZ;
  try {
    for (const tz of ["America/Los_Angeles", "Pacific/Kiritimati", "Asia/Manila"]) {
      process.env.TZ = tz;
      assert.equal(savedAt("2026-11-25T23:42:00Z", NOW), "saved 7:42 AM", tz); // Nov 26, 7:42 AM Manila
      assert.equal(savedAt("2026-11-26T04:10:00Z", Date.parse("2026-11-27T01:00:00Z")), "saved Nov 26, 12:10 PM", tz);
      // the day boundary: 23:59 and 00:01 in Manila are different days
      const justAfterMidnight = Date.parse("2026-11-26T16:01:00Z"); // Nov 27, 00:01 Manila
      assert.equal(savedAt("2026-11-26T15:59:00Z", justAfterMidnight), "saved Nov 26, 11:59 PM", tz);
      assert.equal(savedAt("2026-11-26T16:00:30Z", justAfterMidnight), "saved 12:00 AM", tz);
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test("T70-L10 savedAt uses a plain space before AM/PM, built from 24-hour parts (as offline.ts T27-13)", async () => {
  const { savedAt } = await load();
  assert.ok(!/[  ]/.test(savedAt("2026-11-26T04:10:00Z", NOW)));
  const source = readFileSync(new URL("./outbox.ts", import.meta.url), "utf8");
  assert.match(source, /hourCycle: "h23"/);
  assert.doesNotMatch(source, /hour: "numeric"|hour12: true|hourCycle: "h12"/);
});

test("T70-L11 settleLine: none, one, many", async () => {
  const { settleLine } = await load();
  assert.equal(settleLine(0), null);
  assert.equal(settleLine(1), "1 expense is still waiting for signal here, so this isn't final yet.");
  assert.equal(settleLine(2), "2 expenses are still waiting for signal here, so this isn't final yet.");
});

// ---------------------------------------------------------------- logs (plan §7)

test("T70-L18 log lines carry outcomes and counts only, never a name, a note or an id", async () => {
  const { sendLog, runnerLog } = await load();
  assert.equal(sendLog("sent", 2), "[tg-outbox] send outcome=sent tries=2");
  assert.equal(sendLog("dropLine", 1), "[tg-outbox] send outcome=dropLine tries=1");
  assert.equal(runnerLog(3), "[tg-outbox] runner start due=3");
});

// ---------------------------------------------------------------- L16 purity

test("T70-L16 outbox.ts is pure: type-only imports, no React, no client directive, no module state", async () => {
  const source = readFileSync(new URL("./outbox.ts", import.meta.url), "utf8");
  for (const line of source.split("\n").filter((l) => /^\s*import\b/.test(l))) assert.match(line, /^import type /, line);
  assert.doesNotMatch(source, /\bimport\s*\(/);
  assert.doesNotMatch(source, /use client|react|indexedDB|idbStore|localStorage|\bfetch\(/i);
  assert.doesNotMatch(source, /^(let|var) /m, "D3: no module-level state (held lives on the store)");
  assert.doesNotMatch(source, /new (Set|Map)\(/, "D3");
});

// ---------------------------------------------------------------- the store seam (B23, D3)

function memory() {
  const data = new Map<string, Queued>();
  return {
    data,
    getAll: async () => [...data.values()],
    put: async (r: Queued) => void data.set(r.id, structuredClone(r)),
    delete: async (id: string) => void data.delete(id),
  };
}

test("T70-L17s outboxStore: queue, list (oldest first), update and remove go through the injected store", async (t) => {
  const { outboxStore } = await loadStore();
  t.mock.method(console, "info", () => {});
  const mem = memory();
  const s = outboxStore(mem);
  await s.queue(row({ id: "new", savedAt: iso(NOW - 1 * MIN) }));
  await s.queue(row({ id: "old", savedAt: iso(NOW - 9 * MIN) }));
  assert.deepEqual((await s.list()).map((r) => r.id), ["old", "new"]);
  await s.update(row({ id: "new", savedAt: iso(NOW - 1 * MIN), state: "failed" }));
  assert.equal(mem.data.get("new")?.state, "failed");
  await s.remove("old");
  assert.deepEqual((await s.list()).map((r) => r.id), ["new"]);
});

test("T70-L17s outboxStore logs 'queued why=… n=<this wallet's rows>' with no id, slug, note or name", async (t) => {
  const { outboxStore } = await loadStore();
  const info = t.mock.method(console, "info", () => {});
  const s = outboxStore(memory());
  await s.queue(row({ id: "x1", why: "offline" }));
  await s.queue(row({ id: "o1", slug: OTHER, why: "server" }));
  await s.queue(row({ id: "x2", why: "rate_limited" }));
  const lines = info.mock.calls.map((c) => c.arguments.join(" "));
  assert.deepEqual(lines, ["[tg-outbox] queued why=offline n=1", "[tg-outbox] queued why=server n=1", "[tg-outbox] queued why=rate_limited n=2"]);
  for (const l of lines) assert.doesNotMatch(l, /x1|x2|o1|aaaa|bbbb|Taxi|Ana/);
});

test("T70-L17s held is per store instance (D3): a fresh store has an empty set", async () => {
  const { outboxStore } = await loadStore();
  const one = outboxStore(memory());
  one.held.add(ID);
  assert.equal(outboxStore(memory()).held.size, 0);
  assert.equal(one.held.has(ID), true);
});

test("T70-L17 B23 no IndexedDB (node): the default store rejects with no-indexeddb and logs idb unavailable once", async (t) => {
  const { outbox } = await loadStore();
  const warn = t.mock.method(console, "warn", () => {});
  await assert.rejects(outbox.queue(row()), /no-indexeddb/);
  await assert.rejects(outbox.list(), /no-indexeddb/);
  const lines = warn.mock.calls.map((c) => c.arguments.join(" "));
  assert.deepEqual(lines, ["[tg-outbox] idb unavailable"]);
});

test("T70-L4d review S2: a dropped line survives a retry, so the final send still says LINE_DROPPED", async () => {
  const { afterSend, sentLines } = await load();
  const dropped = afterSend(row(), rejected("unknown_budget_line"), at());
  assert.equal(dropped.kind, "dropLine");
  // the immediate resend times out: a retry, and the row must keep lineDropped
  const retried = afterSend(dropped.row, timedOut, at(NOW + S, OFFLINE));
  assert.equal(retried.kind, "retry");
  assert.equal(retried.row.lineDropped, true);
  assert.equal(retried.row.body.budget_key, null);
  // a failed try after that keeps it too
  const again = afterSend(retried.row, server, at(NOW + MIN));
  assert.equal(again.row.lineDropped, true);
  const sent = afterSend(again.row, ok([ID]), at(NOW + 2 * MIN));
  assert.equal(sent.kind, "sent");
  assert.equal(sent.row.lineDropped, true);
  assert.deepEqual(sentLines([{ kind: "sent", row: sent.row }], formatPeso), [
    "Sent Taxi to Echo Valley (made up), ₱450, without its budget line, because the plan's lines changed. Pick one in Details.",
  ]);
});
