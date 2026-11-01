// TG-52 PR 3: the guide as the trip's checklist and progress map. Run with `npm test` (node --test, type stripping).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  type Guide, type GuideRow, type Mark, dayProgress, marksByKey, pickMark, placeIcon, rowMark, rowShows, todoMark, whereNow,
} from "./guide.ts";

const WEB = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB), "utf8");

const spot = (id: string, category = "park", lodging = false) => ({ kind: "spot" as const, id, name: id, category, lodging });
const row = (key: string, place: GuideRow["place"] = null, extra: Partial<GuideRow> = {}): GuideRow => ({
  key, time: "09:00", plan: key, note: "", place, bus: null, show_if: null, hide_if: null, ...extra,
});
const mark = (key: string, value = "done", at = "2026-11-06T01:00:00Z"): Mark => ({ key, value, updated_at: at });
const bus = { title: "Out", intro: "", buses: [], tips: [] };
const guide: Guide = {
  title: "T", summary: "", lodging: spot("hotel", "other", true), getting_there: bus, getting_home: bus,
  budget: { summary: "", rows: [], excluded: "" }, todo: [{ key: "todo-03", text: "Ask the host", done: false }], sources: [],
  days: [
    { day: 1, title: "D1", intro: "", pick: null, tips: [], rows: [row("d1-01", { kind: "terminal", id: "t", name: "VL Cubao", category: null, lodging: false }), row("d1-02"), row("d1-03", spot("hotel", "other", true))] },
    { day: 2, title: "D2", intro: "", tips: [], pick: { key: "sunrise", title: "Sunrise", options: [] }, rows: [
      row("d2-01", spot("yangbew", "viewpoint"), { show_if: { pick: "sunrise", is: "A" } }),
      row("d2-02", spot("mines", "viewpoint"), { show_if: { pick: "sunrise", is: "B" } }),
      row("d2-03", spot("farm", "other")),
    ] },
    { day: 3, title: "D3", intro: "", pick: null, tips: [], rows: [row("d3-01", spot("mines", "viewpoint"), { hide_if: { pick: "sunrise", is: "B" } })] },
  ],
};

test("GD1 the checklist keys: a day row, a to-do and a pick", () => {
  assert.equal(rowMark({ key: "d2-05" }), "row:d2-05");
  assert.equal(todoMark({ key: "todo-03" }), "todo:03");
  assert.equal(pickMark("sunrise"), "pick:sunrise");
});

test("GD2 before a pick every option's rows show; after it, only the picked one's, and B hides Sunday's Mines View", () => {
  const none = marksByKey([]);
  assert.deepEqual(guide.days[1].rows.filter((r) => rowShows(r, none)).map((r) => r.key), ["d2-01", "d2-02", "d2-03"]);
  const b = marksByKey([mark("pick:sunrise", "B")]);
  assert.deepEqual(guide.days[1].rows.filter((r) => rowShows(r, b)).map((r) => r.key), ["d2-02", "d2-03"]);
  assert.equal(rowShows(guide.days[2].rows[0], b), false);
  assert.equal(rowShows(guide.days[2].rows[0], marksByKey([mark("pick:sunrise", "A")])), true);
});

test("GD3 the group stands at the latest-ticked row that has a place, whatever order rows were ticked in", () => {
  assert.equal(whereNow(guide, []), null);
  assert.deepEqual(whereNow(guide, [mark("row:d1-01", "done", "2026-11-06T01:30:00Z")]), { day: 1, key: "d1-01" });
  // d1-02 has no place, so the group stays at the terminal
  assert.deepEqual(whereNow(guide, [mark("row:d1-01", "done", "2026-11-06T01:30:00Z"), mark("row:d1-02", "done", "2026-11-06T05:00:00Z")]), { day: 1, key: "d1-01" });
  // ticked out of order: the latest tick wins, not the latest row
  assert.deepEqual(
    whereNow(guide, [mark("row:d2-03", "done", "2026-11-07T01:00:00Z"), mark("row:d1-03", "done", "2026-11-07T02:00:00Z")]),
    { day: 1, key: "d1-03" },
  );
  assert.equal(whereNow(guide, [mark("todo:03"), mark("pick:sunrise", "A")]), null, "to-dos and picks aren't places");
});

test("GD4 icons: the hotel, a terminal, or the spot's kind; a row without a place has none", () => {
  assert.equal(placeIcon(guide.days[0].rows[2].place), "place-lodging");
  assert.equal(placeIcon(guide.days[0].rows[0].place), "place-terminal");
  assert.equal(placeIcon(spot("x", "viewpoint")), "place-viewpoint");
  assert.equal(placeIcon(null), null);
});

test("GD5 a day's progress counts only the rows that show", () => {
  const marks = marksByKey([mark("pick:sunrise", "B"), mark("row:d2-02"), mark("row:d2-01")]);
  assert.deepEqual(dayProgress(guide.days[1], marks), { done: 1, total: 2 });
});

test("GD6 the trip page shows the level map above the rest, live, with photos, and refreshes every 30 seconds", () => {
  const view = read("src/components/TripView.tsx");
  assert.match(view, /<SectionTitle id="progress-title">Trip progress<\/SectionTitle>/);
  assert.ok(view.indexOf('id="progress-title"') < view.indexOf("<PlanSection"), "the map comes first");
  assert.match(view, /<LevelMap\b/);
  assert.match(view, /tripApi\.mark\(slug, key, "done"\)/);
  assert.match(view, /tripApi\.unmark\(slug, key\)/);
  assert.match(view, /tripApi\.addFile\(slug, "photo", photo, rowKey \? \{ row_key: rowKey \} : \{\}\)/, "a photo carries its level");
  assert.match(view, /const photo = await fitPhoto\(file\);/, "shrunk on the phone first");
  assert.match(view, /30_000/);
  const map = read("src/components/LevelMap.tsx");
  assert.match(map, /data-party=""/);
  assert.match(map, /Mark done!/);
  assert.match(map, /Add photos here/);
  assert.doesNotMatch(map, /₱1,?032/, "fares only from the trip rows");
});

test("GD7 the plan's own page shows its level map read-only", () => {
  const list = read("src/components/ItineraryList.tsx");
  assert.match(list, /\{it\.guide && <LevelMap guide=\{it\.guide\} \/>\}/);
});
