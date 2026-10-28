// Search direction (Manila to Baguio and back) and the search form's state.
// Pure TS with no imports so `node --test` can run it with type stripping.

/** Same names as the scraper's --direction (scraper/victory_liner.py). */
export type Direction = "to-baguio" | "from-baguio";

export const DEFAULT_DIRECTION: Direction = "to-baguio";

// "Metro Manila" is both the label and the API value: the API maps it to every NCR terminal.
const ENDS: Record<Direction, { originCity: string; destinationCity: string }> = {
  "to-baguio": { originCity: "Metro Manila", destinationCity: "Baguio" },
  "from-baguio": { originCity: "Baguio", destinationCity: "Metro Manila" },
};

/** searchTrips() params for a direction. A fresh object each call. */
export function endpoints(d: Direction): { originCity: string; destinationCity: string } {
  return { ...ENDS[d] };
}

export function swapDirection(d: Direction): Direction {
  return d === "to-baguio" ? "from-baguio" : "to-baguio";
}

/** "Metro Manila → Baguio", for the eye. Screen-reader text uses words instead (swapLabel, the live region). */
export function routeLabel(d: Direction): string {
  return `${ENDS[d].originCity} → ${ENDS[d].destinationCity}`;
}

/** The swap button's accessible name: what tapping it will do. */
export function swapLabel(d: Direction): string {
  return `Swap direction, search ${ENDS[d].destinationCity} to ${ENDS[d].originCity} instead`;
}

/** "2026-11-08" -> "Sun, Nov 8". Read and formatted in UTC, so the day never shifts with the device's time zone. */
export function formatTravelDate(iso: string): string {
  if (!iso) return ""; // today is "" until it is read on the client
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** "Baguio → Metro Manila · Sun, Nov 8" */
export function resultsHeading(d: Direction, iso: string): string {
  return `${routeLabel(d)} · ${formatTravelDate(iso)}`;
}

export function emptyMessage(d: Direction, iso: string): string {
  return `No trips on file from ${ENDS[d].originCity} to ${ENDS[d].destinationCity} on ${formatTravelDate(iso)} yet.`;
}

export type SearchStatus = "idle" | "loading" | "done" | "error";

export type SearchState<T> = {
  direction: Direction;
  date: string; // the date the user picked, or "" (the form then shows today)
  status: SearchStatus;
  trips: T[];
  searched: { direction: Direction; date: string } | null; // the query the shown (or loading) results are for
  requestId: number;
};

export type SearchAction<T> =
  | { type: "swap" }
  | { type: "pickDate"; date: string }
  | { type: "searchStarted"; date: string }
  | { type: "searchDone"; requestId: number; trips: T[] }
  | { type: "searchFailed"; requestId: number };

export function initialSearchState<T>(): SearchState<T> {
  return { direction: DEFAULT_DIRECTION, date: "", status: "idle", trips: [], searched: null, requestId: 0 };
}

/**
 * searchStarted moves requestId on by one; the caller sends that id back with searchDone or searchFailed.
 * A reply whose id isn't the current one (a swap or a newer search came after it) returns the state unchanged,
 * so results are never shown under another direction's or date's heading.
 */
export function searchReducer<T>(state: SearchState<T>, action: SearchAction<T>): SearchState<T> {
  switch (action.type) {
    case "swap":
      // Keeps the date; drops any shown results and any search still in flight
      return {
        ...state,
        direction: swapDirection(state.direction),
        status: "idle",
        trips: [],
        searched: null,
        requestId: state.requestId + 1,
      };
    case "pickDate":
      // Shown results keep their own heading (searched.date) until the next search
      return { ...state, date: action.date };
    case "searchStarted":
      if (!action.date) return state;
      return {
        ...state,
        status: "loading",
        trips: [],
        searched: { direction: state.direction, date: action.date },
        requestId: state.requestId + 1,
      };
    case "searchDone":
      if (action.requestId !== state.requestId) return state;
      return { ...state, status: "done", trips: action.trips };
    case "searchFailed":
      if (action.requestId !== state.requestId) return state;
      return { ...state, status: "error", trips: [] };
  }
}
