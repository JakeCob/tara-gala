// TG-61 review S8: the server sends each change as a ChangeLine {word, day, text}; the phone writes the sentences, with
// its own level numbers only for its own change (ux.md §3.1). Run with `npm test` (node --test, type stripping).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type ChangeLine, type PlanVersion, type Said, barSaid, busNotice, busWarningLine, changeRows, copyLine, farLine, historyRow, justChanged, legLines, lineParts,
  linePlain, removeConfirm, saidPlain, undoConfirm, undoLabel,
} from "./planLines.ts";

const L = (word: string, text: string, day: number | null = 1): ChangeLine => ({ word, day, text });
const v = (seq: number, source: PlanVersion["source"], changes: ChangeLine[], created_at = "2026-11-09T07:12:00Z"): PlanVersion => ({ seq, source, changes, created_at });

// F13 FINAL (tg-ux, ux.md §3.1): the server's text is never put inside a sentence. One display everywhere: the bold word,
// " · World N" when there's a day, then " · <text>" as sent.
const plain = (s: Said | string) => saidPlain(s);

test("T61-L1 one display for a change line: the word, its World, the server's text verbatim; More plain, Copied as a phrase", () => {
  assert.deepEqual(lineParts(L("New", "Café Yagam at 3:00 PM")), { word: "New", rest: " · World 1 · Café Yagam at 3:00 PM" });
  assert.deepEqual(lineParts(L("Bus", "Home: Victory Liner 4:10 PM", null)), { word: "Bus", rest: " · Home: Victory Liner 4:10 PM" }, "no day, no World");
  assert.deepEqual(lineParts({ word: "More", day: null, text: "and 3 more changes" }), { word: null, rest: "and 3 more changes" });
  assert.deepEqual(lineParts({ word: "Copied", day: null, text: "the plan" }), { word: null, rest: "Copied the plan" });
  assert.equal(linePlain(L("Later", "Burnham Park to 4:00 PM", 3)), "Later · World 3 · Burnham Park to 4:00 PM", "the time is never stripped");
  assert.deepEqual(changeRows([L("New", "Cafe at 3:00 PM"), { word: "More", day: null, text: "and 3 more changes" }]), [
    { word: "New", rest: " · World 1 · Cafe at 3:00 PM" }, { word: null, rest: "and 3 more changes" },
  ], "proposals use the same display");
});

test("T61-L2 the bar: a lead for what happened, then the first line; more lines are counted, a removal says Undo brings it back", () => {
  assert.equal(plain(barSaid([L("New", "Café Yagam at 3:00 PM")], "save")), "Saved: New · World 1 · Café Yagam at 3:00 PM.");
  assert.equal(plain(barSaid([L("Dropped", "Museum", 3)], "save")), "Saved: Dropped · World 3 · Museum. Undo brings it back.");
  assert.equal(plain(barSaid([L("Dropped", "Cafe")], "undo")), "Undid: Dropped · World 1 · Cafe. Undo brings it back.");
  assert.equal(plain(barSaid([L("New", "Cafe at 3:00 PM")], "redo")), "Put back: New · World 1 · Cafe at 3:00 PM.");
  assert.equal(plain(barSaid([L("New", "Cafe at 3:00 PM")], "chat")), "Applied the chatbot's change: New · World 1 · Cafe at 3:00 PM.");
  assert.equal(plain(barSaid([L("New", "Cafe"), L("Later", "Lunch to 1:00 PM")], "save")), "Saved: New · World 1 · Cafe. And 1 more change.");
  const lines = [L("New", "Café Yagam"), L("Later", "Check in", 1), L("Later", "Dinner", 1), { word: "More", day: null, text: "and 5 more changes" }];
  assert.equal(plain(barSaid(lines, "save")), "Saved: New · World 1 · Café Yagam. And 7 more changes.", "the lines after the first, plus More's number");
  assert.equal(
    plain(barSaid([L("Dropped", "Museum")], "save", { firstCopy: true })),
    "Saved: Dropped · World 1 · Museum. Undo brings it back. This trip now has its own copy of the plan. The shared plan's link doesn't change.",
  );
  const said = barSaid([L("New", "Cafe")], "save");
  assert.deepEqual(said, { lead: "Saved: ", line: L("New", "Cafe"), tail: "." }, "structured, so the word can be bold");
  assert.equal(plain("Saving..."), "Saving...", "a plain status stays as it is");
});

test("T61-L3 Changes, the plan just changed line and their times: no level numbers, the same display", () => {
  assert.deepEqual(historyRow(v(3, "hand", [L("New", "Café Yagam at 3:00 PM")]), "2026-11-09"), { at: "3:12 PM", lead: "", line: L("New", "Café Yagam at 3:00 PM") });
  assert.equal(historyRow(v(3, "hand", [L("New", "x")]), "2026-11-10").at, "Nov 9", "before today: the date");
  assert.equal(historyRow(v(4, "chat", [L("New", "Cafe")]), "2026-11-09").lead, "Chatbot: ");
  assert.deepEqual(historyRow(v(0, "copy", [{ word: "Copied", day: null, text: "the plan" }]), "2026-11-09").line, { word: "Copied", day: null, text: "the plan" });
  assert.equal(plain(justChanged(v(3, "hand", [L("New", "Café Yagam at 3:00 PM")]))), "The plan just changed: New · World 1 · Café Yagam at 3:00 PM.");
});

test("T61-L5 Undo becomes Redo after an undo; it asks first when the change may be another phone's, with the line as shown", () => {
  const mine = new Map([[3, Date.parse("2026-11-09T07:12:00Z")]]);
  const edits = (versions: PlanVersion[]) => ({ seq: versions[0].seq, versions });
  assert.equal(undoLabel(null), "Undo");
  assert.equal(undoLabel(edits([v(4, "undo", [L("Dropped", "Cafe")])])), "Redo");
  assert.equal(undoLabel(edits([v(3, "hand", [L("New", "Cafe")])])), "Undo");
  const newest = edits([v(3, "hand", [L("New", "Café Yagam at 3:00 PM")])]);
  assert.equal(undoConfirm(newest, mine, Date.parse("2026-11-09T07:15:00Z")), null, "this phone's own change, 3 minutes ago");
  assert.equal(undoConfirm(newest, mine, Date.parse("2026-11-09T07:30:00Z")), "Undo the last change? New · World 1 · Café Yagam at 3:00 PM. It was saved at 3:12 PM, maybe from another phone.");
  assert.equal(undoConfirm(newest, new Map(), Date.parse("2026-11-09T07:13:00Z")) !== null, true, "another phone's");
});

test("T61-L6 the copy line, from the newest version's time", () => {
  assert.equal(copyLine(true, { seq: 3, versions: [v(3, "hand", [L("New", "x")], "2026-11-05T07:12:00Z")] }), "Your group's own copy of the plan, last changed Nov 5, 3:12 PM.");
  assert.equal(copyLine(false, null), null, "before the first edit, no line");
  assert.equal(copyLine(true, null), "Your group's own copy of the plan.", "no time known yet: the short line");
  assert.equal(copyLine(true, null, "2026-11-05T07:12:00Z"), "Your group's own copy of the plan, last changed Nov 5, 3:12 PM.", "W-7: the /i/ page reads the plan's own changed_at");
  assert.equal(copyLine(true, { seq: 3, versions: [v(3, "hand", [L("New", "x")], "2026-11-06T01:00:00Z")] }, "2026-11-05T07:12:00Z"), "Your group's own copy of the plan, last changed Nov 6, 9:00 AM.", "the trip page's newest version wins");
  assert.equal(copyLine(false, null, "2026-11-05T07:12:00Z"), null, "a shared plan has no such line");
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

test("T61-L11 after a fit's Apply the line names the World, since the map may show another day; a route with no minutes leaves them out", () => {
  assert.equal(saidPlain(barSaid([L("New", "Ghibli Store at 2:00 PM", 2)], "save")), "Saved: New · World 2 · Ghibli Store at 2:00 PM.", "F13 FINAL: the line names the World");
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

// ---------------------------------------------------------------- tg-build7's e2e findings on a38d093 (W-1 to W-9)

test("T61-L13 (e2e W-5) the remove confirm counts a single photo: 'tick and 1 photo'", () => {
  assert.equal(removeConfirm("Museum", 3, true, 1), "Remove Museum from World 3? Its tick and 1 photo are hidden, not deleted. Undo brings them back.");
  assert.equal(removeConfirm("Museum", 3, false, 1), "Remove Museum from World 3? Its 1 photo is hidden, not deleted. Undo brings it back.");
  assert.equal(removeConfirm("Museum", 3, true, 2), "Remove Museum from World 3? Its tick and 2 photos are hidden, not deleted. Undo brings them back.");
});

test("T61-L14 (e2e W-6) a redo is saved as an undo too: an odd run of undos reads Redo, an even run reads Undo", () => {
  const e = (...sources: PlanVersion["source"][]) => ({ seq: 9, versions: sources.map((source, i) => v(9 - i, source, [L("New", "x")])) });
  assert.equal(undoLabel(e("undo", "hand")), "Redo", "after an undo");
  assert.equal(undoLabel(e("undo", "undo", "hand")), "Undo", "after a redo: the next tap undoes the change again");
  assert.equal(undoLabel(e("undo", "undo", "undo", "hand")), "Redo");
  assert.equal(undoLabel(e("hand", "undo", "hand")), "Undo");
});

test("T61-L15 (e2e W-1) another phone's version is announced, the first copy included, but not the plan the page opens with", async () => {
  const { newerPlan } = await import("./planLines.ts");
  assert.equal(newerPlan(undefined, { slug: "c", seq: 3 }), false, "the first plan on screen is no news");
  assert.equal(newerPlan({ slug: "shared", seq: null }, { slug: "c", seq: 1 }), true, "the first copy, from another phone");
  assert.equal(newerPlan({ slug: "c", seq: 3 }, { slug: "c", seq: 4 }), true);
  assert.equal(newerPlan({ slug: "c", seq: 4 }, { slug: "c", seq: 4 }), false);
  assert.equal(newerPlan({ slug: "c", seq: 4 }, { slug: "shared", seq: null }), false, "a plan with no version is never news");
});

test("T61-L16 (e2e W-8) the swap names the towns, as ux §7 does: Cubao, not Victory Liner Cubao", async () => {
  const { town } = await import("./planLines.ts");
  assert.equal(town("Victory Liner Cubao", "Victory Liner"), "Cubao");
  assert.equal(town("Victory Liner Baguio", "Victory Liner"), "Baguio");
  assert.equal(town("Genesis Pasay", "Genesis/Joy Bus"), "Genesis Pasay", "no prefix to drop: the name as it is");
});

test("T61-L17 (e2e W-9) after a swap the booked bus row says to check its note, until that row changes again", async () => {
  const { busChangedLine } = await import("./planLines.ts");
  const at = (seq: number, changes: ChangeLine[], created_at: string) => v(seq, "hand", changes, created_at);
  const swap = at(4, [{ word: "Bus", day: null, text: "Home: Victory Liner 11:00 AM" }], "2026-11-05T07:12:00Z");
  assert.equal(busChangedLine({ seq: 4, versions: [swap] }, "Bus leaves"), "The bus changed on Nov 5. Check this note.");
  const edited = at(5, [{ word: "Changed", day: 1, text: "Bus leaves" }], "2026-11-05T08:00:00Z");
  assert.equal(busChangedLine({ seq: 5, versions: [edited, swap] }, "Bus leaves"), null, "the row was changed after the swap");
  assert.equal(busChangedLine({ seq: 5, versions: [at(5, [L("New", "Cafe")], "2026-11-05T08:00:00Z"), swap] }, "Bus leaves"), "The bus changed on Nov 5. Check this note.", "another row's change doesn't count");
  assert.equal(busChangedLine(null, "Bus leaves"), null);
});
