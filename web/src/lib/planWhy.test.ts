// TG-61 owner feedback 2026-11-15: the chatbot says why it removes (or moves, or swaps) something. A change line can carry
// `why` (ChangeLine.why, 1 to 120 characters, already through the server's check_text). ux.md §10 "Why it changes", §3.2
// and §11 give the copy and the placement. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as L from "./planLines.ts";
import type { ChangeLine, PlanVersion } from "./planLines.ts";

const WEB = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB), "utf8");
const WHY = "You asked for a slower Day 2, and it's the farthest stop that day";
const dropped: ChangeLine & { why?: string | null } = { word: "Dropped", day: 2, text: "BenCab Museum (made up)", why: WHY };
const plain: ChangeLine = { word: "Later", day: 2, text: "Lunch, by 30 min" };
const whyText = (why: unknown) => {
  assert.equal(typeof (L as Record<string, unknown>).whyText, "function", "planLines.whyText exists");
  return (L as unknown as { whyText: (w: unknown) => string | null }).whyText(why);
};

test("T61-Y1 the why line: 'Why: ' and the why as written; a '.' only when it doesn't end in . ! or ?", () => {
  assert.equal(whyText(WHY), `Why: ${WHY}.`);
  assert.equal(whyText("No time left before the bus home."), "Why: No time left before the bus home.");
  assert.equal(whyText("Mas chill ang Day 2!"), "Why: Mas chill ang Day 2!");
  assert.equal(whyText("Too far, isn't it?"), "Why: Too far, isn't it?");
  const long = "x".repeat(120);
  assert.equal(whyText(long), `Why: ${long}.`, "nothing is cut");
  for (const none of [undefined, null, "", "   "]) assert.equal(whyText(none), null, `never a placeholder: ${JSON.stringify(none)}`);
  assert.equal(whyText(42), null, "only text");
});

test("T61-Y2 a proposal's rows carry the why under their line; lines without one show no why", () => {
  const rows = L.changeRows([dropped, plain]) as (ReturnType<typeof L.lineParts> & { why?: string | null })[];
  assert.deepEqual(rows[0], { word: "Dropped", rest: " · World 2 · BenCab Museum (made up)", why: `Why: ${WHY}.` });
  assert.deepEqual(rows[1], { word: "Later", rest: " · World 2 · Lunch, by 30 min", why: null });
  assert.deepEqual(L.lineParts(dropped), { word: "Dropped", rest: " · World 2 · BenCab Museum (made up)" }, "the line itself is unchanged (F13)");
});

test("T61-Y3 the one-line places never show a why: the bar, the Undo confirm, the plan just changed", () => {
  assert.equal(L.linePlain(dropped), "Dropped · World 2 · BenCab Museum (made up)");
  assert.doesNotMatch(L.saidPlain(L.barSaid([dropped], "chat")), /Why/);
  const v: PlanVersion = { seq: 3, source: "chat", changes: [dropped], created_at: "2026-11-15T07:40:00Z" };
  assert.doesNotMatch(L.saidPlain(L.justChanged(v)), /Why/);
  const ask = L.undoConfirm({ seq: 3, versions: [v] }, new Map(), Date.now());
  assert.ok(ask === null || !/Why/.test(ask), "the Undo confirm stays one line");
});

test("T61-Y4 Changes: a chatbot version's row keeps its line's why for the row under it", () => {
  const v: PlanVersion = { seq: 3, source: "chat", changes: [dropped, plain], created_at: "2026-11-15T07:40:00Z" };
  const row = L.historyRow(v, "2026-11-15") as ReturnType<typeof L.historyRow> & { why?: string | null };
  assert.equal(row.lead, "Chatbot: ");
  assert.equal(row.why, `Why: ${WHY}.`);
  const hand = L.historyRow({ ...v, source: "hand", changes: [plain] }, "2026-11-15") as typeof row;
  assert.equal(hand.why, null);
});

test("T61-Y5 the phone's chat log keeps a proposal's whys, as words on screen", async () => {
  const { saveLog, loadLog, chatAnswer } = await import("./chat.ts");
  const data = new Map<string, string>();
  const s = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
  const slug = "0123456789abcdef0123456789abcdef";
  saveLog(s, slug, [{ kind: "bot", text: "a", changes: [dropped, plain], proposal: "open" }]);
  const back = loadLog(s, slug)[0];
  assert.ok(back.kind === "bot");
  assert.deepEqual(back.changes, [dropped, plain]);
  const base = { itinerary_slug: "edit-made-up-copy", seq: 1 };
  const out = { reply: "r", outcome: "proposal", need_link: null, proposal: { guide: {}, stored: {}, base, changes: [dropped] } };
  assert.equal(chatAnswer(200, out).ok, true);
  assert.equal(chatAnswer(200, { ...out, proposal: { ...out.proposal, changes: [{ ...dropped, why: 42 }] } }).ok, false, "a why is text or nothing");
});

test("T61-Y6 the card and Changes draw the why on its own line inside the same <li>: indented, text-sm, not meta, not bold", () => {
  const bits = read("src/components/PlanBits.tsx");
  const list = bits.slice(bits.indexOf("export function ChangeList"), bits.indexOf("\n}\n", bits.indexOf("export function ChangeList")));
  assert.match(list, /<li[^>]*>[\s\S]*?\{l\.why && <span className="block pl-4 text-sm">\{l\.why\}<\/span>\}[\s\S]*?<\/li>/, "under its line, in the same <li>");
  assert.match(list, /lines\.some\(\(l\) => l\.why\) \? "gap-2" : "gap-1"/, "a little more air when any line has a why");
  const bar = read("src/components/PlanEditBar.tsx");
  const row = bar.slice(bar.indexOf("function HistoryRow"));
  assert.match(row, /\{r\.why && <span className="block pl-4 text-sm">\{r\.why\}<\/span>\}/, "Changes: under the row, the same way");
  for (const src of [list, row]) {
    assert.doesNotMatch(src.slice(src.indexOf("why")), /PX\.meta[^\n]*why|why[^\n]*font-bold/, "not fine print, and Why: isn't bold");
  }
});

test("T61-Y7 a why is never logged", () => {
  // Where whys are drawn, no log mentions one at all. Elsewhere `<result>.why` is a failure's code ("offline", "clash"),
  // never a reason's text, and a line's why (or whyText) never reaches a log
  const strict = ["src/components/PlanBits.tsx", "src/components/PlanEditBar.tsx", "src/lib/planLines.ts", "src/lib/chat.ts"];
  for (const file of [...strict, "src/components/PlanChat.tsx", "src/components/TripView.tsx"]) {
    for (const [, args] of read(file).matchAll(/console\.(?:info|warn|error|log)\(([^;]*)\);/g)) {
      const rest = strict.includes(file) ? args : args.replace(/\b(r|w|out)\.why\b/g, "");
      assert.doesNotMatch(rest, /\bwhy\b|whyText/, `${file}: ${args}`);
    }
  }
});

// ---- Apply sends the whys back (tg-build, 2026-11-15): the server rebuilds the lines and puts the whys on them only
// if the phone sends them, so Changes keeps them. A hand save never carries whys (the API refuses that with a 422).

const WHYS = { "row:d2-05": WHY, "todo:01": "Already bought (made up)" };
const BASE = { itinerary_slug: "edit-made-up-copy", seq: 4 };
const OUT = { reply: "r", outcome: "proposal", need_link: null, proposal: { guide: {}, stored: { days: [] }, base: BASE, changes: [dropped], whys: WHYS } };

test("T61-Y8 a proposal's whys are read as an opaque map of text, and may be absent", async () => {
  const { chatAnswer } = await import("./chat.ts");
  const r = chatAnswer(200, OUT);
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.body.proposal?.whys, WHYS);
  const none = { ...OUT, proposal: { ...OUT.proposal, whys: undefined } };
  assert.equal(chatAnswer(200, none).ok, true, "no whys: still a proposal");
  const empty = chatAnswer(200, { ...OUT, proposal: { ...OUT.proposal, whys: {} } });
  assert.ok(empty.ok, "the API always sends whys, {} when there are none: an empty map is a good answer");
  assert.deepEqual(empty.ok && empty.body.proposal?.whys, {});
  for (const bad of [[], "x", { "row:d2-05": 3 }, null]) {
    assert.equal(chatAnswer(200, { ...OUT, proposal: { ...OUT.proposal, whys: bad } }).ok, bad === null, JSON.stringify(bad));
  }
});

test("T61-Y9 savePlan sends the whys only on a chat save; a hand save never does", async (t) => {
  const { tripApi } = await import("./trip.ts");
  const sent: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ itinerary: {}, changes: [] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const save = tripApi.savePlan as (slug: string, base: unknown, guide: unknown, source: "hand" | "chat", whys?: Record<string, string>) => Promise<unknown>;
  await save("s", BASE, { days: [] }, "chat", WHYS);
  await save("s", BASE, { days: [] }, "chat");
  await save("s", BASE, { days: [] }, "chat", {});
  await save("s", BASE, { days: [] }, "hand", WHYS);
  await save("s", BASE, { days: [] }, "hand");
  assert.deepEqual(sent[0], { base: BASE, guide: { days: [] }, source: "chat", whys: WHYS });
  assert.deepEqual(sent[1], { base: BASE, guide: { days: [] }, source: "chat" }, "no whys: the key is left out");
  assert.deepEqual(sent[2], { base: BASE, guide: { days: [] }, source: "chat", whys: {} }, "an empty map goes back as it came");
  assert.deepEqual(sent[3], { base: BASE, guide: { days: [] }, source: "hand" }, "a hand save never carries whys");
  assert.deepEqual(sent[4], { base: BASE, guide: { days: [] }, source: "hand" });
});

test("T61-Y10 the chat's Apply passes the proposal's whys; the hand editor's saves don't; whys are never stored or logged", () => {
  const view = read("src/components/TripView.tsx");
  assert.match(view, /tripApi\.savePlan\(slug, (\w+)\.base, \1\.stored, "chat", \1\.whys\)/);
  assert.match(view, /tripApi\.savePlan\(slug, base, next, "hand"\)/, "the hand path is unchanged");
  const chat = read("src/lib/chat.ts");
  const keep = chat.slice(chat.indexOf("function keep("), chat.indexOf("\n}\n", chat.indexOf("function keep(")));
  assert.doesNotMatch(keep, /whys/, "the phone's log keeps words, never the whys map");
  for (const file of ["src/components/TripView.tsx", "src/components/PlanChat.tsx", "src/lib/trip.ts", "src/lib/chat.ts"]) {
    for (const [, args] of read(file).matchAll(/console\.(?:info|warn|error|log)\(([^;]*)\);/g)) assert.doesNotMatch(args, /whys/, `${file}: ${args}`);
  }
});

