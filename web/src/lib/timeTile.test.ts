// TG-49 PR 2, item 3 (ux §2): the departure-time tile. Source guards: the repo's tests run with no JSX.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
const WEB = new URL("../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, WEB), "utf8");
const CARD = "src/components/TripCard.tsx";
const TILE = "inline-block pixel-frame bg-accent px-2 py-0.5 text-2xl leading-tight font-extrabold tabular-nums text-accent-ink";
const tileValue = async () => ((await import("../components/pixel/classes.ts")).PX as unknown as { timeTile?: string }).timeTile;
test("T49P2-T1 PX.timeTile is exactly ux §2.1's string", async () => assert.equal(await tileValue(), TILE));
test("T49P2-T2 the card shows the time in the tile, centred against the fare; nothing else is inside it", () => {
  assert.match(read(CARD), /<div className="flex items-center justify-between gap-2">\s*<span className=\{PX\.timeTile\}>\{formatTime\(t\.departure_time\)\}<\/span>/);
  assert.doesNotMatch(read(CARD), /items-baseline/);
});
test("T49P2-T3 the tile is a sign, not a control (T13 can't see it through PX, so this pins it)", async () => {
  const tile = (await tileValue()) ?? "";
  assert.ok(tile, "PX.timeTile exists");
  for (const tok of tile.split(/\s+/)) assert.doesNotMatch(tok, /^(pixel-btn|focus-pixel|focus-pixel-within|min-h-11|cursor-|hover:|active:|focus:|shadow-|animate-)/, tok);
  const src = read(CARD);
  assert.match(src, /<span className=\{PX\.timeTile\}>/, "a span with className and nothing else: no handler, tabIndex or role");
  assert.doesNotMatch(src, /<(a|button|Link|PixelLink|PixelButton)\b[^>]*timeTile/);
});
test("T49P2-T4 one tile on the card; the arrival and the fare stay plain", () => {
  const src = read(CARD);
  assert.equal(src.match(/PX\.timeTile/g)?.length, 1);
  assert.match(src, /<span className="font-bold tabular-nums">₱\{t\.fare_php\.toLocaleString\("en-PH"\)\}<\/span>/);
  assert.match(src, /arrives around \$\{formatTime\(t\.arrives_around\)\}/);
});
test("T49P2-X1 the card reads only today's Trip fields, and nothing computed", () => {
  const src = read(CARD);
  assert.deepEqual([...new Set([...src.matchAll(/\bt\.(\w+)/g)].map((m) => m[1]))].sort(), ["arrives_around", "arrives_day_offset", "booking_url", "departure_time", "destination_name", "fare_php", "last_verified_at", "operator_name", "origin_city", "origin_name", "origin_slug", "service_class", "source_url", "via"]);
  assert.doesNotMatch(src, /\bDate\b|Math\.|Intl\.|useState|useEffect/, "nothing computed; \"Checked date\" in a comment is fine");
  assert.doesNotMatch(src, /leaving|next bus|seats?\b|countdown/i);
});
test("T49P2-D1 the confirm note and the Checked line stay where they are today", () => {
  const card = read(CARD);
  assert.doesNotMatch(card, /confirm_note/);
  assert.match(card, /formatVerified\(t\.last_verified_at\)/);
  assert.match(read("src/components/ItineraryList.tsx"), /<p className=\{PX\.meta\}>\{leg\.trip\.confirm_note\}<\/p>/);
  assert.match(read("src/components/WorldSheet.tsx"), /\{t\.confirm_note\}/);
  assert.match(read("src/components/TripSearch.tsx"), /\{trips\.length\} trip\{trips\.length === 1 \? "" : "s"\} · \{trips\[0\]\.confirm_note\}/);
});
test("T49P2-D2 the tile stays in the body font", async () => {
  const tile = (await tileValue()) ?? "";
  assert.ok(tile, "PX.timeTile exists");
  assert.doesNotMatch(tile, /font-(pixel|wordmark|sign)/);
});
test("T49P2-X2 the tile is only on the bus card", () => {
  const walk = (d: URL, o: URL[] = []): URL[] => { for (const n of readdirSync(d)) { const u = new URL(n, d); if (statSync(u).isDirectory()) walk(new URL(`${n}/`, d), o); else o.push(u); } return o; };
  assert.deepEqual(walk(new URL("src/", WEB)).filter((u) => u.pathname.endsWith(".tsx") && readFileSync(u, "utf8").includes("PX.timeTile")).map((u) => u.pathname.split("/src/").pop()), ["components/TripCard.tsx"]);
});
