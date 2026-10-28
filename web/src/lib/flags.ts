// Feature flags from NEXT_PUBLIC_* env vars. See README section 7.
// Pure TS with no imports so `node --test` can run it with type stripping.

export type Flags = { plannerLive: boolean; premadeItineraries: boolean; realMap: boolean };

export const FLAG_DEFAULTS: Flags = { plannerLive: false, premadeItineraries: true, realMap: false };

const TRUE_WORDS = ["1", "true", "yes", "on"];
const FALSE_WORDS = ["0", "false", "no", "off"];

/** Same rules as api/app/flags.py; unset, empty or unknown values give the fallback (silently). */
export function parseFlag(raw: string | undefined, fallback: boolean): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  if (TRUE_WORDS.includes(value)) return true;
  if (FALSE_WORDS.includes(value)) return false;
  return fallback;
}

/**
 * Each flag must be read as a literal process.env.NEXT_PUBLIC_* access: Next inlines only those
 * at build time. A computed key or an alias of process.env stays undefined in the browser.
 */
export function readFlags(): Flags {
  return {
    plannerLive: parseFlag(process.env.NEXT_PUBLIC_PLANNER_LIVE, FLAG_DEFAULTS.plannerLive),
    premadeItineraries: parseFlag(process.env.NEXT_PUBLIC_PREMADE_ITINERARIES, FLAG_DEFAULTS.premadeItineraries),
    realMap: parseFlag(process.env.NEXT_PUBLIC_REAL_MAP, FLAG_DEFAULTS.realMap),
  };
}

/** Values baked in at `next build`. Components import this. */
export const flags: Flags = readFlags();
