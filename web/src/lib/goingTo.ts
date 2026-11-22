// TG-71 (flag goingTo, NEXT_PUBLIC_GOING_TO): the "Going to" city picker on /buses and /plan (TG-71 ux.md §7.2).
// Pure TS so `node --test` runs it. The cities are the Around tab's (around.ts), in its order, until the city registry
// (plan B2, cities.json) replaces that list. Flag off, nothing here is used, so both pages are today's.
import { AROUND_CITIES } from "./around.ts";
import { DEFAULT_CITY } from "./direction.ts";
import type { PremadeView } from "./planForm.ts";

/** ux.md §8 BUSES_PICK: the picker's legend, on /buses and /plan */
export const GOING_TO_LEGEND = "Going to";

/** The cities to pick from, in AROUND_CITIES order. The first is Baguio, where both pickers start. */
export const GOING_TO_CITIES: readonly string[] = AROUND_CITIES.map((c) => c.name);

export { DEFAULT_CITY };

/**
 * Where a picker starts. ux.md §7.2's "the current trip's city" is skipped for now: a phone's opened trips
 * (trip.ts KnownTrip) don't carry their city, so every picker starts on Baguio, plan §12.6's fallback.
 */
export const START_CITY: string = DEFAULT_CITY;

/**
 * The cities /plan offers. The live AI planner (PLANNER_LIVE) builds Baguio plans only (api planner_context.py), so in
 * live mode, and with no form at all, there's nothing to pick and the picker hides; only the ready-made list has more.
 */
export function planCities(mode: "live" | "premade" | "none"): readonly string[] {
  return mode === "premade" ? GOING_TO_CITIES : [];
}

/**
 * The city /plan's length hint names and its ready-made list keeps: the picked one on the ready-made list, Baguio for
 * the live planner (its only city), and null with no form, so the hint stays as it is without the flag.
 */
export function planCity(mode: "live" | "premade" | "none", picked: string): string | null {
  if (mode === "none") return null;
  return mode === "premade" && GOING_TO_CITIES.includes(picked) ? picked : DEFAULT_CITY;
}

/** A ready-made trip's city. One from an API older than TG-72 has none, and every plan was Baguio then. */
export const premadeCity = (s: { city?: string }): string => s.city ?? DEFAULT_CITY;

/** The ready-made list for one city, order kept. An empty result reads as "empty", so its box can name the city. */
export function premadeForCity(view: PremadeView, city: string): PremadeView {
  if (view.kind !== "list") return view;
  const list = view.list.filter((s) => premadeCity(s) === city);
  return list.length ? { kind: "list", list } : { kind: "empty" };
}

/** The empty box and status line once a city is picked, in place of PLAN_COPY.list.empty */
export const premadeEmpty = (city: string): string => `No ready-made trips for ${city} on file yet.`;
