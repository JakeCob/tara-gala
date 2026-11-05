// TG-61 W11: the plan editor's wiring, read from the source in the style of guide.test.ts. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const WEB = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB), "utf8");
const view = () => read("src/components/TripView.tsx");
const TG61 = ["TripView", "LevelMap", "StopChange", "PlaceInput", "BusSwap", "PlanEditBar", "PlanTextEditors", "PlanBits"].map((f) => `src/components/${f}.tsx`);

test("T61-W11a the /i/ page never gets an editor, so a plan can only be changed from its trip", () => {
  for (const file of ["src/components/ItineraryList.tsx", "src/components/ItineraryView.tsx"]) assert.doesNotMatch(read(file), /editor=/, file);
  assert.match(view(), /editor=\{editor\}/);
  assert.match(view(), /const editor: PlanEditor \| undefined = flags\.planEditing && theGuide \?/, "behind NEXT_PUBLIC_PLAN_EDITING, and only for a plan with a guide");
  const list = read("src/components/ItineraryList.tsx");
  assert.match(list, /\{it\.edited \? \(/, "review S5: a copy's page doesn't offer Share");
});

test("T61-W11b every edit control checks for signal: Edit the plan, Change this stop, and each save", () => {
  const v = view();
  assert.match(v, /const online = useSyncExternalStore\(subscribeOnline, \(\) => navigator\.onLine, \(\) => true\);/);
  assert.match(v, /aria-disabled=\{!online \|\| undefined\}/, "Edit the plan");
  assert.match(v, /Editing needs signal\. You can still tick stops\./);
  assert.match(v, /can: canEdit\(shown, trip, online, planWriting\)/);
  assert.match(v, /!canEdit\(s, t, navigator\.onLine, false\)/, "and again when the save goes");
  assert.match(read("src/components/LevelMap.tsx"), /\{change && change\.editor\.online && \(/, "Change this stop is left out offline (ux.md §4.1)");
});

test("T61-W11c the trip page fetches the plan again when another phone's version shows up in the poll", () => {
  const v = view();
  assert.match(v, /const planSeq = load\.state === "ready" \? \(load\.trip\.plan_edits\?\.seq \?\? null\) : null;/);
  assert.match(v, /\}, \[planSlug, planSeq, retry\]\);/);
  assert.match(v, /30_000/);
});

test("T61-W11d a tap while a plan write is out is ignored, not queued; ticks wait only for that write", () => {
  const v = view();
  const write = v.slice(v.indexOf("async function planWrite("), v.indexOf("async function onUndo("));
  assert.match(write, /if \(writingPlan\.current \|\| !s\?\.guide \|\| !t \|\| !canEdit\(s, t, navigator\.onLine, false\)\) \{\s+console\.info\("\[tg-trip\] plan %s ignored", action\);\s+return IGNORED;/);
  assert.ok(write.indexOf("writingPlan.current = true;") < write.indexOf("const r = await req;"));
  assert.match(v, /busy=\{busy \|\| planWriting\}/, "ticks, Mark done! and the to-do boxes wait while a plan write is out");
  for (const file of ["src/components/StopChange.tsx", "src/components/PlaceInput.tsx", "src/components/BusSwap.tsx", "src/components/PlanTextEditors.tsx"]) {
    const src = read(file);
    assert.match(src, /aria-disabled=\{off/, `${file}: waiting controls are aria-disabled, so focus stays`);
    assert.doesNotMatch(src, /(?<![-\w])disabled=\{/, `${file}: never disabled mid-interaction (guide §10)`);
  }
});

test("T61-W11e a save's answer sets the plan, its version and the trip together (review M1, R1)", () => {
  const v = view();
  const write = v.slice(v.indexOf("async function planWrite("), v.indexOf("async function onUndo("));
  assert.match(write, /const next = shownFrom\(saved\.itinerary\);/);
  assert.match(write, /sessionSlug\.current = saved\.itinerary\.share_slug;/);
  assert.match(write, /afterPlanSaved\(prev\.trip, saved, source, /);
  assert.match(write, /setShown\(\(prev\) => \(acceptPlan\(prev, next, saved\.itinerary\.share_slug\) \? next : prev\)\);/);
});

test("T61-W11f logs: the action, codes, versions and counts, never a name, note, place, link, pin or text", () => {
  for (const file of TG61) {
    const logs = [...read(file).matchAll(/console\.(?:info|warn|error)\(([^;]*)\);/g)].map((m) => m[1]);
    for (const args of logs) {
      assert.match(args, /^"\[tg-trip\] /, `${file}: ${args}`);
      const values = args.slice(args.indexOf('"', 1) + 1);
      assert.doesNotMatch(values, /\b(name|names|text|note|plan|typed|link|maps_url|lat|lng|label|item|query|changes|place\.\w+)\b/, `${file}: ${args}`);
    }
  }
});

test("T61-W11g the edit bar stays in view, and every result has a live status line that exists before it changes", () => {
  const bar = read("src/components/PlanEditBar.tsx");
  assert.match(bar, /className="sticky top-0 z-20 /);
  assert.match(bar, /<p role="status" aria-live="polite"/);
  assert.match(bar, /aria-expanded=\{open\}/, "Changes is a disclosure");
  assert.match(view(), /<p role="status" aria-live="polite" className="text-sm empty:sr-only">\{otherLine\}<\/p>/, "the plan just changed line");
  assert.match(read("src/components/StopChange.tsx"), /<p role="status" aria-live="polite"/, "the Move step keeps its own line (ux.md §3.3)");
});

test("T61-W11h the copy line, the delete sentence and the trip place's chip use ux.md's words", () => {
  assert.match(view(), /its own copy of the plan and the places your group added, and its shared tickets and QRs from the server, not from phones that already saved the trip\. The shared plan and the wallet keep their own links\./);
  const map = read("src/components/LevelMap.tsx");
  assert.match(map, /Added by your group, not verified/);
  assert.match(map, /Directions in Google Maps/);
  // ux's own chip says "not verified", and the done badge is the sprite ui-badge-verified: both are allowed
  const words = TG61.map(read).join("\n").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "").replaceAll("not verified", "").replaceAll("ui-badge-verified", "");
  assert.doesNotMatch(words, /\bverified\b|\bconfirmed\b|checked in|\bquest\b|\bXP\b/, "never verified, confirmed or checked in (ux.md §11)");
});
