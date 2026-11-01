"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { PX, PixelBox, PixelButton, PixelCardLink, SectionTitle, cx } from "@/components/pixel";
import { datesLine, knownTripsRaw, parseKnownTrips, rememberTrip, tripApi, tripFailureMessage, tripProblem } from "@/lib/trip";

const subscribeNothing = () => () => {};

/**
 * TG-52: the Trip tab. The trips this phone has opened, a form to start one, and the phone's own tickets and wallets.
 * A trip is shared by its link; whoever opens it sees it listed here from then on.
 */
export default function TripHome() {
  const router = useRouter();
  const raw = useSyncExternalStore(subscribeNothing, knownTripsRaw, () => null);
  const known = useMemo(() => parseKnownTrips(raw), [raw]);
  const [name, setName] = useState("Baguio trip");
  const [start, setStart] = useState("");
  const [back, setBack] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    const problem = tripProblem(name, start, back);
    if (problem) return setError(problem);
    setError("");
    setBusy(true);
    const r = await tripApi.create(name.trim(), start, back);
    console.info("[tg-trip] create ok=%s", r.ok ? "yes" : r.why);
    if (!r.ok) {
      setBusy(false);
      return setError(tripFailureMessage(r));
    }
    rememberTrip({ slug: r.trip.share_slug, name: r.trip.name, start_date: r.trip.start_date });
    router.push(`/t/${r.trip.share_slug}`);
  }

  return (
    <div className="flex flex-col gap-5 md:grid md:grid-cols-2 md:items-start md:gap-6">
      <div className="flex flex-col gap-4">
        <section aria-labelledby="trips-title" className="flex flex-col gap-3">
          <SectionTitle id="trips-title">Your trips</SectionTitle>
          {known.length === 0 ? (
            <p className="text-sm text-muted">No trip on this phone yet. Start one, or open the link someone shared with you.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {known.map((t) => (
                <li key={t.slug}>
                  <PixelCardLink href={`/t/${t.slug}`} className="flex items-center justify-between gap-3 p-4">
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="break-words font-bold">{t.name}</span>
                      <span className={PX.meta}>{datesLine(t.start_date, t.start_date)}</span>
                    </span>
                    <span aria-hidden="true">→</span>
                  </PixelCardLink>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="phone-title" className="flex flex-col gap-3">
          <SectionTitle id="phone-title">On this phone</SectionTitle>
          <PixelCardLink href="/tickets" className="flex flex-col gap-1 p-4">
            <span className="font-bold">My tickets</span>
            <span className={PX.meta}>Your bus e-tickets, saved on this phone for the terminal.</span>
          </PixelCardLink>
          <PixelCardLink href="/wallet" className="flex flex-col gap-1 p-4">
            <span className="font-bold">Trip wallets</span>
            <span className={PX.meta}>Who paid what, and who pays whom at the end.</span>
          </PixelCardLink>
        </section>
      </div>

      <div className="flex flex-col gap-3">
        <PixelBox as="form" onSubmit={onCreate} noValidate aria-labelledby="start-title" className="flex flex-col gap-3 p-4">
          <SectionTitle id="start-title">Start a trip</SectionTitle>
          <p className="text-sm text-muted">One link for the whole trip: the plan, the shared wallet and the hotel. Send it to everyone coming.</p>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-semibold">Trip name</span>
            <input className={PX.input} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex min-w-0 flex-col gap-1 text-sm">
              <span className="font-semibold">Leave</span>
              <input type="date" className={cx(PX.input, "w-full")} value={start} onChange={(e) => setStart(e.target.value)} />
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-sm">
              <span className="font-semibold">Come home</span>
              <input type="date" className={cx(PX.input, "w-full")} value={back} onChange={(e) => setBack(e.target.value)} />
            </label>
          </div>
          <PixelButton type="submit" variant="primary" className="px-4 py-3" disabled={busy}>
            {busy ? "Starting..." : "Start the trip"}
          </PixelButton>
        </PixelBox>
        {error && (
          <PixelBox as="p" tone="alertText" role="alert" className="p-4 text-sm">
            {error}
          </PixelBox>
        )}
      </div>
    </div>
  );
}
