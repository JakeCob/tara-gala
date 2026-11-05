"use client";

// TG-61 ux.md §4: the change menu, inside the level dialog (one dialog, so focus stays in it). Each choice swaps the
// dialog's content and has Back. Every control that changes the plan waits while a plan write is out or a newer plan
// isn't on screen yet (ux.md §3.3): it's aria-disabled and a tap does nothing, so nothing is queued.
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { PX, PixelBox, PixelButton, PixelChoice, cx } from "@/components/pixel";
import { formatTime } from "@/lib/api";
import { type Guide, type GuideRow, type Mark, marksByKey, rowMark, rowShows } from "@/lib/guide";
import type { Level } from "@/lib/levelMap";
import { type At, type PlaceIn, type RowIn, type Suggestion, noteSuggestion, nudgeRow, removeRow, setRow, toStored } from "@/lib/planEdit";
import { busChangedLine, levelLabel, removeConfirm } from "@/lib/planLines";
import { type SuggestIn, type TripFile, planFailureMessage } from "@/lib/trip";
import BusSwap, { type BusAt, busAt, swapTitle } from "./BusSwap";
import FitPlace, { type FitState, type Slot } from "./FitPlace";
import { PlanProblem, SaidText } from "./PlanBits";
import type { Focus, PlanEditor } from "./PlanEditor";
import { type Chosen, FindPlace, Proposal, linkPlace } from "./PlaceInput";

type Mode = "replace" | "add" | "move" | "fit";
type SlotAt = Exclude<SuggestIn["at"], { anywhere: true }>;
/** A fit's proposal knows its slot, which may be on another day than the map, and the choice Back returns to. */
type Proposed = { mode: Mode; chosen: Chosen; day: number; slot?: Slot; fit?: FitState; fitFrom?: Chosen };
type Step =
  | { k: "menu" }
  | { k: "find"; mode: "replace" | "add" | "fit"; text?: string }
  | { k: "fit"; chosen: Chosen; fit: FitState }
  | ({ k: "propose" } & Proposed)
  | ({ k: "clash" } & Proposed)
  | { k: "time" }
  | { k: "move" }
  | { k: "bus" };


const placeOf = (r: GuideRow): PlaceIn | null =>
  r.place?.kind === "spot" ? { spot_id: r.place.id } : r.place?.kind === "trip_place" ? { trip_place_id: r.place.id } : null;
const whereFrom = (r: GuideRow | undefined) => (r ? (r.place?.name ?? r.plan) : null);

/** A dialog that holds a plan step on its own: Add a stop to World N, and Swap this bus from the Buses panel. */
export function PlanDialog({ label, bare, onClose, children }: { label: string; bare?: boolean; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);
  return (
    <dialog ref={dialog} aria-label={label} onClose={(e) => e.target === e.currentTarget && onClose()}
      onClick={(e) => e.target === e.currentTarget && e.currentTarget.close()}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(28rem,calc(100%-2rem))] bg-transparent p-0 text-foreground backdrop:bg-screen-ink/60">
      <div className="pixel-box flex flex-col gap-3 bg-card p-4 text-foreground">
        {!bare && (
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm font-bold break-words">{label}</p>
            <PixelButton variant="secondary" onClick={() => dialog.current?.close()}>Close</PixelButton>
          </div>
        )}
        {children}
      </div>
    </dialog>
  );
}

export default function StopChange({ editor, guide, marks, files, level, world, start, onClose, onBack, onDone }: {
  editor: PlanEditor;
  guide: Guide;
  marks: readonly Mark[];
  files: readonly TripFile[];
  /** The stop, or null for "Add a stop to World N" */
  level: Level | null;
  world: number;
  /** fit: Add a place, which asks the server where the place fits (ux.md §4.8) */
  start: "menu" | "find" | "fit";
  onClose: () => void;
  /** Back from the menu, to the stop's own view (when it was opened from there) */
  onBack?: () => void;
  onDone: (focus: Focus) => void;
}) {
  const [step, setStep] = useState<Step>(start === "menu" ? { k: "menu" } : { k: "find", mode: start === "fit" ? "fit" : "add" });
  const [said, setSaid] = useState("");
  const [problem, setProblem] = useState("");
  const used = useRef<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLParagraphElement>(null);
  const row = level?.row;
  const key = row?.key ?? null;
  const day = guide.days.find((d) => d.day === world) ?? guide.days[0];
  const at = key ? day.rows.findIndex((r) => r.key === key) : -1;
  const before = at > 0 ? day.rows[at - 1] : undefined;
  const last = day.rows.at(-1);
  const off = !editor.can;
  const picks = marksByKey(marks);
  const label = (k: string) => levelLabel(guide, marks, k);

  // Back to the menu puts focus on the button that was used; a new step starts at its heading (ux.md §12). On first
  // open, showModal has already put focus on Close
  const opened = useRef(false);
  useEffect(() => {
    if (!opened.current) {
      opened.current = true;
      return;
    }
    if (step.k === "menu" && used.current) box.current?.querySelector<HTMLElement>(`[data-menu="${used.current}"]`)?.focus();
    else if (step.k !== "find" && step.k !== "propose" && step.k !== "fit") top.current?.focus();
  }, [step.k]);

  const go = (name: "replace" | "add" | "time" | "move" | "bus", next: Step) => {
    if (off) return;
    used.current = name;
    setProblem("");
    setSaid("");
    setStep(next);
  };

  // Where a found place would go, for the server's suggestion and the phone's own (a note with no pin)
  const addAfter = level ? key : (last?.key ?? null);
  const suggestAt = (mode: Mode, toDay = world): SlotAt => {
    if (mode === "replace" && key) return { replace: key };
    const target = guide.days.find((d) => d.day === toDay);
    const after = mode === "move" ? (target?.rows.filter((r) => r.key !== key).at(-1)?.key ?? null) : addAfter;
    return after ? { after } : { first_of_day: toDay };
  };
  const atFor = (mode: Mode, toDay: number): At => (mode === "move" && key ? { move: key, day: toDay } : suggestAt(mode, toDay));
  const noteFor = (mode: Mode, toDay = world) => (name: string): Suggestion => {
    const s = suggestAt(mode, toDay);
    const g = toStored(guide);
    if ("replace" in s && row) {
      const base = noteSuggestion(g, before?.key ? { after: before.key } : { first_of_day: world }, name);
      return { ...base, time: row.time, changes: [{ word: "Out", day: world, text: row.plan, part: "stop" }, { word: "In", day: world, text: name, part: "stop" }] };
    }
    return noteSuggestion(g, "after" in s ? { after: s.after } : { first_of_day: "first_of_day" in s ? s.first_of_day : toDay }, name);
  };

  async function onMoveTo(toDay: number) {
    if (off || !row) return;
    const place = placeOf(row);
    const s = suggestAt("move", toDay);
    const r = place ? await editor.suggest(s, place as SuggestIn["place"]) : null;
    if (r && !r.ok) return setProblem(planFailureMessage(r));
    const suggestion = r?.ok ? r.body : noteFor("move", toDay)(row.plan);
    setStep({ k: "propose", mode: "move", day: toDay, chosen: { place, link: null, pin: null, name: row.plan, suggestion } });
  }

  async function onNudge(dir: -1 | 1) {
    if (off || !key) return;
    setSaid("Moving...");
    const word = dir < 0 ? "earlier" : "later";
    const out = await editor.save("plan-nudge", (g) => nudgeRow(g, key, dir, (r: RowIn) => rowShows(r as unknown as GuideRow, picks)), { kind: "nudge", dir: word }, key);
    if (!out.ok) {
      if (!out.ignored) setSaid(out.message);
      return;
    }
    const now = levelLabel(out.guide, marks, key);
    const d = out.guide.days.find((x) => x.rows.some((r) => r.key === key));
    const rows = d?.rows.filter((r) => rowShows(r, picks)) ?? [];
    const i = rows.findIndex((r) => r.key === key);
    const t = rows[i]?.time ?? "";
    const outOfOrder = (i > 0 && rows[i - 1].time > t) || (i < rows.length - 1 && rows[i + 1].time < t);
    setSaid(`Moved ${word}. It's now Level ${now}.${outOfOrder ? ` Its time is still ${formatTime(t)}. Change it in Change time and note.` : ""}`);
  }

  async function onRemove() {
    if (off || !row || !key) return;
    const ticked = picks.get(rowMark(row))?.value === "done";
    const photos = files.filter((f) => f.kind === "photo" && f.row_key === key).length;
    if (!window.confirm(removeConfirm(row.plan, world, ticked, photos))) {
      console.info("[tg-trip] plan remove declined");
      return;
    }
    const out = await editor.save("plan-remove", (g) => removeRow(g, key), { kind: "remove" }, key);
    if (out.ok) return onDone(out.focus);
    if (!out.ignored) setProblem(out.message);
  }

  // Where a place fits, asked again: after a clash the ranking can change with the newer plan (B60, ux.md §4.8)
  async function onRefit(s: Proposed) {
    if (off) return;
    const { chosen } = s;
    const place = (chosen.place ?? (chosen.link ? linkPlace(chosen) : null)) as SuggestIn["place"] | null;
    const r = place ? await editor.suggest({ anywhere: true }, place) : null;
    if (r && !r.ok) return setProblem(planFailureMessage(r));
    setProblem("");
    setStep({ k: "fit", chosen: r?.ok ? { ...chosen, suggestion: { ...r.body, name: chosen.name } } : chosen, fit: s.fit ?? { pick: 0, manual: !place, day: world, after: null } });
  }

  async function onRecheck(s: Proposed) {
    if (off) return;
    if (s.mode === "fit") return onRefit(s);
    const { chosen } = s;
    const r = chosen.place ? await editor.suggest(suggestAt(s.mode, s.day), chosen.place as SuggestIn["place"]) : chosen.link ? await editor.suggest(suggestAt(s.mode, s.day), linkPlace(chosen)) : null;
    if (r && !r.ok) return setProblem(planFailureMessage(r));
    setProblem("");
    setStep({ ...s, k: "propose", chosen: { ...chosen, suggestion: r?.ok ? r.body : noteFor(s.mode, s.day)(chosen.name) } });
  }

  const busTable = row?.bus === "outbound" ? "getting_there" : row?.bus === "return" ? "getting_home" : null;
  const bus: BusAt | null = busTable ? { table: busTable, index: Math.max(0, guide[busTable].buses.findIndex((b) => b.booked)) } : null;
  const where = level ? `Level ${level.label}` : `World ${world}`;
  const heading = ((): string => {
    switch (step.k) {
      case "menu":
        return row ? `${where} · ${formatTime(row.time)}` : where;
      case "find":
        if (step.mode === "fit") return "Add a place";
        return step.mode === "replace" ? `Replace ${where}` : level ? `Add a stop after ${where}` : `Add a stop to ${where}`;
      case "fit":
        return `Where ${step.chosen.name} fits`;
      case "propose":
      case "clash":
        if (step.slot) return `Add ${step.chosen.name} after Level ${label(step.slot.after) ?? ""}`;
        if (step.mode === "replace") return `Replace ${where} with ${step.chosen.name}`;
        if (step.mode === "move") return `Move ${where} to World ${step.day}`;
        return level ? `Add ${step.chosen.name} after ${where}` : `Add ${step.chosen.name} to ${where}`;
      case "time":
        return `Change ${where}`;
      case "move":
        return `Move ${where}`;
      case "bus":
        return bus ? swapTitle(busAt(guide, bus)) : "Change the bus";
    }
  })();

  const fit = (mode: Mode, toDay: number, slot?: Slot) => {
    if (slot) {
      const rows = guide.days.find((d) => d.day === slot.day)?.rows ?? [];
      const i = rows.findIndex((r) => r.key === slot.after);
      const next = rows[i + 1];
      return i >= 0 && next ? `Fits between ${formatTime(rows[i].time)} and ${formatTime(next.time)}.` : "After the last stop of the day.";
    }
    if (mode === "replace") return "Keeps this stop's time slot.";
    if (mode === "move") return `At the end of World ${toDay}.`;
    const after = addAfter ? day.rows.findIndex((r) => r.key === addAfter) : -1;
    const next = day.rows[after + 1];
    if (after < 0) return "The first stop of the day.";
    return next ? `Fits between ${formatTime(day.rows[after].time)} and ${formatTime(next.time)}.` : "After the last stop of the day.";
  };
  const fromFor = (mode: Mode, toDay: number, slot?: Slot): string | null => {
    if (slot) return whereFrom(guide.days.flatMap((d) => d.rows).find((r) => r.key === slot.after));
    if (mode === "replace") return whereFrom(before);
    if (mode === "move") return whereFrom(guide.days.find((d) => d.day === toDay)?.rows.filter((r) => r.key !== key).at(-1));
    return addAfter ? whereFrom(day.rows.find((r) => r.key === addAfter)) : null;
  };
  const rowName = (k: string) => guide.days.flatMap((d) => d.rows).find((r) => r.key === k)?.plan ?? "a stop";
  const rowTime = (k: string) => guide.days.flatMap((d) => d.rows).find((r) => r.key === k)?.time ?? null;
  const doneFor = (mode: Mode, toDay: number, slot?: Slot) =>
    slot ? ({ kind: "add", after: slot.after, day: slot.day, world: true } as const) : mode === "replace" ? ({ kind: "replace" } as const) : mode === "move" ? ({ kind: "move", day: toDay } as const) : ({ kind: "add", after: addAfter, day: world } as const);

  return (
    <div ref={box} className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <p ref={top} tabIndex={-1} className="text-sm font-bold break-words tabular-nums">{heading}</p>
        {/* First in the DOM after the heading, as in the level dialog */}
        <PixelButton variant="secondary" onClick={onClose}>Close</PixelButton>
      </div>

      {step.k === "menu" && row && (
        <>
          <p className="text-lg font-bold break-words">{row.plan}</p>
          {/* e2e W-9: in edit mode too, the swapped bus's row says to check its note (ux §7) */}
          {row.bus && busChangedLine(editor.edits, row.plan) && <p className={PX.meta}>{busChangedLine(editor.edits, row.plan)}</p>}
          {row.note && <p className="text-sm break-words">{row.note}</p>}
          {row.place?.name && <p className="text-sm font-semibold break-words">{row.place.name}</p>}
          {(row.show_if || row.hide_if) && (
            <span className={cx(PX.chip, "self-start")}>
              {row.show_if ? `Only if the group picks ${row.show_if.is}` : `Not if the group picks ${row.hide_if!.is}`}
            </span>
          )}
          <div className="flex flex-col gap-2">
            {row.bus ? (
              <PixelButton data-menu="replace" variant="secondary" className="inline-flex w-full items-center justify-center px-4 text-sm" aria-disabled={off || undefined} onClick={() => go("bus", { k: "bus" })}>
                Change the bus
              </PixelButton>
            ) : (
              <PixelButton data-menu="replace" variant="secondary" className="inline-flex w-full items-center justify-center px-4 text-sm" aria-disabled={off || undefined} onClick={() => go("replace", { k: "find", mode: "replace" })}>
                Replace this stop
              </PixelButton>
            )}
            <PixelButton data-menu="add" variant="secondary" className="inline-flex w-full items-center justify-center px-4 text-sm" aria-disabled={off || undefined} onClick={() => go("add", { k: "find", mode: "add" })}>
              Add a stop after it
            </PixelButton>
            <PixelButton data-menu="time" variant="secondary" className="inline-flex w-full items-center justify-center px-4 text-sm" aria-disabled={off || undefined} onClick={() => go("time", { k: "time" })}>
              Change time and note
            </PixelButton>
            <PixelButton data-menu="move" variant="secondary" className="inline-flex w-full items-center justify-center px-4 text-sm" aria-disabled={off || undefined} onClick={() => go("move", { k: "move" })}>
              Move
            </PixelButton>
            {!row.bus && (
              <PixelButton data-menu="remove" variant="secondary" className="inline-flex w-full items-center justify-center px-4 text-sm" aria-disabled={off || undefined} onClick={onRemove}>
                Remove this stop
              </PixelButton>
            )}
          </div>
          {problem && <PlanProblem text={problem} />}
          {onBack && <PixelButton variant="secondary" className="inline-flex items-center self-start px-4 text-sm" onClick={onBack}>Back</PixelButton>}
        </>
      )}

      {step.k === "find" && (
        <FindPlace editor={editor} at={step.mode === "fit" ? { anywhere: true } : suggestAt(step.mode)} noteFor={noteFor(step.mode === "fit" ? "add" : step.mode)}
          startText={step.text} finding={step.mode === "fit" ? "Finding where it fits..." : undefined}
          onChosen={(chosen) => {
            const name = chosen.name || chosen.suggestion.name || "";
            if (step.mode === "fit") setStep({ k: "fit", chosen: { ...chosen, name }, fit: { pick: 0, manual: !(chosen.place || chosen.link), day: world, after: null } });
            else setStep({ k: "propose", mode: step.mode, chosen, day: world });
          }}
          onBack={() => (level ? setStep({ k: "menu" }) : onClose())} />
      )}

      {step.k === "fit" && (
        <>
          {(step.chosen.link || step.chosen.place && "trip_place_id" in step.chosen.place) && (
            <span className={cx(PX.chip, "self-start")}>Added by your group, not verified</span>
          )}
          <FitPlace editor={editor} guide={guide} marks={marks} chosen={step.chosen} start={step.fit}
            onNext={(slot, suggestion, state) => setStep({ k: "propose", mode: "fit", day: slot.day, slot, fit: state, fitFrom: step.chosen, chosen: { ...step.chosen, suggestion } })}
            onBack={() => setStep({ k: "find", mode: "fit", text: step.chosen.link ?? step.chosen.name })} />
        </>
      )}

      {step.k === "propose" && (
        <Proposal key={`${step.mode}-${step.day}-${step.slot?.after}-${step.chosen.name}`} editor={editor} chosen={step.chosen}
          at={step.slot ? { after: step.slot.after } : atFor(step.mode, step.day)} kind={step.mode === "fit" ? "add" : step.mode}
          anchor={step.slot ? step.slot.after : step.mode === "add" ? addAfter : key} done={doneFor(step.mode, step.day, step.slot)}
          fit={fit(step.mode, step.day, step.slot)} from={fromFor(step.mode, step.day, step.slot)}
          rowName={rowName} rowTime={rowTime} onApplied={onDone}
          onBack={() => setStep(step.mode === "move" ? { k: "move" } : step.mode === "fit" ? { k: "fit", chosen: step.fitFrom ?? step.chosen, fit: step.fit! } : { k: "find", mode: step.mode, text: step.chosen.link ?? step.chosen.name })}
          onClash={() => setStep({ ...step, k: "clash" })} />
      )}

      {step.k === "clash" && (
        // The newer plan is being fetched behind this dialog; what was chosen is kept (ux.md §6)
        (key && step.mode !== "add" ? !guide.days.some((d) => d.rows.some((r) => r.key === key)) : false) ? (
          <>
            <ClashBox lead="Someone just changed the plan, and this stop isn't in it any more." rest="Your change wasn't saved. Changes shows what they did." />
            <PixelButton variant="secondary" className="inline-flex items-center self-start px-4 text-sm" onClick={onClose}>Close</PixelButton>
          </>
        ) : (
          <>
            <ClashBox lead="Someone just changed the plan, so your change wasn't saved." rest="The map now shows their version. Check your change against it, then tap Apply again." />
            {problem && <PlanProblem text={problem} />}
            <PixelButton variant="secondary" className="inline-flex items-center self-start px-4 text-sm" aria-disabled={off || undefined} onClick={() => onRecheck(step)}>
              {step.mode === "fit" ? "Find where it fits again" : "Check my change again"}
            </PixelButton>
            <p role="status" className="text-sm empty:sr-only">{off ? <SaidText said={editor.status} /> : ""}</p>
          </>
        )
      )}

      {step.k === "time" && row && key && (
        <TimeAndNote editor={editor} row={row} before={before} after={day.rows[at + 1]} label={label}
          onSaved={onDone} onBack={() => setStep({ k: "menu" })} />
      )}

      {step.k === "move" && row && key && (
        <>
          <div className="flex flex-wrap gap-2">
            {([-1, 1] as const).map((dir) => {
              const shown = day.rows.filter((r) => rowShows(r, picks));
              const i = shown.findIndex((r) => r.key === key);
              const end = dir < 0 ? i <= 0 : i >= shown.length - 1;
              return (
                <PixelButton key={dir} variant="secondary" aria-disabled={off || end || undefined} onClick={() => !end && onNudge(dir)}>
                  {off && said === "Moving..." ? "Moving..." : dir < 0 ? "Move earlier" : "Move later"}
                </PixelButton>
              );
            })}
          </div>
          {/* The edit bar sits behind this dialog, so the dialog says what happened (ux.md §3.3) */}
          <p role="status" aria-live="polite" className="text-sm empty:sr-only">{said === "Moving..." && editor.status !== "Saving..." && !off ? "" : said}</p>
          {!row.bus && guide.days.length > 1 && (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-semibold">Or move it to another day</legend>
              {guide.days.map((d) => (
                <PixelChoice key={d.day} name="move-world" value={String(d.day)} checked={d.day === world}
                  onChange={() => d.day !== world && onMoveTo(d.day)} inputProps={{ "aria-disabled": off || undefined }}
                  className="flex min-h-11 items-center gap-2 px-3 py-2 text-left text-sm">
                  World {d.day}
                </PixelChoice>
              ))}
            </fieldset>
          )}
          <p className={PX.meta}>Its tick and photos move with it.</p>
          {problem && <PlanProblem text={problem} />}
          <PixelButton variant="secondary" className="inline-flex items-center self-start px-4 text-sm" onClick={() => setStep({ k: "menu" })}>Back</PixelButton>
        </>
      )}

      {step.k === "bus" && bus && (
        <BusSwap editor={editor} guide={guide} at={bus} onApplied={onDone} onBack={() => setStep({ k: "menu" })} />
      )}
    </div>
  );
}

/** A clash keeps the dialog open over the newer plan (ux.md §6): what happened, then what to do. */
function ClashBox({ lead, rest }: { lead: string; rest: string }) {
  return (
    <PixelBox tone="alert" role="alert" className="flex flex-col gap-1 p-3">
      <p className="text-sm font-semibold text-danger-text">{lead}</p>
      <p className="text-sm">{rest}</p>
    </PixelBox>
  );
}

/** Change time and note (ux.md §4.5). A bus row's time comes from its bus, so only its text changes here. */
function TimeAndNote({ editor, row, before, after, label, onSaved, onBack }: {
  editor: PlanEditor;
  row: GuideRow;
  before: GuideRow | undefined;
  after: GuideRow | undefined;
  label: (key: string) => string | null;
  onSaved: (focus: Focus) => void;
  onBack: () => void;
}) {
  const [time, setTime] = useState(row.time);
  const [plan, setPlan] = useState(row.plan);
  const [note, setNote] = useState(row.note);
  const [problem, setProblem] = useState<{ field: "time" | "plan" | "save"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const off = !editor.can || saving;
  const early = !row.bus && before && time < before.time ? before : null;
  const late = !row.bus && after && time > after.time ? after : null;

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (off) return;
    if (!row.bus && !/^\d{2}:\d{2}$/.test(time)) return setProblem({ field: "time", text: "Pick a time first." });
    if (!plan.trim()) return setProblem({ field: "plan", text: "Type what you'll do first." });
    setProblem(null);
    setSaving(true);
    const parts = row.bus ? { plan: plan.trim(), note: note.trim() } : { time, plan: plan.trim(), note: note.trim() };
    const out = await editor.save("plan-edit", (g) => setRow(g, row.key, parts), { kind: "edit", key: row.key }, row.key);
    setSaving(false);
    if (out.ok) return onSaved(out.focus);
    if (!out.ignored) setProblem({ field: "save", text: out.message });
  }

  return (
    <form onSubmit={onSave} noValidate className="flex flex-col gap-3">
      {row.bus ? (
        <p className="text-sm">The time comes from the bus.</p>
      ) : (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-semibold">Time</span>
          <input type="time" className={PX.input} value={time} onChange={(e) => setTime(e.target.value)} autoFocus />
        </label>
      )}
      {problem?.field === "time" && <PlanProblem text={problem.text} />}
      {(early || late) && (
        <p className={PX.meta}>
          That&apos;s {early ? "earlier" : "later"} than Level {label((early ?? late)!.key)} ({formatTime((early ?? late)!.time)}). To change the order, use Move.
        </p>
      )}
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-semibold">What you&apos;ll do</span>
        <input className={PX.input} value={plan} maxLength={120} onChange={(e) => setPlan(e.target.value)} />
      </label>
      {problem?.field === "plan" && <PlanProblem text={problem.text} />}
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-semibold">Note</span>
        <span className={PX.meta}>Optional.</span>
        <textarea className={PX.input} rows={3} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
      </label>
      {problem?.field === "save" && <PlanProblem text={problem.text} />}
      <div className="flex flex-wrap gap-2">
        <PixelButton type="submit" variant="primary" aria-disabled={off || undefined}>{saving ? "Saving..." : "Save"}</PixelButton>
        <PixelButton variant="secondary" onClick={onBack}>Back</PixelButton>
      </div>
    </form>
  );
}

