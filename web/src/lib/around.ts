// TG-71/72 (flag aroundTab): the Around tab's cities, each with its own Getting around page, and the site words that
// stop saying only "Manila to Baguio". Pure TS so `node --test` runs it. Words follow TG-71 ux.md §7 and §8, minus the
// own-plan invites: own plans aren't built yet (TG-71, after the owner's trip), so nothing here promises them.
import { BAGUIO_TERMINALS } from "./lastMile.ts";
import { BAGUIO_IDLE_COPY, BAGUIO_IDLE_ROW } from "./baguioIdle.ts";
import type { DecorShow } from "./homeDecor.ts";
import type { SpriteName } from "./sprites.ts";

/** Where a group can start on a city's page: a terminal (legs that start there) or a spot (legs that leave it). */
export type AroundStart = { kind: "terminal" | "spot"; slug: string; label: string };

export type AroundCity = {
  slug: string;
  name: string;
  /** The card's line on /around, and the city page's intro. Only modes the city's data has. */
  blurb: string;
  legend: string;
  starts: readonly AroundStart[];
  idle: { lead: string; line: string };
  /** The idle box's decor, left to right: the city's own rides and places (names unique: they're the React keys) */
  idleRow: readonly { name: SpriteName; show: DecorShow }[];
  empty: string;
};

export const AROUND_CITIES: readonly AroundCity[] = [
  {
    slug: "baguio",
    name: "Baguio",
    blurb: "Jeeps, taxis and walks from the bus terminal to the top spots.", // today's /baguio intro, byte for byte
    legend: "Which terminal does your bus arrive at?",
    starts: BAGUIO_TERMINALS.map((t) => ({ kind: "terminal" as const, slug: t.slug, label: t.label })),
    idle: BAGUIO_IDLE_COPY,
    idleRow: BAGUIO_IDLE_ROW,
    empty: "No routes on file yet for this terminal.",
  },
  {
    slug: "sagada",
    name: "Sagada",
    // TG-67's data has walks and vans only (data/last_mile_routes.csv, data/sagada-coda/), so the line says just those
    blurb: "Walks and vans from the town centre to the caves, falls and viewpoints.",
    legend: "Where are you starting from?",
    starts: [
      { kind: "terminal", slug: "coda-sagada", label: "Coda Lines stop" },
      { kind: "spot", slug: "sagada-town-centre", label: "Town centre" },
    ],
    idle: { lead: "Tara, pick where you're starting above.", line: "We'll show the walks and vans from there to the top spots." },
    // walks and vans only, like its data; a church, a museum and a viewpoint, like its spots
    idleRow: [
      { name: "place-terminal", show: "all" },
      { name: "chibi-senior-lola-wave", show: "min375" },
      { name: "mode-walk", show: "all" },
      { name: "place-church", show: "md" },
      { name: "mode-van", show: "all" },
      { name: "place-museum", show: "md" },
      { name: "place-viewpoint", show: "all" },
    ],
    empty: "No routes on file yet from here.",
  },
];

export const aroundCity = (slug: string): AroundCity | undefined => AROUND_CITIES.find((c) => c.slug === slug);

export const AROUND_WORDS = {
  tab: "Around",
  menu: "Getting around",
  title: "Getting around",
  intro: "Jeeps, taxis, vans and walks in the places we've checked, from the bus terminal to the top spots.",
  pageTitle: (city: string) => `Getting around ${city}`,
  // Owner, 2026-11-22: the app is for every province, so the site words name no city (only a city's own page does)
  /** The title screen's line, under the wordmark */
  tagline: "Provincial buses, straight from the operators.",
  /** /buses' hero line: true for whatever the search covers */
  heroLine: "Bus trips on file, with fares and where to book.",
  /** layout.tsx and manifest.ts */
  siteDescription: "Provincial bus times, how to get around once you're there, and an ambagan for the barkada's costs.",
} as const;

/** Legs that start at this start: a terminal's from the API as is; a spot's query also returns legs coming back to it. */
export function legsFrom<T extends { origin: { kind: string; slug: string } }>(legs: readonly T[], start: AroundStart): T[] {
  return start.kind === "terminal" ? [...legs] : legs.filter((l) => l.origin.kind === "spot" && l.origin.slug === start.slug);
}
