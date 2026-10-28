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
          className={`pixel-btn focus-pixel min-h-11 inline-flex items-center justify-center gap-1 bg-card px-3 text-sm font-bold text-brand${showSakay(city) ? "" : " col-span-2"}`}
        >
          Google Maps <span aria-hidden>↗</span>
        </a>
        {showSakay(city) && (
          <a
            href={sakayUrl(place)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={sakayLabel()}
            className="pixel-btn focus-pixel min-h-11 inline-flex items-center justify-center gap-1 bg-card px-3 text-sm font-semibold text-foreground"
          >
            Sakay.ph <span aria-hidden>↗</span>
          </a>
        )}
      </div>
    </div>
  );
}
