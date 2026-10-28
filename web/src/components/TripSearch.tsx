"use client";

import { useReducer, useState, useSyncExternalStore } from "react";
import {
  formatClass,
  formatDayOffset,
  formatTime,
  formatVerified,
  manilaToday,
  searchTrips,
  type Trip,
} from "@/lib/api";
import {
  emptyMessage,
  endpoints,
  initialSearchState,
  resultsHeading,
  searchReducer,
  swapLabel,
} from "@/lib/direction";
import TerminalLinks from "@/components/TerminalLinks";
import { PX, PixelBox, PixelButton } from "@/components/pixel";

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
    <div className="flex flex-col gap-4">
      <PixelBox as="form" onSubmit={onSearch} className="p-4 flex flex-col gap-3">
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
        <ul className="flex flex-col gap-3">
          {trips.map((t) => (
            <TripCard key={t.trip_id} trip={t} />
          ))}
        </ul>
      )}
    </div>
  );
}

function TripCard({ trip: t }: { trip: Trip }) {
  return (
    <PixelBox as="li">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-2xl font-extrabold tabular-nums">{formatTime(t.departure_time)}</span>
        {t.fare_php != null && <span className="font-bold tabular-nums">₱{t.fare_php.toLocaleString("en-PH")}</span>}
      </div>
      <div className="text-sm">
        <span className="font-semibold">{t.operator_name}</span> · {formatClass(t.service_class)}
        {t.via ? ` · via ${t.via}` : ""}
      </div>
      <div className="text-sm text-muted">
        {t.origin_name} → {t.destination_name}
        {t.arrives_around ? (
          <>
            {` · arrives around ${formatTime(t.arrives_around)}`}
            {/* An overnight arrival is the easiest fact to misread, so the offset gets full contrast (TG-42 ux.md 3.3) */}
            <span className="font-semibold text-foreground">{formatDayOffset(t.arrives_day_offset)}</span>
          </>
        ) : (
          ""
        )}
      </div>
      <TerminalLinks slug={t.origin_slug} name={t.origin_name} city={t.origin_city} />
      <div className="flex items-center justify-between gap-2 pt-1 text-xs text-muted">
        <span>
          {formatVerified(t.last_verified_at)}
          {t.source_url && (
            <>
              {" · "}
              <a href={t.source_url} target="_blank" rel="noreferrer" className={PX.inlineLink}>
                source
              </a>
            </>
          )}
        </span>
        {t.booking_url ? (
          <a
            href={t.booking_url}
            target="_blank"
            rel="noreferrer"
            className="min-h-11 inline-flex items-center pixel-btn focus-pixel bg-accent px-3 text-sm font-bold text-accent-ink"
          >
            Book
          </a>
        ) : (
          <span>No booking link yet</span>
        )}
      </div>
    </PixelBox>
  );
}
