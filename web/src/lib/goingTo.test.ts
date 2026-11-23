// TG-71: the Going to city picker on /buses and /plan (ux.md §7.2), behind NEXT_PUBLIC_GOING_TO (default off).
// Pure helpers are tested directly; the components are pinned by source, like the rest of the repo's UI tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_CITY,
  emptyMessage,
  endpoints,
  initialSearchState,
  resultsHeading,
  routeLabel,
  searchReducer,
  swapLabel,
  type Direction,
  type SearchAction,
  type SearchState,
} from "./direction.ts";
import { GOING_TO_CITIES, GOING_TO_LEGEND, START_CITY, planCities, planCity, premadeCity, premadeEmpty, premadeForCity } from "./goingTo.ts";
import { AROUND_CITIES } from "./around.ts";
import { FLAG_DEFAULTS } from "./flags.ts";
import { lengthHint, type PremadeView } from "./planForm.ts";
import type { PremadeSummary } from "./api.ts";

const WEB = new URL("../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, WEB), "utf8");
const BOTH: Direction[] = ["to-baguio", "from-baguio"];

type FakeTrip = { city: string };
type State = SearchState<FakeTrip>;
const reduce = (s: State, ...actions: SearchAction<FakeTrip>[]) => actions.reduce((x, a) => searchReducer(x, a), s);

// ---------------------------------------------------------------- the flag and the cities

test("T71-F1 the flag defaults off, and the picker's cities are the Around cities in order, starting on Baguio", () => {
  assert.equal(FLAG_DEFAULTS.goingTo, false);
  assert.deepEqual(GOING_TO_CITIES, ["Baguio", "Sagada"]);
  assert.deepEqual(GOING_TO_CITIES, AROUND_CITIES.map((c) => c.name), "one list: the Around tab's");
  assert.equal(START_CITY, "Baguio");
  assert.equal(DEFAULT_CITY, "Baguio");
  assert.equal(GOING_TO_LEGEND, "Going to", "ux.md §8 BUSES_PICK");
});

// ---------------------------------------------------------------- /buses: direction.ts with a city

test("T71-D1 with no city every line is today's Baguio one, byte for byte", () => {
  assert.deepEqual(endpoints("to-baguio"), { originCity: "Metro Manila", destinationCity: "Baguio" });
  assert.deepEqual(endpoints("from-baguio"), { originCity: "Baguio", destinationCity: "Metro Manila" });
  for (const d of BOTH) {
    assert.deepEqual(endpoints(d, undefined), endpoints(d));
    assert.equal(routeLabel(d, undefined), routeLabel(d));
    assert.equal(swapLabel(d, undefined), swapLabel(d));
    assert.equal(resultsHeading(d, "2026-11-25", undefined), resultsHeading(d, "2026-11-25"));
    assert.equal(emptyMessage(d, "2026-11-25", undefined), emptyMessage(d, "2026-11-25"));
    assert.deepEqual(endpoints(d, "Baguio"), endpoints(d), "picking Baguio is the same as no pick");
  }
  assert.equal(emptyMessage("to-baguio", "2026-11-06"), "No trips on file from Metro Manila to Baguio on Fri, Nov 6 yet.");
});

test("T71-D2 the route line, swap button, heading and empty line follow the city", () => {
  assert.deepEqual(endpoints("to-baguio", "Sagada"), { originCity: "Metro Manila", destinationCity: "Sagada" });
  assert.deepEqual(endpoints("from-baguio", "Sagada"), { originCity: "Sagada", destinationCity: "Metro Manila" });
  assert.equal(routeLabel("to-baguio", "Sagada"), "Metro Manila → Sagada");
  assert.equal(swapLabel("to-baguio", "Sagada"), "Swap direction, search Sagada to Metro Manila instead");
  assert.equal(swapLabel("from-baguio", "Sagada"), "Swap direction, search Metro Manila to Sagada instead");
  assert.equal(resultsHeading("from-baguio", "2026-11-28", "Sagada"), "Sagada → Metro Manila · Sat, Nov 28");
  // ux.md §7.2: the empty line stays today's, with the city in it (Sagada has only the owner's two dates on file)
  assert.equal(emptyMessage("to-baguio", "2026-11-26", "Sagada"), "No trips on file from Metro Manila to Sagada on Thu, Nov 26 yet.");
  assert.equal(emptyMessage("from-baguio", "2026-11-26", "Sagada"), "No trips on file from Sagada to Metro Manila on Thu, Nov 26 yet.");
});

test("T71-D3 flag off the reducer's state is today's: no city key, and a search's heading has none", () => {
  const s = initialSearchState<FakeTrip>();
  assert.deepEqual(s, { direction: "to-baguio", date: "", status: "idle", trips: [], searched: null, requestId: 0 });
  const started = reduce(s, { type: "swap" }, { type: "pickDate", date: "2026-11-08" }, { type: "searchStarted", date: "2026-11-08" });
  assert.equal("city" in started, false);
  assert.deepEqual(started.searched, { direction: "from-baguio", date: "2026-11-08" });
});

test("T71-D4 choosing a city keeps the date and the direction, and drops shown results and any search in flight", () => {
  const swapped = reduce(initialSearchState<FakeTrip>(), { type: "swap" }, { type: "pickDate", date: "2026-11-28" });
  const loading = searchReducer(swapped, { type: "searchStarted", date: "2026-11-28" });
  const shown = searchReducer(loading, { type: "searchDone", requestId: loading.requestId, trips: [{ city: "Baguio" }] });
  assert.equal(shown.status, "done");
  const picked = searchReducer(shown, { type: "pickCity", city: "Sagada" });
  assert.equal(picked.city, "Sagada");
  assert.equal(picked.direction, "from-baguio", "direction kept");
  assert.equal(picked.date, "2026-11-28", "date kept");
  assert.equal(picked.status, "idle");
  assert.deepEqual(picked.trips, []);
  assert.equal(picked.searched, null, "no heading for the old city");
  assert.equal(picked.requestId, shown.requestId + 1);
  // a reply still in flight for the old city is dropped
  const mid = searchReducer(swapped, { type: "searchStarted", date: "2026-11-28" });
  const moved = searchReducer(mid, { type: "pickCity", city: "Sagada" });
  assert.equal(searchReducer(moved, { type: "searchDone", requestId: mid.requestId, trips: [{ city: "Baguio" }] }), moved);
  assert.equal(searchReducer(moved, { type: "searchFailed", requestId: mid.requestId }), moved);
});

test("T71-D5 picking the shown city changes nothing; a search's heading carries the picked city", () => {
  const s = initialSearchState<FakeTrip>();
  assert.equal(searchReducer(s, { type: "pickCity", city: "Baguio" }), s, "Baguio is where it starts");
  const sagada = searchReducer(s, { type: "pickCity", city: "Sagada" });
  assert.equal(searchReducer(sagada, { type: "pickCity", city: "Sagada" }), sagada);
  const started = searchReducer({ ...sagada, date: "2026-11-25" }, { type: "searchStarted", date: "2026-11-25" });
  assert.deepEqual(started.searched, { direction: "to-baguio", date: "2026-11-25", city: "Sagada" });
  // swapping keeps the city
  assert.equal(searchReducer(sagada, { type: "swap" }).city, "Sagada");
  const back = searchReducer(sagada, { type: "pickCity", city: "Baguio" });
  assert.equal(back.city, "Baguio");
  assert.equal(emptyMessage(back.direction, "2026-11-25", back.city), emptyMessage("to-baguio", "2026-11-25"));
});

// ---------------------------------------------------------------- /plan

const trip = (slug: string, city?: string): PremadeSummary => ({
  share_slug: slug, vibe: "Chill", trip_date: "2026-11-25", return_date: "2026-11-28", budget_php: null,
  day_count: 4, stop_count: 9, spot_names: ["Made-up spot"], ...(city ? { city } : {}),
});

test("T71-P1 the live planner stays Baguio: the picker shows on the ready-made list only", () => {
  assert.deepEqual(planCities("premade"), ["Baguio", "Sagada"]);
  assert.deepEqual(planCities("live"), [], "live: hidden, the AI planner plans Baguio only");
  assert.deepEqual(planCities("none"), []);
  assert.equal(planCity("premade", "Sagada"), "Sagada");
  assert.equal(planCity("premade", "Vigan"), "Baguio", "an unknown city falls back");
  assert.equal(planCity("live", "Sagada"), "Baguio");
  assert.equal(planCity("none", "Sagada"), null, "no form: the hint stays as it is");
});

test("T71-P2 the ready-made trips are filtered by their city, order kept; an older API's trip is Baguio", () => {
  const list = [trip("a", "Sagada"), trip("b", "Baguio"), trip("c"), trip("d", "Sagada")];
  const view: PremadeView = { kind: "list", list };
  assert.deepEqual((premadeForCity(view, "Sagada") as { list: PremadeSummary[] }).list.map((s) => s.share_slug), ["a", "d"]);
  assert.deepEqual((premadeForCity(view, "Baguio") as { list: PremadeSummary[] }).list.map((s) => s.share_slug), ["b", "c"]);
  assert.equal(premadeCity(trip("c")), "Baguio");
  assert.deepEqual(premadeForCity({ kind: "list", list: [trip("b", "Baguio")] }, "Sagada"), { kind: "empty" });
  for (const kind of ["empty", "unavailable", "failed"] as const) assert.deepEqual(premadeForCity({ kind }, "Sagada"), { kind });
  assert.equal(view.list.length, 4, "the loaded list isn't changed");
  assert.equal(premadeEmpty("Sagada"), "No ready-made trips for Sagada on file yet.");
});

test("T71-P3 the length hint says 'N days in <city>' with the flag on; off it's today's rule", () => {
  assert.equal(lengthHint("2026-11-25", "2026-11-28", "Sagada"), "4 days in Sagada");
  assert.equal(lengthHint("2026-11-25", "2026-11-28", "Baguio"), "4 days in Baguio");
  assert.equal(lengthHint("2026-11-25", "2026-11-25", "Sagada"), "Day trip");
  const form = read("src/components/PlanForm.tsx");
  // every new value is null or empty unless the flag is on, so the hint, list and status line are today's
  assert.match(form, /const cities = flags\.goingTo \? planCities\(mode\) : \[\];/);
  assert.match(form, /const city = flags\.goingTo \? planCity\(mode, picked\) : null;/);
  assert.match(form, /const listCity = cities\.length > 0 \? city : null;/);
  assert.match(form, /const premade = listCity && run\.premade \? premadeForCity\(run\.premade, listCity\) : run\.premade;/);
  assert.match(form, /hint=\{lengthHint\(values\.date, values\.returnDate, city \?\? \(flags\.aroundTab \? null : "Baguio"\)\)\}/);
  assert.match(form, /const status = !listCity\s*\? statusText\(run, mode, values\)/);
  assert.match(form, /emptyMessage=\{listCity \? premadeEmpty\(listCity\) : undefined\}/);
  assert.match(read("src/components/PlanResults.tsx"), /<SearchBusesBox message=\{props\.emptyMessage \?\? LIST\.empty\} \/>/);
});

test("T71-P4 the plan picker sits first in the locked fieldset, only with a list city", () => {
  const form = read("src/components/PlanForm.tsx");
  const fieldset = form.indexOf('<fieldset disabled={busy} role="none" className="contents">');
  const picker = form.indexOf("{listCity && (");
  assert.ok(fieldset > 0 && picker > fieldset && picker < form.indexOf("<DatesBox"), "inside the busy fieldset, above the dates");
  assert.match(form.slice(picker), /^\{listCity && \(\s*<PixelBox className="p-4">\s*<GoingToPicker\s+heading\s+name="plan-going-to"\s+cities=\{cities\}\s+city=\{listCity\}\s+onPick=\{setPicked\}/);
  assert.doesNotMatch(form, /console\./, "the plan form stays log-free (T21-S7)");
});

// ---------------------------------------------------------------- /buses source

test("T71-S1 /buses renders the picker only with the flag, first in the form, and passes the city to every line", () => {
  const src = read("src/components/TripSearch.tsx");
  const form = src.indexOf('<PixelBox as="form" onSubmit={onSearch}');
  const picker = src.indexOf("{flags.goingTo && (");
  assert.ok(form > 0 && picker > form && picker < src.indexOf('<div className="grid grid-cols-[1fr_auto_1fr]'), "above the From / To row");
  assert.equal(src.match(/<GoingToPicker\b/g)?.length, 1);
  assert.match(src, /cities=\{GOING_TO_CITIES\}\s+city=\{state\.city \?\? DEFAULT_CITY\}/);
  assert.match(src, /const \{ originCity, destinationCity \} = endpoints\(direction, state\.city\);/);
  assert.match(src, /aria-label=\{swapLabel\(direction, state\.city\)\}/);
  assert.match(src, /\{emptyMessage\(searched\.direction, searched\.date, searched\.city\)\}/);
  assert.match(src, /\{resultsHeading\(searched\.direction, searched\.date, searched\.city\)\}/);
  // the request uses the same endpoints, so it asks the API for the picked city (GET /trips?destination_city=Sagada)
  assert.match(src, /searchTrips\(\{ originCity, destinationCity, date \}\)/);
});

test("T71-L1 a pick is logged with the city only, no user data", () => {
  const src = read("src/components/TripSearch.tsx");
  const logs: string[] = src.match(/console\.\w+\([^)]*\)/g) ?? [];
  assert.ok(logs.includes('console.info("[tg-buses] going-to city=%s", city)'), logs.join("\n"));
  assert.match(src, /console\.info\("\[tg-buses\] going-to city=%s", city\);\s*dispatch\(\{ type: "pickCity", city \}\);/);
});

test("T71-S2 the picker: native radios in a fieldset named by its legend, in a row that wraps", () => {
  const src = read("src/components/GoingToPicker.tsx");
  assert.doesNotMatch(src, /use client/, "no state of its own");
  assert.match(src, /<fieldset className="m-0 min-w-0 border-0 p-0">/);
  assert.equal(src.match(/\{GOING_TO_LEGEND\}/g)?.length, 2, "the legend, in the pixel font on /plan or as a small label on /buses");
  assert.match(src, /<SectionTitle as="legend"/);
  assert.match(src, /<legend className="mb-1 text-sm text-muted">/);
  assert.match(src, /<div className="flex flex-wrap gap-2">/);
  assert.match(src, /<PixelChoice key=\{c\} name=\{name\} value=\{c\} checked=\{c === city\} onChange=\{\(\) => props\.onPick\(c\)\}/);
  assert.doesNotMatch(src, /console\./);
});
