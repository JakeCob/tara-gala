// TG-61 review M1 and M2: the TG-54 rule for the plan. A slug's plan now changes under it, so the screen holds the plan
// with its version, from one answer, and never lets an older answer, or another plan's, replace it.

import type { Guide } from "./guide.ts";
import type { PlanVersion } from "./planLines.ts";
import type { PlanBase, PlanSaved, Trip } from "./trip.ts";

/** The plan on screen: always from one ItineraryOut. seq is null for a shared plan, which has no versions. */
export type Shown = { slug: string; seq: number | null; guide: Guide | null; edited: boolean };

const VERSIONS_KEPT = 5; // as SessionOut.plan_edits lists them

/** The plan on screen, from one answer: the live GET, the worker's saved copy, or a save's own answer. */
export function shownFrom(it: { share_slug: string; seq?: number | null; guide?: Guide | null; edited?: boolean }): Shown {
  return { slug: it.share_slug, seq: it.seq ?? null, guide: it.guide ?? null, edited: !!it.edited };
}

/** The base for the next change: always the plan on screen, so a change is never sent against a plan nobody saw (M1). */
export function baseOf(shown: Shown): PlanBase {
  return { itinerary_slug: shown.slug, seq: shown.seq ?? 0 };
}

/**
 * TG-54 for the plan (review M2): whether an answer may replace the plan on screen. Never another plan than the trip's
 * current one (a late answer for the shared plan once the copy exists), and never an older version of the same plan
 * (a slow GET, or the service worker's saved copy). A plan with no version only replaces another with none.
 */
export function acceptPlan(shown: Shown | null, next: Shown, sessionSlug: string | null): boolean {
  if (next.slug !== sessionSlug) return false;
  if (!shown || shown.slug !== next.slug || shown.seq === null) return true;
  return next.seq !== null && next.seq >= shown.seq;
}

/** Whether the plan on screen is the newest this phone knows of. R2: a shared plan (no edits yet) has a null seq. */
export function inStep(shown: Shown | null, trip: Pick<Trip, "itinerary_slug" | "plan_edits">): boolean {
  if (!shown || shown.slug !== trip.itinerary_slug) return false;
  const known = trip.plan_edits?.seq ?? null;
  return known === null ? shown.seq === null : shown.seq === known;
}

/** Edit controls: online, no plan write out, and the newest known plan on screen. Otherwise taps are ignored (ux §3.3). */
export function canEdit(shown: Shown | null, trip: Pick<Trip, "itinerary_slug" | "plan_edits">, online: boolean, writing: boolean): boolean {
  return online && !writing && !!shown?.guide && inStep(shown, trip);
}

/**
 * R1: a save's answer comes from a write under the session's lock, so its plan is the trip's current one. The trip on
 * screen takes its slug and version at once, rather than waiting on the session's refetch to say so.
 */
export function afterPlanSaved(trip: Trip, saved: PlanSaved, source: PlanVersion["source"], now: string): Trip {
  const seq = saved.itinerary.seq ?? 0;
  const versions = [{ seq, source, changes: saved.changes, created_at: now }, ...(trip.plan_edits?.versions ?? []).filter((v) => v.seq < seq)];
  return { ...trip, itinerary_slug: saved.itinerary.share_slug, plan_edits: { seq, versions: versions.slice(0, VERSIONS_KEPT) } };
}
