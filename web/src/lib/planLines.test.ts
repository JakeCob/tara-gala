// TG-61 review S8: the server sends each change as a ChangeLine {word, day, text}; the phone writes the sentences, with
// its own level numbers only for its own change (ux.md §3.1). Run with `npm test` (node --test, type stripping).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type ChangeLine, type PlanVersion, busNotice, busWarningLine, changeRows, copyLine, farLine, historyLine, justChanged, legLines, removeConfirm, resultLine,
  summaryOf, undoConfirm, undoLabel,
} from "./planLines.ts";

const L = (word: string, text: string, day: number | null = 1): ChangeLine => ({ word, day, text });
const v = (seq: number, source: PlanVersion["source"], changes: ChangeLine[], created_at = "2026-11-09T07:12:00Z"): PlanVersion => ({ seq, source, changes, created_at });
const level = (key: string) => ({ "d1-03": "1-3", "d1-05": "1-5" })[key] ?? null;

test("T61-L1 the edit bar's line for each change this phone makes", () => {
  assert.equal(resultLine([L("New", "Café Yagam")], { kind: "add", after: "d1-03", day: 1 }, level), "Added Café Yagam after Level 1-3.");
  assert.equal(resultLine([L("New", "Café Yagam")], { kind: "add", after: null, day: 2 }, level), "Added Café Yagam at the start of World 2.");
  assert.equal(resultLine([L("Out", "Burnham Park walk"), L("In", "Wright Park and The Mansion")], { kind: "replace" }, level), "Burnham Park walk is now Wright Park and The Mansion.");
  assert.equal(resultLine([L("Later", "Lunch to 1:00 PM")], { kind: "edit", key: "d1-05" }, level), "Changed Level 1-5.");
  assert.equal(resultLine([L("Moved", "Burnham Park walk", 2)], { kind: "move", day: 2 }, level), "Moved Burnham Park walk to World 2.");
  assert.equal(resultLine([L("Moved", "Burnham Park walk")], { kind: "nudge", dir: "earlier" }, level), "Moved Burnham Park walk earlier.");
  assert.equal(resultLine([L("Dropped", "Burnham Park walk")], { kind: "remove" }, level), "Removed Burnham Park walk. Undo brings it back.");
  assert.equal(resultLine([L("Bus", "Home: Victory Liner 11:00 AM", null)], { kind: "bus", from: "10:15", to: "11:00" }, level), "Swapped the 10:15 AM bus for the 11:00 AM.");
  assert.equal(resultLine([L("Bus", "x", null)], { kind: "bus", from: null, to: "11:00" }, level), "Swapped the bus for the 11:00 AM.", "the old bus is gone from the schedule");
  assert.equal(resultLine([L("Budget", "Food", null)], { kind: "list", what: "budget" }, level), "Changed the budget.");
  assert.equal(resultLine([L("To-do", "Bring jackets", null)], { kind: "list", what: "todo" }, level), "Changed the to-do list.");
  assert.equal(resultLine([L("Sources", "Map", null)], { kind: "list", what: "sources" }, level), "Changed the sources.");
  assert.equal(resultLine([L("New", "x")], { kind: "chat" }, level), "Applied the chatbot's change.");
});

test("T61-L2 more lines add 'And N more changes.', the server's More counts too, and the first save says the copy was made", () => {
  const lines = [L("New", "Café Yagam"), L("Later", "Check in", 1), L("Later", "Dinner", 1), { word: "More", day: null, text: "and 3 more changes" }];
  assert.equal(resultLine(lines, { kind: "add", after: "d1-03", day: 1 }, level), "Added Café Yagam after Level 1-3. And 5 more changes.");
  assert.equal(resultLine([L("Out", "A"), L("In", "B"), L("Later", "C")], { kind: "replace" }, level), "A is now B. And 1 more change.", "Out and In are one sentence");
  assert.equal(
    resultLine([L("Dropped", "Museum")], { kind: "remove" }, level, { firstCopy: true }),
    "Removed Museum. Undo brings it back. This trip now has its own copy of the plan. The shared plan's link doesn't change.",
  );
});

test("T61-L3 Changes and other phones' lines use the World, never a level number; a chatbot version says so", () => {
  assert.equal(summaryOf(v(3, "hand", [L("New", "Café Yagam")])), "Added Café Yagam (World 1)");
  assert.equal(summaryOf(v(3, "hand", [L("Out", "Museum", 3), L("In", "Park", 3)])), "Museum is now Park (World 3)");
  assert.equal(summaryOf(v(3, "hand", [L("Dropped", "Museum", 3)])), "Removed Museum (World 3)");
  assert.equal(summaryOf(v(3, "hand", [L("Moved", "Museum", 2)])), "Moved Museum (World 2)");
  assert.equal(summaryOf(v(3, "hand", [L("Later", "Burnham Park to 4:00 PM", 3)])), "Moved Burnham Park to 4:00 PM (World 3)");
  assert.equal(summaryOf(v(3, "hand", [L("Changed", "Lunch", 1)])), "Changed Lunch (World 1)");
  assert.equal(summaryOf(v(3, "hand", [L("Bus", "Home: Victory Liner 4:10 PM", null)])), "Swapped a bus: Home: Victory Liner 4:10 PM");
  assert.equal(summaryOf(v(3, "hand", [L("Budget", "Food", null)])), "Changed the budget");
  assert.equal(summaryOf(v(0, "copy", [{ word: "Copied", day: null, text: "the plan" }])), "Copied the plan");
  assert.equal(summaryOf(v(4, "chat", [L("New", "Cafe")])), "Chatbot: Added Cafe (World 1)");
  assert.equal(summaryOf(v(5, "undo", [L("Dropped", "Cafe")])), "Removed Cafe (World 1)", "an undo's lines are the diff it makes");
  assert.equal(historyLine(v(3, "hand", [L("New", "Café Yagam")]), "2026-11-09"), "3:12 PM · Added Café Yagam (World 1)", "today: the Manila time");
  assert.equal(historyLine(v(3, "hand", [L("New", "Café Yagam")]), "2026-11-10"), "Nov 9 · Added Café Yagam (World 1)", "before today: the date");
  assert.equal(justChanged(v(3, "hand", [L("New", "Café Yagam")])), "The plan just changed: Added Café Yagam (World 1).");
});

test("T61-L4 What changes: a bold word, the World, the text; the server's More is a plain line", () => {
  assert.deepEqual(changeRows([L("New", "3:00 PM Café Yagam"), L("Bus", "Home: 4:10 PM", null), { word: "More", day: null, text: "and 3 more changes" }]), [
    { word: "New", text: "World 1, 3:00 PM Café Yagam" },
    { word: "Bus", text: "Home: 4:10 PM" },
    { word: null, text: "and 3 more changes" },
  ]);
});

test("T61-L5 Undo becomes Redo after an undo; it asks first when the change may be another phone's", () => {
  const mine = new Map([[3, Date.parse("2026-11-09T07:12:00Z")]]);
  const edits = (versions: PlanVersion[]) => ({ seq: versions[0].seq, versions });
  assert.equal(undoLabel(null), "Undo");
  assert.equal(undoLabel(edits([v(4, "undo", [L("Dropped", "Cafe")])])), "Redo");
  assert.equal(undoLabel(edits([v(3, "hand", [L("New", "Cafe")])])), "Undo");
  const newest = edits([v(3, "hand", [L("New", "Café Yagam")])]);
  assert.equal(undoConfirm(newest, mine, Date.parse("2026-11-09T07:15:00Z")), null, "this phone's own change, 3 minutes ago");
  assert.equal(undoConfirm(newest, mine, Date.parse("2026-11-09T07:30:00Z")), 'Undo the last change? "Added Café Yagam (World 1)", at 3:12 PM, maybe from another phone.', "over 10 minutes");
  assert.equal(undoConfirm(newest, new Map(), Date.parse("2026-11-09T07:13:00Z")) !== null, true, "another phone's");
});

test("T61-L6 the copy line, from the newest version's time", () => {
  assert.equal(copyLine(true, { seq: 3, versions: [v(3, "hand", [L("New", "x")], "2026-11-05T07:12:00Z")] }), "Your group's own copy of the plan, last changed Nov 5, 3:12 PM.");
  assert.equal(copyLine(false, null), null, "before the first edit, no line");
  assert.equal(copyLine(true, null), "Your group's own copy of the plan.", "the /i/ page has no history");
});

test("T61-L7 how to get there: a route with its Checked line, or an estimate with no fare and its own line", () => {
  assert.deepEqual(legLines({ kind: "route", last_mile_route_id: "lm", mode: "jeep", minutes: 15, fare_min_php: 13, fare_max_php: 15, signboard: "Trancoville", last_verified_at: "2026-10-26T02:00:00Z" }), {
    line: "Jeep, Trancoville signboard, about 15 min · ₱13–15",
    note: "Checked Oct 26 · Fares and routes change. Confirm with the driver or a local before you ride.",
  });
  assert.equal(legLines({ kind: "route", last_mile_route_id: "lm", mode: "taxi", minutes: 8, fare_min_php: 120, fare_max_php: 120, signboard: null, last_verified_at: null }).line, "Taxi, about 8 min · ₱120");
  assert.deepEqual(legLines({ kind: "estimate", mode: "taxi", minutes: 10, km: 1.8 }), {
    line: "Taxi, about 10 min, 1.8 km",
    note: "An estimate from the distance, not a route on file. A jeep may go there: ask a local.",
  });
  assert.equal(legLines({ kind: "estimate", mode: "walk", minutes: 12, km: 0.9 }).line, "Walk, about 12 min, 900 m");
  assert.doesNotMatch(JSON.stringify(legLines({ kind: "estimate", mode: "taxi", minutes: 10, km: 1.8 })), /₱|jeep,/i);
});

test("T61-L8 far, removal and bus lines", () => {
  assert.equal(farLine(243), "This is about 240 km from Baguio. Add it anyway?");
  assert.equal(farLine(26.4), "This is about 26 km from Baguio. Add it anyway?");
  assert.equal(removeConfirm("Burnham Park walk", 1, true, 2), "Remove Burnham Park walk from World 1? Its tick and 2 photos are hidden, not deleted. Undo brings them back.");
  assert.equal(removeConfirm("Museum", 3, false, 1), "Remove Museum from World 3? Its photo is hidden, not deleted. Undo brings it back.");
  assert.equal(removeConfirm("Museum", 3, true, 0), "Remove Museum from World 3? Its tick is hidden, not deleted. Undo brings it back.");
  assert.equal(removeConfirm("Museum", 3, false, 0), "Remove Museum from World 3? Undo brings it back.");
  assert.equal(busWarningLine("retired", "2026-11-06"), "This bus isn't on the schedule any more.");
  assert.equal(busWarningLine("gone", "2026-11-06"), "This bus isn't on the schedule any more.");
  assert.equal(busWarningLine("not_running", "2026-11-06"), "This bus isn't on the schedule for Fri, Nov 6 any more.");
  assert.equal(busNotice(1), "A bus in this plan isn't on the schedule any more.");
  assert.equal(busNotice(2), "2 buses in this plan aren't on the schedule any more.");
});

test("T61-L9 a level's number on the map counts only the rows that show for the picks", async () => {
  const { levelLabel } = await import("./planLines.ts");
  const row = (key: string, extra = {}) => ({ key, time: "09:00", plan: key, note: "", place: null, bus: null, show_if: null, hide_if: null, ...extra });
  const g = { days: [{ day: 2, rows: [row("d2-01", { show_if: { pick: "sunrise", is: "A" } }), row("d2-02", { show_if: { pick: "sunrise", is: "B" } }), row("d2-03")] }] } as never;
  assert.equal(levelLabel(g, [], "d2-03"), "2-3");
  assert.equal(levelLabel(g, [{ key: "pick:sunrise", value: "A", updated_at: "" }], "d2-03"), "2-2");
  assert.equal(levelLabel(g, [], "d9-99"), null);
});
