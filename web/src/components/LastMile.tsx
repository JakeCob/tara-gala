"use client";

import { useRef, useState } from "react";
import { PixelBox, PixelButton, PixelChoice } from "@/components/pixel";
import { fetchLastMile } from "@/lib/api";
import { BAGUIO_TERMINALS, groupByDestination, type LastMileLeg } from "@/lib/lastMile";
import LegCard from "@/components/LegCard";

type Status = "idle" | "loading" | "done" | "error";

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
      <fieldset className="m-0 min-w-0 border-0 p-0 flex flex-col gap-2 md:max-w-xl">
        <legend className="mb-2 text-sm font-semibold text-foreground">Which terminal does your bus arrive at?</legend>
        <div className="grid grid-cols-3 gap-2">
          {BAGUIO_TERMINALS.map((t) => (
            <PixelChoice
              key={t.slug}
              name="terminal"
              value={t.slug}
              checked={terminal === t.slug}
              onChange={() => load(t.slug)}
            >
              {t.label}
            </PixelChoice>
          ))}
        </div>
      </fieldset>

      <div aria-live="polite" className="flex flex-col gap-3">
        {status === "loading" && <p className="text-sm text-muted md:max-w-prose">Loading routes...</p>}
        {status === "done" && legs.length > 0 && <p className="text-sm text-muted md:max-w-prose">{legs[0].confirm_note}</p>}
        {status === "done" && legs.length === 0 && (
          <PixelBox as="p" className="p-4 text-sm md:max-w-prose">No routes on file yet for this terminal.</PixelBox>
        )}
        {status === "error" && (
          <PixelBox tone="alert" className="p-4 text-sm flex flex-col items-start gap-3">
            <p className="md:max-w-prose text-danger-text">Could not reach the server. Check your connection and try again.</p>
            <PixelButton
              variant="secondary"
              onClick={() => {
                if (!terminal) return;
                // This box unmounts on retry; keep keyboard and screen-reader focus on the terminal being retried.
                document.querySelector<HTMLInputElement>('input[name="terminal"]:checked')?.focus();
                load(terminal);
              }}
            >
              Try again
            </PixelButton>
          </PixelBox>
        )}
      </div>

      {groups.length > 0 && (
        <div className="contents md:grid md:grid-cols-[repeat(auto-fill,minmax(20rem,1fr))] md:gap-x-6 md:gap-y-8 md:items-start">
          {groups.map((g) => (
            <section key={`${g.destination.kind}:${g.destination.slug}`} className="flex flex-col gap-2">
              <h2 className="text-base font-bold min-w-0 break-words">{g.destination.name}</h2>
              <ul className="flex flex-col gap-3">
                {g.legs.map((leg) => (
                  <LegCard key={leg.last_mile_route_id} leg={leg} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
