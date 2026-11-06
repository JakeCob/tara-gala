// TG-52 trip sessions on the web: links, dates, hotel times, what this phone remembers, and offline.
// Run with `npm test` (node --test, type stripping).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  datesLine, deleteLine, forgetTrip, hotelMapsUrl, hotelTime, knownTrips, parseKnownTrips, rememberTrip, slugFromLink, toInput, toWallTime,
  tripFailureMessage, tripProblem,
} from "./trip.ts";

const WEB = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB), "utf8");
const WALLET = "0123456789abcdef0123456789abcdef";
const TRIP = "fedcba9876543210fedcba9876543210";

function memory() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

test("TS1 a pasted plan or wallet link gives its slug; anything else gives null", () => {
  assert.equal(slugFromLink("https://tara-gala-ph.vercel.app/i/premade-chill", "itinerary"), "premade-chill");
  assert.equal(slugFromLink("  tara-gala-ph.vercel.app/i/abc123def456?x=1 ", "itinerary"), "abc123def456");
  assert.equal(slugFromLink("abc123def456", "itinerary"), "abc123def456");
  assert.equal(slugFromLink(`https://tara-gala-ph.vercel.app/w/${WALLET}`, "wallet"), WALLET);
  assert.equal(slugFromLink(WALLET, "wallet"), WALLET);
  assert.equal(slugFromLink(`https://tara-gala-ph.vercel.app/w/${WALLET}`, "itinerary"), null, "a wallet link isn't a plan");
  assert.equal(slugFromLink("https://tara-gala-ph.vercel.app/i/abc", "wallet"), null);
  assert.equal(slugFromLink("not a link", "itinerary"), null);
  assert.equal(slugFromLink("", "wallet"), null);
  assert.equal(slugFromLink("abc", "wallet"), null, "a wallet slug is 32 hex characters");
});

test("TS2 a trip needs a name up to 40 letters, both dates, home not before leaving, and at most 30 days", () => {
  assert.equal(tripProblem("Baguio", "2026-11-06", "2026-11-08"), null);
  assert.equal(tripProblem("Baguio", "2026-11-06", "2026-11-06"), null, "a day trip");
  assert.equal(tripProblem("  ", "2026-11-06", "2026-11-08"), "Give the trip a name.");
  assert.match(tripProblem("x".repeat(41), "2026-11-06", "2026-11-08") ?? "", /40 letters/);
  assert.match(tripProblem("Baguio", "", "2026-11-08") ?? "", /Pick when you leave/);
  assert.match(tripProblem("Baguio", "2026-11-08", "2026-11-06") ?? "", /can't be before/);
  assert.equal(tripProblem("Baguio", "2026-11-06", "2026-12-06"), null, "30 days is fine");
  assert.match(tripProblem("Baguio", "2026-11-06", "2026-12-07") ?? "", /up to 30 days/);
});

test("TS3 dates and hotel times read as calendar days and Manila wall time, whatever the phone's zone", () => {
  assert.equal(datesLine("2026-11-06", "2026-11-08"), "Fri, Nov 6 – Sun, Nov 8");
  assert.equal(datesLine("2026-11-06", "2026-11-06"), "Fri, Nov 6");
  assert.equal(hotelTime("2026-11-06T14:00:00"), "Fri, Nov 6, 2:00 PM");
  assert.equal(hotelTime(null), null);
  assert.equal(toWallTime("2026-11-06T14:00"), "2026-11-06T14:00:00");
  assert.equal(toWallTime(""), null);
  assert.equal(toInput("2026-11-06T14:00:00"), "2026-11-06T14:00");
  assert.equal(toInput(null), "");
});

test("TS4 the hotel's Google Maps link searches its name and address as typed", () => {
  assert.equal(
    hotelMapsUrl({ name: "Pine Hill Inn", address: " 12 Session Rd, Baguio " }),
    "https://www.google.com/maps/search/?api=1&query=Pine%20Hill%20Inn%2C%2012%20Session%20Rd%2C%20Baguio",
  );
  assert.match(hotelMapsUrl({ name: "Pine Hill Inn", address: "" }), /query=Pine%20Hill%20Inn$/);
});

test("TS5 this phone remembers trips, most recent first, up to 20, and forgets a deleted one", () => {
  const store = memory();
  rememberTrip({ slug: TRIP, name: "Baguio", start_date: "2026-11-06" }, store);
  rememberTrip({ slug: WALLET, name: "Sagada", start_date: "2026-12-01" }, store);
  rememberTrip({ slug: TRIP, name: "Baguio barkada", start_date: "2026-11-06" }, store);
  assert.deepEqual(knownTrips(store).map((t) => [t.slug, t.name]), [[TRIP, "Baguio barkada"], [WALLET, "Sagada"]]);
  forgetTrip(TRIP, store);
  assert.deepEqual(knownTrips(store).map((t) => t.slug), [WALLET]);
  assert.deepEqual(parseKnownTrips('[{"slug":"bad","name":"x","start_date":"2026-11-06"}, 5, null]'), [], "bad entries are dropped");
  assert.deepEqual(parseKnownTrips("not json"), []);
  const full = memory();
  for (let i = 0; i < 25; i++) rememberTrip({ slug: i.toString(16).padStart(32, "0"), name: `T${i}`, start_date: "2026-11-06" }, full);
  assert.equal(knownTrips(full).length, 20);
});

test("TS6 failures read as plain sentences, with the API's link problems spelled out", () => {
  assert.match(tripFailureMessage({ why: "offline" }), /No signal/);
  assert.match(tripFailureMessage({ why: "not_found" }), /trip link doesn't work/);
  assert.match(tripFailureMessage({ why: "rejected", detail: "itinerary_not_found" }), /plan link doesn't work/);
  assert.match(tripFailureMessage({ why: "rejected", detail: "wallet_not_found" }), /wallet link doesn't work/);
  assert.match(tripFailureMessage({ why: "rejected", detail: "name_mismatch" }), /Type it exactly/);
  assert.match(tripFailureMessage({ why: "rejected", detail: "something_else" }), /didn't save/);
});

test("TS7 the trip link is a capability: never indexed, no referrer; the service worker keeps it and its data offline", () => {
  const page = read("src/app/t/[slug]/page.tsx");
  assert.match(page, /robots: \{ index: false, follow: false \}/);
  assert.match(page, /referrer: "no-referrer"/);
  const sw = read("public/sw.js");
  assert.match(sw, /\/\^\\\/sessions\\\/\[0-9a-f\]\{32\}\$\//, "GET /sessions/<slug> is kept for offline");
  assert.match(sw, /const PRECACHE_PAGES = \[[^\]]*"\/trip"[^\]]*\];/);
});

test("TS8 the trip's logs carry the action and the outcome, never a name, hotel or link", () => {
  for (const file of ["src/components/TripView.tsx", "src/components/TripHome.tsx"]) {
    const logs = [...read(file).matchAll(/console\.(?:info|warn|error)\(([^;]*)\);/g)].map((m) => m[1]);
    assert.ok(logs.length > 0, file);
    for (const args of logs) {
      assert.match(args, /^"\[tg-trip\] [a-z-%]+[^"]*"/, `${file}: ${args}`);
      assert.doesNotMatch(args, /name|hotel\.|slug|link|address|booking|notes/i, `${file}: ${args}`);
    }
  }
});

// ---------------------------------------------------------------- TG-52 PR 2: shared tickets and payout QRs

test("TS9 an upload is the raw picture with its type; the kind, label and person ride in the query", async () => {
  const { tripApi } = await import("./trip.ts");
  const seen: { url: string; init: RequestInit }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ share_slug: TRIP, files: [] }), { status: 201 });
  }) as typeof fetch;
  try {
    const picture = new Blob([new Uint8Array([0x89, 0x50])], { type: "image/png" });
    await tripApi.addFile(TRIP, "ticket", picture, { label: "Victory Liner Nov 6" });
    await tripApi.addFile(TRIP, "payout_qr", picture, { member_id: "m1" });
    await tripApi.deleteFile(TRIP, "f1");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.match(seen[0].url, new RegExp(`/sessions/${TRIP}/files\\?kind=ticket&label=Victory\\+Liner\\+Nov\\+6$`));
  assert.equal(seen[0].init.method, "POST");
  assert.deepEqual(seen[0].init.headers, { "content-type": "image/png" });
  assert.ok(seen[0].init.body instanceof Blob);
  assert.match(seen[1].url, /\?kind=payout_qr&member_id=m1$/);
  assert.match(seen[2].url, new RegExp(`/sessions/${TRIP}/files/f1$`));
  assert.equal(seen[2].init.method, "DELETE");
});

test("TS10 big pictures are redrawn to fit 2400 px; small ones go as they are", async () => {
  const { fitScale, fitForUpload } = await import("./shrink.ts");
  assert.equal(fitScale(1200, 800), 1);
  assert.equal(fitScale(4800, 3600), 0.5);
  assert.equal(fitScale(3000, 6000), 0.4);
  const small = new Blob([new Uint8Array(10)], { type: "image/png" });
  assert.equal(await fitForUpload(small), small);
});

test("TS11 shared files say when they leave the trip; upload problems read plainly", () => {
  assert.equal(deleteLine("2026-11-22"), "Deleted from the trip after Sun, Nov 22");
  assert.equal(deleteLine(null), "");
  assert.match(tripFailureMessage({ why: "rejected", detail: "not_an_image" }), /isn't a picture/);
  assert.match(tripFailureMessage({ why: "rejected", detail: "too_big" }), /over 5 MB/);
  assert.match(tripFailureMessage({ why: "rejected", detail: "unknown_member" }), /isn't in this trip's wallet/);
});

test("TS12 this phone notes each trip's wallet, so the wallet page finds its payout QRs", () => {
  const store = memory();
  rememberTrip({ slug: TRIP, name: "Baguio", start_date: "2026-11-06", wallet_slug: WALLET }, store);
  assert.equal(knownTrips(store)[0].wallet_slug, WALLET);
  assert.deepEqual(parseKnownTrips(`[{"slug":"${TRIP}","name":"x","start_date":"2026-11-06","wallet_slug":"nope"}]`), [], "a bad wallet slug drops the entry");
  assert.equal(parseKnownTrips(`[{"slug":"${TRIP}","name":"x","start_date":"2026-11-06"}]`).length, 1, "PR 1's entries still read");
  const wallet = read("src/components/WalletView.tsx");
  assert.match(wallet, /knownTrips\(\)\.find\(\(t\) => t\.wallet_slug === slug\)/);
  assert.match(wallet, /r\.trip\.wallet\?\.share_slug !== slug/, "only the trip that still holds this wallet");
});

test("TS13 shared files open offline: the service worker keeps them, and opening the trip fetches each once", () => {
  assert.match(read("public/sw.js"), /\/\^\\\/sessions\\\/\[0-9a-f\]\{32\}\\\/files\\\/\[0-9a-f-\]\{36\}\$\//);
  const view = read("src/components/TripView.tsx");
  assert.match(view, /keepFilesOffline\(r\.trip, keptFiles\.current\);/);
  assert.match(read("src/lib/trip.ts"), /const res = await fetch\(fileUrl\(slug, id\)\);/, "a CORS fetch, not an opaque <img>");
  assert.doesNotMatch(read("src/components/TripFiles.tsx"), /<img\b|src=\{fileUrl/);
});

test("TS14 tickets on this phone are shared only when someone taps Add to trip", () => {
  const src = read("src/components/TicketWallet.tsx");
  assert.match(src, /onClick=\{\(\) => shareToTrip\(t\)\}>\s*Add to trip/);
  assert.equal(src.match(/tripApi\.addFile\(/g)?.length, 1, "one upload, inside shareToTrip");
});

test("TS15 the file logs carry the kind and outcome, never a label, name or link", () => {
  for (const file of ["src/components/TripFiles.tsx", "src/components/TicketWallet.tsx", "src/components/WalletView.tsx", "src/components/ProofDialog.tsx"]) {
    const logs = [...read(file).matchAll(/console\.(?:info|warn|error)\(([^;]*)\);/g)].map((m) => m[1]);
    for (const args of logs) assert.doesNotMatch(args, /label|(?<!err)\.name\b|slug|fileUrl/i, `${file}: ${args}`);
  }
});

test("TR-F1 a file is fetched once: its bytes never change for an id, and a failure isn't kept", async () => {
  const { fetchFile } = await import("./trip.ts");
  const real = globalThis.fetch;
  let calls = 0;
  let up = false;
  globalThis.fetch = (async () => {
    calls++;
    if (!up) throw new Error("offline");
    return new Response("x");
  }) as typeof fetch;
  try {
    assert.equal(await fetchFile("s", "tr-f1"), null);
    up = true;
    const [a, b] = await Promise.all([fetchFile("s", "tr-f1"), fetchFile("s", "tr-f1")]);
    assert.ok(a && a === b, "two callers at once share one download");
    assert.equal(await fetchFile("s", "tr-f1"), a);
    assert.equal(calls, 2, "the failure, then one download");
    for (let i = 0; i < 200; i++) await fetchFile("s", `tr-f1-${i}`);
    assert.equal(calls, 202);
    await fetchFile("s", "tr-f1");
    assert.equal(calls, 203, "only so many stay in memory");
  } finally {
    globalThis.fetch = real;
  }
});

test("TR-F2 a thumb fetches by the file's id, not its object: a poll makes new objects with the same ids", () => {
  const files = readFileSync("src/components/TripFiles.tsx", "utf8");
  assert.match(files, /\}, \[slug, id\]\);/);
  assert.doesNotMatch(files, /\}, \[slug, file\]\);/);
  const view = readFileSync("src/components/TripView.tsx", "utf8");
  assert.match(view, /function keepFilesOffline\(trip: Trip, kept: Set<string>\)/, "tickets are kept once, not on every poll");
  assert.match(view, /f\.kind !== "photo" && !kept\.has\(f\.id\)/);
});

test("TR-F3 trip photos are 1600px at most, and a browser that can't draw gives null, not a blank picture", async () => {
  const { PHOTO_SIDE } = await import("./shrink.ts");
  assert.equal(PHOTO_SIDE, 1600);
  const src = readFileSync("src/lib/shrink.ts", "utf8");
  const photo = src.slice(src.indexOf("export async function fitPhoto"), src.indexOf("/** The picture as is"));
  assert.match(photo, /if \(!context\) \{/);
  assert.doesNotMatch(photo, /getContext\("2d"\)\?\./);
  assert.match(photo, /canvas\.width = 0;/, "iOS caps total canvas memory: free each one");
});

test("TR-F4 a batch that stops early says how many landed", () => {
  const view = readFileSync("src/components/TripView.tsx", "utf8");
  assert.match(view, /`\$\{added\} of \$\{picked\.length\} photos added\. \$\{n\.text\}`/);
});

// ---------------------------------------------------------------- TG-54: an older answer never replaces newer state

const onScreen = (marks: string[]) => ({
  state: "ready" as const,
  trip: { share_slug: TRIP, marks: marks.map((key) => ({ key, value: "done", updated_at: "2026-11-06T01:00:00.000000Z" })) } as unknown as import("./trip.ts").Trip,
});

test("TG54-1 afterGet: an answer a newer one overtook keeps the trip on screen, so the tick stays", async () => {
  const { afterGet } = await import("./trip.ts");
  const prev = onScreen(["row:d1-01"]);
  const older = { ok: true as const, trip: onScreen([]).trip };
  assert.equal(afterGet(prev, older, TRIP, true), prev);
  assert.deepEqual(afterGet(prev, older, TRIP, false), { state: "ready", trip: older.trip }, "not overtaken: another phone's change comes through, an untick too");
});

test("TG54-2 afterGet: a saved copy is judged by its age alone, and still opens a trip offline", async () => {
  const { afterGet } = await import("./trip.ts");
  const prev = onScreen(["row:d1-01"]);
  const saved = { ok: true as const, trip: onScreen([]).trip, savedAt: 2000 };
  assert.equal(afterGet(prev, saved, TRIP, true), prev, "older than the screen: keep the screen");
  assert.deepEqual(afterGet(prev, saved, TRIP, false), { state: "ready", trip: saved.trip }, "newer than the screen: it shows");
  assert.deepEqual(afterGet({ state: "loading" }, saved, TRIP, true), { state: "ready", trip: saved.trip }, "nothing on screen: the copy is the trip");
  assert.deepEqual(afterGet({ state: "error", why: "offline" }, saved, TRIP, true), { state: "ready", trip: saved.trip });
  const other = { ...onScreen([]), trip: { ...onScreen([]).trip, share_slug: WALLET } };
  assert.deepEqual(afterGet(other, saved, TRIP, true), { state: "ready", trip: saved.trip }, "another trip's screen isn't this trip's copy");
});

test("TG54-3 afterGet: a failure keeps the trip when offline or overtaken, and shows otherwise", async () => {
  const { afterGet } = await import("./trip.ts");
  const prev = onScreen(["row:d1-01"]);
  assert.equal(afterGet(prev, { ok: false, why: "offline" }, TRIP, false), prev, "offline with a copy on screen: keep showing it");
  assert.deepEqual(afterGet(prev, { ok: false, why: "not_found" }, TRIP, false), { state: "error", why: "not_found" });
  assert.deepEqual(afterGet(prev, { ok: false, why: "server" }, TRIP, false), { state: "error", why: "server" });
  assert.equal(afterGet(prev, { ok: false, why: "server" }, TRIP, true), prev, "a write landed after this GET left: it just worked, so no error box");
  assert.deepEqual(afterGet({ state: "loading" }, { ok: false, why: "offline" }, TRIP, false), { state: "error", why: "offline" });
  assert.deepEqual(afterGet({ state: "loading" }, { ok: false, why: "server" }, TRIP, true), { state: "error", why: "server" }, "nothing on screen to keep");
});

test("TG54-4 tripApi.get gives a saved copy's age, in ms; a live answer has none", async () => {
  const { tripApi } = await import("./trip.ts");
  const real = globalThis.fetch;
  const body = JSON.stringify({ share_slug: TRIP, marks: [] });
  const stamped = (value: string) => (async () => new Response(body, { status: 200, headers: { "X-TG-Saved-At": value } })) as typeof fetch;
  try {
    globalThis.fetch = stamped("2026-11-07T01:00:00.000Z");
    const copy = await tripApi.get(TRIP);
    assert.ok(copy.ok && copy.savedAt === Date.parse("2026-11-07T01:00:00.000Z"));
    globalThis.fetch = stamped("not a time");
    const bad = await tripApi.get(TRIP);
    assert.ok(bad.ok && bad.savedAt === undefined, "an unreadable stamp is no age");
    globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
    const live = await tripApi.get(TRIP);
    assert.ok(live.ok && live.savedAt === undefined);
  } finally {
    globalThis.fetch = real;
  }
});

test("TG54-5 TripView: every GET it shows goes through afterGet, aged against what's on screen", () => {
  const view = readFileSync("src/components/TripView.tsx", "utf8");
  assert.match(view, /const left = Date\.now\(\);\s+tripApi\.get\(slug\)\.then\(\(r\) => \{\s+if \(!live\) return;/, "timed before the GET leaves; an answer a newer GET replaced is dropped");
  assert.match(view, /const from = answerFrom\(r, left\);\s+const overtaken = from < shownAt\.current;/);
  assert.match(view, /setLoad\(\(prev\) => afterGet\(prev, r, slug, overtaken\)\);/);
  const write = view.slice(view.indexOf("async function write("), view.indexOf("const onFail ="));
  assert.ok(write.indexOf("shownAt.current = Date.now();") > write.indexOf("if (!r.ok)"), "only a write that landed");
  assert.ok(write.indexOf("shownAt.current = Date.now();") < write.indexOf("setLoad("), "before its state, so no answer can slip between");
  assert.equal(view.match(/setLoad\(/g)?.length, 4, "afterGet, the write, TG-57's afterSaved and TG-61's afterPlanSaved: nothing else sets the trip");
  const plan = view.slice(view.indexOf("async function planWrite("), view.indexOf("async function onUndo("));
  assert.ok(plan.indexOf("shownAt.current = Date.now();") < plan.indexOf("setLoad("), "TG-61: a plan save ages the screen first, so an older session GET can't put the old plan back");
  assert.match(view, /console\.info\("\[tg-trip\] load ok=%s", r\.ok \? \(overtaken \? "overtaken" : r\.savedAt \? "saved" : "yes"\) : r\.why\);/);
  // An overtaken answer leaves everything alone: this phone's note of the trip too
  assert.match(view, /if \(r\.ok && !overtaken\) \{\s+shownAt\.current = from;\s+remember\(r\.trip\);\s+keepFilesOffline\(r\.trip, keptFiles\.current\);\s+\}/);
});

test("TG54-7 answerFrom: a slow-signal phone still sees other phones' ticks, and never loses its own", async () => {
  const { afterGet, answerFrom } = await import("./trip.ts");
  const ok = (marks: string[], savedAt?: number) => ({ ok: true as const, trip: onScreen(marks).trip, ...(savedAt ? { savedAt } : {}) });
  // TripView's load path, in order
  let shownAt = 0;
  let screen: import("./trip.ts").TripLoad = { state: "loading" };
  const land = (r: import("./trip.ts").TripResult, left: number) => {
    const from = answerFrom(r, left);
    const overtaken = from < shownAt;
    if (r.ok && !overtaken) shownAt = from;
    screen = afterGet(screen, r, TRIP, overtaken);
  };
  const marks = () => (screen.state === "ready" ? screen.trip.marks.map((m) => m.key) : null);

  land(ok([]), 1000); // opened with signal
  assert.deepEqual(marks(), []);
  // Signal slows: each GET gets the worker's copy at 4 s, and its real answer only reaches the cache
  land(ok([], 1000), 31000);
  assert.deepEqual(marks(), []);
  land(ok(["row:d1-03"], 31000), 61000); // the copy now holds another phone's tick, from the GET that left at 31 s
  assert.deepEqual(marks(), ["row:d1-03"], "a saved copy newer than the screen shows");
  // This phone ticks at 70 s; the next GET gets a copy from before it
  shownAt = 70000;
  screen = { state: "ready", trip: onScreen(["row:d1-03", "row:d1-04"]).trip };
  land(ok(["row:d1-03"], 61000), 91000);
  assert.deepEqual(marks(), ["row:d1-03", "row:d1-04"], "a copy from before the write doesn't take the tick back");
  land(ok(["row:d1-03"]), 69000); // a live GET that left before the tick
  assert.deepEqual(marks(), ["row:d1-03", "row:d1-04"], "nor does a GET sent before it");
  land(ok(["row:d1-03", "row:d1-04", "row:d1-05"], 75000), 121000); // the copy from the refresh after the tick
  assert.equal(marks()?.length, 3, "a copy from after the write shows");
});

// --- TG-57 the map shows from the worker's saved copy while the fresh answer is on its way ------------------------

const savedHit = (body: unknown, stamp: string | null) =>
  new Response(JSON.stringify(body), { headers: stamp ? { "X-TG-Saved-At": stamp } : {} });

test("TG57-1 savedAnswer: the worker's copy and its age, ignoring Vary, and null when there's none to read", async () => {
  const { savedAnswer } = await import("./api.ts");
  const asked: unknown[][] = [];
  const store = (hit?: Response) => ({ match: async (...args: unknown[]) => (asked.push(args), hit) });
  const stamp = "2026-11-02T05:00:00.000Z";
  assert.deepEqual(await savedAnswer("http://api/x", store(savedHit({ a: 1 }, stamp))), { body: { a: 1 }, savedAt: Date.parse(stamp) });
  assert.deepEqual(asked[0], ["http://api/x", { ignoreVary: true }], "the API's Vary: Origin mustn't hide the copy from the page");
  assert.deepEqual(await savedAnswer("http://api/x", store(savedHit({ a: 1 }, null))), { body: { a: 1 }, savedAt: 0 }, "no stamp: older than anything");
  assert.deepEqual(await savedAnswer("http://api/x", store(savedHit({ a: 1 }, "soon"))), { body: { a: 1 }, savedAt: 0 });
  assert.equal(await savedAnswer("http://api/x", store()), null, "nothing saved");
  assert.equal(await savedAnswer("http://api/x", undefined), null, "no Cache API on this page");
  assert.equal(await savedAnswer("http://api/x", { match: async () => { throw new Error("blocked"); } }), null);
  assert.equal(await savedAnswer("http://api/x", store(new Response("not json"))), null);
});

test("TG57-2 savedTrip: a trip's own copy from the exact URL the GET uses; another trip's body is no copy", async () => {
  const { savedTrip } = await import("./trip.ts");
  const { API_URL } = await import("./api.ts");
  const trip = { ...onScreen([]).trip };
  let url = "";
  const store = (body: unknown) => ({ match: async (u: string) => ((url = u), savedHit(body, "2026-11-02T05:00:00.000Z")) });
  assert.deepEqual(await savedTrip(TRIP, store(trip)), { trip, savedAt: Date.parse("2026-11-02T05:00:00.000Z") });
  assert.equal(url, `${API_URL}/sessions/${TRIP}`);
  assert.equal(await savedTrip(TRIP, store({ ...trip, share_slug: "0".repeat(32) })), null);
  const { savedItinerary } = await import("./api.ts");
  const real = globalThis.caches;
  const asked: string[] = [];
  try {
    Object.defineProperty(globalThis, "caches", { configurable: true, value: { match: async (u: string) => void asked.push(u) } });
    await savedItinerary("baguio-barkada-nov6");
  } finally {
    Object.defineProperty(globalThis, "caches", { configurable: true, value: real });
  }
  assert.deepEqual(asked, [`${API_URL}/itineraries/baguio-barkada-nov6`], "the exact URL fetchItinerary uses, or the saved guide never shows");
});

test("TG57-3 afterSaved: a saved copy only fills an empty screen, never a trip or an error", async () => {
  const { afterSaved } = await import("./trip.ts");
  const copy = onScreen(["row:d1-01"]).trip;
  assert.deepEqual(afterSaved({ state: "loading" }, copy), { state: "ready", trip: copy });
  const newer = onScreen(["row:d1-01", "row:d1-02"]);
  assert.equal(afterSaved(newer, copy), newer, "a GET or a write beat the saved copy to the screen");
  const gone = { state: "error" as const, why: "not_found" as const };
  assert.equal(afterSaved(gone, copy), gone, "a deleted trip stays deleted");
});

test("TG57-4 the age rule holds with a saved copy first: fresh answers replace it, older ones and writes aren't undone", async () => {
  const { afterGet, afterSaved, answerFrom } = await import("./trip.ts");
  // TripView's paths, in order
  let shownAt = 0;
  let screen: import("./trip.ts").TripLoad = { state: "loading" };
  const saved = (marks: string[], savedAt: number) => {
    shownAt ||= savedAt;
    screen = afterSaved(screen, onScreen(marks).trip);
  };
  const land = (r: import("./trip.ts").TripResult, left: number) => {
    const from = answerFrom(r, left);
    const overtaken = from < shownAt;
    if (r.ok && !overtaken) shownAt = from;
    screen = afterGet(screen, r, TRIP, overtaken);
  };
  const ok = (marks: string[], savedAt?: number) => ({ ok: true as const, trip: onScreen(marks).trip, ...(savedAt ? { savedAt } : {}) });
  const marks = () => (screen.state === "ready" ? screen.trip.marks.map((m) => m.key) : null);

  saved(["row:d1-01"], 1000);
  assert.deepEqual(marks(), ["row:d1-01"], "the copy shows at once");
  land(ok(["row:d1-01", "row:d1-02"]), 5000);
  assert.deepEqual(marks(), ["row:d1-01", "row:d1-02"], "the fresh answer replaces it");

  // Slow signal: the same GET gets the very same copy back from the worker at 4 s
  shownAt = 0;
  screen = { state: "loading" };
  saved(["row:d1-01"], 1000);
  land(ok(["row:d1-01"], 1000), 5000);
  assert.deepEqual(marks(), ["row:d1-01"]);
  assert.equal(shownAt, 1000, "its age stays the copy's, so the next real answer still counts as newer");

  // A tick lands on the saved map while the first GET is still out
  shownAt = 0;
  screen = { state: "loading" };
  saved([], 1000);
  shownAt = 7000;
  screen = onScreen(["row:d1-01"]);
  land(ok([]), 5000);
  assert.deepEqual(marks(), ["row:d1-01"], "the GET that left before the tick doesn't take it back");

  // A newer tab's copy on disk is newer than this page's first GET
  shownAt = 0;
  screen = { state: "loading" };
  saved(["row:d1-02"], 9000);
  land(ok([]), 5000);
  assert.deepEqual(marks(), ["row:d1-02"], "a GET older than the copy doesn't replace it");

  // The write got there before the disk answered
  shownAt = 7000;
  screen = onScreen(["row:d1-03"]);
  saved([], 1000);
  assert.equal(shownAt, 7000, "the copy doesn't age the screen backwards");
  assert.deepEqual(marks(), ["row:d1-03"]);
});

test("TG57-5 fillGuide: a saved guide or a failure only fills a gap, so neither replaces an answer already held", async () => {
  const { fillGuide } = await import("./trip.ts");
  const guide = (n: string) => ({ n }) as unknown as import("./guide.ts").Guide;
  const fresh = { plan: "p", guide: guide("fresh") };
  const failed = { plan: "p", guide: null, failed: true };
  assert.deepEqual(fillGuide(null, { plan: "p", guide: guide("saved") }), { plan: "p", guide: guide("saved") });
  assert.equal(fillGuide(fresh, { plan: "p", guide: guide("saved") }), fresh, "the fresh answer landed first");
  assert.equal(fillGuide(fresh, failed), fresh, "a failed GET keeps the saved guide on screen");
  assert.deepEqual(fillGuide(failed, { plan: "p", guide: guide("saved") }), { plan: "p", guide: guide("saved") }, "a copy after a failure shows");
  assert.deepEqual(fillGuide(fresh, { plan: "q", guide: null, failed: true }), { plan: "q", guide: null, failed: true }, "another plan's guide isn't this plan's");
});

test("TG57-6 mapSlot: a frame while the plan's guide is on its way, the map once it's here, nothing without one", async () => {
  const { mapSlot } = await import("./trip.ts");
  const guide = { days: [] } as unknown as import("./guide.ts").Guide;
  assert.equal(mapSlot(null, null), null, "no plan, no map");
  assert.equal(mapSlot("p", null), "frame");
  assert.equal(mapSlot("p", { plan: "old", guide }), "frame", "the last plan's guide isn't shown for this one");
  assert.equal(mapSlot("p", { plan: "p", guide }), guide);
  assert.equal(mapSlot("p", { plan: "p", guide: null }), null, "a plan without a guide, or a deleted one");
  assert.equal(mapSlot("p", { plan: "p", guide: null, failed: true }), null, "no signal and no copy: the frame doesn't spin for ever");
});

test("TG57-7 TripView: saved copies go through the age rule, the guide retries with the polls, and the frame stays out of LevelMap", () => {
  const src = read("src/components/TripView.tsx");
  const peek = src.slice(src.indexOf("savedTrip(slug)"), src.indexOf("tripApi.get(slug).then"));
  assert.match(peek, /if \(!live \|\| !saved\) return;/, "an unmounted view or a slug change drops the copy");
  assert.match(peek, /shownAt\.current \|\|= saved\.savedAt/, "the copy never ages the screen backwards");
  assert.match(peek, /afterSaved\(prev, saved\.trip\)/);
  assert.ok(src.indexOf("savedTrip(slug)") < src.indexOf("tripApi.get(slug).then"), "the copy is asked for first");
  assert.doesNotMatch(peek, /remember\(|keepFilesOffline/, "only a fresh answer updates this phone's note and its kept files");
  const guide = src.slice(src.indexOf("const planSlug"), src.indexOf('if (load.state === "loading")'));
  assert.match(guide, /savedItinerary\(planSlug\)/);
  // TG-61: the saved copy only fills a gap, now judged with the plan's version too (planState.acceptSaved)
  assert.match(guide, /setShown\(\(prev\) => \(acceptSaved\(prev, next, sessionSlug\.current\) \? next : prev\)\)/);
  assert.match(guide, /if \(live\) setPlanMiss\(planSlug\);/);
  assert.match(guide, /\[planSlug, planSeq, retry\]/, "a failed fetch tries again with the next poll, and another phone's version fetches the plan again");
  assert.match(src, /mapSlot\(trip\.itinerary_slug, shown \? \{ plan: shown\.slug, guide: shown\.guide \} : planMiss \? \{ plan: planMiss, guide: null \} : null\)/);
  assert.match(src, /\{slot === "frame" && \(\s+<section data-map-loading/, "the frame is drawn");
  assert.doesNotMatch(read("src/components/LevelMap.tsx"), /data-map-loading/);
  assert.doesNotMatch(src.slice(src.indexOf("data-map-loading") - 200, src.indexOf("data-map-loading") + 400), /progress-title/, "#progress-title still means the real map");
});

test("TG57-8 TripHeader: opening the edit form starts from the trip on screen, not the copy it first drew", () => {
  const src = read("src/components/TripView.tsx");
  const header = src.slice(src.indexOf("function TripHeader"), src.indexOf("function PlanSection"));
  assert.match(header, /onClick=\{openEditor\}/, "the button uses it");
  const open = header.slice(header.indexOf("function openEditor"), header.indexOf("async function onShare"));
  assert.match(open, /setName\(trip\.name\)/);
  assert.match(open, /setStart\(trip\.start_date\)/);
  assert.match(open, /setBack\(trip\.return_date\)/);
});

test("TG57-9 TripView: when the worker takes over mid-visit, ask again for its copies, without touching the GET on screen", () => {
  const src = read("src/components/TripView.tsx");
  const keep = src.slice(src.indexOf("const keepCopies"), src.indexOf('if (load.state === "loading")'));
  assert.match(keep, /void tripApi\.get\(slug\);/);
  assert.match(keep, /fetchItinerary\(planSlug\)\.catch\(\(\) => undefined\)/);
  assert.match(keep, /serviceWorker\?\.addEventListener\("controllerchange", keepCopies\)/);
  assert.match(keep, /serviceWorker\?\.removeEventListener\("controllerchange", keepCopies\)/);
  assert.doesNotMatch(keep, /setReloads|setLoad|setGuide/, "the screen's own GET isn't cancelled, and these answers don't go to the screen");
});
