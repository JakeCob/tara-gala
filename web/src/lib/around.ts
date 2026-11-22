// TG-71/72 (flag aroundTab): the Around tab's cities, each with its own Getting around page, and the site words that
// stop saying only "Manila to Baguio". Pure TS so `node --test` runs it. Words follow TG-71 ux.md §7 and §8, minus the
// own-plan invites: own plans aren't built yet (TG-71, after the owner's trip), so nothing here promises them.
import { BAGUIO_TERMINALS } from "./lastMile.ts";
import { BAGUIO_IDLE_COPY } from "./baguioIdle.ts";

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
    empty: "No routes on file yet from here.",
  },
];

export const aroundCity = (slug: string): AroundCity | undefined => AROUND_CITIES.find((c) => c.slug === slug);

/** "Baguio and Sagada", then "Baguio, Sagada and Vigan". */
export function andList(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const CITIES = andList(AROUND_CITIES.map((c) => c.name));

export const AROUND_WORDS = {
  tab: "Around",
  menu: "Getting around",
  title: "Getting around",
  intro: "Jeeps, taxis, vans and walks in the places we've checked, from the bus terminal to the top spots.",
  pageTitle: (city: string) => `Getting around ${city}`,
  /** The title screen's line, under the wordmark */
  tagline: `${CITIES} buses, straight from the operators.`,
  /** /buses' hero line. The search itself is still Manila ⇄ Baguio until its city picker (TG-71 §7.2) */
  heroLine: `Bus times for ${CITIES}, with fares and where to book.`,
  /** layout.tsx and manifest.ts */
  siteDescription: `Bus times for ${CITIES}, how to get around once you're there, and a shared wallet for the barkada.`,
} as const;

/** Legs that start at this start: a terminal's from the API as is; a spot's query also returns legs coming back to it. */
export function legsFrom<T extends { origin: { kind: string; slug: string } }>(legs: readonly T[], start: AroundStart): T[] {
  return start.kind === "terminal" ? [...legs] : legs.filter((l) => l.origin.kind === "spot" && l.origin.slug === start.slug);
}
