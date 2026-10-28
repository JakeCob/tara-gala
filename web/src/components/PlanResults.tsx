"use client";

import { useEffect, useId, useRef } from "react";
import Link from "next/link";
import type { Flags } from "@/lib/flags";
import { PLAN_COPY, premadeCountLine, matchesDates, showPremadeAction, type ErrorView, type PremadeView } from "@/lib/planForm";
import { premadeCard } from "@/lib/premadeView";
import type { PremadeSummary } from "@/lib/api";
import { UI } from "./planUi";

const LIST = PLAN_COPY.list;

/**
 * A failed plan (ux §5.2): the message, then Try again and See ready-made trips where that error allows them.
 * Not a live region: the form's status line already announces the same text.
 */
export function PlanErrorBox(props: {
  view: ErrorView;
  flags: Pick<Flags, "plannerLive" | "premadeItineraries">;
  busy: boolean;
  onRetry(): void;
  onPremade(): void;
}) {
  const { view, busy } = props;
  const premade = showPremadeAction(view, props.flags);
  return (
    <div className={UI.box}>
      <p className="text-sm">{view.message}</p>
      {(view.retry || premade) && (
        <div className="flex flex-wrap gap-2">
          {view.retry && (
            <button type="button" className={UI.secondaryBtn} aria-disabled={busy} onClick={() => !busy && props.onRetry()}>
              {PLAN_COPY.actions.tryAgain}
            </button>
          )}
          {premade && (
            <button type="button" className={UI.secondaryBtn} aria-disabled={busy} onClick={() => !busy && props.onPremade()}>
              {PLAN_COPY.actions.seePremade}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SearchBusesBox({ message }: { message: string }) {
  return (
    <div className={UI.box}>
      <p className="text-sm">{message}</p>
      <Link href="/" className={UI.secondaryBtn}>
        {PLAN_COPY.actions.searchBuses}
      </Link>
    </div>
  );
}

function TripCard({ trip, date, returnDate }: { trip: PremadeSummary; date: string; returnDate: string }) {
  const titleId = useId();
  const card = premadeCard(trip, date, returnDate);
  return (
    <li className={UI.box}>
      <h3 id={titleId} className="text-base font-bold min-w-0 break-words">
        {card.title}
      </h3>
      {card.matches && <span className={UI.matchChip}>{LIST.match}</span>}
      <p className="text-sm tabular-nums">{card.dates}</p>
      {card.places && <p className="text-sm min-w-0 break-words">{card.places}</p>}
      {card.budget && <p className={`${UI.meta} tabular-nums`}>{card.budget}</p>}
      <Link href={card.href} className={UI.secondaryBtn} aria-describedby={titleId}>
        {LIST.see}
      </Link>
    </li>
  );
}

/**
 * The pre-made list and its states (ux §6). Scrolled into view when it appears, smoothly only without reduced
 * motion; focus stays where it is, since the status line announces the result.
 */
export function PremadeResults(props: { premade: PremadeView; date: string; returnDate: string; busy: boolean; onRetry(): void }) {
  const { premade, date, returnDate } = props;
  const top = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    top.current?.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
  }, []);

  if (premade.kind === "empty") return <div ref={top}><SearchBusesBox message={LIST.empty} /></div>;
  if (premade.kind === "unavailable") return <div ref={top}><SearchBusesBox message={LIST.unavailable} /></div>;
  if (premade.kind === "failed") {
    return (
      <div ref={top} className={UI.box}>
        <p className="text-sm">{LIST.failed}</p>
        <button type="button" className={UI.secondaryBtn} aria-disabled={props.busy} onClick={() => !props.busy && props.onRetry()}>
          {PLAN_COPY.actions.tryAgain}
        </button>
      </div>
    );
  }
  const matching = premade.list.filter((s) => matchesDates(s, date, returnDate)).length;
  return (
    <section ref={top} className="flex flex-col gap-3 scroll-mt-4" aria-labelledby="plan-results-heading">
      <h2 id="plan-results-heading" className={UI.dataHeading}>
        {LIST.heading}
      </h2>
      <p className={UI.meta}>{premadeCountLine(premade.list.length, matching)}</p>
      <ul className="flex flex-col gap-4">
        {premade.list.map((trip) => (
          <TripCard key={trip.share_slug} trip={trip} date={date} returnDate={returnDate} />
        ))}
      </ul>
    </section>
  );
}
