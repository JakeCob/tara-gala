// "Get to the terminal" link tests (TG-14). Run with `npm test` (node --test, Node 22.18+ type stripping).
// All coordinates and addresses below are made up; real ones come from `terminals` (TG-7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MAPS_DIR_BASE,
  SAKAY_HOME,
  googleMapsUrl,
  hasCoordinates,
  mapsDestination,
  mapsLabel,
  sakayLabel,
  sakayUrl,
  showSakay,
  withTerminalData,
  type TerminalPlace,
} from "./mapLinks.ts";

const CUBAO: TerminalPlace = { slug: "vl-cubao", name: "Victory Liner Cubao", city: "Quezon City" };
const GEN_BAGUIO: TerminalPlace = { slug: "gen-baguio", name: "Genesis Baguio (Gov. Pack Rd)", city: "Baguio" };

// The 12 seeded terminals (supabase/schema.sql), all with null address/lat/lng today.
const SEED: TerminalPlace[] = [
  { slug: "vl-cubao", name: "Victory Liner Cubao", city: "Quezon City" },
  { slug: "vl-pasay", name: "Victory Liner Pasay", city: "Pasay" },
  { slug: "vl-caloocan", name: "Victory Liner Caloocan", city: "Caloocan" },
  { slug: "vl-sampaloc", name: "Victory Liner Sampaloc", city: "Manila" },
  { slug: "gen-cubao", name: "Genesis Cubao", city: "Quezon City" },
  { slug: "gen-pasay", name: "Genesis Pasay", city: "Pasay" },
  { slug: "gen-avenida", name: "Genesis Avenida", city: "Manila" },
  { slug: "sn-cubao", name: "Solid North Cubao", city: "Quezon City" },
  { slug: "pitx", name: "PITX", city: "Paranaque" },
  { slug: "vl-baguio", name: "Victory Liner Baguio", city: "Baguio" },
  { slug: "gen-baguio", name: "Genesis Baguio (Gov. Pack Rd)", city: "Baguio" },
  { slug: "sn-baguio", name: "Solid North Baguio (Gov. Pack Rd)", city: "Baguio" },
].map((t) => ({ ...t, address: null, lat: null, lng: null }));

function params(href: string) {
  return new URL(href).searchParams;
}

// B1
test("maps link falls back to name and city", () => {
  assert.equal(
    googleMapsUrl(CUBAO),
    "https://www.google.com/maps/dir/?api=1&destination=Victory+Liner+Cubao%2C+Quezon+City&travelmode=transit",
  );
  assert.equal(
    googleMapsUrl({ ...CUBAO, address: null, lat: null, lng: null }),
    "https://www.google.com/maps/dir/?api=1&destination=Victory+Liner+Cubao%2C+Quezon+City&travelmode=transit",
  );
});

// B2
test("names with parentheses and periods are encoded and round-trip", () => {
  const href = googleMapsUrl(GEN_BAGUIO);
  assert.equal(
    href,
    "https://www.google.com/maps/dir/?api=1&destination=Genesis+Baguio+%28Gov.+Pack+Rd%29%2C+Baguio&travelmode=transit",
  );
  assert.equal(params(href).get("destination"), "Genesis Baguio (Gov. Pack Rd), Baguio");
});

test("URL metacharacters can't inject parameters", () => {
  const name = 'A&B #1 / 50% = "x"? ñ';
  const href = googleMapsUrl({ slug: "x", name, city: "Manila" });
  const p = params(href);
  assert.equal(p.get("destination"), `${name}, Manila`);
  assert.deepEqual([...p.keys()], ["api", "destination", "travelmode"]);
  const raw = href.split("destination=")[1].split("&travelmode=")[0];
  assert.doesNotMatch(raw, /[ #"&]/);
});

// B3
test("address goes between name and city; blank address is skipped", () => {
  const withAddress = { ...CUBAO, address: "EDSA cor. New York St" };
  assert.equal(mapsDestination(withAddress), "Victory Liner Cubao, EDSA cor. New York St, Quezon City");
  assert.equal(params(googleMapsUrl(withAddress)).get("destination"), "Victory Liner Cubao, EDSA cor. New York St, Quezon City");
  for (const address of ["", "   ", null, undefined]) {
    assert.equal(mapsDestination({ ...CUBAO, address }), "Victory Liner Cubao, Quezon City", JSON.stringify(address));
  }
});

// B4
test("coordinates win over name text", () => {
  const href = googleMapsUrl({ ...GEN_BAGUIO, address: "Gov. Pack Rd", lat: 16.4136, lng: 120.596 });
  assert.equal(
    href,
    "https://www.google.com/maps/dir/?api=1&destination=16.4136%2C120.596&travelmode=transit",
  );
  assert.equal(params(href).get("destination"), "16.4136,120.596");
  assert.equal(params(googleMapsUrl({ ...CUBAO, lat: 14.6206, lng: 121.053 })).get("destination"), "14.6206,121.053");
});

test("half, NaN or 0,0 coordinates fall back to the name", () => {
  const cases: [number | null | undefined, number | null | undefined][] = [
    [14.6, null],
    [null, 121.0],
    [14.6, undefined],
    [NaN, 121.0],
    [14.6, NaN],
    [Infinity, 121.0],
    [0, 0],
  ];
  for (const [lat, lng] of cases) {
    const place = { ...CUBAO, lat, lng };
    assert.equal(hasCoordinates(place), false, `${lat},${lng}`);
    assert.equal(mapsDestination(place), "Victory Liner Cubao, Quezon City", `${lat},${lng}`);
  }
  assert.equal(hasCoordinates({ ...CUBAO, lat: 14.6, lng: 121.0 }), true);
  assert.equal(hasCoordinates({ ...CUBAO, lat: 0, lng: 121.0 }), true);
});

// B5
test("every maps link has the documented shape", () => {
  const long = { ...CUBAO, name: "N".repeat(300), address: "A".repeat(300) };
  const places = [...SEED, long, { ...CUBAO, lat: 14.6, lng: 121.0 }];
  for (const place of places) {
    const href = googleMapsUrl(place);
    assert.ok(href.startsWith("https://www.google.com/maps/dir/?api=1&"), href);
    assert.ok(href.startsWith(MAPS_DIR_BASE + "?"), href);
    const p = params(href);
    assert.equal(p.get("api"), "1");
    assert.equal(p.get("travelmode"), "transit");
    assert.equal(p.has("origin"), false);
    assert.ok(href.length < 2048, `${place.slug}: ${href.length}`);
  }
});

// B6 (Sakay deep link not verifiable, so always the home page; see plan.md)
test("sakay link is always the home page", () => {
  assert.equal(SAKAY_HOME, "https://sakay.ph");
  for (const place of [CUBAO, GEN_BAGUIO, { ...CUBAO, lat: 14.6, lng: 121.0, address: "EDSA" }]) {
    assert.equal(sakayUrl(place), "https://sakay.ph");
  }
});

test("sakay shows for Metro Manila origins only", () => {
  assert.equal(showSakay("Baguio"), false);
  assert.equal(showSakay(" Baguio "), false);
  for (const city of ["Quezon City", "Pasay", "Manila", "Caloocan", "Paranaque"]) {
    assert.equal(showSakay(city), true, city);
  }
});

// B7 (exact copy from ux.md)
test("accessible names", () => {
  assert.equal(mapsLabel("Victory Liner Cubao"), "Google Maps directions to Victory Liner Cubao, opens in a new tab");
  assert.equal(
    mapsLabel("Genesis Baguio (Gov. Pack Rd)"),
    "Google Maps directions to Genesis Baguio (Gov. Pack Rd), opens in a new tab",
  );
  assert.equal(sakayLabel(), "Sakay.ph home page, opens in a new tab");
});

// B8
test("withTerminalData uses the API's address and coordinates", () => {
  const api = { ...CUBAO, address: "EDSA cor. New York St", lat: 14.6, lng: 121.0 };
  const merged = withTerminalData(CUBAO, api);
  assert.equal(merged.slug, "vl-cubao");
  assert.equal(merged.name, "Victory Liner Cubao");
  assert.equal(merged.city, "Quezon City");
  assert.equal(merged.address, "EDSA cor. New York St");
  assert.equal(merged.lat, 14.6);
  assert.equal(merged.lng, 121.0);
  const zeroLat = withTerminalData(CUBAO, { ...CUBAO, lat: 0, lng: 121.0 });
  assert.equal(zeroLat.lat, 0);
  assert.equal(zeroLat.lng, 121.0);
});

test("withTerminalData keeps the trip's fields when the API has nothing", () => {
  for (const api of [undefined, null, { ...CUBAO, address: null, lat: null, lng: null }]) {
    const merged = withTerminalData(CUBAO, api);
    assert.equal(merged.name, "Victory Liner Cubao");
    assert.equal(merged.city, "Quezon City");
    assert.equal(hasCoordinates(merged), false);
    assert.equal(params(googleMapsUrl(merged)).get("destination"), "Victory Liner Cubao, Quezon City");
  }
});

test("withTerminalData never mutates its inputs", () => {
  const trip = { ...CUBAO };
  const api = { ...CUBAO, address: "EDSA", lat: 14.6, lng: 121.0 };
  const tripCopy = structuredClone(trip);
  const apiCopy = structuredClone(api);
  const merged = withTerminalData(trip, api);
  assert.deepEqual(trip, tripCopy);
  assert.deepEqual(api, apiCopy);
  assert.notEqual(merged, trip);
  assert.notEqual(merged, api);
});

// B8 with a slug lookup, as TerminalLinks does: always the trip's origin terminal, both directions.
test("links target the trip's origin terminal in both directions", () => {
  const terminals = new Map<string, TerminalPlace>([
    ["vl-cubao", { ...CUBAO, lat: 14.6, lng: 121.0 }],
    ["vl-baguio", { slug: "vl-baguio", name: "Victory Liner Baguio", city: "Baguio", lat: 16.4, lng: 120.6 }],
  ]);
  const toBaguio = { origin_slug: "vl-cubao", origin_name: "Victory Liner Cubao", origin_city: "Quezon City" };
  const toManila = { origin_slug: "vl-baguio", origin_name: "Victory Liner Baguio", origin_city: "Baguio" };
  const link = (t: typeof toBaguio) =>
    googleMapsUrl(
      withTerminalData({ slug: t.origin_slug, name: t.origin_name, city: t.origin_city }, terminals.get(t.origin_slug)),
    );
  assert.equal(params(link(toBaguio)).get("destination"), "14.6,121");
  assert.equal(params(link(toManila)).get("destination"), "16.4,120.6");
});

test("coordinates arriving in /terminals upgrade the link with no code change", () => {
  const before = new Map(SEED.map((t) => [t.slug, t]));
  const after = new Map(before);
  after.set("vl-cubao", { ...before.get("vl-cubao")!, lat: 14.6, lng: 121.0 });
  assert.equal(params(googleMapsUrl(withTerminalData(CUBAO, before.get("vl-cubao")))).get("destination"), "Victory Liner Cubao, Quezon City");
  assert.equal(params(googleMapsUrl(withTerminalData(CUBAO, after.get("vl-cubao")))).get("destination"), "14.6,121");
});

test("unknown slug falls back to the trip's own name", () => {
  const terminals = new Map(SEED.map((t) => [t.slug, t]));
  const trip = { slug: "new-terminal", name: "New Terminal", city: "Pasay" };
  const href = googleMapsUrl(withTerminalData(trip, terminals.get(trip.slug)));
  assert.equal(params(href).get("destination"), "New Terminal, Pasay");
  assert.equal(params(href).get("travelmode"), "transit");
});

const source = readFileSync(new URL("./mapLinks.ts", import.meta.url), "utf8");

test("mapLinks.ts is a plain module", () => {
  assert.doesNotMatch(source, /^\s*import\b/m);
  assert.doesNotMatch(source, /\bimport\s*\(/);
  assert.doesNotMatch(source, /@\//);
  assert.doesNotMatch(source, /use client/);
  assert.doesNotMatch(source, /\benum\s/);
  assert.doesNotMatch(source, /\bnamespace\s/);
  assert.doesNotMatch(source, /<\/[A-Za-z]|\/>/); // no JSX (closing or self-closing tags)
  assert.doesNotMatch(source, /\bconsole\./);
});

// RED audit S1: TerminalLinks.tsx has no component runner until TG-18, so guard its source.
const component = readFileSync(new URL("../components/TerminalLinks.tsx", import.meta.url), "utf8");
const anchors = [...component.matchAll(/<a\b[\s\S]*?<\/a>/g)];

test("TerminalLinks: every link opens a new tab safely and is named by the label helpers", () => {
  assert.equal(anchors.length, 2);
  for (const [a] of anchors) {
    assert.match(a, /target="_blank"/);
    assert.match(a, /rel="noopener noreferrer"/);
    assert.match(a, /aria-label=\{(mapsLabel|sakayLabel)\(/);
  }
  assert.equal(component.match(/<a\b/g)?.length, 2);
  assert.doesNotMatch(component, /aria-live/);
  assert.doesNotMatch(component, /\bconsole\./);
});

test("TerminalLinks: the Sakay link renders only under showSakay", () => {
  const sakay = anchors.filter(([a]) => a.includes("sakayUrl("));
  const maps = anchors.filter(([a]) => a.includes("googleMapsUrl("));
  assert.equal(sakay.length, 1);
  assert.equal(maps.length, 1);
  assert.match(sakay[0][0], /aria-label=\{sakayLabel\(/);
  assert.match(maps[0][0], /aria-label=\{mapsLabel\(/);
  const before = component.slice(0, sakay[0].index);
  assert.match(before, /\{showSakay\(city\) && \(\s*$/);
});
