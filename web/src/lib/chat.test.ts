// TG-61 PR 2 (W10 and the chat contract agreed with the API builder): the chat log kept on this phone, what's sent,
// how each answer is read, and ux.md §10's lines. Pure: no fetch, no React. Run with `npm test`.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

// chat.ts doesn't exist until GREEN: load it inside each test, so every test fails on its own
type Chat = typeof import("./chat.ts");
const load = (): Promise<Chat> => import(new URL("./chat.ts", import.meta.url).href);

const SLUG = "0123456789abcdef0123456789abcdef"; // a made-up trip slug
const OTHER = "fedcba9876543210fedcba9876543210";
const BASE = { itinerary_slug: "edit-made-up-copy", seq: 4 };
const line = (word: string, text: string) => ({ word, day: 1, text });

/** A Storage stand-in. `fail` makes every call throw, like Safari's private mode or a full quota. */
function store(fail: "none" | "get" | "set" | "all" = "none") {
  const data = new Map<string, string>();
  return {
    data,
    getItem(k: string) {
      if (fail === "get" || fail === "all") throw new Error("SecurityError");
      return data.has(k) ? data.get(k)! : null;
    },
    setItem(k: string, v: string) {
      if (fail === "set" || fail === "all") throw new Error("QuotaExceededError");
      data.set(k, v);
    },
    removeItem(k: string) {
      if (fail === "all") throw new Error("SecurityError");
      data.delete(k);
    },
  };
}

const originalTZ = process.env.TZ;
afterEach(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

// ---- what's sent (W10: at most 10 turns) ------------------------------------------------------------

test("T61-W10a toSend: the last 10 user and chatbot turns, as plain text, alerts left out, each at most 1,000 characters", async () => {
  const { toSend, MAX_SENT, MAX_TEXT } = await load();
  assert.equal(MAX_SENT, 10);
  assert.equal(MAX_TEXT, 1000);
  const log = [
    ...Array.from({ length: 14 }, (_, i) => (i % 2 === 0 ? { kind: "user" as const, text: `ask ${i}` } : { kind: "bot" as const, text: `reply ${i}` })),
    { kind: "alert" as const, text: "The chatbot needs signal." },
    { kind: "user" as const, text: "x".repeat(1500) },
  ];
  const sent = toSend(log);
  assert.equal(sent.length, 10);
  const turns = log.filter((e) => e.kind !== "alert").slice(-10);
  assert.deepEqual(sent.map((m) => m.role), turns.map((e) => (e.kind === "user" ? "user" : "assistant")));
  assert.deepEqual(sent.slice(0, -1).map((m) => m.text), turns.slice(0, -1).map((e) => e.text));
  assert.equal(sent.at(-1)!.role, "user", "the newest message is the user's");
  assert.equal(sent.at(-1)!.text.length, 1000);
  assert.ok(sent.every((m) => Object.keys(m).sort().join() === "role,text"), "only role and text go to the server");
  assert.ok(!sent.some((m) => m.text === "The chatbot needs signal."), "the app's own alert lines are never sent");
});

test("T61-W10b toSend sends a chatbot turn as its reply text only: no proposal, changes or link ask", async () => {
  const { toSend } = await load();
  const sent = toSend([
    { kind: "user", text: "add merienda" },
    { kind: "bot", text: "Here's a change.", changes: [line("New", "3:00 PM Merienda")], proposal: "applied", needLink: { name: "Made-Up Cafe", at: null } },
    { kind: "user", text: "salamat" },
  ]);
  assert.deepEqual(sent, [
    { role: "user", text: "add merienda" },
    { role: "assistant", text: "Here's a change." },
    { role: "user", text: "salamat" },
  ]);
});

// ---- the log on this phone (W10: at most 30 turns, survives a throwing localStorage) ------------------

test("T61-W10c the log is kept per trip, at most 30 entries, and an open proposal comes back as not applied", async () => {
  const { saveLog, loadLog, storeKey, MAX_KEPT } = await load();
  assert.equal(MAX_KEPT, 30);
  assert.equal(storeKey(SLUG), `tg-chat:${SLUG}`);
  const s = store();
  const log = Array.from({ length: 40 }, (_, i) => ({ kind: "user" as const, text: `m${i}` }));
  assert.equal(saveLog(s, SLUG, log), true);
  const back = loadLog(s, SLUG);
  assert.equal(back.length, 30);
  assert.deepEqual(back.at(0), { kind: "user", text: "m10" });
  assert.deepEqual(back.at(-1), { kind: "user", text: "m39" });
  assert.deepEqual(loadLog(s, OTHER), [], "another trip's log is its own");
  saveLog(s, SLUG, [{ kind: "user", text: "q" }, { kind: "bot", text: "a", changes: [line("New", "x")], proposal: "open" }]);
  assert.deepEqual(loadLog(s, SLUG).at(-1), { kind: "bot", text: "a", changes: [line("New", "x")], proposal: "lapsed" },
    "after a reload no proposal can be applied: its plan may be old (ux.md §10, Not applied.)");
});

test("T61-W10d alerts and the proposal's plan are never stored: only the words on screen", async () => {
  const { saveLog } = await load();
  const s = store();
  // An entry that carries a plan by mistake: only the words may reach the phone's store
  const leaky = { kind: "bot", text: "a", changes: [line("New", "x")], proposal: "open", stored: { days: [] }, guide: { days: [] }, base: BASE };
  saveLog(s, SLUG, [
    { kind: "user", text: "q", base: BASE } as never,
    leaky as never,
    { kind: "alert", text: "The chatbot needs signal." },
  ]);
  const raw = s.data.get(`tg-chat:${SLUG}`)!;
  assert.doesNotMatch(raw, /needs signal/);
  assert.doesNotMatch(raw, /"(stored|guide|base|itinerary_slug|seq)"/);
});

test("T61-W10e a throwing, missing or garbled store never breaks the chat: the log lasts as long as the page", async () => {
  const { saveLog, loadLog, clearLog } = await load();
  for (const fail of ["get", "set", "all"] as const) {
    const s = store(fail);
    assert.doesNotThrow(() => loadLog(s, SLUG), fail);
    assert.deepEqual(loadLog(s, SLUG), [], fail);
    assert.doesNotThrow(() => saveLog(s, SLUG, [{ kind: "user", text: "q" }]), fail);
    assert.doesNotThrow(() => clearLog(s, SLUG), fail);
  }
  assert.equal(saveLog(store("set"), SLUG, [{ kind: "user", text: "q" }]), false);
  assert.deepEqual(loadLog(null, SLUG), []);
  assert.equal(saveLog(null, SLUG, []), false);
  const s = store();
  for (const junk of ["{", "null", "42", '{"kind":"user"}', '[{"kind":"hack","text":"x"},{"kind":"user","text":7},{"kind":"user","text":"ok"}]']) {
    s.data.set(`tg-chat:${SLUG}`, junk);
    assert.doesNotThrow(() => loadLog(s, SLUG), junk);
  }
  assert.deepEqual(loadLog(s, SLUG), [{ kind: "user", text: "ok" }], "bad entries are dropped, good ones kept");
  clearLog(s, SLUG);
  assert.equal(s.data.has(`tg-chat:${SLUG}`), false);
});

test("T61-W10f only the newest proposal keeps its buttons; settling it marks applied or declined", async () => {
  const { addEntry, settle } = await load();
  let log = addEntry([], { kind: "bot", text: "one", changes: [line("New", "a")], proposal: "open" });
  log = addEntry(log, { kind: "user", text: "no, earlier" });
  log = addEntry(log, { kind: "bot", text: "two", changes: [line("New", "b")], proposal: "open" });
  assert.deepEqual(log.map((e) => (e.kind === "bot" ? e.proposal : e.kind)), ["lapsed", "user", "open"]);
  assert.deepEqual(settle(log, "applied").map((e) => (e.kind === "bot" ? e.proposal : e.kind)), ["lapsed", "user", "applied"]);
  assert.deepEqual(settle(log, "declined").at(-1), { kind: "bot", text: "two", changes: [line("New", "b")], proposal: "declined" });
  assert.deepEqual(settle([{ kind: "user", text: "q" }], "applied"), [{ kind: "user", text: "q" }], "nothing open, nothing changes");
  assert.equal(addEntry(Array.from({ length: 30 }, () => ({ kind: "user" as const, text: "q" })), { kind: "user", text: "new" }).length, 30, "the page's log is capped too");
});

// ---- reading an answer (the contract with the API builder, 2026-11-05) ------------------------------

const OUT = {
  reply: "Inilipat ko ang merienda.",
  proposal: { guide: { days: [] }, stored: { days: [] }, changes: [line("Later", "Merienda, by 30 min")], base: BASE },
  outcome: "proposal",
  need_link: null,
};

test("T61-W10g chatAnswer: a 200 is the chatbot's answer; a malformed one is a server failure", async () => {
  const { chatAnswer } = await load();
  assert.deepEqual(chatAnswer(200, OUT), { ok: true, body: OUT });
  const answer = { ...OUT, proposal: null, outcome: "answer", need_link: { name: "Made-Up Hill", at: { after: "d1-03" } } };
  assert.deepEqual(chatAnswer(200, answer), { ok: true, body: answer });
  assert.deepEqual(chatAnswer(200, { ...OUT, proposal: null, outcome: "no_fit" }), { ok: true, body: { ...OUT, proposal: null, outcome: "no_fit" } });
  for (const bad of [null, {}, { ...OUT, reply: 3 }, { ...OUT, outcome: "maybe" }, { ...OUT, proposal: { changes: [] } }]) {
    assert.deepEqual(chatAnswer(200, bad), { ok: false, why: "server" }, JSON.stringify(bad));
  }
});

test("T61-W10h chatAnswer: busy and cap carry retry_at; off, a stale base, a lost trip, the provider and offline", async () => {
  const { chatAnswer } = await load();
  assert.deepEqual(chatAnswer(429, { detail: "chat_busy", retry_at: "2026-11-09T16:10:00+08:00" }), { ok: false, why: "busy", retryAt: "2026-11-09T16:10:00+08:00" });
  assert.deepEqual(chatAnswer(429, { detail: "chat_busy", retry_at: null }), { ok: false, why: "busy", retryAt: null });
  assert.deepEqual(chatAnswer(429, null), { ok: false, why: "busy", retryAt: null }, "a 429 from anything in front of the API");
  assert.deepEqual(chatAnswer(429, { detail: "chat_cap", retry_at: "2026-11-10T00:00:00+08:00" }), { ok: false, why: "cap", retryAt: "2026-11-10T00:00:00+08:00" });
  assert.deepEqual(chatAnswer(429, { detail: "chat_busy", retry_at: "4:10" }), { ok: false, why: "busy", retryAt: null }, "only an ISO time is used");
  assert.deepEqual(chatAnswer(503, { detail: "chat_off" }), { ok: false, why: "off" });
  assert.deepEqual(chatAnswer(503, { detail: "other" }), { ok: false, why: "server" });
  assert.deepEqual(chatAnswer(409, { detail: "plan_changed", itinerary_slug: "edit-made-up-copy", seq: 5 }),
    { ok: false, why: "clash", clash: { itinerary_slug: "edit-made-up-copy", seq: 5 } });
  assert.deepEqual(chatAnswer(404, { detail: "Not Found" }), { ok: false, why: "not_found" });
  assert.deepEqual(chatAnswer(502, { detail: "chat_failed" }), { ok: false, why: "server" });
  assert.deepEqual(chatAnswer(500, null), { ok: false, why: "server" });
  assert.deepEqual(chatAnswer(422, { detail: [{ loc: ["body"] }] }), { ok: false, why: "rejected" });
  assert.deepEqual(chatAnswer("offline", null), { ok: false, why: "offline" });
});

// ---- ux.md §10's lines ---------------------------------------------------------------------------------

test("T61-W10i the limits' lines; chat_busy's time is retry_at in Manila, on any phone clock", async () => {
  const { chatFailureLines } = await load();
  for (const tz of ["UTC", "Asia/Manila", "America/Los_Angeles"]) {
    process.env.TZ = tz;
    assert.deepEqual(chatFailureLines({ why: "busy", retryAt: "2026-11-09T16:10:00+08:00" }),
      ["The chatbot has answered 20 messages for this trip this hour. Try again after 4:10 PM, or change the plan by hand."], tz);
    assert.deepEqual(chatFailureLines({ why: "busy", retryAt: "2026-11-09T08:10:00Z" }),
      ["The chatbot has answered 20 messages for this trip this hour. Try again after 4:10 PM, or change the plan by hand."], `${tz}, a UTC retry_at`);
  }
  assert.deepEqual(chatFailureLines({ why: "busy", retryAt: null }),
    ["The chatbot has answered 20 messages for this trip this hour. Try again later, or change the plan by hand."]);
  assert.deepEqual(chatFailureLines({ why: "cap", retryAt: "2026-11-10T00:00:00+08:00" }), ["The chatbot is done for today. You can still change the plan by hand."]);
  assert.deepEqual(chatFailureLines({ why: "off" }), ["The chatbot is off right now. You can still change the plan by hand."]);
  assert.deepEqual(chatFailureLines({ why: "offline" }), ["The chatbot needs signal."]);
});

test("T61-W10j the chat's own lines are ux.md §10's, word for word", async () => {
  const c = await load();
  assert.equal(c.FIRST_MESSAGE, `Kumusta! Tell me what to change, like "add merienda after Burnham Park" or "mas chill ang Day 2". I only use places on Tara Gala and ones your group added. Nothing changes until someone taps Apply.`);
  assert.equal(c.PRIVACY_LINE, "This chat is kept only on this phone. To answer, your messages and the plan are sent to an AI service. The group sees only changes you apply.");
  assert.equal(c.THINKING, "The chatbot is thinking...");
  assert.equal(c.APPLIED, "Applied. It's in Changes, and Undo takes it back.");
  assert.equal(c.NOT_APPLIED, "Not applied.");
  assert.equal(c.NO_FIT, "The chatbot couldn't make a change that fits the plan. Try asking another way.");
  assert.deepEqual(c.APPLY_CLASH, ["Someone just changed the plan, so this change wasn't applied.", "Ask again and the chatbot will use the newer plan."]);
  assert.equal(c.CLEAR_CONFIRM, "Clear this chat on this phone? Applied changes stay.");
  assert.equal(c.needLinkLine("Hill Station"), "Hill Station isn't on Tara Gala yet, so I can't pin it. Paste its Google Maps link and I'll fit it in.");
  assert.equal(c.askLine("Café Yagam"), "What should we do at Café Yagam, and is there something similar nearby?");
});

test("T61-W10k the request: base, the trimmed turns ending with the new message, and the focus key", async () => {
  const { chatRequest } = await load();
  const log = Array.from({ length: 12 }, (_, i) => ({ kind: (i % 2 ? "bot" : "user") as "bot" | "user", text: `t${i}` }));
  const body = chatRequest(BASE, log, "what about Day 2?", "d2-04");
  assert.deepEqual(body.base, BASE);
  assert.deepEqual(body.focus, { key: "d2-04" });
  assert.equal(body.messages.length, 10);
  assert.deepEqual(body.messages.at(-1), { role: "user", text: "what about Day 2?" });
  assert.deepEqual(chatRequest(BASE, [], "hi", null), { base: BASE, messages: [{ role: "user", text: "hi" }], focus: null });
  assert.equal(chatRequest(BASE, [], "  hi  ", null).messages[0].text, "hi", "trimmed");
});
