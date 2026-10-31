// The share page's list view (TG-23, ux.md 1 to 3): summary, issues, the two buses and the days.
// With map (TG-22, NEXT_PUBLIC_OVERWORLD_MAP), the overworld map replaces the bus and day sections; the summary,
// Share and the changes notice stay above it. Without it, this is TG-23's list, which carries the same facts.
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
  type DayOut,
  type Itinerary,
  type PlanIssue,
  type StopOut,
} from "@/lib/itinerary";
import { placeSprite, spriteSrc } from "@/lib/sprites";
import LegCard from "@/components/LegCard";
import OverworldMap from "@/components/OverworldMap";
import ShareButton from "@/components/ShareButton";
import TripCard from "@/components/TripCard";
import { PX, PixelBox, PixelLink, SectionTitle } from "@/components/pixel";

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function ItineraryList({ itinerary: it, map = false }: { itinerary: Itinerary; map?: boolean }) {
  const names = joinNames(it.party);
  const confirmNote = it.outbound.trip?.confirm_note ?? it.return.trip?.confirm_note;
  const budget = formatPeso(it.budget_php);
  return (
    <>
      <PixelBox as="section" aria-label="Trip summary" className="p-4 flex flex-col gap-3">
        <p className={PX.dataHeading}>{dateRange(it.trip_date, it.return_date)}</p>
        <p className="text-sm">{partySummary(it.party)}</p>
        {names && <p className="text-sm min-w-0 break-words">{names}</p>}
        {(it.vibe || it.premade) && (
          <div className="flex flex-wrap gap-2">
            {it.vibe && <span className={`${PX.chip} min-w-0 break-words`}>{it.vibe}</span>}
            {it.premade && <span className={PX.chip}>Pre-made plan</span>}
          </div>
        )}
        {budget && <p className={`${PX.meta} tabular-nums`}>Budget {budget}</p>}
        <ShareButton slug={it.share_slug} tripDate={it.trip_date} returnDate={it.return_date} />
      </PixelBox>

      {it.issues.length > 0 && (
        <PixelBox as="section" aria-label="Plan changes" tone="alert" className="p-4 flex flex-col gap-1">
          <p className="text-sm font-bold text-danger-text">Some of this plan has changed since it was saved.</p>
          <p className="text-sm">Check the marked buses and stops before you go.</p>
        </PixelBox>
      )}

      {map ? (
        <>
          <p className="text-sm">Tap a stop or a ride for details.</p>
          {confirmNote && <p className={PX.meta}>{confirmNote}</p>}
          <OverworldMap itinerary={it} />
        </>
      ) : (
        <>
          <BusSection title="Bus to Baguio" leg={it.outbound} issues={issuesFor("outbound", it.issues)} />

          {it.days.map((day, d) => (
            <DaySection key={day.day} day={day} index={d} issues={it.issues} />
          ))}

          <BusSection title="Bus to Metro Manila" leg={it.return} issues={issuesFor("return", it.issues)} />
        </>
      )}
    </>
  );
}

function BusSection({ title, leg, issues }: { title: string; leg: BusLegOut; issues: PlanIssue[] }) {
  return (
    <section className="flex flex-col gap-3">
      <SectionTitle>
        {title} · {formatTravelDate(leg.date)}
      </SectionTitle>
      {leg.trip ? (
        <>
          <ul className="flex flex-col gap-3">
            <TripCard trip={leg.trip} notice={issues[0] ? issueNotice(issues[0].code) : undefined} />
          </ul>
          <p className={PX.meta}>{leg.trip.confirm_note}</p>
        </>
      ) : (
        <PixelBox tone="alert" className="p-4 flex flex-col items-start gap-3">
          <p className="text-sm text-danger-text">{issueNotice("unknown_trip")}</p>
          <PixelLink variant="secondary" href="/buses">
            Search buses
          </PixelLink>
        </PixelBox>
      )}
    </section>
  );
}

function DaySection({ day, index, issues }: { day: DayOut; index: number; issues: PlanIssue[] }) {
  const legNote = day.stops.find((s) => s.leg)?.leg?.confirm_note; // the API's last-mile note, once per day
  return (
    <section className="flex flex-col gap-3">
      <SectionTitle>{dayHeading(day)}</SectionTitle>
      {day.stops.length === 0 ? (
        <PixelBox as="p" className="p-4 text-sm">Free time. No stops planned for this day.</PixelBox>
      ) : (
        <>
          {legNote && <p className={PX.meta}>{legNote}</p>}
          <ol className="flex flex-col gap-4">
            {day.stops.map((stop, s) => (
              <StopItem key={`${s}-${stop.spot_id}`} n={s + 1} stop={stop} issues={issuesFor(`days[${index}].stops[${s}]`, issues)} />
            ))}
          </ol>
        </>
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
      <span aria-hidden="true" className={`${PX.numeral} w-6 shrink-0 text-center`}>
        {n}
      </span>
      <div className="min-w-0 flex-1 flex flex-col gap-2">
        {stop.leg ? (
          <ul className="flex flex-col">
            <LegCard leg={stop.leg} notice={legIssues[0] ? issueNotice(legIssues[0].code) : undefined} />
          </ul>
        ) : (
          <PixelBox as="p" className="p-4 text-sm">{issueNotice("unknown_leg")}</PixelBox>
        )}
        <PixelBox className="p-4 flex flex-col gap-1">
          {stopNotice && <p className="text-sm font-semibold">{issueNotice(stopNotice.code)}</p>}
          <div className="flex items-start gap-2">
            {spot && (
              // The plate is on the wrapper, so the art draws at a true 24px (TG-23 review S1)
              <span className={PX.plate}>
                {/* eslint-disable-next-line @next/next/no-img-element -- pixel art: next/image would resample it */}
                <img
                  src={spriteSrc(placeSprite(spot.category))}
                  width={24}
                  height={24}
                  alt=""
                  className="pixelated block"
                  draggable={false}
                  decoding="async"
                />
              </span>
            )}
            <h3 className={`${PX.dataHeading} min-w-0 break-words`}>{spot ? spot.name : issueNotice("unknown_spot")}</h3>
          </div>
          <p className="text-sm tabular-nums">
            {formatTime(stop.arrive)} – {formatTime(stop.leave)}
            {spot && spot.category !== "other" ? ` · ${capitalise(spot.category)}` : ""}
          </p>
          {fee && <p className={PX.meta}>Entrance {fee}</p>}
        </PixelBox>
      </div>
    </li>
  );
}
