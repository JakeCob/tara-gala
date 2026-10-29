"use client";

import { useEffect, useId, useState } from "react";
import { PX, PixelBox, PixelButton, PixelLink, SectionTitle } from "@/components/pixel";
import { fetchPremade, type PremadeResult } from "@/lib/api";
import { flags } from "@/lib/flags";
import { landingPremadeView, type LandingCard } from "@/lib/premadeView";
import SectionStripe from "./SectionStripe";

function TripCard({ card }: { card: LandingCard }) {
  const titleId = useId();
  return (
    <PixelBox as="li" className="flex flex-col items-start gap-2 p-4">
      <p id={titleId} className={`${PX.dataHeading} min-w-0 break-words`}>
        {card.title}
      </p>
      <p className="text-sm tabular-nums">{card.dates}</p>
      {card.places && <p className="min-w-0 break-words text-sm">{card.places}</p>}
      {card.budget && <p className={`${PX.meta} tabular-nums`}>{card.budget}</p>}
      <PixelLink variant="secondary" href={card.href} aria-describedby={titleId}>
        See this trip
      </PixelLink>
    </PixelBox>
  );
}

/**
 * Ready-made trips (ux §5.4), from the same list as /plan, which TG-27's service worker caches. It loads after the
 * page paints and sits under the search, so nothing it shows can push the search button down.
 */
export default function PremadeTrips() {
  const [result, setResult] = useState<PremadeResult | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!flags.premadeItineraries) return;
    let live = true;
    fetchPremade().then((r) => {
      if (!live) return;
      const shown = landingPremadeView(r, navigator.onLine);
      console.info("[tg-landing] premade state=%s count=%d", shown.state, shown.cards?.length ?? 0);
      setResult(r);
    });
    return () => {
      live = false;
    };
  }, [attempt]);

  function retry() {
    setResult(null);
    setAttempt((n) => n + 1);
  }

  if (!flags.premadeItineraries) return null;
  // navigator is undefined in the server prerender, where the list is always still loading
  const view = landingPremadeView(result, result === null || navigator.onLine);
  if (view.state === "hidden") return null;

  return (
    <section aria-labelledby="ready-made-trips" className="flex flex-col gap-3">
      <div className="mt-3">
        <SectionTitle id="ready-made-trips">Ready-made trips</SectionTitle>
        <SectionStripe />
      </div>
      <p className="text-sm text-muted">No time to plan? Tara, pick one. Each is built only from buses and spots on file.</p>
      {view.state === "loading" && <p className="text-sm text-muted">Loading trip ideas...</p>}
      {view.state === "empty" && <p className="text-sm text-muted">No ready-made trips on file yet.</p>}
      {view.state === "offline" && (
        <p className="text-sm text-muted">
          Ready-made trips need a connection the first time. Open this page once with signal and they&apos;ll be saved.
        </p>
      )}
      {view.state === "failed" && (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm">Could not load trip ideas. Check your connection and try again.</p>
          <PixelButton variant="secondary" onClick={retry}>
            Try again
          </PixelButton>
        </div>
      )}
      {view.state === "list" && (
        <ul className="flex flex-col gap-3 md:grid md:grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] md:gap-4">
          {view.cards?.map((card) => <TripCard key={card.href} card={card} />)}
        </ul>
      )}
    </section>
  );
}
