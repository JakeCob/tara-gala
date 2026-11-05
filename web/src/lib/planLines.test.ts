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
  assert.equal(resultLine([L("New", "Café Yagam at 2:30 PM")], { kind: "add", after: "d1-03", day: 1 }, level), "Added Café Yagam at 2:30 PM, after Level 1-3.", "F13: the text as sent, time included, then a comma");
  assert.equal(resultLine([L("New", "Café Yagam")], { kind: "add", after: null, day: 2 }, level), "Added Café Yagam at the start of World 2.");
  assert.equal(resultLine([L("Out", "Burnham Park walk"), L("In", "Wright Park and The Mansion")], { kind: "replace" }, level), "Burnham Park walk is now Wright Park and The Mansion.");
  assert.equal(resultLine([L("Later", "Burnham Park to 4:00 PM")], { kind: "edit", key: "d1-05" }, level), "Moved Burnham Park to 4:00 PM.", "F13: a time change says where it went");
  assert.equal(resultLine([L("Earlier", "Lunch to 12:00 PM")], { kind: "edit", key: "d1-05" }, level), "Moved Lunch to 12:00 PM.");
  assert.equal(resultLine([L("Changed", "Lunch")], { kind: "edit", key: "d1-05" }, level), "Changed Level 1-5.", "a note or plan text change");
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
  assert.equal(resultLine(lines, { kind: "add", after: "d1-03", day: 1 }, level), "Added Café Yagam, after Level 1-3. And 5 more changes.");
  assert.equal(resultLine([L("Out", "A"), L("In", "B"), L("Later", "C")], { kind: "replace" }, level), "A is now B. And 1 more change.", "Out and In are one sentence");
  assert.equal(
    resultLine([L("Dropped", "Museum")], { kind: "remove" }, level, { firstCopy: true }),
    "Removed Museum. Undo brings it back. This trip now has its own copy of the plan. The shared plan's link doesn't change.",
  );
});

test("T61-L3 Changes and other phones' lines use the World, never a level number; a chatbot version says so", () => {
  assert.equal(summaryOf(v(3, "hand", [L("New", "Café Yagam")])), "Added Café Yagam (World 1)");
  assert.equal(summaryOf(v(3, "hand", [L("New", "Cafe X at 2:30 PM")])), "Added Cafe X at 2:30 PM (World 1)", "F13: never strip the time");
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

test("T61-L10 where it fits: each card's five lines, from the server's fit (ux.md §4.8)", async () => {
  const { fitLines, fitFooter, duration, NO_FIT } = await import("./planLines.ts");
  const rows: Record<string, { plan: string; time: string; place: string | null }> = {
    "d2-04": { plan: "BenCab Museum", time: "13:00", place: "BenCab Museum" },
    "d1-04": { plan: "Check in at the condo", time: "14:30", place: "Finteo Skylands" },
    "d1-05": { plan: "Walk", time: "16:00", place: null },
    "d1-06": { plan: "Groceries and breakfast stuff", time: "18:00", place: null },
  };
  const row = (k: string) => rows[k] ?? null;
  const best = {
    day: 2, after: "d2-04", time: "14:00", leg: { kind: "estimate" as const, mode: "taxi" as const, minutes: 8, km: 2.1 }, ripple: [], notes: [], changes: [],
    condition: null, reason: { kind: "near_stops" as const, near_key: "d2-04", near_km: 0.4, free_min: 90, dropped: 0 },
  };
  assert.deepEqual(fitLines(best, row), {
    when: "World 2 · 2:00 PM to 3:00 PM", slot: "After BenCab Museum", travel: "Taxi, about 8 min, 2.1 km (estimate)", moves: "Nothing else moves.",
    why: "Near BenCab Museum (400 m). 1 h 30 min free there.", chip: null,
  });
  const second = { ...best, day: 1, after: "d1-04", time: "16:30", leg: { kind: "estimate" as const, mode: "walk" as const, minutes: 12, km: 0.9 },
    ripple: [{ key: "d1-05", time: "17:00" }, { key: "d1-06", time: "19:00" }], condition: { pick: "sunrise", is: "A", kind: "show_if" as const },
    reason: { kind: "near_hotel" as const, near_key: "d1-04", near_km: 2.14, free_min: 0, dropped: 0 } };
  const two = fitLines(second, row);
  assert.equal(two.moves, "Moves 2 later stops 1 h later.");
  assert.equal(two.why, "Near your hotel (2.1 km).", "near_hotel names the hotel; no free time, so that part is left out");
  assert.equal(fitLines({ ...best, reason: { ...best.reason, free_min: 0 } }, row).why, "Near BenCab Museum (400 m).");
  assert.equal(two.chip, "Only if the group picks A");
  assert.equal(fitLines({ ...second, ripple: [{ key: "d1-06", drop: true }] }, row).moves, "Drops Groceries and breakfast stuff.");
  assert.equal(fitLines({ ...second, condition: { pick: "sunrise", is: "B", kind: "hide_if" } }, row).chip, "Not if the group picks B");
  const route = fitLines({ ...best, leg: { kind: "route", last_mile_route_id: "lm", mode: "jeep", minutes: 15, fare_min_php: 13, fare_max_php: 15, signboard: "Trancoville", last_verified_at: "2026-10-26T02:00:00Z" } }, row);
  assert.equal(route.travel, "Jeep, Trancoville signboard, about 15 min · ₱13–15 · Checked Oct 26");
  const nopin = fitLines({ ...best, leg: null, reason: { kind: "free_time", near_key: null, near_km: null, free_min: 45, dropped: 0 } }, row);
  assert.equal(nopin.travel, "No travel estimate: one of the places has no pin.");
  assert.equal(nopin.why, "45 min free there.");
  assert.equal(fitLines({ ...best, leg: null, reason: { kind: "free_time", near_key: null, near_km: null, free_min: -20, dropped: 1 } }, row).why, "The day runs 20 min over.");
  assert.equal(fitLines({ ...best, leg: null, reason: { kind: "free_time", near_key: "d2-04", near_km: 0.4, free_min: 0, dropped: 0 } }, row).why, null, "free_time has no Near part, and 0 adds nothing");
  assert.deepEqual([duration(45), duration(60), duration(90), duration(125)], ["45 min", "1 h", "1 h 30 min", "2 h 5 min"]);
  assert.deepEqual(fitFooter([best, second], true), ["Ranked by how close it is to the stops around it, and by free time that day.", "Estimates come from the distance, not routes on file."]);
  assert.deepEqual(fitFooter([{ ...best, leg: null }], false), ["Ranked by free time only: this place has no pin."]);
  assert.equal(NO_FIT, "No free slot for it on this plan. Choose the day yourself, and the later stops can move to make room.");
});

test("T61-L11 after a fit's Apply the bar names the World, since the map may show another day; a route with no minutes leaves them out", () => {
  assert.equal(resultLine([L("New", "Ghibli Store at 2:00 PM", 2)], { kind: "add", after: "d1-03", day: 2, world: true }, level), "Added Ghibli Store at 2:00 PM on World 2, after Level 1-3.", "F13");
  assert.equal(legLines({ kind: "route", last_mile_route_id: "lm", mode: "jeep", minutes: null, fare_min_php: 13, fare_max_php: 15, signboard: "Trancoville", last_verified_at: null }).line, "Jeep, Trancoville signboard · ₱13–15");
});

test("T61-L12 where a link's pin came from (round 5): the link, the address (check it), or pasted by the group", async () => {
  const { pinLine } = await import("./planLines.ts");
  assert.deepEqual(pinLine({ pin_source: "address", lat: 16.4138, lng: 120.5964, km_from_baguio: 2 }), {
    lead: "Pin from the address, ", link: "check it on Google Maps", href: "https://www.google.com/maps/search/?api=1&query=16.4138,120.5964", rest: "",
  });
  assert.deepEqual(pinLine({ pin_source: "typed", lat: 16.4, lng: 120.6, km_from_baguio: 2 }), { lead: "Pin you pasted, about 2 km from Baguio.", link: null, href: null, rest: "" });
  assert.deepEqual(pinLine({ pin_source: "link", lat: 16.4, lng: 120.6, km_from_baguio: 3 }), { lead: "Pinned from your link, about 3 km from Baguio.", link: null, href: null, rest: "" });
  assert.equal(pinLine({ pin_source: null, lat: null, lng: null, km_from_baguio: null }), null, "a spot or trip place: nothing to say");
});
