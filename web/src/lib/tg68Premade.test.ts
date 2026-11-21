// TG-68 part 5 (ux.md §5, audit §2.8): home's ready-made cards show no dates (they're last month's); /plan's list keeps them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { landingCard, landingPremadeView, premadeCard } from "./premadeView.ts";
import type { PremadeSummary } from "./api.ts";

const summary = (over: Partial<PremadeSummary>): PremadeSummary =>
  ({
    share_slug: "premade-chill",
    vibe: "Chill",
    trip_date: "2026-11-06",
    return_date: "2026-11-08",
    day_count: 3,
    stop_count: 9,
    spot_names: ["Burnham Park (made up)"],
    budget_php: 6000,
    ...over,
  }) as PremadeSummary;

test("TG68-P1 a home card reads `3 days · 9 stops`: premadeMeta without its leading ` · `, and no dates", () => {
  assert.equal(landingCard(summary({})).dates, "3 days · 9 stops");
  assert.equal(landingCard(summary({ day_count: 1, stop_count: 1 })).dates, "1 day · 1 stop", "the same singulars");
  assert.equal(landingCard(summary({ day_count: 2, stop_count: 12 })).dates, "2 days · 12 stops");
  const shown = landingPremadeView({ kind: "ok", list: [summary({})] }, true).cards?.[0]?.dates;
  assert.equal(shown, "3 days · 9 stops", "the list home draws");
  assert.doesNotMatch(shown ?? "", /Nov|Fri|Sun|–/);
});

test("TG68-P2 /plan's card keeps its dates, to match them to the dates the person picked", () => {
  const card = premadeCard(summary({}), "2026-11-06", "2026-11-08");
  assert.equal(card.dates, "Fri, Nov 6 – Sun, Nov 8 · 3 days · 9 stops");
  assert.equal(card.matches, true);
});

test("TG68-P3 everything else on a home card is premadeCard's", () => {
  const s = summary({ share_slug: "a b/c" });
  const { title, places, budget, href } = premadeCard(s, "", "");
  const card = landingCard(s);
  assert.deepEqual({ ...card, dates: undefined }, { title, places, budget, href, dates: undefined });
  assert.ok(!("matches" in card));
});
