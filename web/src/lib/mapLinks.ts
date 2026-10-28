// "Get to the terminal" links (TG-14). Plain module with no imports so `node --test` can load it directly.
// Google Maps URLs: https://developers.google.com/maps/documentation/urls/get-started (directions action).

export type TerminalPlace = {
  slug: string;
  name: string;
  city: string;
  address?: string | null;
  lat?: number | null;
  lng?: number | null;
};

export const MAPS_DIR_BASE = "https://www.google.com/maps/dir/";
export const SAKAY_HOME = "https://sakay.ph";

/** True when both lat and lng are finite numbers and not the 0,0 placeholder. */
export function hasCoordinates(t: TerminalPlace): boolean {
  return Number.isFinite(t.lat) && Number.isFinite(t.lng) && !(t.lat === 0 && t.lng === 0);
}

/** "lat,lng" when known, else "name, address, city" with blank parts skipped. */
export function mapsDestination(t: TerminalPlace): string {
  if (hasCoordinates(t)) return `${t.lat},${t.lng}`;
  return [t.name, t.address, t.city]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(", ");
}

/** Transit directions from the device's location; with no `origin`, Maps uses where the phone is. */
export function googleMapsUrl(t: TerminalPlace): string {
  const q = new URLSearchParams({ api: "1", destination: mapsDestination(t), travelmode: "transit" });
  return `${MAPS_DIR_BASE}?${q}`;
}

/** Home page only: Sakay's documented `?to=lat,lng` link loses its query on the sakay.ph redirect (TG-14 plan). */
export function sakayUrl(_t: TerminalPlace): string {
  return SAKAY_HOME;
}

/** Sakay routes Metro Manila transit; every non-Baguio origin in the data is in Metro Manila. */
export function showSakay(city: string): boolean {
  return city.trim() !== "Baguio";
}

export function mapsLabel(name: string): string {
  return `Google Maps directions to ${name}, opens in a new tab`;
}

export function sakayLabel(): string {
  return "Sakay.ph home page, opens in a new tab";
}

/** The trip's own terminal fields, upgraded with address and coordinates from /terminals when it has them. */
export function withTerminalData(trip: TerminalPlace, api?: TerminalPlace | null): TerminalPlace {
  if (!api) return { ...trip };
  return {
    ...trip,
    address: api.address ?? trip.address,
    lat: api.lat ?? trip.lat,
    lng: api.lng ?? trip.lng,
  };
}
