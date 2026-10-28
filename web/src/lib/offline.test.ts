// Offline banner tests (TG-27). Run with `npm test` (node --test, Node 22.18+ type stripping).
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MSG_DATA,
  MSG_SKIP_WAITING,
  bannerReducer,
  bannerText,
  bannerVariant,
  formatSavedAt,
  initialBanner,
  olderOf,
  parseSwMessage,
  type BannerEvent,
  type BannerState,
  type Variant,
} from "./offline.ts";

const TZS = ["America/Los_Angeles", "Pacific/Kiritimati", "Asia/Manila"];
const SAVED = "2026-10-30T13:12:00.000Z"; // 9:12 PM in Manila
const EARLIER = "2026-10-29T01:00:00.000Z";

const originalTZ = process.env.TZ;
afterEach(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

const full = (v: Variant, savedAt: string | null) => {
  const { lead, rest } = bannerText(v, savedAt);
  return lead + rest;
};
const reduce = (s: BannerState, ...events: BannerEvent[]) => events.reduce(bannerReducer, s);
const cached = (savedAt: string | null): BannerEvent => ({ type: "data", source: "cache", savedAt });
const fresh: BannerEvent = { type: "data", source: "network", savedAt: null };
const miss: BannerEvent = { type: "data", source: "none", savedAt: null };

test("changing TZ in-process really changes the device time zone", () => {
  // Guards the TZ loops below: if this fails they would prove nothing
  process.env.TZ = "America/Los_Angeles";
  const la = new Date(SAVED).getHours();
  process.env.TZ = "Asia/Manila";
  assert.notEqual(new Date(SAVED).getHours(), la);
});

// T27-13 (B9): saved-at in Manila time, the trip cards' 12-hour style, no year
test("T27-13 formatSavedAt shows Manila time whatever the device time zone", () => {
  const cases: [string, string][] = [
    ["2026-10-30T13:12:00Z", "Oct 30, 9:12 PM"],
    ["2026-10-30T16:05:00Z", "Oct 31, 12:05 AM"], // Manila has rolled over to Oct 31; UTC hasn't
    ["2026-10-31T04:00:00Z", "Oct 31, 12:00 PM"],
    ["2026-11-05T15:59:00Z", "Nov 5, 11:59 PM"],
    ["2026-11-06T00:30:00Z", "Nov 6, 8:30 AM"],
    ["2026-11-05T16:00:00Z", "Nov 6, 12:00 AM"],
  ];
  for (const tz of TZS) {
    process.env.TZ = tz;
    for (const [iso, expected] of cases) assert.equal(formatSavedAt(iso), expected, `${tz} ${iso}`);
  }
});

test("T27-13 the time uses a plain space before AM/PM, like the trip cards", () => {
  const s = formatSavedAt("2026-10-30T13:12:00Z");
  assert.ok(!/[  ]/.test(s), "no narrow or non-breaking space from Intl");
  assert.match(s, /^Oct 30, 9:12 PM$/);
});

test("T27-13 the hour comes from 24-hour parts, not Intl's 12-hour output", () => {
  // Node's ICU puts a plain space before PM where Chrome puts U+202F, so the format test above can't catch
  // Intl 12-hour output here; guard the source instead (RED audit N2)
  const source = readFileSync(new URL("./offline.ts", import.meta.url), "utf8");
  assert.match(source, /hourCycle: "h23"/);
  assert.doesNotMatch(source, /hour: "numeric"/);
  assert.doesNotMatch(source, /hour12: true|hourCycle: "h12"/);
});

test("T27-13b the year is never shown", () => {
  for (const iso of ["2025-12-31T15:30:00Z", "2026-01-01T00:00:00Z", "2027-03-01T02:00:00Z"]) {
    assert.doesNotMatch(formatSavedAt(iso), /\b(19|20)\d\d\b/, iso);
    assert.doesNotMatch(full("A", iso), /\b(19|20)\d\d\b/, iso);
  }
  assert.equal(formatSavedAt("2025-12-31T15:30:00Z"), "Dec 31, 11:30 PM");
});

// ux.md copy, all four variants
test("T27-13 banner copy for each variant", () => {
  for (const tz of TZS) {
    process.env.TZ = tz;
    assert.equal(full("A", SAVED), "Offline · saved Oct 30, 9:12 PM · schedules may have changed", tz);
    assert.equal(full("B", SAVED), "Can't reach the server · saved Oct 30, 9:12 PM · schedules may have changed", tz);
    assert.equal(full("C", SAVED), "Offline · searching needs a connection", tz);
    assert.equal(full("C", null), "Offline · searching needs a connection", tz);
    assert.equal(full("D", SAVED), "Back online · saved Oct 30, 9:12 PM · search again for the latest times", tz);
  }
});

test("the lead phrase is split out for bold text", () => {
  assert.equal(bannerText("A", SAVED).lead, "Offline");
  assert.equal(bannerText("B", SAVED).lead, "Can't reach the server");
  assert.equal(bannerText("C", null).lead, "Offline");
  assert.equal(bannerText("D", SAVED).lead, "Back online");
});

test("the separators are a middle dot with spaces", () => {
  for (const v of ["A", "B", "C", "D"] as Variant[]) {
    const text = full(v, SAVED);
    assert.ok(text.includes(" · "), v);
    assert.doesNotMatch(text.replaceAll(" · ", ""), /·/, `${v}: every dot has a space each side`);
  }
});

test("T27-13 an unknown saved-at still says the data may be stale", () => {
  for (const savedAt of [null, "", "garbage", "NaN"]) {
    assert.equal(full("A", savedAt), "Offline · saved time unknown · schedules may have changed", String(savedAt));
    assert.equal(full("B", savedAt), "Can't reach the server · saved time unknown · schedules may have changed");
    assert.equal(full("D", savedAt), "Back online · saved time unknown · search again for the latest times");
    for (const v of ["A", "B", "D"] as Variant[]) {
      assert.doesNotMatch(full(v, savedAt), /Invalid|NaN|1970|undefined|null/);
    }
  }
});

// ---------------------------------------------------------------- reducer and variants (B9 to B13)

test("the first paint has no banner", () => {
  assert.deepEqual(initialBanner(true), { kind: "none", savedAt: null, online: true, backOnline: false });
  assert.deepEqual(initialBanner(false), { kind: "none", savedAt: null, online: false, backOnline: false });
  assert.equal(bannerVariant(initialBanner(true)), null);
  assert.equal(bannerVariant(initialBanner(false)), null);
});

test("B9 offline and served from the cache: variant A, even when just saved", () => {
  const s = reduce(initialBanner(false), cached(SAVED));
  assert.deepEqual(s, { kind: "cached", savedAt: SAVED, online: false, backOnline: false });
  assert.equal(bannerVariant(s), "A");
  // No "fresh enough" threshold: a copy saved a moment ago is still flagged
  assert.equal(bannerVariant(reduce(initialBanner(false), cached(new Date().toISOString()))), "A");
});

test("B10 online but served from the cache (lie-fi, API down or 5xx): variant B", () => {
  const s = reduce(initialBanner(true), cached(SAVED));
  assert.equal(bannerVariant(s), "B");
});

test("B11 offline and nothing cached: variant C; online misses show nothing", () => {
  assert.equal(bannerVariant(reduce(initialBanner(false), miss)), "C");
  assert.equal(bannerVariant(reduce(initialBanner(true), miss)), null);
});

test("B11 a miss keeps the earlier saved-at and flags", () => {
  const before = reduce(initialBanner(false), cached(SAVED));
  const after = bannerReducer(before, miss);
  assert.deepEqual(after, { ...before, kind: "miss" });
});

test("Part B: /terminals only upgrades directions links, so its answers never change the banner", () => {
  // Offline on a saved itinerary, opening the bus sheet fetched /terminals (never saved by the README steps): its
  // miss replaced "Offline · saved" with "searching needs a connection", though the whole trip was on screen
  const api = "https://api.example.test";
  const a = reduce(initialBanner(false), cached(SAVED));
  const terminals = (source: "none" | "network" | "cache"): BannerEvent => ({ type: "data", source, savedAt: null, url: `${api}/terminals` });
  assert.deepEqual(bannerReducer(a, terminals("none")), a);
  assert.equal(bannerVariant(bannerReducer(a, terminals("none"))), "A");
  assert.deepEqual(bannerReducer(a, terminals("network")), a); // a fresh /terminals says nothing about the trip's data
  assert.deepEqual(bannerReducer(a, terminals("cache")), a);
  // The screen's own data still drives it: a trip search miss is variant C, as before
  const tripsMiss: BannerEvent = { type: "data", source: "none", savedAt: null, url: `${api}/trips?origin_city=Baguio` };
  assert.equal(bannerVariant(bannerReducer(a, tripsMiss)), "C");
  assert.equal(bannerVariant(reduce(initialBanner(false), terminals("none"))), null);
});

test("Part B: OfflineBanner passes the message's url to the reducer", () => {
  const source = readFileSync(new URL("../components/OfflineBanner.tsx", import.meta.url), "utf8");
  assert.match(source, /dispatch\(\{ type: "data", source: msg\.source, savedAt: msg\.savedAt, url: msg\.url \}\)/);
});

test("B12 back online with cached data on screen: variant D until a fresh response", () => {
  const a = reduce(initialBanner(false), cached(SAVED));
  const d = bannerReducer(a, { type: "online" });
  assert.deepEqual(d, { kind: "cached", savedAt: SAVED, online: true, backOnline: true });
  assert.equal(bannerVariant(d), "D");
  const cleared = bannerReducer(d, fresh);
  assert.deepEqual(cleared, { kind: "none", savedAt: null, online: true, backOnline: false });
  assert.equal(bannerVariant(cleared), null);
});

test("B12 an online event without cached data, or while already online, isn't 'back online'", () => {
  assert.equal(bannerReducer(initialBanner(false), { type: "online" }).backOnline, false);
  assert.equal(bannerReducer(reduce(initialBanner(true), cached(SAVED)), { type: "online" }).backOnline, false);
  assert.equal(bannerVariant(bannerReducer(reduce(initialBanner(true), cached(SAVED)), { type: "online" })), "B");
});

test("B12 going offline again from D shows A", () => {
  const d = reduce(initialBanner(false), cached(SAVED), { type: "online" });
  const again = bannerReducer(d, { type: "offline" });
  assert.deepEqual(again, { kind: "cached", savedAt: SAVED, online: false, backOnline: false });
  assert.equal(bannerVariant(again), "A");
});

test("B12 a cached response while in D drops back to B (still not fresh)", () => {
  const d = reduce(initialBanner(false), cached(SAVED), { type: "online" });
  const s = bannerReducer(d, cached(SAVED));
  assert.equal(s.backOnline, false);
  assert.equal(bannerVariant(s), "B");
});

test("B13 several cached responses: the oldest saved-at wins", () => {
  const s = reduce(initialBanner(false), cached(SAVED), cached(EARLIER), cached("2026-10-31T00:00:00.000Z"));
  assert.equal(s.savedAt, EARLIER);
  assert.equal(full(bannerVariant(s)!, s.savedAt), "Offline · saved Oct 29, 9:00 AM · schedules may have changed");
});

test("B13 a fresh response between two cached ones starts the oldest over", () => {
  const s = reduce(initialBanner(false), cached(EARLIER), fresh, cached(SAVED));
  assert.equal(s.savedAt, SAVED);
});

test("B13 reset (route change) goes back to the initial state for the current connection", () => {
  const s = reduce(initialBanner(false), cached(SAVED), { type: "online" });
  assert.deepEqual(bannerReducer(s, { type: "reset", online: true }), initialBanner(true));
  assert.deepEqual(bannerReducer(s, { type: "reset", online: false }), initialBanner(false));
});

test("the reducer never mutates its input", () => {
  const s = Object.freeze(reduce(initialBanner(false), cached(SAVED)));
  for (const e of [fresh, miss, cached(EARLIER), { type: "online" }, { type: "offline" }, { type: "reset", online: true }] as BannerEvent[]) {
    assert.doesNotThrow(() => bannerReducer(s, e));
  }
  assert.deepEqual(s, { kind: "cached", savedAt: SAVED, online: false, backOnline: false });
});

test("variant table", () => {
  const cases: [BannerState, Variant | null][] = [
    [{ kind: "none", savedAt: null, online: true, backOnline: false }, null],
    [{ kind: "none", savedAt: null, online: false, backOnline: false }, null],
    [{ kind: "miss", savedAt: null, online: false, backOnline: false }, "C"],
    [{ kind: "miss", savedAt: SAVED, online: true, backOnline: false }, null],
    [{ kind: "cached", savedAt: SAVED, online: false, backOnline: false }, "A"],
    [{ kind: "cached", savedAt: SAVED, online: true, backOnline: true }, "D"],
    [{ kind: "cached", savedAt: SAVED, online: true, backOnline: false }, "B"],
  ];
  for (const [s, v] of cases) assert.equal(bannerVariant(s), v, JSON.stringify(s));
});

test("olderOf picks the earlier instant either way round", () => {
  assert.equal(olderOf(SAVED, EARLIER), EARLIER);
  assert.equal(olderOf(EARLIER, SAVED), EARLIER);
  assert.equal(olderOf(SAVED, SAVED), SAVED);
  assert.equal(olderOf(null, null), null);
});

// ---------------------------------------------------------------- message contract

test("message names", () => {
  assert.equal(MSG_DATA, "tg-sw:data");
  assert.equal(MSG_SKIP_WAITING, "SKIP_WAITING");
});

test("parseSwMessage accepts only well-formed data messages", () => {
  const url = "http://localhost:8010/trips?date=2026-11-06";
  for (const source of ["network", "cache", "none"] as const) {
    assert.deepEqual(parseSwMessage({ type: "tg-sw:data", source, savedAt: SAVED, url }), { type: "tg-sw:data", source, savedAt: SAVED, url });
  }
  assert.deepEqual(parseSwMessage({ type: "tg-sw:data", source: "cache", savedAt: null, url }), {
    type: "tg-sw:data",
    source: "cache",
    savedAt: null,
    url,
  });
  const bad: unknown[] = [
    null,
    undefined,
    "tg-sw:data",
    42,
    {},
    { type: "SKIP_WAITING" },
    { type: "other", source: "cache", savedAt: SAVED, url },
    { type: "tg-sw:data", source: "disk", savedAt: SAVED, url },
    { type: "tg-sw:data", source: "cache", savedAt: 123, url },
    { type: "tg-sw:data", source: "cache", savedAt: SAVED },
    { type: "tg-sw:data", source: "cache", savedAt: SAVED, url: 5 },
  ];
  for (const data of bad) assert.equal(parseSwMessage(data), null, JSON.stringify(data));
});

test("parseSwMessage keeps only the known fields", () => {
  const msg = parseSwMessage({ type: "tg-sw:data", source: "cache", savedAt: SAVED, url: "u", extra: "<b>x</b>" });
  assert.deepEqual(msg, { type: "tg-sw:data", source: "cache", savedAt: SAVED, url: "u" });
});

// T27-18
test("offline.ts is a plain module with no imports at all", () => {
  const source = readFileSync(new URL("./offline.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^\s*import\b/m);
  assert.doesNotMatch(source, /\bimport\s*\(/);
  assert.doesNotMatch(source, /\brequire\s*\(/);
  assert.doesNotMatch(source, /use client/);
  assert.doesNotMatch(source, /\benum\s/);
  assert.doesNotMatch(source, /\bnamespace\s/);
});
