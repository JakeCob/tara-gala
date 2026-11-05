// TG-61 review M1 and M2: the TG-54 rule for the plan. A slug's plan now changes under it, so the screen holds the plan
// with its version, from one answer, and never lets an older answer, or another plan's, replace it.

import type { Guide } from "./guide.ts";
import type { PlanVersion } from "./planLines.ts";
import type { PlanBase, PlanSaved, Trip } from "./trip.ts";

/** The plan on screen: always from one ItineraryOut. seq is null for a shared plan, which has no versions. */
export type Shown = { slug: string; seq: number | null; guide: Guide | null; edited: boolean };

const todo = (): never => {
  throw new Error("TG-61: not built yet");
};
export const shownFrom = (_it: { share_slug: string; seq?: number | null; guide?: Guide | null; edited?: boolean }): Shown => todo();
export const baseOf = (_shown: Shown): PlanBase => todo();
export const acceptPlan = (_shown: Shown | null, _next: Shown, _sessionSlug: string | null): boolean => todo();
export const inStep = (_shown: Shown | null, _trip: Pick<Trip, "itinerary_slug" | "plan_edits">): boolean => todo();
export const canEdit = (_shown: Shown | null, _trip: Pick<Trip, "itinerary_slug" | "plan_edits">, _online: boolean, _writing: boolean): boolean => todo();
export const afterPlanSaved = (_trip: Trip, _saved: PlanSaved, _source: PlanVersion["source"], _now: string): Trip => todo();
