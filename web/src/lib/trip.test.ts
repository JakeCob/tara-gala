// TG-52 trip sessions on the web: links, dates, hotel times, what this phone remembers, and offline.
// Run with `npm test` (node --test, type stripping).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  datesLine, forgetTrip, hotelMapsUrl, hotelTime, knownTrips, parseKnownTrips, rememberTrip, slugFromLink, toInput, toWallTime,
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
