// TG-61 W11: the plan editor's wiring, read from the source in the style of guide.test.ts. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs"; // TG-67 W14

const WEB = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB), "utf8");
const view = () => read("src/components/TripView.tsx");
const TG61 = ["TripView", "LevelMap", "StopChange", "PlaceInput", "BusSwap", "PlanEditBar", "PlanTextEditors", "PlanBits", "FitPlace"].map((f) => `src/components/${f}.tsx`);

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
  assert.match(v, /const waiting = !!lost \|\| behind\(shown, clashAt, trip\.itinerary_slug\);/, "a lost answer, or a 409's newer plan not on screen yet");
  assert.match(v, /const editable = canEdit\(shown, trip, online, planWriting \|\| busy \|\| waiting\);/);
  assert.match(v, /can: editable,/);
  assert.match(v, /!canEdit\(s, t, navigator\.onLine, busyRef\.current \|\| !!lostRef\.current \|\| behind\(s, clashAtRef\.current, t\?\.itinerary_slug\)\)/, "and again when the save goes");
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
  assert.match(write, /if \(writingPlan\.current \|\| !s\?\.guide \|\| !t \|\| !canEdit\(s, t, navigator\.onLine, busyRef\.current \|\| !!lostRef\.current \|\| behind\(s, clashAtRef\.current, t\?\.itinerary_slug\)\)\) \{\s+console\.info\("\[tg-trip\] plan %s ignored", action\);\s+return IGNORED;/);
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
      assert.doesNotMatch(values, /\b(name|names|text|note|plan|typed|link|maps_url|lat|lng|label|item|query|changes|detail|place\.\w+)\b/, `${file}: ${args}`);
    }
  }
});

test("T61-W11g the edit bar stays in view, and every result has a live status line that exists before it changes", () => {
  const bar = read("src/components/PlanEditBar.tsx");
  assert.match(bar, /className="sticky top-0 z-20 /);
  assert.match(bar, /<p role="status" aria-live="polite"/);
  assert.match(bar, /aria-expanded=\{open\}/, "Changes is a disclosure");
  assert.match(view(), /<p role="status" aria-live="polite" className="text-sm empty:sr-only"><SaidText said=\{otherLine\} \/><\/p>/, "the plan just changed line");
  // F13 FINAL: one display for a change line, the word in bold; the server's text is never put inside a sentence
  assert.match(bar, /<SaidText said=\{barLine\(status, edits\)\} \/>/);
  assert.match(bar, /<LineText line=\{r\.line\} \/>/, "Changes uses it too");
  assert.match(read("src/components/PlanBits.tsx"), /\{p\.word && <span className="font-bold">\{p\.word\}<\/span>\}/);
  assert.doesNotMatch(view(), /resultLine|levelLabel\(g/, "no level numbers in the bar");
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

test("T61-W11i a PixelButton given a className keeps its padding: className replaces the variant's layout", () => {
  for (const file of TG61) {
    for (const m of read(file).matchAll(/<PixelButton\b[^>]*?\sclassName="([^"]*)"/g)) {
      assert.match(m[1], /\bp[xy]?-\d/, `${file}: ${m[0].slice(0, 90)}`);
    }
  }
});

test("T61-W11j Add a place (ux.md §4.8): on the bar and beside Edit the plan, with the offline rule; one Apply, on the proposal", () => {
  const v = view();
  const entry = v.slice(v.indexOf("entry: (addPlace) =>"), v.indexOf("top: (addPlace) =>"));
  assert.match(entry, /Edit the plan[\s\S]*Add a place/, "beside Edit the plan, outside edit mode");
  assert.equal(entry.match(/aria-disabled=\{!online \|\| undefined\}/g)?.length, 2, "both need signal");
  const bar = read("src/components/PlanEditBar.tsx").slice(read("src/components/PlanEditBar.tsx").indexOf("return ("));
  assert.ok(bar.indexOf("Editing the plan") < bar.indexOf("Done editing") && bar.indexOf("Done editing") < bar.indexOf("Add a place"), "the top line, then Add a place first on the second row");
  assert.ok(bar.indexOf("Add a place") < bar.indexOf("{undoLabel(edits)}"));
  assert.match(bar, /aria-disabled=\{!online \|\| undefined\} onClick=\{\(\) => \{\s+console\.info\("\[tg-trip\] plan add-place bar open=%s", online \? "yes" : "offline"\);\s+if \(online\) onAddPlace\(\);/, "it saves nothing, so only signal holds it");
  const map = read("src/components/LevelMap.tsx");
  assert.match(map, /start="fit"/);
  assert.match(map, /if \(!editor\.editing\) editor\.startEditing\(\);/, "applied from outside edit mode, the page switches into it");
  const fit = read("src/components/FitPlace.tsx");
  assert.doesNotMatch(fit.replace(/^\s*(\/\/|\*).*$/gm, ""), /Apply/, "a card is a preview: Apply is only on the proposal");
  assert.doesNotMatch(fit, /At the start of the day/, "no fit starts a day, and neither does the manual choice");
  const change = read("src/components/StopChange.tsx");
  assert.match(change, /\{step\.mode === "fit" \? "Find where it fits again" : "Check my change again"\}/);
  assert.match(change, /editor\.suggest\(\{ anywhere: true \}, place\)/, "a clash asks where it fits again (B60)");
  assert.match(change, /\{ k: "fit", chosen: step\.fitFrom \?\? step\.chosen, fit: step\.fit! \}/, "the proposal's Back returns to every choice, not only the one picked");
});

test("T61-W11k round 5: need_pin is the next step, not an error; the pin goes up as typed with the link, on every call about it", () => {
  const place = read("src/components/PlaceInput.tsx");
  assert.match(place, /if \(!r\.ok && r\.detail === "need_pin"\) \{[\s\S]{0,120}setNeedPin\(typed\);\s+setName\(prefillName\(r\.name\)\)/, "the link's name fills in Name");
  assert.match(place, /inputMode="decimal"/);
  assert.match(place, /editor\.suggest\(at, \{ link, pin \}\)/);
  assert.match(place, /const pin = pinText; \/\/ as typed/, "never trimmed or cut: the server parses it");
  assert.match(place, /editor\.addPlace\(chosen\.link, plan\.slice\(0, MAX_NAME\), chosen\.pin\)/, "Apply sends the same pin");
  assert.match(place, /Wrong spot\? Paste the pin instead\./);
  assert.doesNotMatch(place + read("src/lib/trip.ts"), /link_no_pin/, "retired in round 5");
  for (const file of ["src/components/StopChange.tsx", "src/components/FitPlace.tsx"]) assert.match(read(file), /linkPlace\(chosen\)/, `${file}: a recheck keeps the pin`);
  assert.match(view(), /addPlace: \(link, name, pin\) => tripApi\.addPlace\(slug, pin \? \{ link, name, pin \} : \{ link, name \}\)/);
});

test("T61-W11l tg-build7's e2e findings: W-2 the search waits for the spots, W-3 Changes opens, W-4 a lost answer is recovered", () => {
  const place = read("src/components/PlaceInput.tsx");
  assert.match(place, /const found: Found\[\] = searched === null \? \[\] : findPlaces\(searched, editor\.spots \?\? \[\], editor\.places\);/, "W-2: worked out on every render");
  assert.match(place, /spotsLoading \? \(\s+<p role="status" className="text-sm">Finding places on Tara Gala\.\.\.<\/p>/, "W-2: never 'No place called' while loading");
  const v = view();
  assert.match(v, /setChangesOpen\(true\); \/\/ e2e W-3/);
  assert.match(v, /const lostAnswer = r\.why === "offline" && navigator\.onLine;/, "W-4: online, an unanswered save may have landed");
  assert.match(v, /canEdit\(s, t, navigator\.onLine, busyRef\.current \|\| !!lostRef\.current \|\| behind\(s, clashAtRef\.current, t\?\.itinerary_slug\)\)/, "W-4: editing waits for the server's word");
  assert.match(v, /clashAtRef\.current = r\.clash \?\? null;/, "a 409 names the newer plan, and editing waits for it");
  assert.match(v, /const stale = \(!!shown && !synced && planMiss === trip\.itinerary_slug\) \|\| !!lost\?\.failed;/);
  assert.match(v, /newerPlan\(before, now\)/, "W-1: the first copy from another phone is news too");
});

test("T61-W11m tg-build7's W-10 and W-11: the dialog outlives its removed stop; nothing is live before the newer plan is on screen", () => {
  const map = read("src/components/LevelMap.tsx");
  assert.match(map, /const found = open && list\.find\(\(l\) => l\.row\.key === open\.key\);/);
  assert.match(map, /if \(found && kept\?\.row !== found\.row\) setKept\(found\);/, "the open stop is kept as it was last seen");
  assert.match(map, /const current = found \|\| \(open && kept\?\.row\.key === open\.key \? kept : undefined\);/, "W-10: removed by another phone, its dialog stays to say so");
  const v = view();
  assert.match(v, /useLayoutEffect\(\(\) => \{\s+shownRef\.current = shown;/, "W-11: the plan a tap reads is the one painted");
  assert.match(v, /if \(!r\.clash\) \{[\s\S]{0,200}lostRef\.current = \{ at: Date\.now\(\), failed: false \};/, "a 409 that names no plan waits for the session's word");
});

test("T61-W11n W-7 and F10: the copy's /i/ page reads changed_at, and every Name prefill goes through prefillName", () => {
  assert.match(read("src/components/ItineraryList.tsx"), /copyLine\(true, null, it\.changed_at\)/);
  const place = read("src/components/PlaceInput.tsx");
  assert.equal(place.match(/setName\(prefillName\(/g)?.length, 2, "a found link, and need_pin");
  assert.doesNotMatch(place, /setName\(\(r\./, "no name is cut to fit");
});

// ---------------------------------------------------------------- tg-ux's PR review (ux-review.md, 2026-11-08)

test("T61-W11o (UX Must 1) Swap's cards: the window first, Show all after, and no Book or Get to the terminal", () => {
  const swap = read("src/components/BusSwap.tsx");
  assert.match(swap, /swapWindow\(/, "the list is windowed around the old bus");
  assert.match(swap, /showAllLabel\(/);
  assert.match(swap, /<TripCard [^>]*\bplain\b/, "the cards are drawn plain");
  const card = read("src/components/TripCard.tsx");
  assert.match(card, /\{!plain && <TerminalLinks/, "plain leaves out Get to the terminal");
  assert.match(card, /!plain && \(t\.booking_url/, "and Book");
});

test("T61-W11p (UX Must 2) after Undo the bar shows the version it took back; after Redo, the redo's own lines", () => {
  assert.match(view(), /how === "undo" && done\.kind === "undo" && done\.undone \? done\.undone\.changes : saved\.changes/);
});

test("T61-W11q (UX should 1) Find turns secondary once a place is found, and Red again when the field changes", () => {
  const input = read("src/components/PlaceInput.tsx");
  assert.match(input, /<PixelButton type="submit" variant=\{findFirst \? "primary" : "secondary"\}/);
});

test("T61-W11r (UX should 2) a clash on Save, Move, Remove or a swap's Apply says what to do next", () => {
  const stop = read("src/components/StopChange.tsx");
  assert.match(stop, /saveProblem\(out, "Save"\)/, "Change time and note");
  assert.match(stop, /saveProblem\(out, "Remove this stop"\)/);
  assert.match(stop, /saveProblem\(out, `Move \$\{word\}`\)/);
  assert.match(read("src/components/BusSwap.tsx"), /saveProblem\(out, "Apply"\)/);
});

test("T61-W11s (UX should 3) the bar's status line says why Undo is greyed", () => {
  assert.match(read("src/components/PlanEditBar.tsx"), /<SaidText said=\{barLine\(status, edits\)\} \/>/);
});

// ---- TG-67 S4: the plan's city on the trip page, read from the source (test-plan T67-W9 to W12)
const comp = (name: string) => read(`src/components/${name}.tsx`);

test("T67-W9 TripView: spots filtered by the plan's city at render, chat hidden off Baguio, the city on the editor and the map", () => {
  const v = view();
  assert.match(v, /const city = cityOf\(shown \?\? \{\}\);/, "the city comes from the plan on screen, Baguio by default");
  assert.match(v, /const spots = useMemo\(\(\) => \(rawSpots \? rawSpots\.filter\(\(s\) => s\.city === city\) : null\), \[rawSpots, city\]\);/,
    "filtered at render, so a plan moving to another city refilters");
  const want = v.slice(v.indexOf("const wantSpots = useCallback("), v.indexOf("}, []);", v.indexOf("const wantSpots = useCallback(")));
  assert.match(want, /if \(list\) setRawSpots\(list\);/, "the raw list is kept as it came");
  assert.doesNotMatch(want, /\.filter\(/, "never filtered in the setter (M-W1)");
  assert.match(v, /const chatTools: ChatTools \| null = flags\.planEditing && flags\.chatbotLive && city === "Baguio" \? \{/, "the chat stays Baguio's (M-W2)");
  const ed = v.slice(v.indexOf("const editor: PlanEditor | undefined ="), v.indexOf("chat: chatTools,"));
  assert.match(ed, /\n    city,\n/, "the editor carries the city");
  assert.match(v, /<LevelMap\n\s+guide=\{theGuide\}\n\s+city=\{city\}/, "the map gets it");
  assert.match(read("src/components/PlanEditor.ts"), /\n  city: string;\n/);
});

test("T67-W10 BusSwap searches and names the plan's city, and refetches when it changes", () => {
  const src = comp("BusSwap");
  assert.match(src, /const city = editor\.city;/);
  assert.match(src, /searchTrips\(\{ originCity: up \? "Metro Manila" : city, destinationCity: up \? city : "Metro Manila", date \}\)/);
  assert.match(src, /\}, \[date, up, oldTime, city\]\);/, "M-W3: the effect deps include the city");
  assert.match(src, /swapHeader\([^)]*, city\)/);
  assert.doesNotMatch(src, /"Baguio"/, "no hard-coded Baguio left");
});

test("T67-W11 PlaceInput: no hard-coded Baguio distance; pinLine and farLine get the city", () => {
  const src = comp("PlaceInput");
  assert.doesNotMatch(src, /km from Baguio/);
  assert.equal(src.match(/pinLine\(s, editor\.city\)/g)?.length, 2, "the find step and the proposal");
  assert.match(src, /farLine\(s\.km_from_baguio \?\? 0, editor\.city\)/);
});

test("T67-W12 the three [tg-trip] lines with the city, the hidden-chat line once, and nothing personal in them", () => {
  const v = view();
  const spots = /console\.info\("\[tg-trip\] plan spots ok=%s count=%d city=%s", list \? "yes" : "no", list\?\.length \?\? 0, cityRef\.current\);/;
  assert.match(v, spots);
  const hidden = /console\.info\("\[tg-trip\] plan chat hidden city=%s", city\);/;
  assert.match(v, hidden);
  const once = v.slice(v.indexOf("chatHiddenLogged"), v.indexOf("plan chat hidden city"));
  assert.match(once, /if \(chatHiddenLogged\.current[^)]*\) return;/, "logged once, not on every render");
  assert.match(once, /chatHiddenLogged\.current = true;/);
  const swap = /console\.info\("\[tg-trip\] plan swap list trips=%d near=%s city=%s", trips\.length, oldTime \? swapWindow\(oldTime, trips\)\.near\.length : "none", city\);/;
  assert.match(comp("BusSwap"), swap);
  for (const line of [...v.matchAll(/console\.info\("\[tg-trip\] plan (spots|chat hidden)[^\n]*/g), ...comp("BusSwap").matchAll(/console\.info\("\[tg-trip\] plan swap list trips[^\n]*/g)]) {
    assert.doesNotMatch(line[0], /name|note|link|lat|lng|pin\b|\.plan\b/, `no name, note, link or pin: ${line[0]}`);
  }
});

test("T67-W14 the plan's city is read only through cityOf: no component reads shown.city (RED audit should)", () => {
  for (const f of readdirSync(new URL("src/components/", WEB)).filter((n) => /\.tsx?$/.test(n))) {
    assert.doesNotMatch(read(`src/components/${f}`), /shown\??\.city/, `${f}: an optional city reads undefined on a Baguio plan; use cityOf`);
  }
});
