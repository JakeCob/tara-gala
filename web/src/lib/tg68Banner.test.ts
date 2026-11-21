// TG-68 part 3 (ux.md §3, audit §2.9): on a wallet (/w/…) the offline banner talks about expenses, not schedules.
// Every other page keeps TG-27's four strings (offline.test.ts T27-13, unedited).
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bannerText, type Variant } from "./offline.ts";

const TZS = ["America/Los_Angeles", "Pacific/Kiritimati", "Asia/Manila"];
const SAVED = "2026-11-24T23:02:00.000Z"; // Nov 25, 7:02 AM in Manila
const originalTZ = process.env.TZ;
afterEach(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});
// The third argument is new in TG-68: the page's path
const text = bannerText as (v: Variant, savedAt: string | null, pathname?: string | null) => { lead: string; rest: string };
const full = (v: Variant, savedAt: string | null, path?: string | null) => {
  const { lead, rest } = text(v, savedAt, path);
  return lead + rest;
};

test("TG68-B1 on /w/: A, B and D say what happens to expenses (ux §3's table), in every time zone", () => {
  for (const tz of TZS) {
    process.env.TZ = tz;
    for (const path of ["/w/abc123", "/w/" + "a".repeat(32)]) {
      assert.equal(full("A", SAVED, path), "Offline · saved Nov 25, 7:02 AM · expenses you add won't save until there's signal", `${tz} ${path}`);
      assert.equal(full("B", SAVED, path), "Can't reach the server · saved Nov 25, 7:02 AM · expenses you add won't save until it's back", tz);
      assert.equal(full("D", SAVED, path), "Back online · saved Nov 25, 7:02 AM · tap Refresh for the latest", tz);
    }
  }
});

test("TG68-B2 on /w/ the lead is still split out for bold, and an unknown saved time still says so", () => {
  assert.equal(text("A", SAVED, "/w/abc").lead, "Offline");
  assert.equal(text("B", SAVED, "/w/abc").lead, "Can't reach the server");
  assert.equal(text("D", SAVED, "/w/abc").lead, "Back online");
  assert.equal(full("A", null, "/w/abc"), "Offline · saved time unknown · expenses you add won't save until there's signal");
});

test("TG68-B3 every other page keeps today's four strings: the trip, home, the planner, the wallet list, and no path", () => {
  process.env.TZ = "Asia/Manila";
  for (const path of ["/t/abc123", "/", "/plan", "/wallet", "/i/x", "/whatever/w/abc", null, undefined]) {
    const p = String(path);
    assert.equal(full("A", SAVED, path), "Offline · saved Nov 25, 7:02 AM · schedules may have changed", p);
    assert.equal(full("B", SAVED, path), "Can't reach the server · saved Nov 25, 7:02 AM · schedules may have changed", p);
    assert.equal(full("C", SAVED, path), "Offline · searching needs a connection", p);
    assert.equal(full("D", SAVED, path), "Back online · saved Nov 25, 7:02 AM · search again for the latest times", p);
  }
});

test("TG68-B4 OfflineBanner hands bannerText its pathname", () => {
  const src = readFileSync(new URL("../components/OfflineBanner.tsx", import.meta.url), "utf8");
  assert.match(src, /bannerText\(variant, state\.savedAt, pathname\)/);
});
