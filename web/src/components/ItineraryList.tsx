// The share page's list view (TG-23, ux.md 1 to 3): summary, issues, the two buses and the days.
// TG-22 adds or swaps in the overworld map here (Part B).
import Link from "next/link";
import { formatTime } from "@/lib/api";
import { formatTravelDate } from "@/lib/direction";
import {
  dateRange,
  dayHeading,
  formatPeso,
  issueNotice,
  issuesFor,
  joinNames,
  partySummary,
  type BusLegOut,
  type Itinerary,
  type PlanIssue,
  type StopOut,
} from "@/lib/itinerary";
import { placeSprite, spriteSrc } from "@/lib/sprites";
import LegCard from "@/components/LegCard";
import ShareButton from "@/components/ShareButton";
import TripCard from "@/components/TripCard";
import { UI } from "@/components/planUi";

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function ItineraryList({ itinerary: it }: { itinerary: Itinerary }) {
  const names = joinNames(it.party);
  const budget = formatPeso(it.budget_php);
  return (
    <>
      <section className={UI.box} aria-label="Trip summary">
        <p className="text-base font-bold">{dateRange(it.trip_date, it.return_date)}</p>
        <p className="text-sm">{partySummary(it.party)}</p>
        {names && <p className="text-sm min-w-0 break-words">{names}</p>}
        {(it.vibe || it.premade) && (
          <div className="flex flex-wrap gap-2">
            {it.vibe && <span className={`${UI.chip} min-w-0 break-words`}>{it.vibe}</span>}
            {it.premade && <span className={UI.chip}>Pre-made plan</span>}
          </div>
        )}
        {budget && <p className={`${UI.meta} tabular-nums`}>Budget {budget}</p>}
        <ShareButton slug={it.share_slug} tripDate={it.trip_date} returnDate={it.return_date} />
      </section>

      {it.issues.length > 0 && (
        <section className={UI.textBox} aria-label="Plan changes">
          <p className="text-sm font-bold">Some of this plan has changed since it was saved.</p>
          <p className="text-sm">Check the marked buses and stops before you go.</p>
        </section>
      )}

      <BusSection title="Bus to Baguio" leg={it.outbound} issues={issuesFor("outbound", it.issues)} />

      {it.days.map((day, d) => {
        const legNote = day.stops.find((s) => s.leg)?.leg?.confirm_note; // the API's last-mile note, once per day
        return (
        <section key={day.day} className="flex flex-col gap-3">
          <h2 className={UI.h2}>{dayHeading(day)}</h2>
          {day.stops.length === 0 ? (
            <p className={`${UI.textBox} text-sm`}>Free time. No stops planned for this day.</p>
          ) : (
            <>
              {legNote && <p className={UI.meta}>{legNote}</p>}
              <ol className="flex flex-col gap-4">
                {day.stops.map((stop, s) => (
                  <StopItem key={`${s}-${stop.spot_id}`} n={s + 1} stop={stop} issues={issuesFor(`days[${d}].stops[${s}]`, it.issues)} />
                ))}
              </ol>
            </>
          )}
        </section>
        );
      })}

      <BusSection title="Bus to Metro Manila" leg={it.return} issues={issuesFor("return", it.issues)} />
    </>
  );
}

function BusSection({ title, leg, issues }: { title: string; leg: BusLegOut; issues: PlanIssue[] }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className={UI.h2}>
        {title} · {formatTravelDate(leg.date)}
      </h2>
      {leg.trip ? (
        <>
          <ul className="flex flex-col gap-3">
            <TripCard trip={leg.trip} notice={issues[0] ? issueNotice(issues[0].code) : undefined} />
          </ul>
          <p className={UI.meta}>{leg.trip.confirm_note}</p>
        </>
      ) : (
        <div className={UI.box}>
          <p className="text-sm">{issueNotice("unknown_trip")}</p>
          <Link href="/" className={UI.secondaryBtn}>
            Search buses
          </Link>
        </div>
      )}
    </section>
  );
}

function StopItem({ n, stop, issues }: { n: number; stop: StopOut; issues: PlanIssue[] }) {
  const legIssues = issues.filter((i) => i.path.includes(".leg"));
  const stopNotice = issues.find((i) => !i.path.includes(".leg") && i.code !== "unknown_spot");
  const spot = stop.spot;
  const fee = spot ? formatPeso(spot.entrance_fee_php) : null;
  return (
    <li className="flex gap-3">
      <span aria-hidden="true" className="w-6 shrink-0 text-center text-xl font-semibold">
        {n}
      </span>
      <div className="min-w-0 flex-1 flex flex-col gap-2">
        {stop.leg ? (
          <ul className="flex flex-col">
            <LegCard leg={stop.leg} notice={legIssues[0] ? issueNotice(legIssues[0].code) : undefined} />
          </ul>
        ) : (
          <p className={`${UI.textBox} text-sm`}>{issueNotice("unknown_leg")}</p>
        )}
        <div className={UI.textBox}>
          {stopNotice && <p className="text-sm font-semibold">{issueNotice(stopNotice.code)}</p>}
          <div className="flex items-start gap-2">
            {spot && (
              // eslint-disable-next-line @next/next/no-img-element -- pixel art: next/image would resample it
              <img
                src={spriteSrc(placeSprite(spot.category))}
                width={24}
                height={24}
                alt=""
                className={`${UI.plate} ${UI.pixelated} shrink-0`}
                draggable={false}
                decoding="async"
              />
            )}
            <h3 className="text-base font-bold min-w-0 break-words">{spot ? spot.name : issueNotice("unknown_spot")}</h3>
          </div>
          <p className="text-sm tabular-nums">
            {formatTime(stop.arrive)} – {formatTime(stop.leave)}
            {spot && spot.category !== "other" ? ` · ${capitalise(spot.category)}` : ""}
          </p>
          {fee && <p className={UI.meta}>Entrance {fee}</p>}
        </div>
      </div>
    </li>
  );
}
