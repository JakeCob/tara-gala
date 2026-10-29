// Pre-made trip card data (TG-21): the text on each card in the "Trip ideas" list. Plain module.
import type { PremadeResult, PremadeSummary } from "./api.ts";
import { dateRange, formatPeso } from "./itinerary.ts";
import { PLAN_COPY, matchesDates, premadeMeta, premadePlaces } from "./planForm.ts";

export type PremadeCard = { title: string; matches: boolean; dates: string; places: string; budget: string | null; href: string };

// No fare totals, per-person costs or "fits your budget": we don't have the numbers to back them (ux §6.1)
export function premadeCard(s: PremadeSummary, date: string, ret: string): PremadeCard {
  const peso = formatPeso(s.budget_php);
  return {
    title: s.vibe ?? PLAN_COPY.list.untitled,
    matches: matchesDates(s, date, ret),
    dates: dateRange(s.trip_date, s.return_date) + premadeMeta(s.day_count, s.stop_count),
    places: premadePlaces(s.spot_names),
    budget: peso ? `Budget ${peso}` : null,
    href: `/i/${encodeURIComponent(s.share_slug)}`,
  };
}

export type LandingCard = Omit<PremadeCard, "matches">;
export type LandingPremadeView = {
  state: "loading" | "list" | "empty" | "offline" | "failed" | "hidden";
  cards?: LandingCard[];
};

/** A landing card (TG-46): the same text, with no date to match against. */
export function landingCard(s: PremadeSummary): LandingCard {
  const { title, dates, places, budget, href } = premadeCard(s, "", "");
  return { title, dates, places, budget, href };
}

/** The landing's ready-made section for one fetch outcome; null while it loads. */
export function landingPremadeView(result: PremadeResult | null, online: boolean): LandingPremadeView {
  if (result === null) return { state: "loading" };
  if (result.kind === "unavailable") return { state: "hidden" };
  if (result.kind === "failed") return { state: online ? "failed" : "offline" };
  if (result.list.length === 0) return { state: "empty" };
  return { state: "list", cards: result.list.map(landingCard) };
}
