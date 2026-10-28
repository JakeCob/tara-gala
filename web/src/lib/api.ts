import type { Itinerary } from "@/lib/itinerary";
import type { LastMileLeg } from "@/lib/lastMile";

export type Trip = {
  trip_id: string;
  operator_slug: string;
  operator_name: string;
  origin_slug: string;
  origin_name: string;
  origin_city: string;
  destination_slug: string;
  destination_name: string;
  destination_city: string;
  via: string | null;
  service_class: string;
  fare_php: number | null;
  travel_minutes: number | null;
  departure_time: string;
  arrives_around: string | null;
  arrives_day_offset: number | null;
  booking_url: string | null;
  source: string;
  source_url: string | null;
  last_verified_at: string | null;
  confirm_note: string;
};

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export async function searchTrips(params: {
  originCity: string;
  destinationCity: string;
  date: string;
}): Promise<Trip[]> {
  const q = new URLSearchParams({
    origin_city: params.originCity,
    destination_city: params.destinationCity,
    date: params.date,
  });
  const res = await fetch(`${API_URL}/trips?${q}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

/** Today's date in Manila as YYYY-MM-DD. */
export function manilaToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
}

export function formatClass(c: string): string {
  return c.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

export function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** " +1 day" style suffix for arrivals after midnight; empty for same day, unknown, or an older API without the field.
 * Starts with a non-breaking space so it never wraps away from the arrival time. */
export function formatDayOffset(offset: number | null | undefined): string {
  if (!offset) return "";
  return offset === 1 ? "\u00a0+1 day" : `\u00a0+${offset} days`;
}

export function formatVerified(iso: string | null): string {
  if (!iso) return "Not yet verified";
  const d = new Date(iso);
  return `Checked ${d.toLocaleDateString("en-PH", { month: "short", day: "numeric", timeZone: "Asia/Manila" })}`;
}

/** Last-mile legs in Baguio. Empty filters mean no filter; unknown slugs give []. */
export async function fetchLastMile(params: { terminal?: string; spot?: string }): Promise<LastMileLeg[]> {
  const q = new URLSearchParams();
  if (params.terminal) q.set("terminal", params.terminal);
  if (params.spot) q.set("spot", params.spot);
  const res = await fetch(`${API_URL}/last-mile?${q}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

/** One saved plan by its share slug (TG-23); null when there's no such plan. Runs in the browser, so the TG-27
    service worker caches it for offline use. Network errors propagate: the page shows "try again", not the 404. */
export async function fetchItinerary(slug: string): Promise<Itinerary | null> {
  const res = await fetch(`${API_URL}/itineraries/${encodeURIComponent(slug)}`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}
