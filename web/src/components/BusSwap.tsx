"use client";

// TG-61 ux.md §7: swap a bus for another real trip on the same day and way. Only trips on file are listed, through
// TripCard with its trust lines; a time or fare is never typed in (CLAUDE.md). Picking one goes to a proposal.
import { useEffect, useState } from "react";
import { PX, PixelButton } from "@/components/pixel";
import { type Trip, formatClass, formatTime, searchTrips } from "@/lib/api";
import type { BusRow, Guide } from "@/lib/guide";
import { swapBus } from "@/lib/planEdit";
import { type ChangeLine, busWarningLine, town } from "@/lib/planLines";
import { datesLine } from "@/lib/trip";
import { ChangeList, PlanProblem } from "./PlanBits";
import type { Focus, PlanEditor } from "./PlanEditor";
import TripCard from "./TripCard";

export type BusAt = { table: "getting_there" | "getting_home"; index: number };

const busName = (t: Trip | null) => (t ? `${formatTime(t.departure_time)} ${t.operator_name} ${formatClass(t.service_class)}` : "a bus no longer listed");

/** The bus row on a day the booked bus sets the time of (ux-arch-notes 7). */
const busRowOf = (g: Guide, table: BusAt["table"]) => g.days.flatMap((d) => d.rows.map((r) => ({ r, day: d.day }))).find(({ r }) => r.bus === (table === "getting_there" ? "outbound" : "return"));

export function busAt(g: Guide, at: BusAt): BusRow | undefined {
  return g[at.table].buses[at.index];
}

export default function BusSwap({ editor, guide, at, onApplied, onBack }: {
  editor: PlanEditor;
  guide: Guide;
  at: BusAt;
  onApplied: (focus: Focus) => void;
  onBack?: () => void;
}) {
  const bus = busAt(guide, at);
  const up = at.table === "getting_there";
  const [list, setList] = useState<Trip[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState<Trip | null>(null);
  const [applying, setApplying] = useState(false);
  const [problem, setProblem] = useState("");
  const date = bus?.date ?? "";

  useEffect(() => {
    if (!date) return;
    let live = true;
    searchTrips({ originCity: up ? "Metro Manila" : "Baguio", destinationCity: up ? "Baguio" : "Metro Manila", date }).then(
      (trips) => {
        console.info("[tg-trip] plan swap list trips=%d", trips.length);
        if (live) setList(trips);
      },
      () => {
        console.info("[tg-trip] plan swap list failed");
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [date, up]);

  if (!bus) return null;
  const old = bus.trip;
  // e2e W-8: the towns, as ux §7 names them ("from Cubao to Baguio"), not the terminals
  const from = old ? town(old.origin_name, old.operator_name) : up ? "Metro Manila" : "Baguio";
  const to = old ? town(old.destination_name, old.operator_name) : up ? "Baguio" : "Metro Manila";
  const day = datesLine(date, date);
  const others = (list ?? []).filter((t) => t.trip_id !== bus.trip_id);
  const off = !editor.can || applying;
  const booked = bus.booked;

  async function onApply() {
    if (off || !picked) return;
    setApplying(true);
    setProblem("");
    const row = busRowOf(guide, at.table);
    const out = await editor.save("plan-bus", (g) => swapBus(g, at.table, at.index, picked.trip_id), { kind: "bus", from: old?.departure_time ?? null, to: picked.departure_time }, booked ? (row?.r.key ?? null) : null);
    setApplying(false);
    if (out.ok) return onApplied(out.focus);
    if (!out.ignored) setProblem(out.message);
  }

  if (picked) {
    const row = bus.booked ? busRowOf(guide, at.table) : undefined;
    const lines: ChangeLine[] = [
      { word: "Out", day: null, text: busName(old) },
      { word: "In", day: null, text: busName(picked) },
      ...(row && row.r.time !== picked.departure_time
        ? [{ word: picked.departure_time > row.r.time ? "Later" : "Earlier", day: row.day, text: `${row.r.plan}, ${formatTime(row.r.time)} to ${formatTime(picked.departure_time)}` }]
        : []),
    ];
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm font-semibold">What changes</p>
        <ChangeList lines={lines} />
        {row && <p className={PX.meta}>Check the bus row&apos;s note: it may still name the old bus.</p>}
        {problem && <PlanProblem text={problem} />}
        <PixelButton variant="primary" className="w-full px-4 py-3" aria-disabled={off || undefined} onClick={onApply}>
          {applying ? "Applying..." : "Apply"}
        </PixelButton>
        <p className={PX.meta}>Nothing changes until you tap Apply.</p>
        <PixelButton variant="secondary" className="inline-flex items-center self-start px-4 text-sm" onClick={() => setPicked(null)}>Back</PixelButton>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {bus.warning && <p className="text-sm font-semibold">{busWarningLine(bus.warning, date)}</p>}
      {bus.booked && <p className="text-sm">You marked it booked, so check your ticket with {old?.operator_name ?? "the bus company"} before you swap.</p>}
      <p className="text-sm">Buses on file from {from} to {to} on {day}.</p>
      {failed && <PlanProblem text="The bus list didn't load. Check your signal, then try again." />}
      {list === null && !failed && <p className="text-sm text-muted">Finding buses...</p>}
      {list !== null && others.length === 0 && <p className="text-sm">No other buses on file from {from} to {to} on {day} yet.</p>}
      {others.length > 0 && (
        <ul className="flex flex-col gap-3">
          {others.map((t) => (
            <TripCard key={t.trip_id} trip={t}
              action={<PixelButton variant="secondary" className="inline-flex items-center self-start px-4 text-sm" aria-disabled={!editor.can || undefined} onClick={() => editor.can && setPicked(t)}>Use this bus</PixelButton>} />
          ))}
        </ul>
      )}
      {others[0]?.confirm_note && <p className={PX.meta}>{others[0].confirm_note}</p>}
      {onBack && <PixelButton variant="secondary" className="inline-flex items-center self-start px-4 text-sm" onClick={onBack}>Back</PixelButton>}
    </div>
  );
}

export const swapTitle = (bus: BusRow | undefined) => (bus?.trip ? `Swap the ${formatTime(bus.trip.departure_time)} bus` : "Swap this bus");
