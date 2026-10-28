// Pre-made trip card data (TG-21): the text on each card in the "Trip ideas" list. Plain module.
import type { PremadeSummary } from "./api.ts";
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
