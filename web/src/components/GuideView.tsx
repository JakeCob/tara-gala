"use client";

import { PX, PixelBox, PixelButton, SectionTitle, cx } from "@/components/pixel";
import { Sprite } from "@/components/WorldSheet";
import { formatClass, formatTime, formatVerified } from "@/lib/api";
import { chibi } from "@/lib/sprites";
import {
  type BusTable, type Guide, type Mark, dayProgress, pickMark, placeIcon, rowMark, rowShows, todoMark, whereNow,
} from "@/lib/guide";

type Props = {
  guide: Guide;
  /** On a trip the day checklists come first, then the bus tables (during the trip the days matter most) */
  checklistFirst?: boolean;
  /** The trip's ticks and picks; without them the guide is read-only (the plan's own page) */
  marks?: readonly Mark[];
  busy?: boolean;
  onTick?: (key: string, done: boolean) => void;
  onPick?: (pickKey: string, option: string) => void;
};

const peso = (n: number) => `₱${n.toLocaleString("en-PH", { maximumFractionDigits: 0 })}`;

function Buses({ table }: { table: BusTable }) {
  const booked = table.buses.find((b) => b.booked)?.trip;
  // The class says it all when every bus is one operator's; name the operator only where it differs from the first
  const first = table.buses[0]?.trip?.operator_name;
  return (
    <section className="flex flex-col gap-2">
      <SectionTitle>{table.title}</SectionTitle>
      {table.intro && <p className="text-sm">{table.intro}</p>}
      <PixelBox className="overflow-x-auto p-0">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b-2 border-border">
              <th scope="col" className="px-3 py-2 font-semibold">Departs</th>
              <th scope="col" className="px-3 py-2 font-semibold">{first ?? "Bus"}</th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">Fare</th>
              <th scope="col" className="px-3 py-2 font-semibold">Note</th>
            </tr>
          </thead>
          <tbody>
            {table.buses.map((b) => (
              <tr key={b.trip_id} className={cx("border-b border-border last:border-b-0", b.booked && "font-bold")}>
                <td className="px-3 py-2 whitespace-nowrap tabular-nums">{b.trip ? formatTime(b.trip.departure_time) : "?"}</td>
                <td className="px-3 py-2">
                  {b.trip ? `${b.trip.operator_name !== first ? `${b.trip.operator_name} ` : ""}${formatClass(b.trip.service_class)}` : "No longer listed"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{b.trip?.fare_php != null ? peso(b.trip.fare_php) : "?"}</td>
                <td className="px-3 py-2">{b.booked ? `✓ ${b.note || "Booked"}` : b.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </PixelBox>
      <p className={PX.meta}>
        Times and fares from the operator&apos;s schedule data{booked ? `, ${formatVerified(booked.last_verified_at).replace(/^Checked/, "last checked")}` : ""}. {booked?.confirm_note ?? ""}
      </p>
      {table.tips.length > 0 && (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
          {table.tips.map((t) => <li key={t}>{t}</li>)}
        </ul>
      )}
    </section>
  );
}

/**
 * TG-52: the itinerary's guide. With a trip's marks it's the trip's progress map: each day is a trail of its rows, any
 * row can be ticked or unticked by anyone, and the party chibi stands at the latest-ticked row that has a place.
 */
export default function GuideView({ guide, marks, busy, onTick, onPick, checklistFirst }: Props) {
  const byKey = new Map((marks ?? []).map((m) => [m.key, m]));
  const here = marks ? whereNow(guide, marks) : null;
  const live = !!onTick;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h2 className="text-xl font-bold text-balance">{guide.title}</h2>
        {guide.summary && <p className="text-sm text-muted md:max-w-prose">{guide.summary}</p>}
      </header>

      {!checklistFirst && <Buses table={guide.getting_there} />}

      {guide.days.map((day) => {
        const pick = day.pick;
        const chosen = pick ? byKey.get(pickMark(pick.key))?.value : undefined;
        const progress = dayProgress(day, byKey);
        return (
          <section key={day.day} aria-labelledby={`guide-day-${day.day}`} className="flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <SectionTitle id={`guide-day-${day.day}`}>{day.title}</SectionTitle>
              {marks && <span className={PX.meta}>{progress.done} of {progress.total} done</span>}
            </div>
            {day.intro && <p className="text-sm md:max-w-prose">{day.intro}</p>}

            {pick && (
              <PixelBox className="flex flex-col gap-2 p-4">
                <p className="font-semibold">{pick.title}</p>
                <ul className="flex flex-col gap-2">
                  {pick.options.map((o) => (
                    <li key={o.id} className="flex flex-wrap items-start justify-between gap-2 border-b border-border pb-2 last:border-b-0 last:pb-0">
                      <span className="min-w-0 flex-1 text-sm">
                        <span className="font-semibold">{o.id}. {o.label}</span> · leave {formatTime(o.leave)}
                        {o.what && <span className="block text-muted">{o.what}</span>}
                      </span>
                      {onPick && (
                        <PixelButton variant={chosen === o.id ? "primary" : "secondary"} className="px-3 text-sm" disabled={busy}
                          aria-pressed={chosen === o.id} onClick={() => onPick(pick.key, o.id)}>
                          {chosen === o.id ? "Picked" : `Pick ${o.id}`}
                        </PixelButton>
                      )}
                    </li>
                  ))}
                </ul>
                {marks && <p className={PX.meta}>{chosen ? `The group picked ${chosen}.` : "Nobody has picked yet."}</p>}
              </PixelBox>
            )}

            <ol className="flex flex-col" aria-label={`${day.title} checklist`}>
              {day.rows.filter((r) => rowShows(r, byKey)).map((r, i, shown) => {
                const done = byKey.get(rowMark(r))?.value === "done";
                const icon = placeIcon(r.place);
                const isHere = here?.key === r.key;
                return (
                  <li key={r.key} data-row={r.key} className="grid grid-cols-[3.5rem_1fr] gap-3">
                    <div className="relative flex flex-col items-center">
                      <span className={cx("relative flex shrink-0 items-center justify-center", icon ? "h-12 w-12 pixel-frame bg-screen" : "mt-4 h-4 w-4 border-2 border-frame", done && !icon && "bg-frame")}>
                        {icon && <Sprite name={icon} scale={2} className={cx(!done && marks && "opacity-60")} />}
                      </span>
                      {isHere && (
                        <span className="absolute -top-3 -left-1" data-party="">
                          <Sprite name={chibi("adult", "idle-1")} scale={1} />
                          <span className="sr-only">The group is here</span>
                        </span>
                      )}
                      {i < shown.length - 1 && <span aria-hidden="true" className="min-h-4 w-0 flex-1 border-l-2 border-dashed border-border" />}
                    </div>
                    <div className="flex min-w-0 flex-col gap-0.5 pb-4">
                      <label className={cx("flex min-h-11 items-start gap-3", live && "cursor-pointer")}>
                        {live && (
                          <input type="checkbox" className="mt-1 h-6 w-6 shrink-0" checked={done} disabled={busy}
                            onChange={(e) => onTick?.(rowMark(r), e.target.checked)} />
                        )}
                        <span className={cx("min-w-0", done && "text-muted")}>
                          <span className="font-semibold tabular-nums">{formatTime(r.time)}</span> · {r.plan}
                          {r.note && <span className="block text-sm text-muted">{r.note}</span>}
                          {r.place?.name && <span className="block text-xs text-muted">{r.place.name}</span>}
                        </span>
                      </label>
                    </div>
                  </li>
                );
              })}
            </ol>
            {day.tips.length > 0 && (
              <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
                {day.tips.map((t) => <li key={t}>{t}</li>)}
              </ul>
            )}
          </section>
        );
      })}

      {checklistFirst && <Buses table={guide.getting_there} />}
      <Buses table={guide.getting_home} />

      <section className="flex flex-col gap-2">
        <SectionTitle>Budget per person</SectionTitle>
        {guide.budget.summary && <p className="text-sm">{guide.budget.summary}</p>}
        <PixelBox className="overflow-x-auto p-0">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b-2 border-border">
                <th scope="col" className="px-3 py-2 font-semibold">Item</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">Estimate (₱)</th>
              </tr>
            </thead>
            <tbody>
              {guide.budget.rows.map((b) => (
                <tr key={b.item} className="border-b border-border last:border-b-0">
                  <td className="px-3 py-2">{b.item}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">{b.estimate}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </PixelBox>
        {guide.budget.excluded && <p className={PX.meta}>{guide.budget.excluded}</p>}
      </section>

      {guide.todo.length > 0 && (
        <section className="flex flex-col gap-2">
          <SectionTitle>To do before the trip</SectionTitle>
          <ul className="flex flex-col gap-1">
            {guide.todo.map((t) => {
              const done = t.done || byKey.get(todoMark(t))?.value === "done";
              return (
                <li key={t.key}>
                  <label className={cx("flex min-h-11 items-start gap-3 text-sm", live && !t.done && "cursor-pointer")}>
                    <input type="checkbox" className="mt-0.5 h-6 w-6 shrink-0" checked={done} disabled={!live || t.done || busy}
                      onChange={(e) => onTick?.(todoMark(t), e.target.checked)} />
                    <span className={cx(done && "text-muted")}>{t.text}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {guide.sources.length > 0 && (
        <section className="flex flex-col gap-2">
          <SectionTitle>Sources</SectionTitle>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
            {guide.sources.map((s) => (
              <li key={s.label}>
                {s.url ? <a className={PX.inlineLink} href={s.url} target="_blank" rel="noopener noreferrer">{s.label}</a> : s.label}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
