"use client";

import { useState, useSyncExternalStore } from "react";
import {
  formatClass,
  formatDayOffset,
  formatTime,
  formatVerified,
  manilaToday,
  searchTrips,
  type Trip,
} from "@/lib/api";

type Status = "idle" | "loading" | "done" | "error";

const subscribeNothing = () => () => {};

export default function TripSearch() {
  // Today in Manila, read on the client only so the prerendered shell does not bake in a date
  const today = useSyncExternalStore(subscribeNothing, manilaToday, () => "");
  const [picked, setPicked] = useState<string | null>(null);
  const date = picked ?? today;
  const [trips, setTrips] = useState<Trip[]>([]);
  const [status, setStatus] = useState<Status>("idle");

  async function onSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!date) return;
    setStatus("loading");
    try {
      setTrips(await searchTrips({ originCity: "Metro Manila", destinationCity: "Baguio", date }));
      setStatus("done");
    } catch {
      setStatus("error");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={onSearch} className="rounded-2xl border border-border bg-card p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between text-sm">
          <div>
            <div className="text-muted">From</div>
            <div className="font-semibold">Metro Manila</div>
          </div>
          <div className="text-muted" aria-hidden>
            →
          </div>
          <div className="text-right">
            <div className="text-muted">To</div>
            <div className="font-semibold">Baguio</div>
          </div>
        </div>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Travel date</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setPicked(e.target.value)}
            className="rounded-lg border border-border bg-background px-3 py-2 text-base"
            required
          />
        </label>
        <button
          type="submit"
          disabled={status === "loading" || !date}
          className="rounded-xl bg-brand px-4 py-3 font-semibold text-brand-ink disabled:opacity-60"
        >
          {status === "loading" ? "Searching..." : "Tara, show buses"}
        </button>
      </form>

      {status === "error" && (
        <p className="rounded-xl border border-border bg-card p-4 text-sm">
          Could not reach the schedule server. Check your connection and try again.
        </p>
      )}

      {status === "done" && trips.length === 0 && (
        <p className="rounded-xl border border-border bg-card p-4 text-sm">
          No trips on file for this date yet.
        </p>
      )}

      {status === "done" && trips.length > 0 && (
        <>
          <p className="text-sm text-muted">
            {trips.length} trip{trips.length === 1 ? "" : "s"} · {trips[0].confirm_note}
          </p>
          <ul className="flex flex-col gap-3">
            {trips.map((t) => (
              <TripCard key={t.trip_id} trip={t} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function TripCard({ trip: t }: { trip: Trip }) {
  return (
    <li className="rounded-2xl border border-border bg-card p-4 flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-2xl font-bold tabular-nums">{formatTime(t.departure_time)}</span>
        {t.fare_php != null && <span className="font-semibold">₱{t.fare_php.toLocaleString("en-PH")}</span>}
      </div>
      <div className="text-sm">
        <span className="font-semibold">{t.operator_name}</span> · {formatClass(t.service_class)}
        {t.via ? ` · via ${t.via}` : ""}
      </div>
      <div className="text-sm text-muted">
        {t.origin_name} → {t.destination_name}
        {t.arrives_around
          ? ` · arrives around ${formatTime(t.arrives_around)}${formatDayOffset(t.arrives_day_offset)}`
          : ""}
      </div>
      <div className="flex items-center justify-between gap-2 pt-1 text-xs text-muted">
        <span>
          {formatVerified(t.last_verified_at)}
          {t.source_url && (
            <>
              {" · "}
              <a href={t.source_url} target="_blank" rel="noreferrer" className="underline">
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
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-[#1d2a24]"
          >
            Book
          </a>
        ) : (
          <span>No booking link yet</span>
        )}
      </div>
    </li>
  );
}
