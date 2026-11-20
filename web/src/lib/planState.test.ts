// TG-61 review M1 and M2: the plan on screen, its version and the next base always come from one answer, and no older
// answer replaces a newer plan. Run with `npm test` (node --test, type stripping).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Guide } from "./guide.ts";
import { type Shown, acceptPlan, acceptSaved, afterPlanSaved, baseOf, canEdit, inStep, keepNewerPlan, shownFrom } from "./planState.ts";
import type { PlanSaved, Trip } from "./trip.ts";

const WEB = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB), "utf8");
const SHARED = "baguio-barkada";
const COPY = "0123456789abcdef0123456789abcdef";
const g = (title: string) => ({ title }) as Guide;
const plan = (slug: string, seq: number | null, title = `${slug}@${seq}`): Shown => ({ slug, seq, guide: g(title), edited: seq !== null });
const trip = (itinerary_slug: string | null, seq: number | null): Trip => ({
  share_slug: "fedcba9876543210fedcba9876543210", name: "T", start_date: "2026-11-06", return_date: "2026-11-08", created_at: "", itinerary_slug,
  wallet: null, hotel: null, files: [], marks: [],
  plan_edits: seq === null ? null : { seq, versions: [{ seq, source: "hand", changes: [{ word: "New", day: 1, text: "Cafe" }], created_at: "2026-11-09T07:12:00Z" }] },
});

test("T61-W12a shown is built from one answer: its guide, slug and version go together, and so does the next base", () => {
  const it = { share_slug: COPY, seq: 5, guide: g("five"), edited: true };
  const shown = shownFrom(it);
  assert.deepEqual(shown, { slug: COPY, seq: 5, guide: it.guide, edited: true });
  assert.deepEqual(baseOf(shown), { itinerary_slug: COPY, seq: 5 });
  assert.deepEqual(baseOf(shownFrom({ share_slug: SHARED, guide: g("shared") })), { itinerary_slug: SHARED, seq: 0 }, "a shared plan has no seq: its base is 0 (R2)");
  // TripView sets the guide only through shownFrom, and the base only through baseOf(shown)
  const view = read("src/components/TripView.tsx");
  assert.doesNotMatch(view, /itinerary_slug: /, "no base is put together from parts");
  const write = view.slice(view.indexOf("async function planWrite("), view.indexOf("async function onUndo("));
  assert.match(write, /const s = shownRef\.current;/);
  assert.match(write, /const base = baseOf\(s\);/, "the base and the guide come from one object");
  assert.match(write, /run\(base, toStored\(s\.guide\)\)/);
  assert.equal(view.match(/baseOf\(/g)?.length, 3, "the save, the suggestion and the chat's question (TG-61 PR 2): nowhere else");
  assert.match(view, /setShown\(\(prev\) => \(acceptPlan\(prev, next, /);
  assert.equal(view.match(/setShown\(/g)?.length, 3, "the saved copy, the live GET and the save: each through the guard");
  assert.doesNotMatch(view, /setShown\(\(prev\) => (?!\(accept(Plan|Saved)\(prev, next, )/);
});

test("T61-W12b an older answer for the same plan is refused: a slow GET, or the service worker's saved copy", () => {
  const five = plan(COPY, 5);
  assert.equal(acceptPlan(five, plan(COPY, 4), COPY), false, "the GET for 4 lands after 5 is shown");
  assert.equal(acceptPlan(five, plan(COPY, 5, "same version"), COPY), true, "the same version again is fine");
  assert.equal(acceptPlan(five, plan(COPY, 6), COPY), true);
  assert.equal(acceptPlan(five, { ...plan(COPY, 5), seq: null }, COPY), false, "an answer with no version never replaces one with a version");
  assert.equal(acceptPlan(null, plan(COPY, 4), COPY), true, "an empty screen takes any version of the current plan");
  assert.equal(acceptPlan(plan(SHARED, null), plan(SHARED, null, "reloaded tonight"), SHARED), true, "a shared plan may change under its slug, as today");
});

test("T61-W12c a plan for a slug that isn't the trip's current plan is refused", () => {
  assert.equal(acceptPlan(plan(COPY, 5), plan(SHARED, null), COPY), false, "the shared plan's late answer after the copy was made");
  assert.equal(acceptPlan(null, plan(SHARED, null), COPY), false);
  assert.equal(acceptPlan(plan(SHARED, null), plan(COPY, 1), null), false, "the trip has no plan any more");
});

test("T61-W12d R1: the first save from the shared plan is taken at once, with no session refetch", () => {
  const before = trip(SHARED, null);
  const saved: PlanSaved = { itinerary: { share_slug: COPY, seq: 1, guide: g("first edit"), edited: true } as never, changes: [{ word: "New", day: 1, text: "Cafe" }] };
  const after = afterPlanSaved(before, saved, "hand", "2026-11-09T07:12:00Z");
  assert.equal(after.itinerary_slug, COPY);
  assert.deepEqual(after.plan_edits, { seq: 1, versions: [{ seq: 1, source: "hand", changes: saved.changes, created_at: "2026-11-09T07:12:00Z" }] });
  assert.equal(acceptPlan(plan(SHARED, null), shownFrom(saved.itinerary), after.itinerary_slug), true);
  assert.equal(inStep(shownFrom(saved.itinerary), after), true, "editing comes back on as soon as the save answers");
  assert.equal(before.itinerary_slug, SHARED, "the trip on screen isn't changed in place");
  // A later save keeps the newest five versions, newest first
  let t = after;
  for (let seq = 2; seq <= 7; seq++) t = afterPlanSaved(t, { itinerary: { share_slug: COPY, seq } as never, changes: saved.changes }, "hand", "2026-11-09T07:13:00Z");
  assert.deepEqual(t.plan_edits!.versions.map((v) => v.seq), [7, 6, 5, 4, 3]);
});

test("T61-W12e canEdit: off while a write is out, offline, while another phone's newer version isn't on screen yet, and without a guide", () => {
  const five = plan(COPY, 5);
  assert.equal(canEdit(five, trip(COPY, 5), true, false), true);
  assert.equal(canEdit(five, trip(COPY, 5), true, true), false, "a write is out");
  assert.equal(canEdit(five, trip(COPY, 5), false, false), false, "offline");
  assert.equal(canEdit(five, trip(COPY, 6), true, false), false, "another phone saved 6: wait for it");
  assert.equal(canEdit(plan(SHARED, null), trip(COPY, 1), true, false), false, "the copy exists but the shared plan is on screen");
  assert.equal(canEdit(plan(SHARED, null), trip(SHARED, null), true, false), true, "no copy yet (R2: null with null)");
  assert.equal(canEdit(plan(SHARED, 0), trip(SHARED, null), true, false), false, "R2: never compare null with 0");
  assert.equal(canEdit({ ...five, guide: null }, trip(COPY, 5), true, false), false);
  assert.equal(canEdit(null, trip(COPY, 5), true, false), false);
});

test("T61-W12f TG-57 still holds: the worker's saved copy only fills a gap, or brings a newer version of the copy", () => {
  assert.equal(acceptSaved(null, plan(COPY, 4), COPY), true, "nothing on screen yet");
  assert.equal(acceptSaved(plan(SHARED, null, "live"), plan(SHARED, null, "saved"), SHARED), false, "the live answer landed first: keep it");
  assert.equal(acceptSaved(plan(COPY, 5), plan(COPY, 5), COPY), false);
  assert.equal(acceptSaved(plan(COPY, 4), plan(COPY, 5), COPY), true, "a newer version, as other phones' ticks arrive on slow signal");
  assert.equal(acceptSaved(plan(COPY, 5), plan(COPY, 4), COPY), false);
  assert.equal(acceptSaved(plan(SHARED, null), plan(COPY, 3), COPY), true, "the trip moved to its copy");
  assert.equal(acceptSaved(null, plan(SHARED, null), COPY), false, "never another plan's copy");
});

test("T61-W12g review M1: a session write's answer never puts back an older plan than the one on screen", () => {
  const ticked = (t: Trip): Trip => ({ ...t, marks: [{ key: "d1-01", value: "done", updated_at: "" }] });
  // A tick that committed before the plan save, landing after it
  const kept = keepNewerPlan(trip(COPY, 6), ticked(trip(COPY, 5)));
  assert.equal(kept.plan_edits?.seq, 6, "an older version of the copy is kept out");
  assert.equal(kept.marks.length, 1, "the rest of the answer is taken");
  const first = keepNewerPlan(trip(COPY, 1), ticked(trip(SHARED, null)));
  assert.equal(first.itinerary_slug, COPY, "on a trip's first edit, the shared plan from before the copy is kept out");
  assert.equal(first.plan_edits?.seq, 1);
  assert.equal(first.marks.length, 1);
  assert.equal(keepNewerPlan(trip(COPY, 5), trip(COPY, 6)).plan_edits?.seq, 6, "a newer version, from another phone, is taken");
  assert.equal(keepNewerPlan(trip(SHARED, null), trip(COPY, 1)).itinerary_slug, COPY, "another phone made the copy: taken");
  assert.equal(keepNewerPlan(trip(COPY, 5), trip(COPY, 5)).plan_edits?.seq, 5);
});

test("T61-W12h review M1: a plan write is refused while a session write is out, and attach or detach waits for a plan write", () => {
  const view = read("src/components/TripView.tsx");
  const top = view.slice(view.indexOf("async function planWrite("), view.indexOf("const base = baseOf(s)"));
  assert.match(top, /canEdit\(s, t, navigator\.onLine, busyRef\.current \|\|/, "canEdit's writing, at the top of planWrite, counts a session write that's out");
  assert.match(view, /const editable = canEdit\(shown, trip, online, [^;]*\bbusy\b/, "editable counts it too");
  const apply = view.slice(view.indexOf("async function apply("), view.indexOf("async function planWrite("));
  assert.match(apply, /busyRef\.current = true/);
  assert.match(apply, /keepNewerPlan\(/, "the answer goes through keepNewerPlan");
  // G4: the branch itself, so a revert that skips keepNewerPlan (leaving the call as dead code) fails here
  assert.match(apply, /const moves = action === "itinerary-attach" \|\| action === "itinerary-detach";/, "only attach and detach skip it");
  assert.match(apply, /if \(moves \|\| prev\.state !== "ready"\) return \{ state: "ready", trip: r\.trip \};\s+const next = keepNewerPlan\(prev\.trip, r\.trip\);/);
  assert.match(apply, /return \{ state: "ready", trip: next \};/, "the trip on screen is keepNewerPlan's");
  assert.match(view, /<PlanSection trip=\{trip\} busy=\{busy \|\| planWriting\}/, "attach and detach move the plan: they wait for a plan write");
});

// ---- TG-67 S4: the plan's city rides with the plan on screen (plan §3 S4; test-plan T67-W3)
test("T67-W3 shownFrom keeps the answer's city; a missing one reads as Baguio", async () => {
  const { cityOf } = await import(new URL("./itinerary.ts", import.meta.url).href) as typeof import("./itinerary.ts");
  const sagada = shownFrom({ share_slug: COPY, seq: 2, guide: g("sagada"), edited: true, city: "Sagada" } as Parameters<typeof shownFrom>[0]);
  assert.equal(sagada.city, "Sagada");
  assert.equal(cityOf(sagada), "Sagada");
  const old = shownFrom({ share_slug: SHARED, guide: g("shared") });
  assert.equal(cityOf(old), "Baguio", "an answer with no city (an older saved copy, or before S2) is Baguio");
  assert.equal(cityOf(shownFrom({ share_slug: SHARED, guide: g("shared"), city: "" } as Parameters<typeof shownFrom>[0])), "Baguio");
});
