"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { PX, PixelBox, PixelButton, PixelLink, SectionTitle, cx } from "@/components/pixel";
import { formatTime, manilaNow, manilaToday } from "@/lib/api";
import { mapsLabel } from "@/lib/mapLinks";
import { type BusPart, type HotelPart, type NextUp, type NextUpJump, type StopPart, busLines, dayLine, jumpFor, shortDate, thenLine, todosLine, tomorrowLine } from "@/lib/nextUp";
import { hotelTime } from "@/lib/trip";
import DriverView from "./DriverView";

type Jump = (j: NextUpJump) => void;
// Split by a 2px rule as the Settle up rows are; from md, side by side in equal columns with the rule between (ux §3)
const PART = "flex min-w-0 flex-col gap-2 border-b-2 border-border py-3 last:border-b-0 last:pb-0 md:border-b-0 md:border-r-2 md:px-4 md:py-0 md:first:pl-0 md:last:border-r-0 md:last:pr-0";
const COLUMNS = ["", "md:grid md:grid-cols-1", "md:grid md:grid-cols-2", "md:grid md:grid-cols-3"];
const LABEL = "text-sm font-semibold";
const FULL = "flex w-full items-center justify-center px-4 text-sm"; // a secondary button's layout, full width
const INLINE = cx(PX.inlineLink, "inline-flex min-h-11 items-center"); // a button inside a line, still 44px tall
const smooth = () => (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

/**
 * TG-69: Manila's date and time for the card, read again on return to the tab and every minute, so a bus that has left
 * and Manila's midnight both show without a reload. With `on` false (the flag off) it starts no listener or timer.
 */
export function useManilaClock(on: boolean): { today: string; now: string } {
  const [clock, setClock] = useState(() => ({ today: manilaToday(), now: manilaNow() }));
  useEffect(() => {
    if (!on) return;
    const read = () => {
      const today = manilaToday();
      const now = manilaNow();
      setClock((c) => (c.today === today && c.now === now ? c : { today, now }));
    };
    const onVisible = () => document.visibilityState === "visible" && read();
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(read, 60_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [on]);
  return clock;
}

/** ux §7: the card's state, once per day per page, once the plan is in. Draws nothing */
export function NextUpLog({ today, line, ready }: { today: string; line: string; ready: boolean }) {
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || seen.current === today) return;
    seen.current = today;
    console.info("[tg-trip] next-up %s", line);
  }, [today, line, ready]);
  return null;
}

/**
 * TG-69 (ux.md): the first thing on the trip page during the trip. Where we go next, today's bus, and the hotel's
 * address to show a driver; the day before, tomorrow's bus and the to-dos left. It only reads: ticking stays in the
 * map's dialog, which Open on the map opens. No live region, because a card that moves shouldn't talk.
 */
export default function NextUpCard({ up, onJump }: { up: NextUp; onJump: Jump }) {
  const parts: [string, ReactNode][] = up.state === "during"
    ? [
      ...(up.stop ? [["stop", <StopBody key="stop" stop={up.stop} onJump={onJump} />] as [string, ReactNode]] : []),
      ...(up.bus ? [["bus", <BusBody key="bus" label="Bus today" part={up.bus} onJump={onJump} />] as [string, ReactNode]] : []),
      ...(up.hotel ? [["hotel", <HotelBody key="hotel" hotel={up.hotel} />] as [string, ReactNode]] : []),
    ]
    : [
      ...(up.bus ? [["bus", <BusBody key="bus" label="Bus tomorrow" part={up.bus} onJump={onJump} />] as [string, ReactNode]] : []),
      ...(up.todos ? [["todo", <TodoBody key="todo" left={up.todos.left} onJump={onJump} />] as [string, ReactNode]] : []),
    ];
  return (
    <PixelBox as="section" aria-labelledby="next-up-title" className="flex flex-col gap-2 p-4">
      <SectionTitle id="next-up-title">{up.state === "during" ? "Next up" : "Leaving tomorrow"}</SectionTitle>
      <p className={cx(PX.meta, "tabular-nums")}>{up.state === "during" ? dayLine(up) : shortDate(up.date)}</p>
      <div className={cx("flex flex-col", COLUMNS[parts.length])}>
        {parts.map(([key, body]) => (
          <div key={key} className={PART}>{body}</div>
        ))}
      </div>
    </PixelBox>
  );
}

/** "Buses", inside a sentence: opens the map's Buses panel */
function BusesButton({ onJump }: { onJump: Jump }) {
  return (
    <button type="button" className={INLINE} onClick={() => onJump({ menu: "buses" })}>
      Buses
    </button>
  );
}

function StopBody({ stop, onJump }: { stop: StopPart; onJump: Jump }) {
  const jump = jumpFor(stop);
  const onMap = jump && (
    <PixelButton variant="secondary" className={FULL} onClick={() => onJump(jump)}>
      Open on the map
    </PixelButton>
  );
  const then = (stop.kind === "row" || stop.kind === "busRow") && stop.then && <p className={PX.meta}>{thenLine(stop.then)}</p>;
  return (
    <>
      <p className={LABEL}>Next stop</p>
      {stop.kind === "row" && (
        <>
          {stop.time && <p className="text-base font-bold tabular-nums">{formatTime(stop.time)}</p>}
          <p className="text-base break-words">{stop.plan}</p>
          {stop.leg && <p className={PX.meta}>{stop.leg}</p>}
          {then}
          {stop.mapsUrl && stop.mapsName && (
            <PixelLink variant="primary" external href={stop.mapsUrl} aria-label={mapsLabel(stop.mapsName)} className="flex w-full items-center justify-center px-4 py-3">
              Open in Google Maps<span aria-hidden="true">&nbsp;↗</span>
            </PixelLink>
          )}
        </>
      )}
      {stop.kind === "busRow" &&
        (stop.bus ? (
          <BusLines part={stop.bus} onJump={onJump} />
        ) : (
          <>
            <p className="text-base break-words">{stop.plan}</p>
            <p className="text-sm">See <BusesButton onJump={onJump} />.</p>
          </>
        ))}
      {stop.kind === "busRow" && then}
      {stop.kind === "pick" && <p className="text-base font-bold break-words">Pick one first: {stop.title}</p>}
      {stop.kind === "todayDone" && (
        <>
          <p className="text-base font-bold">Today&apos;s plan is done.</p>
          {stop.tomorrow && <p className={cx(PX.meta, "break-words")}>{tomorrowLine(stop.tomorrow)}</p>}
        </>
      )}
      {stop.kind === "allDone" && <p className="text-base font-bold">That&apos;s the whole plan. Ingat pauwi!</p>}
      {stop.kind === "nothingToday" && <p className="text-base">Nothing on the plan for today.</p>}
      {/* The height of a stop with its buttons, so the card doesn't jump when the plan lands */}
      {stop.kind === "opening" && <p className="min-h-40 text-sm text-muted">Opening the plan...</p>}
      {onMap}
    </>
  );
}

/** A bus's lines (ux §5.3): every one from its `trips` row, always with its checked date and the confirm note */
function BusLines({ part, onJump }: { part: BusPart; onJump: Jump }) {
  if (part.kind === "gone") return <p className="text-sm">This bus isn&apos;t on the schedule any more. See <BusesButton onJump={onJump} />.</p>;
  const l = busLines(part);
  return (
    <>
      <p className="font-bold tabular-nums">{l.time}</p>
      <p className="text-sm break-words">{l.route}</p>
      <p className={PX.meta}>{l.checked}</p>
      {!part.booked && <p className="text-sm">Not marked booked yet. See <BusesButton onJump={onJump} />.</p>}
    </>
  );
}

function BusBody({ label, part, onJump }: { label: string; part: BusPart; onJump: Jump }) {
  return (
    <>
      <p className={LABEL}>{label}</p>
      <BusLines part={part} onJump={onJump} />
    </>
  );
}

function TodoBody({ left, onJump }: { left: number; onJump: Jump }) {
  return (
    <>
      <p className={LABEL}>To-do</p>
      <p className="font-bold">{todosLine(left)}</p>
      {left > 0 && (
        <PixelButton variant="secondary" className={FULL} onClick={() => onJump({ menu: "todo" })}>
          Open the to-do list
        </PixelButton>
      )}
    </>
  );
}

/** Where we're staying (ux §5.4, §8.3): the address in big text, to hold up to a driver */
function HotelBody({ hotel }: { hotel: HotelPart }) {
  const opener = useRef<HTMLButtonElement | null>(null);
  const [driver, setDriver] = useState(false);
  const toHotel = () => {
    const title = document.getElementById("hotel-title");
    title?.scrollIntoView({ block: "start", behavior: smooth() });
    title?.focus({ preventScroll: true });
  };
  return (
    <>
      <p className={LABEL}>Where we&apos;re staying</p>
      {hotel.from === "none" ? (
        <p className="text-sm">
          No hotel added yet. Add it in <button type="button" className={INLINE} onClick={toHotel}>Where we&apos;re staying</button>.
        </p>
      ) : (
        <>
          <p className="font-bold break-words">{hotel.name}</p>
          {hotel.from === "trip" && hotel.address && <p className="text-lg select-text break-words">{hotel.address}</p>}
          {hotel.from === "trip" && hotel.checkOut && <p className={PX.meta}>Check-out {hotelTime(hotel.checkOut)}</p>}
          {hotel.from === "trip" && hotel.address && (
            <PixelButton variant="secondary" className={FULL}
              onClick={(e) => {
                opener.current = e.currentTarget;
                setDriver(true);
              }}>
              Show the driver
            </PixelButton>
          )}
          <PixelLink variant="secondary" external href={hotel.mapsUrl} aria-label={mapsLabel(hotel.name)} className={FULL}>
            Open in Google Maps<span aria-hidden="true">&nbsp;↗</span>
          </PixelLink>
          {hotel.from === "trip" && hotel.address && (
            <DriverView hotel={driver ? { name: hotel.name, address: hotel.address } : null} opener={opener} onClose={() => setDriver(false)} />
          )}
        </>
      )}
    </>
  );
}
