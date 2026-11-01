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
  assert.match(view, /keepFilesOffline\(r\.trip\);/);
  assert.match(read("src/lib/trip.ts"), /const res = await fetch\(fileUrl\(slug, id\)\);/, "a CORS fetch, not an opaque <img>");
  assert.doesNotMatch(read("src/components/TripFiles.tsx"), /<img\b|src=\{fileUrl/);
});

test("TS14 tickets on this phone are shared only when someone taps Add to trip", () => {
  const src = read("src/components/TicketWallet.tsx");
  assert.match(src, /onClick=\{\(\) => shareToTrip\(t\)\}>\s*Add to trip/);
  assert.equal(src.match(/tripApi\.addFile\(/g)?.length, 1, "one upload, inside shareToTrip");
});

test("TS15 the file logs carry the kind and outcome, never a label, name or link", () => {
  for (const file of ["src/components/TripFiles.tsx", "src/components/TicketWallet.tsx", "src/components/WalletView.tsx"]) {
    const logs = [...read(file).matchAll(/console\.(?:info|warn|error)\(([^;]*)\);/g)].map((m) => m[1]);
    for (const args of logs) assert.doesNotMatch(args, /label|(?<!err)\.name\b|slug|fileUrl/i, `${file}: ${args}`);
  }
});
