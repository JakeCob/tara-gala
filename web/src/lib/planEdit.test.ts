// TG-61: the hand editor's pure helpers. Each change is a whole stored guide, worked out from the plan on screen, and
// the server mints every key. Run with `npm test` (node --test, type stripping).
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Guide, GuideRow } from "./guide.ts";
import {
  type GuideIn, type RowIn, type Suggestion, addRow, applySuggestion, editBudget, editPickOption, editSources, editTodo, legIn, moveRow, nudgeRow,
  removeRow, replacePlace, setRow, swapBus, toStored,
} from "./planEdit.ts";
import { planFailureMessage, tripApi } from "./trip.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/tg61-owner-guide.json", import.meta.url), "utf8")) as { out: Guide; stored: GuideIn };
const spot = (id: string) => ({ spot_id: id });
const row = (key: string | null, extra: Partial<RowIn> = {}): RowIn => ({ key, time: "09:00", plan: key ?? "new", note: "", ...extra });
const table = (n: number, booked = -1) => ({
  title: "Out", intro: "", tips: [],
  buses: Array.from({ length: n }, (_, i) => ({ trip_id: `trip-${i}`, date: "2026-11-06", note: "", booked: i === booked })),
});
const base = (): GuideIn => ({
  title: "T", summary: "", getting_there: table(2, 1), getting_home: table(1), budget: { summary: "", rows: [{ item: "Food", estimate: "1,500" }], excluded: "" },
  todo: [{ key: "todo-01", text: "Book", done: false }], sources: [{ label: "Site", url: "https://example.com" }],
  days: [
    { day: 1, title: "D1", intro: "", tips: [], rows: [row("d1-01"), row("d1-02", { bus: "outbound", time: "10:15" }), row("d1-03", { place: spot("s3"), time: "14:15" }), row("d1-04", { time: "16:30" })] },
    { day: 2, title: "D2", intro: "", tips: [], pick: { key: "sunrise", title: "Sunrise", options: [{ id: "A", label: "Mines", leave: "04:30", what: "" }, { id: "B", label: "Yangbew", leave: "04:00", what: "" }] },
      rows: [row("d2-01", { show_if: { pick: "sunrise", is: "A" } }), row("d2-02", { show_if: { pick: "sunrise", is: "B" } }), row("d2-03", { time: "11:00" })] },
  ],
});
const keys = (g: GuideIn, day: number) => g.days.find((d) => d.day === day)!.rows.map((r) => r.key);
const rowOf = (g: GuideIn, key: string) => g.days.flatMap((d) => d.rows).find((r) => r.key === key)!;

test("T61-W1 toStored gives back the stored guide from the API's own read of the owner's plan, deep-equal", () => {
  assert.deepEqual(toStored(fixture.out), fixture.stored);
});

test("T61-W1b toStored drops what the read adds: names, the bus trip and its warning, a trip place's pin, a leg's route details", () => {
  const out = structuredClone(fixture.out);
  const r = out.days[0].rows[2] as GuideRow;
  r.place = { kind: "trip_place", id: "tp-1", name: "Cafe", category: null, lodging: false, lat: 16.41, lng: 120.59, maps_url: "https://maps.app.goo.gl/x" };
  r.leg = { kind: "route", last_mile_route_id: "lm-1", mode: "jeep", minutes: 15, fare_min_php: 13, fare_max_php: 15, signboard: "Trancoville", last_verified_at: "2026-10-26T00:00:00Z" };
  (out.days[0].rows[3] as GuideRow).leg = { kind: "estimate", mode: "taxi", minutes: 10, km: 1.8 };
  out.getting_there.buses[0] = { ...out.getting_there.buses[0], warning: "retired", trip: { trip_id: "x" } as never };
  const stored = toStored(out);
  assert.deepEqual(stored.days[0].rows[2].place, { trip_place_id: "tp-1" });
  assert.deepEqual(stored.days[0].rows[2].leg, { last_mile_route_id: "lm-1" });
  assert.deepEqual(stored.days[0].rows[3].leg, { estimate: { mode: "taxi", minutes: 10, km: 1.8 } });
  assert.deepEqual(Object.keys(stored.getting_there.buses[0]).sort(), ["booked", "date", "note", "trip_id"]);
  assert.equal(JSON.stringify(stored).includes("maps.app.goo.gl"), false, "the pin and link come back from the server's own row");
});

test("T61-W2 a new row has key null, goes right after its row, and copies that row's condition; at the end of a day it copies none", () => {
  const g = base();
  const added = addRow(g, { after: "d2-01" }, { time: "06:00", plan: "Breakfast", note: "", place: spot("s9") });
  assert.deepEqual(keys(added, 2), ["d2-01", null, "d2-02", "d2-03"]);
  const fresh = added.days[1].rows[1];
  assert.equal(fresh.key, null);
  assert.deepEqual(fresh.show_if, { pick: "sunrise", is: "A" });
  assert.equal(fresh.hide_if, undefined);
  const last = addRow(g, { end_of_day: 2 }, { time: "12:00", plan: "Lunch", note: "" });
  assert.deepEqual(keys(last, 2), ["d2-01", "d2-02", "d2-03", null]);
  assert.equal(last.days[1].rows[3].show_if, undefined);
  assert.deepEqual(keys(g, 2), ["d2-01", "d2-02", "d2-03"], "the guide on screen is never changed in place");
});

test("T61-W3 a move keeps the key: to another day, and one step earlier or later past the rows that show", () => {
  const g = base();
  const moved = moveRow(g, "d1-04", 2, "d2-03")!;
  assert.deepEqual(keys(moved, 1), ["d1-01", "d1-02", "d1-03"]);
  assert.deepEqual(keys(moved, 2), ["d2-01", "d2-02", "d2-03", "d1-04"]);
  assert.deepEqual(keys(moveRow(g, "d1-04", 2, null)!, 2), ["d1-04", "d2-01", "d2-02", "d2-03"], "null: first of the day");
  assert.equal(moveRow(g, "d1-02", 2, null), null, "a bus row stays on its day");
  assert.deepEqual(keys(nudgeRow(g, "d1-03", -1)!, 1), ["d1-01", "d1-03", "d1-02", "d1-04"]);
  assert.deepEqual(keys(nudgeRow(g, "d1-03", 1)!, 1), ["d1-01", "d1-02", "d1-04", "d1-03"]);
  assert.equal(nudgeRow(g, "d1-01", -1), null, "nothing before the first");
  assert.equal(nudgeRow(g, "d1-04", 1), null, "nothing after the last");
  // With A picked, d2-02 is hidden, so "later" from d2-01 goes past it to d2-03
  const showsA = (r: RowIn) => r.show_if?.is !== "B";
  assert.deepEqual(keys(nudgeRow(g, "d2-01", 1, showsA)!, 2), ["d2-02", "d2-03", "d2-01"]);
});

test("T61-W4 replacing a stop's place keeps its key, time and condition; the leg comes or goes with the new place", () => {
  const g = base();
  const r = rowOf(replacePlace(g, "d1-03", { place: { trip_place_id: "tp-2" }, plan: "Cafe", leg: { estimate: { mode: "walk", minutes: 10, km: 0.6 } } }), "d1-03");
  assert.deepEqual(r, { key: "d1-03", time: "14:15", plan: "Cafe", note: "", place: { trip_place_id: "tp-2" }, leg: { estimate: { mode: "walk", minutes: 10, km: 0.6 } } });
  const again = replacePlace({ ...g, days: [{ ...g.days[0], rows: [{ ...g.days[0].rows[2], leg: { last_mile_route_id: "lm" } }] }, g.days[1]] }, "d1-03", { place: null, plan: "Note only" });
  assert.equal(rowOf(again, "d1-03").leg, undefined, "no leg for a stop with no pin");
  assert.equal(rowOf(again, "d1-03").place, undefined);
});

test("T61-W5 setRow changes only the time, plan and note it's given", () => {
  const r = rowOf(setRow(base(), "d1-03", { time: "15:00", note: "Bring cash" }), "d1-03");
  assert.deepEqual(r, { key: "d1-03", time: "15:00", plan: "d1-03", note: "Bring cash", place: spot("s3") });
});

test("T61-W6 removing a stop leaves its key out; a bus row can't be removed", () => {
  const g = base();
  assert.deepEqual(keys(removeRow(g, "d2-02")!, 2), ["d2-01", "d2-03"]);
  assert.equal(removeRow(g, "d1-02"), null);
  assert.equal(removeRow(g, "d9-99"), null);
});

const sug = (over: Partial<Suggestion> = {}): Suggestion => ({
  name: "Cafe", lat: 16.4, lng: 120.6, maps_url: null, km_from_baguio: 2, far: false, time: "15:00",
  leg: { kind: "estimate", mode: "taxi", minutes: 10, km: 1.8 }, ripple: [{ key: "d1-04", time: "17:15" }], notes: [], changes: [], ...over,
});

test("T61-W7 applySuggestion applies only the parts picked: the time, the leg, and the ripple only when it's chosen", () => {
  const g = base();
  const place = spot("s9");
  const after = applySuggestion(g, { after: "d1-03" }, sug(), { place, plan: "Cafe", time: "15:00", ripple: true });
  assert.deepEqual(keys(after, 1), ["d1-01", "d1-02", "d1-03", null, "d1-04"]);
  assert.deepEqual(after.days[0].rows[3], { key: null, time: "15:00", plan: "Cafe", note: "", place, leg: { estimate: { mode: "taxi", minutes: 10, km: 1.8 } } });
  assert.equal(rowOf(after, "d1-04").time, "17:15", "the ripple, chosen");
  const left = applySuggestion(g, { after: "d1-03" }, sug(), { place, plan: "Cafe", time: "15:30", ripple: false });
  assert.equal(rowOf(left, "d1-04").time, "16:30", "the ripple, left out");
  assert.equal(left.days[0].rows[3].time, "15:30", "the time the user changed");
  const drop = applySuggestion(g, { after: "d1-03" }, sug({ ripple: [{ key: "d1-04", drop: true }] }), { place, plan: "Cafe", time: "15:00", ripple: true });
  assert.deepEqual(keys(drop, 1), ["d1-01", "d1-02", "d1-03", null]);
  const replaced = applySuggestion(g, { replace: "d1-03" }, sug({ leg: null, ripple: [] }), { place, plan: "Cafe", time: "15:00", ripple: true });
  assert.deepEqual(rowOf(replaced, "d1-03"), { key: "d1-03", time: "14:15", plan: "Cafe", note: "", place }, "a replace keeps the slot");
  const first = applySuggestion(g, { first_of_day: 2 }, sug({ ripple: [] }), { place, plan: "Cafe", time: "05:00", ripple: false });
  assert.equal(first.days[1].rows[0].key, null);
  const moved = applySuggestion(g, { move: "d1-04", day: 2 }, sug({ ripple: [] }), { place: null, plan: "d1-04", time: "13:00", ripple: false });
  assert.deepEqual(keys(moved, 2), ["d2-01", "d2-02", "d2-03", "d1-04"]);
  assert.equal(rowOf(moved, "d1-04").time, "13:00", "a move to another day takes the suggested time at its end");
  assert.deepEqual(legIn({ kind: "route", last_mile_route_id: "lm-1", mode: "jeep", minutes: 15, fare_min_php: 13, fare_max_php: 15, signboard: "x", last_verified_at: null }), { last_mile_route_id: "lm-1" });
});

test("T61-W8 the list editors: a bus swap changes only its trip, new to-dos and choices have no key, a removed choice clears its rows' condition", () => {
  const g = base();
  const swapped = swapBus(g, "getting_there", 1, "trip-new");
  assert.deepEqual(swapped.getting_there.buses[1], { trip_id: "trip-new", date: "2026-11-06", note: "", booked: true });
  assert.deepEqual(swapped.getting_there.buses[0], g.getting_there.buses[0]);
  assert.deepEqual(editTodo(g, { add: "Bring jackets" }).todo.at(-1), { key: null, text: "Bring jackets", done: false });
  assert.deepEqual(editTodo(g, { set: "todo-01", text: "Book both buses" }).todo, [{ key: "todo-01", text: "Book both buses", done: false }]);
  assert.deepEqual(editTodo(g, { remove: "todo-01" }).todo, []);
  assert.deepEqual(editBudget(g, { add: { item: "Taxi", estimate: "300" } }).budget.rows.at(-1), { item: "Taxi", estimate: "300" });
  assert.deepEqual(editBudget(g, { set: 0, row: { item: "Food", estimate: "1,500 to 2,200" } }).budget.rows, [{ item: "Food", estimate: "1,500 to 2,200" }]);
  assert.deepEqual(editBudget(g, { remove: 0 }).budget.rows, []);
  assert.equal(editBudget(g, { summary: "Per person" }).budget.summary, "Per person");
  assert.equal(editBudget(g, { excluded: "Not the bus" }).budget.excluded, "Not the bus");
  assert.deepEqual(editSources(g, { add: { label: "Map", url: null } }).sources.at(-1), { label: "Map" });
  assert.deepEqual(editSources(g, { set: 0, source: { label: "Site", url: "https://example.org" } }).sources, [{ label: "Site", url: "https://example.org" }]);
  assert.deepEqual(editSources(g, { remove: 0 }).sources, []);
  const added = editPickOption(g, 2, { add: { label: "Kennon", leave: "05:00", what: "" } });
  assert.deepEqual(added.days[1].pick!.options.at(-1), { id: null, label: "Kennon", leave: "05:00", what: "" });
  const set = editPickOption(g, 2, { set: "A", option: { label: "Mines View", leave: "04:45", what: "Coffee there" } });
  assert.deepEqual(set.days[1].pick!.options[0], { id: "A", label: "Mines View", leave: "04:45", what: "Coffee there" });
  const gone = editPickOption(g, 2, { remove: "B" });
  assert.deepEqual(gone.days[1].pick!.options.map((o) => o.id), ["A"]);
  assert.equal(rowOf(gone, "d2-02").show_if, undefined, "its stop now shows whatever the group picks");
  assert.deepEqual(rowOf(gone, "d2-01").show_if, { pick: "sunrise", is: "A" });
});

// ---------------------------------------------------------------- the plan calls (trip.ts)

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
function answer(status: number, body: unknown) {
  const sent: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return sent;
}
const TRIP = "fedcba9876543210fedcba9876543210";

test("T61-W9 a 409 plan_changed comes back as why clash with the newer plan's slug and seq; other codes keep their detail", async () => {
  answer(409, { detail: "plan_changed", itinerary_slug: "c0ffee", seq: 5 });
  assert.deepEqual(await tripApi.savePlan(TRIP, { itinerary_slug: "c0ffee", seq: 4 }, base(), "hand"), { ok: false, why: "clash", detail: "plan_changed", clash: { itinerary_slug: "c0ffee", seq: 5 } });
  answer(409, { detail: "nothing_to_undo" });
  assert.deepEqual(await tripApi.undoPlan(TRIP, { itinerary_slug: "c0ffee", seq: 0 }), { ok: false, why: "rejected", detail: "nothing_to_undo" });
  answer(422, { detail: "unknown_key", problems: 1 });
  const r = await tripApi.savePlan(TRIP, { itinerary_slug: "c0ffee", seq: 4 }, base(), "hand");
  assert.deepEqual(r, { ok: false, why: "rejected", detail: "unknown_key" });
  assert.equal(planFailureMessage(r as never), "That stop isn't in the plan any more. Check the map, then try again.");
  assert.match(planFailureMessage({ why: "clash" }), /^Someone just changed the plan/);
  assert.equal(planFailureMessage({ why: "rejected", detail: "too_big" }), "That change is too big to save. Try a smaller one.", "not the picture's message");
});

test("T61-W9b the plan calls: their paths, bodies and answers", async () => {
  const saved = { itinerary: { share_slug: "c0ffee", seq: 5, guide: null }, changes: [{ word: "New", day: 1, text: "Cafe" }] };
  let sent = answer(200, saved);
  assert.deepEqual(await tripApi.savePlan(TRIP, { itinerary_slug: "c0ffee", seq: 4 }, base(), "hand"), { ok: true, body: saved });
  assert.equal(sent[0].url.endsWith(`/sessions/${TRIP}/plan`), true);
  assert.equal(sent[0].init.method, "PUT");
  assert.deepEqual(JSON.parse(String(sent[0].init.body)), { base: { itinerary_slug: "c0ffee", seq: 4 }, guide: base(), source: "hand" });
  sent = answer(200, saved);
  await tripApi.undoPlan(TRIP, { itinerary_slug: "c0ffee", seq: 5 });
  assert.equal(sent[0].url.endsWith("/plan/undo"), true);
  assert.deepEqual(JSON.parse(String(sent[0].init.body)), { base: { itinerary_slug: "c0ffee", seq: 5 } });
  sent = answer(200, sug());
  await tripApi.suggest(TRIP, { base: { itinerary_slug: "c0ffee", seq: 5 }, at: { after: "d1-03" }, place: { link: "https://maps.app.goo.gl/x" } });
  assert.equal(sent[0].url.endsWith("/plan/suggest"), true);
  sent = answer(201, { id: "tp-1", name: "Cafe", lat: 16.4, lng: 120.6, maps_url: "https://maps.app.goo.gl/x", created_at: "2026-11-09T00:00:00Z" });
  const place = await tripApi.addPlace(TRIP, { link: "https://maps.app.goo.gl/x", name: "Cafe" });
  assert.equal(place.ok && place.body.id, "tp-1");
  assert.deepEqual(JSON.parse(String(sent[0].init.body)), { link: "https://maps.app.goo.gl/x", name: "Cafe" }, "never a pin from the phone");
  globalThis.fetch = (async () => {
    throw new TypeError("offline");
  }) as typeof fetch;
  assert.deepEqual(await tripApi.savePlan(TRIP, { itinerary_slug: "c0ffee", seq: 4 }, base(), "hand"), { ok: false, why: "offline" });
});
