// Last-mile types and display helpers (TG-17). Mirrors api/app/last_mile.py.
// Pure TS with no imports so `node --test` can run it with type stripping.

export type Place = { kind: "terminal" | "spot"; id: string; slug: string; name: string; lat: number | null; lng: number | null };

export type Spot = {
  spot_id: string;
  slug: string;
  name: string;
  city: string;
  category: string;
  lat: number | null;
  lng: number | null;
  description: string | null;
  visit_minutes: number | null;
  opening_hours: Record<string, unknown> | null; // raw jsonb, not parsed yet
  entrance_fee_php: number | null;
};

export type LastMileLeg = {
  last_mile_route_id: string;
  origin: Place;
  destination: Place;
  mode: string;
  signboard: string | null;
  boarding_point: string | null;
  alighting_point: string | null;
  fare_min_php: number | null;
  fare_max_php: number | null;
  minutes: number | null;
  notes: string | null;
  source: string;
  last_verified_at: string | null;
  confirm_note: string;
};

// Seeded in supabase/schema.sql; hard-coded so the picker works with no request and no data.
export const BAGUIO_TERMINALS = [
  { slug: "vl-baguio", label: "Victory Liner" },
  { slug: "gen-baguio", label: "Genesis / Joy Bus" },
  { slug: "sn-baguio", label: "Solid North" },
] as const;

const MODE_LABELS: Record<string, string> = {
  jeep: "Jeepney",
  taxi: "Taxi",
  walk: "Walk",
  tricycle: "Tricycle",
  van: "Van",
  grab: "Grab",
};

export function modeLabel(mode: string): string {
  return MODE_LABELS[mode] ?? mode.charAt(0).toUpperCase() + mode.slice(1);
}

function peso(n: number): string {
  const whole = Number.isInteger(n);
  return n.toLocaleString("en-PH", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
}

/** "₱13–15", "₱13", "₱13+", "up to ₱15", or "" when no fare is on file (never "₱0"). */
export function formatFare(min: number | null, max: number | null): string {
  if (min == null && max == null) return "";
  if (min == null) return `up to ₱${peso(max!)}`;
  if (max == null) return `₱${peso(min)}+`;
  if (min === max) return `₱${peso(min)}`;
  return `₱${peso(min)}–${peso(max)}`;
}

/** "15 min", "1 h", "1 h 15 min", or "" when unknown. */
export function formatMinutes(minutes: number | null): string {
  if (!minutes) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Groups legs by destination, keeping the API's order of groups and of legs within them. */
export function groupByDestination(legs: LastMileLeg[]): { destination: Place; legs: LastMileLeg[] }[] {
  const groups = new Map<string, { destination: Place; legs: LastMileLeg[] }>();
  for (const leg of legs) {
    const key = `${leg.destination.kind}:${leg.destination.slug}`;
    const group = groups.get(key);
    if (group) group.legs.push(leg);
    else groups.set(key, { destination: leg.destination, legs: [leg] });
  }
  return [...groups.values()];
}
