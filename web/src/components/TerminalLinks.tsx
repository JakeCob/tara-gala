"use client";

import { useEffect, useId, useState } from "react";
import {
  googleMapsUrl,
  mapsLabel,
  sakayLabel,
  sakayUrl,
  showSakay,
  withTerminalData,
  type TerminalPlace,
} from "@/lib/mapLinks";
import { getTerminals } from "@/lib/terminals";

const FOCUS = "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-card";

/** Directions to the trip's origin terminal. Renders from the trip's fields first, then upgrades from /terminals. */
export default function TerminalLinks({ slug, name, city }: { slug: string; name: string; city: string }) {
  const id = useId();
  const [terminals, setTerminals] = useState<Map<string, TerminalPlace> | null>(null);

  useEffect(() => {
    let alive = true;
    getTerminals()
      .then((m) => {
        if (alive) setTerminals(m);
      })
      .catch(() => {}); // keep the name-based link
    return () => {
      alive = false;
    };
  }, []);

  const place = withTerminalData({ slug, name, city }, terminals?.get(slug));

  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-1">
      <span id={id} className="text-xs text-muted">
        Get to the terminal
      </span>
      <div className="grid grid-cols-2 gap-2">
        <a
          href={googleMapsUrl(place)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={mapsLabel(name)}
          className={`min-h-11 inline-flex items-center justify-center gap-1 rounded-xl border border-brand bg-card px-3 text-sm font-semibold text-brand ${FOCUS}${showSakay(city) ? "" : " col-span-2"}`}
        >
          Google Maps <span aria-hidden>↗</span>
        </a>
        {showSakay(city) && (
          <a
            href={sakayUrl(place)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={sakayLabel()}
            className={`min-h-11 inline-flex items-center justify-center gap-1 rounded-xl border border-border bg-card px-3 text-sm font-semibold text-foreground ${FOCUS}`}
          >
            Sakay.ph <span aria-hidden>↗</span>
          </a>
        )}
      </div>
    </div>
  );
}
