// TG-62 GW2: the trip page's Budget panel (budgetPanel.ts, BudgetPanel.tsx, LevelMap's mount, TripView's card line).
// Run with `npm test`. Plan §3 G28 to G32 and TG-62 ux.md §3, §5, §6 and §7. Made-up trip, lines and people. The module
// is loaded per test, so before it exists each test fails on its own instead of the whole file. Components can't render
// under node --test, so their wiring is pinned by source; the E2E checks the real screen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { BudgetLineSpend, SessionBudget } from "./sessionBudget.ts";

const load = () => import("./budgetPanel.ts");
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const C = "00000000-0000-4000-8000-000000000003";
const D = "00000000-0000-4000-8000-000000000004";

function line(over: Partial<BudgetLineSpend> = {}): BudgetLineSpend {
  return { key: "meals", item: "Meals and merienda, 2.5 days", estimate: "1,500 to 2,200", min: 1500, max: 2200, readable: true, spent: 0, spent_each: 0, ...over };
}
// Four people. Meals: ₱7,360 for the group, ₱1,840 each (360 left). Van: ₱1,880, ₱470 each (120 over 350).
function budget(over: Partial<SessionBudget> = {}): SessionBudget {
  return {
    state: "ok",
    member_count: 4,
    total_centavos: 1_200_000,
    lines: [
      line({ spent: 736_000, spent_each: 184_000 }),
      line({ key: "van", item: "Van to La Trinidad", estimate: "350", min: 350, max: 350, spent: 188_000, spent_each: 47_000 }),
    ],
    not_in_budget: { count: 2, spent: 160_000 },
    unsorted: { count: 3, spent: 116_000, removed: 1 },
    members: [
      { member_id: A, name: "Ana", share_lines: 231_000, share_total: 300_000 },
      { member_id: B, name: "Ben", share_lines: 280_000, share_total: 300_000 },
      { member_id: C, name: "Carla", share_lines: 231_000, share_total: 300_000 },
      { member_id: D, name: "Dan", share_lines: 182_400, share_total: 300_000 },
    ],
    ...over,
  };
}

// ---------------------------------------------------------------- G28: rounding and words

test("GW2-P1 G28 money: whole pesos rounded half up; spent each is an integer division rounded half up", async () => {
  const { pesosOf, eachOf } = await load();
  assert.equal(pesosOf(0), 0);
  assert.equal(pesosOf(184_049), 1840);
  assert.equal(pesosOf(184_050), 1841, "half up");
  assert.equal(pesosOf(184_099), 1841);
  assert.equal(eachOf(160_000, 4), 40_000);
  assert.equal(eachOf(100, 3), 33, "33.33 rounds down");
  assert.equal(eachOf(5, 2), 3, "2.5 rounds up");
  assert.equal(eachOf(160_000, 0), 0, "no members: nothing each");
});

test("GW2-P2 G28 the plan figure: an en dash range, one number, or the estimate as written", async () => {
  const { planText } = await load();
  assert.equal(planText(line()), "Plan 1,500–2,200");
  assert.equal(planText(line({ min: 350, max: 350 })), "Plan 350");
  assert.equal(planText(line({ estimate: "depends on the season", min: null, max: null, readable: false })), "Plan: depends on the season");
});

test("GW2-P3 G28 left and over against the high end, in whole pesos; exactly max reads 0 left; unreadable has no word", async () => {
  const { leftOver } = await load();
  assert.deepEqual(leftOver(184_000, 2200), { text: "360 left", over: false });
  assert.deepEqual(leftOver(47_000, 350), { text: "120 over", over: true });
  assert.deepEqual(leftOver(220_000, 2200), { text: "0 left", over: false });
  assert.deepEqual(leftOver(219_950, 2200), { text: "0 left", over: false }, "2,199.50 rounds up to the max");
  assert.deepEqual(leftOver(0, 2200), { text: "2,200 left", over: false });
  assert.deepEqual(leftOver(350_000, 2200), { text: "1,300 over", over: true }, "thousands get a comma");
  assert.equal(leftOver(184_000, null), null);
});

// ---------------------------------------------------------------- G28: the table

test("GW2-P4 G28 each line row: the item, its plan, the spend each in whole pesos, and its word", async () => {
  const { panelView } = await load();
  const v = panelView(budget(), A);
  assert.deepEqual(v.rows, [
    { key: "meals", item: "Meals and merienda, 2.5 days", plan: "Plan 1,500–2,200", spent: "1,840", word: { text: "360 left", over: false } },
    { key: "van", item: "Van to La Trinidad", plan: "Plan 350", spent: "470", word: { text: "120 over", over: true } },
  ]);
  const odd = panelView(budget({ lines: [line({ key: "pasalubong", item: "Pasalubong", estimate: "depends on the season", min: null, max: null, readable: false, spent: 80_000, spent_each: 20_000 })] }), A);
  assert.deepEqual(odd.rows[0], { key: "pasalubong", item: "Pasalubong", plan: "Plan: depends on the season", spent: "200", word: null }, "an unreadable line has no word");
});

test("GW2-P5 G28 Total: the plan's lines against their summed range; with an unreadable line, the spend and no word", async () => {
  const { panelView } = await load();
  assert.deepEqual(panelView(budget(), A).total, { plan: "Plan 1,850–2,550", spent: "2,310", word: { text: "240 left", over: false } });
  const odd = budget({ lines: [...budget().lines, line({ key: "pasalubong", item: "Pasalubong", estimate: "depends", min: null, max: null, readable: false, spent: 80_000, spent_each: 20_000 })] });
  // tg-ux2, ux.md "GW2 Q1": the spend still counts every plan line, the unreadable one included
  assert.deepEqual(panelView(odd, A).total, { plan: "Plan: not all lines have a number", spent: "2,510", word: null });
  const over = budget({ lines: [line({ spent: 1_000_000, spent_each: 250_000 })] });
  assert.deepEqual(panelView(over, A).total.word, { text: "300 over", over: true });
});

test("GW2-P6 G28 Not in the budget and Not sorted yet: only above 0, per person, with their meta", async () => {
  const { panelView } = await load();
  const v = panelView(budget(), A);
  assert.deepEqual(v.notInBudget, { spent: "400", meta: "Bus fares, the condo, anything else" });
  assert.deepEqual(v.unsorted, { spent: "290", meta: "3 expenses, 1 from a line that was removed" });
  assert.deepEqual(panelView(budget({ unsorted: { count: 1, spent: 40_000, removed: 0 } }), A).unsorted, { spent: "100", meta: "1 expense" });
  assert.equal(panelView(budget({ unsorted: { count: 4, spent: 40_000, removed: 2 } }), A).unsorted?.meta, "4 expenses, 2 from lines that were removed");
  const none = panelView(budget({ not_in_budget: { count: 0, spent: 0 }, unsorted: { count: 0, spent: 0, removed: 0 } }), A);
  assert.equal(none.notInBudget, null);
  assert.equal(none.unsorted, null);
  const nulls = panelView(budget({ not_in_budget: null, unsorted: null }), A);
  assert.equal(nulls.notInBudget, null, "the API's null reads as zero");
  assert.equal(nulls.unsorted, null);
});

test("GW2-P7 G28 the meta line names the member count; the sort nudge has singular and plural forms", async () => {
  const { panelView } = await load();
  const v = panelView(budget(), A);
  assert.equal(v.splitLine, "Spent is the wallet's total for each line, split over its 4 people. Left and over are against the high end of the plan.");
  assert.equal(panelView(budget({ member_count: 1 }), A).splitLine, "Spent is the wallet's total for each line, split over its 1 person. Left and over are against the high end of the plan.");
  assert.deepEqual(v.nudge, { text: "3 expenses aren't sorted yet.", link: "Sort them in the wallet" });
  assert.deepEqual(panelView(budget({ unsorted: { count: 1, spent: 40_000, removed: 0 } }), A).nudge, { text: "1 expense isn't sorted yet.", link: "Sort it in the wallet" });
  assert.equal(panelView(budget({ unsorted: { count: 0, spent: 0, removed: 0 } }), A).nudge, null);
});

test("GW2-P8 G29 ok with nothing spent: zeros everywhere, no words, no per-person box, and the nothing-spent line", async () => {
  const { panelView } = await load();
  const v = panelView(budget({ total_centavos: 0, lines: [line(), line({ key: "van", item: "Van", min: 350, max: 350, estimate: "350" })], not_in_budget: { count: 0, spent: 0 }, unsorted: { count: 0, spent: 0, removed: 0 }, members: budget().members.map((m) => ({ ...m, share_lines: 0, share_total: 0 })) }), A);
  assert.equal(v.nothingSpent, "Nothing spent yet. Expenses added in the wallet show here.");
  assert.deepEqual(v.rows.map((r) => [r.spent, r.word]), [["0", null], ["0", null]]);
  assert.deepEqual(v.total, { plan: "Plan 1,850–2,550", spent: "0", word: null });
  assert.equal(v.people, null);
  assert.equal(v.nudge, null);
  assert.equal(panelView(budget(), A).nothingSpent, null);
});

test("GW2-P9 G28 the per-person box: wallet order, (you), the share in pesos, and lines, left or over, and other", async () => {
  const { panelView } = await load();
  const v = panelView(budget(), A);
  // Plan's high end per person: 2,200 + 350 = 2,550
  assert.deepEqual(v.people, [
    { name: "Ana", you: true, total: "₱3,000", lines: "₱2,310 on the plan's lines", word: { text: "₱240 left", over: false }, other: "₱690 other" },
    { name: "Ben", you: false, total: "₱3,000", lines: "₱2,800 on the plan's lines", word: { text: "₱250 over", over: true }, other: "₱200 other" },
    { name: "Carla", you: false, total: "₱3,000", lines: "₱2,310 on the plan's lines", word: { text: "₱240 left", over: false }, other: "₱690 other" },
    { name: "Dan", you: false, total: "₱3,000", lines: "₱1,824 on the plan's lines", word: { text: "₱726 left", over: false }, other: "₱1,176 other" },
  ]);
  assert.ok(panelView(budget(), null).people?.every((p) => !p.you), "a phone that doesn't know who it is marks no one");
  const odd = budget({ lines: [...budget().lines, line({ key: "x", item: "X", estimate: "depends", min: null, max: null, readable: false })], members: [{ member_id: A, name: "Ana", share_lines: 300_000, share_total: 300_000 }] });
  assert.deepEqual(panelView(odd, A).people, [{ name: "Ana", you: true, total: "₱3,000", lines: "₱3,000 on the plan's lines", word: null, other: null }], "an unreadable line drops the word; other at 0 is left out");
});

test("GW2-P10 G28 the per-person meta reads as one line", async () => {
  const { personMeta } = await load();
  assert.equal(personMeta({ lines: "₱3,900 on the plan's lines", word: { text: "₱250 left", over: false }, other: "₱920 other" }), "₱3,900 on the plan's lines, ₱250 left · ₱920 other");
  assert.equal(personMeta({ lines: "₱3,900 on the plan's lines", word: null, other: "₱920 other" }), "₱3,900 on the plan's lines · ₱920 other");
  assert.equal(personMeta({ lines: "₱3,900 on the plan's lines", word: { text: "₱10 over", over: true }, other: null }), "₱3,900 on the plan's lines, ₱10 over");
});

test("GW2-P14 ux.md GW2 Q5: a line with nothing spent, among spent lines, shows 0 and its word as any other line", async () => {
  const { panelView } = await load();
  const v = panelView(budget({ lines: [...budget().lines, line({ key: "taxis", item: "Taxis and jeeps", estimate: "200 to 400", min: 200, max: 400 })] }), A);
  assert.deepEqual(v.rows[2], { key: "taxis", item: "Taxis and jeeps", plan: "Plan 200–400", spent: "0", word: { text: "400 left", over: false } });
  assert.deepEqual(v.total, { plan: "Plan 2,050–2,950", spent: "2,310", word: { text: "640 left", over: false } }, "its plan still counts in Total");
  assert.equal(v.nothingSpent, null, "only a wallet with nothing spent drops the words (P8)");
});

// ---------------------------------------------------------------- G29: states, heading; G30: the card

test("GW2-P11 G29 ux §5: each state's line under today's table; ok and no_budget add none", async () => {
  const { stateLine } = await load();
  assert.deepEqual(stateLine("no_wallet"), { text: "Start a wallet for this trip and its spending shows here, line by line.", link: "Go to Shared expenses" });
  assert.deepEqual(stateLine("two_trips"), { text: "This trip's wallet is also on another trip, so its spending isn't matched to these lines.", link: null });
  assert.deepEqual(stateLine("failed"), { text: "Spending couldn't load. Try again with signal.", link: null });
  assert.deepEqual(stateLine("offline"), { text: "Spending couldn't load. Try again with signal.", link: null }, "offline with no saved copy");
  assert.deepEqual(stateLine("loading"), { text: "Loading spending...", link: null });
  for (const s of ["ok", "no_budget", "off"] as const) assert.equal(stateLine(s), null, s);
});

test("GW2-P12 G29 the per-person heading drops 'so far' after the trip's return date (Manila dates)", async () => {
  const { shareHeading } = await load();
  assert.equal(shareHeading("2026-11-08", "2026-11-07"), "Each person's share so far");
  assert.equal(shareHeading("2026-11-08", "2026-11-08"), "Each person's share so far", "the last day is still the trip");
  assert.equal(shareHeading("2026-11-08", "2026-11-09"), "Each person's share");
});

test("GW2-P13 G30 the card line: the wallet's total and about each, hidden at 0", async () => {
  const { cardLine } = await load();
  assert.equal(cardLine(budget({ total_centavos: 1_800_000, member_count: 4 })), "₱18,000 spent · about ₱4,500 each");
  assert.equal(cardLine(budget({ total_centavos: 1_000_000, member_count: 3 })), "₱10,000 spent · about ₱3,333 each");
  assert.equal(cardLine(budget({ state: "two_trips", total_centavos: 50, member_count: 4, lines: [], members: [] })), "₱1 spent · about ₱0 each", "any state with a wallet");
  assert.equal(cardLine(budget({ total_centavos: 0 })), null);
  assert.equal(cardLine(budget({ state: "no_wallet", total_centavos: 0, member_count: 0 })), null);
});

// ---------------------------------------------------------------- the components, by source (the E2E renders them)

const LEVEL_MAP = "src/components/LevelMap.tsx";
const PANEL = "src/components/BudgetPanel.tsx";
const TRIP = "src/components/TripView.tsx";

test("GW2-S1 G29 Rev 1 S1: LevelMap mounts the panel beside the recap mode, never in it; flag off keeps today's table", () => {
  const src = read(LEVEL_MAP);
  assert.match(src, /import BudgetPanel, \{ SpendingNote \} from "\.\/BudgetPanel"/);
  assert.match(src, /spending\?: Spending;/, "an optional prop: the plan's own page and the recap pass none");
  assert.match(src, /const shownSpending = recap \? undefined : spending;/, "the recap never shows the budget (TG-64 §2.2)");
  assert.match(src, /shownSpending\?\.load !== undefined && shownSpending\.load !== "loading" && shownSpending\.load\.ok && shownSpending\.load\.budget\.state === "ok" \? \(\s*<BudgetPanel /,
    "only state ok has lines: no_wallet, two_trips and no_budget come back ok:true too and keep today's table with their line (ux §5)");
  assert.match(src, /<Budget guide=\{guide\}>\{shownSpending && <SpendingNote load=\{shownSpending\.load\} \/>\}<\/Budget>/);
  assert.match(src, /if \(key === "budget" && menu !== "budget"\) shownSpending\?\.onOpen\(\);/, "opening the panel fetches again (ux §5)");
  assert.doesNotMatch(read("src/components/RecapView.tsx"), /spending=/, "the recap passes no spending");
  assert.doesNotMatch(read("src/components/ItineraryList.tsx"), /spending=/, "nor does the plan's own page");
});

test("GW2-S2 ux §6: the spending table is a real table with a caption, column headers and a Total row header", () => {
  const src = read(PANEL);
  assert.match(src, /<caption className="sr-only">The plan and the spending per person, in pesos<\/caption>/);
  assert.match(src, /<th scope="col"[^>]*>Item<\/th>/);
  assert.match(src, /<th scope="col"[^>]*>Spent \(₱\)<\/th>/);
  // ux §3: Total's cell carries the summed plan under it, as each line's item does
  assert.match(src, /<th scope="row"[^>]*>\s*<span[^>]*>Total<\/span>\s*<span className=\{cx\(PX\.meta, "block"\)\}>\{v\.total\.plan\}<\/span>\s*<\/th>/);
  assert.match(src, /text-danger-text/, "over is a word, and the Red only repeats it");
  assert.match(src, /href=\{`\/w\/\$\{walletSlug\}#expenses-title`\}/, "the nudge links to the wallet's expenses");
  assert.match(src, /href="#money-title"/, "no wallet: Go to Shared expenses");
});

test("GW2-S3 G32: with NEXT_PUBLIC_BUDGET_LINES off TripView makes no budget request and passes no spending; the card line too", () => {
  const src = read(TRIP);
  assert.match(src, /if \(!flags\.budgetLines\) return;/, "the load returns before any request");
  assert.match(src, /spending=\{flags\.budgetLines \? spending : undefined\}/);
  assert.match(src, /spent=\{flags\.budgetLines && spend !== "loading" && spend\?\.ok \? cardLine\(spend\.budget\) : null\}/);
  assert.equal((src.match(/getBudget\(/g) ?? []).length, 1, "one call site");
});

test("GW2-S4 G30 the card line sits between the wallet's name and today's meta line", () => {
  const src = read(TRIP);
  assert.match(src, /<span className="break-words font-bold">\{trip\.wallet\.name\}<\/span>\s*\{spent && <span className="text-sm tabular-nums">\{spent\}<\/span>\}\s*<span className=\{PX\.meta\}>Who paid what, and who pays whom at the end\.<\/span>/);
});

test("GW2-S5 logs: the budget load says its state and counts, never a name, an item or an amount", () => {
  const src = read(TRIP);
  assert.match(src, /console\.info\("\[tg-trip\] budget ok=%s state=%s lines=%d members=%d"/);
  for (const file of [TRIP, PANEL]) {
    for (const [, args] of read(file).matchAll(/console\.\w+\(([^;]*)\);/g)) {
      assert.doesNotMatch(args, /\.name\b|\.item\b|_centavos|\.spent\b|share_/, `${file}: ${args}`);
    }
  }
  assert.doesNotMatch(read("src/lib/budgetPanel.ts"), /console\./, "the words are pure");
});

// ---------------------------------------------------------------- tg-ux2's review of #103 (TG-62/ux-review-gw2.md)

test("GW2-P15 ux-review Q1: a refetch that fails keeps the numbers on screen; couldn't-load is only for nothing to show", async () => {
  const { afterRefetch } = await load();
  const ok = { ok: true as const, budget: budget() };
  const fresh = { ok: true as const, budget: budget({ total_centavos: 1_300_000 }) };
  for (const why of ["offline", "failed", "off"] as const) assert.equal(afterRefetch(ok, { ok: false, why }), ok, why);
  assert.equal(afterRefetch(ok, fresh), fresh, "new numbers replace the old");
  assert.deepEqual(afterRefetch("loading", { ok: false, why: "failed" }), { ok: false, why: "failed" });
  assert.deepEqual(afterRefetch({ ok: false, why: "offline" }, { ok: false, why: "failed" }), { ok: false, why: "failed" });
  assert.equal(afterRefetch(null, fresh), fresh);
  assert.match(read(TRIP), /onOpen: \(\) =>[^\n]*setSpend\(\(prev\) => afterRefetch\(prev, r\)\)/, "Q1: the reopen keeps the numbers");
});

test("GW2-S6 ux-review M1, S1, S2: the wallet link's shape, the Spent header on one line, each amount with its word", () => {
  const src = read(PANEL);
  assert.match(src, /<PixelLink variant="secondary" href=\{`\/w\/\$\{walletSlug\}`\} className="inline-flex items-center self-start px-4 text-sm">/, "M1: like every other secondary PixelLink");
  assert.match(src, /<th scope="col" className="[^"]*whitespace-nowrap[^"]*">Spent \(₱\)<\/th>/, "S1: it wrapped at 320");
  for (const part of ["p.lines", "p.word.text", "p.other"]) assert.match(src, new RegExp(`<span className="[^"]*whitespace-nowrap[^"]*">\\{${part.replace(/\./g, "\\.")}\\}<\\/span>`), `S2: ${part} doesn't break`);
});
