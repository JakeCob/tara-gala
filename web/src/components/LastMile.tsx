"use client";

import { useRef, useState } from "react";
import { fetchLastMile, formatVerified } from "@/lib/api";
import {
  BAGUIO_TERMINALS,
  formatFare,
  formatMinutes,
  groupByDestination,
  modeLabel,
  type LastMileLeg,
} from "@/lib/lastMile";

type Status = "idle" | "loading" | "done" | "error";

const line = "text-sm min-w-0 break-words";

export default function LastMile() {
  const [terminal, setTerminal] = useState<string | null>(null);
  const [legs, setLegs] = useState<LastMileLeg[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  // Only the latest request may update the list; a quick switch of terminal drops the stale answer.
  const requestId = useRef(0);

  async function load(slug: string) {
    const id = ++requestId.current;
    setTerminal(slug);
    setLegs([]);
    setStatus("loading");
    try {
      const result = await fetchLastMile({ terminal: slug });
      if (id !== requestId.current) return;
      setLegs(result);
      setStatus("done");
    } catch {
      if (id !== requestId.current) return;
      setStatus("error");
    }
  }

  const groups = status === "done" ? groupByDestination(legs) : [];

  return (
    <div className="flex flex-col gap-4">
      <fieldset className="m-0 min-w-0 border-0 p-0 flex flex-col gap-2">
        <legend className="mb-2 text-sm text-muted">Which terminal does your bus arrive at?</legend>
        <div className="grid grid-cols-3 gap-2">
          {BAGUIO_TERMINALS.map((t) => (
            <label
              key={t.slug}
              className="min-h-11 flex cursor-pointer items-center justify-center rounded-xl border border-border bg-card px-2 py-2 text-center text-sm font-semibold leading-tight has-checked:border-brand has-checked:bg-brand has-checked:text-brand-ink has-focus-visible:ring-2 has-focus-visible:ring-brand has-focus-visible:ring-offset-2 has-focus-visible:ring-offset-background"
            >
              <input
                type="radio"
                name="terminal"
                value={t.slug}
                checked={terminal === t.slug}
                onChange={() => load(t.slug)}
                className="sr-only"
              />
              {t.label}
            </label>
          ))}
        </div>
      </fieldset>

      <div aria-live="polite" className="flex flex-col gap-3">
        {status === "loading" && <p className="text-sm text-muted">Loading routes...</p>}
        {status === "done" && legs.length > 0 && <p className="text-sm text-muted">{legs[0].confirm_note}</p>}
        {status === "done" && legs.length === 0 && (
          <p className="rounded-xl border border-border bg-card p-4 text-sm">No routes on file yet for this terminal.</p>
        )}
        {status === "error" && (
          <div className="rounded-xl border border-border bg-card p-4 text-sm flex flex-col items-start gap-3">
            <p>Could not reach the server. Check your connection and try again.</p>
            <button
              type="button"
              onClick={() => terminal && load(terminal)}
              className="min-h-11 inline-flex items-center rounded-xl border border-border bg-card px-4 text-sm font-semibold"
            >
              Try again
            </button>
          </div>
        )}
      </div>

      {groups.map((g) => (
        <section key={`${g.destination.kind}:${g.destination.slug}`} className="flex flex-col gap-2">
          <h2 className="text-base font-semibold min-w-0 break-words">{g.destination.name}</h2>
          <ul className="flex flex-col gap-3">
            {g.legs.map((leg) => (
              <LegCard key={leg.last_mile_route_id} leg={leg} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function LegCard({ leg }: { leg: LastMileLeg }) {
  const fare = formatFare(leg.fare_min_php, leg.fare_max_php);
  const minutes = formatMinutes(leg.minutes);
  return (
    <li className="rounded-2xl border border-border bg-card p-4 flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold">{modeLabel(leg.mode)}</span>
        {fare && <span className="font-semibold tabular-nums">{fare}</span>}
      </div>
      {leg.signboard && (
        <p className={line}>
          Signboard: <span className="font-semibold">{leg.signboard}</span>
        </p>
      )}
      {leg.boarding_point && <p className={line}>Board at {leg.boarding_point}</p>}
      {leg.alighting_point && <p className={line}>Get off at {leg.alighting_point}</p>}
      {minutes && <p className={line}>{minutes}</p>}
      {leg.notes && <p className={`${line} text-muted`}>{leg.notes}</p>}
      <p className="pt-1 text-xs text-muted">{formatVerified(leg.last_verified_at)}</p>
    </li>
  );
}
