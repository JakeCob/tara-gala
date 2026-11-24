// Pre-trip check 2026-11-23: Around → Sagada saves every start's legs while there's signal, so a start nobody tapped
// online still opens offline. Source pins, like tg72.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AROUND_CITIES } from "./around.ts";

const WEB = new URL("../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, WEB), "utf8");

test("WarmLegs asks for every start with LastMile's own params, only with signal, and logs the count", () => {
  const s = read("src/components/WarmLegs.tsx");
  const lm = read("src/components/LastMile.tsx");
  const params = 's.kind === "spot" ? { spot: s.slug } : { terminal: s.slug }';
  assert.ok(s.includes(`fetchLastMile(${params})`), "the same URL LastMile asks for, so the saved copy is the one it reads");
  assert.ok(lm.includes('fetchLastMile(start.kind === "spot" ? { spot: slug } : { terminal: slug })'), "LastMile's request is unchanged");
  assert.match(s, /city\.starts/);
  assert.match(s, /if \(!navigator\.onLine\) return;/);
  assert.match(s, /console\.info\("\[tg-around\] warm city=%s ok=%d of=%d"/);
  assert.match(s, /return null;/);
});

test("the city page mounts WarmLegs for every city but Baguio, whose page still asks for nothing until a tap", () => {
  const page = read("src/app/around/[city]/page.tsx");
  assert.match(page, /\{city\.slug !== "baguio" && <WarmLegs city=\{city\} \/>\}/);
  assert.equal(page.match(/<WarmLegs\b/g)?.length, 1);
  assert.doesNotMatch(read("src/components/LastMile.tsx"), /WarmLegs|useEffect/, "LastMile itself is untouched (T49P2-E3)");
  assert.ok(AROUND_CITIES.some((c) => c.slug === "sagada" && c.starts.length === 2), "Sagada has two starts to save");
});
