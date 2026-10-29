"use client";

import { useReducer, useState, useSyncExternalStore } from "react";
import { manilaToday, searchTrips, type Trip } from "@/lib/api";
import {
  emptyMessage,
  endpoints,
  initialSearchState,
  resultsHeading,
  searchReducer,
  swapLabel,
} from "@/lib/direction";
import { PX, PixelBox, PixelButton } from "@/components/pixel";
import TripCard from "@/components/TripCard";

const subscribeNothing = () => () => {};

/** "YYYY-MM-DD" plus n days, computed in UTC so the device's time zone can't shift the day. */
function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export default function TripSearch() {
  // Today in Manila, read on the client only so the prerendered shell does not bake in a date
  const today = useSyncExternalStore(subscribeNothing, manilaToday, () => "");
  const [state, dispatch] = useReducer(searchReducer<Trip>, undefined, initialSearchState<Trip>);
  // Once the user empties the field (Chrome does that mid-edit, one segment at a time), stop falling back to
  // today, or React writes today back in and the keyboard edit is lost
  const [cleared, setCleared] = useState(false);
  const { direction, status, trips, searched } = state;
  const date = state.date || (cleared ? "" : today);
  // Native validation blocks submitting dates outside today to a year from now (Manila), e.g. a mistyped year 0008
  const minDate = today || undefined;
  const maxDate = today ? addDays(today, 365) : undefined;
  const { originCity, destinationCity } = endpoints(direction);

  async function onSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!date) return;
    const requestId = state.requestId + 1; // the id searchStarted gives this search
    dispatch({ type: "searchStarted", date });
    try {
      const found = await searchTrips({ originCity, destinationCity, date });
      dispatch({ type: "searchDone", requestId, trips: found });
    } catch {
      dispatch({ type: "searchFailed", requestId });
    }
  }

  return (
    <div className="flex flex-col gap-4 md:grid md:grid-cols-[20rem_minmax(0,1fr)] md:grid-rows-[auto_1fr] md:gap-6 md:items-start lg:grid-cols-[22rem_minmax(0,1fr)] lg:gap-8">
      <PixelBox as="form" onSubmit={onSearch} className="p-4 flex flex-col gap-3 md:row-span-2">
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-sm">
          <div className="min-w-0 break-words">
            <div className="text-muted">From</div>
            <div className="font-bold">{originCity}</div>
          </div>
          <PixelButton
            variant="iconBrand"
            onClick={() => dispatch({ type: "swap" })}
            disabled={status === "loading"}
            aria-label={swapLabel(direction)}
          >
            <span aria-hidden>⇄</span>
          </PixelButton>
          <div className="min-w-0 break-words text-right">
            <div className="text-muted">To</div>
            <div className="font-bold">{destinationCity}</div>
          </div>
        </div>
        {/* Rendered from the start, so only a change (a swap) is announced */}
        <p className="sr-only" aria-live="polite">
          From {originCity} to {destinationCity}
        </p>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Travel date</span>
          <input
            type="date"
            value={date}
            min={minDate}
            max={maxDate}
            onChange={(e) => {
              setCleared(e.target.value === "");
              dispatch({ type: "pickDate", date: e.target.value });
            }}
            className={PX.input}
            required
          />
        </label>
        <PixelButton variant="primary" type="submit" disabled={status === "loading" || !date}>
          {status === "loading" ? "Searching..." : "Tara, show buses"}
        </PixelButton>
      </PixelBox>

      {/* Status lines are announced; the cards stay outside so a screen reader doesn't read every one.
          empty:-mt-4 cancels its gap before the first status without hiding it (display:none would drop the live region) */}
      <div aria-live="polite" className="flex flex-col gap-1 empty:-mt-4">
        {status === "error" && (
          <PixelBox as="p" className="p-4 text-sm">
            Could not reach the schedule server. Check your connection and try again.
          </PixelBox>
        )}

        {status === "done" && searched && trips.length === 0 && (
          <PixelBox as="p" className="p-4 text-sm">
            {emptyMessage(searched.direction, searched.date)}
          </PixelBox>
        )}

        {status === "done" && searched && trips.length > 0 && (
          <>
            <h2 className={PX.dataHeading}>{resultsHeading(searched.direction, searched.date)}</h2>
            <p className="text-sm text-muted">
              {trips.length} trip{trips.length === 1 ? "" : "s"} · {trips[0].confirm_note}
            </p>
          </>
        )}
      </div>

      {status === "done" && trips.length > 0 && (
        <ul className="flex flex-col gap-3 md:grid md:grid-cols-[repeat(auto-fill,minmax(20rem,1fr))] md:gap-4">
          {trips.map((t) => (
            <TripCard key={t.trip_id} trip={t} />
          ))}
        </ul>
      )}
    </div>
  );
}
