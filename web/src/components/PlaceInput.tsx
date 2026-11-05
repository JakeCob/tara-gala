"use client";

// TG-61 ux.md §4.3 and §4.4: find a place by name or Google Maps link, then the proposal with Apply. A name is searched
// on the phone; only a link goes to the server. Nothing is saved before Apply, and a trip place is made only then, so
// Back leaves nothing behind.
import { type FormEvent, useEffect, useRef, useState } from "react";
import { PX, PixelBox, PixelButton, PixelChoice, cx } from "@/components/pixel";
import { formatTime } from "@/lib/api";
import { type At, type Found, type PlaceIn, type Suggestion, applySuggestion, findPlaces, isLink } from "@/lib/planEdit";
import type { ChangeLine, Done } from "@/lib/planLines";
import { farLine } from "@/lib/planLines";
import { type SuggestIn, planFailureMessage, planOutcome } from "@/lib/trip";
import { ChangeList, LegLine, PlanProblem } from "./PlanBits";
import type { Focus, PlanEditor } from "./PlanEditor";

/** What goes there: a spot or trip place, a link the server pins on Apply, or a note with no pin. */
export type Chosen = { place: PlaceIn | null; link: string | null; name: string; suggestion: Suggestion };

const MAX_NAME = 80;
const ON_FILE = "No opening hours or jeep routes on file.";

export function FindPlace({ editor, at, noteFor, onChosen, onBack }: {
  editor: PlanEditor;
  at: SuggestIn["at"];
  noteFor: (name: string) => Suggestion;
  onChosen: (c: Chosen) => void;
  onBack: () => void;
}) {
  const [text, setText] = useState("");
  const [searched, setSearched] = useState<string | null>(null);
  const [found, setFound] = useState<Found[]>([]);
  const [finding, setFinding] = useState(false);
  const [problem, setProblem] = useState("");
  const [pinned, setPinned] = useState<{ link: string; suggestion: Suggestion } | null>(null);
  const [name, setName] = useState("");
  const [nameProblem, setNameProblem] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const { wantSpots } = editor;
  useEffect(() => {
    wantSpots();
    field.current?.focus();
  }, [wantSpots]);

  async function onFind(e: FormEvent) {
    e.preventDefault();
    setProblem("");
    setPinned(null);
    const typed = text.trim();
    if (!typed) return setProblem("Paste a Google Maps link, or type a place or store name.");
    if (!isLink(typed)) {
      setSearched(typed);
      setFound(findPlaces(typed, editor.spots ?? [], editor.places));
      console.info("[tg-trip] plan find kind=name spots=%s", editor.spots ? "yes" : "no");
      return;
    }
    if (!editor.online) {
      console.info("[tg-trip] plan find kind=link ok=offline");
      return setProblem("Finding a link needs signal.");
    }
    setFinding(true);
    const r = await editor.suggest(at, { link: typed });
    setFinding(false);
    console.info("[tg-trip] plan find kind=link ok=%s", planOutcome(r));
    if (!r.ok) return setProblem(planFailureMessage(r));
    setPinned({ link: typed, suggestion: r.body });
    setName((r.body.name ?? "").slice(0, MAX_NAME));
  }

  async function onPick(f: Found) {
    setFinding(true);
    setProblem("");
    const place: PlaceIn = f.kind === "spot" ? { spot_id: f.id } : { trip_place_id: f.id };
    const r = await editor.suggest(at, place as SuggestIn["place"]);
    setFinding(false);
    console.info("[tg-trip] plan find kind=%s ok=%s", f.kind, r.ok ? "yes" : r.why);
    if (!r.ok) return setProblem(planFailureMessage(r));
    onChosen({ place, link: null, name: f.name, suggestion: r.body });
  }

  function onNoteOnly() {
    const typed = text.trim();
    if (!typed || isLink(typed)) return setProblem("Type what you'll do there first.");
    onChosen({ place: null, link: null, name: typed.slice(0, 120), suggestion: noteFor(typed.slice(0, 120)) });
  }

  function onNext() {
    const typed = name.trim();
    if (!typed || typed.length > MAX_NAME) return setNameProblem("Type its name first.");
    if (pinned) onChosen({ place: null, link: pinned.link, name: typed, suggestion: pinned.suggestion });
  }

  const s = pinned?.suggestion;
  return (
    <div className="flex flex-col gap-3">
      <form onSubmit={onFind} noValidate className="flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-semibold">Where to?</span>
          <input ref={field} className={PX.input} value={text} maxLength={2000} autoComplete="off" onChange={(e) => setText(e.target.value)} />
        </label>
        <p className={PX.meta}>Paste a Google Maps link, or type a place or store name.</p>
        {problem && <PlanProblem text={problem} />}
        <PixelButton type="submit" variant="primary" aria-disabled={finding || undefined} className="w-full px-4 py-3">
          {finding ? "Finding..." : "Find"}
        </PixelButton>
      </form>

      {searched !== null && !pinned && (
        found.length > 0 ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-semibold">On Tara Gala</legend>
            {found.map((f) => (
              <PixelChoice key={`${f.kind}-${f.id}`} name="place" value={f.id} checked={false} onChange={() => !finding && onPick(f)}
                className="flex min-h-11 items-center gap-2 px-3 py-2 text-left text-sm">
                <span className="flex flex-col">
                  <span>{f.name}</span>
                  <span className="text-xs font-normal">{f.line}</span>
                </span>
              </PixelChoice>
            ))}
          </fieldset>
        ) : (
          <p className="text-sm">No place called &ldquo;{searched}&rdquo; on Tara Gala yet. Paste its Google Maps link to pin it, or add it as a note with no pin.</p>
        )
      )}

      {pinned && s && (
        <div className={cx(PX.box.skin, "flex flex-col gap-2 p-3")}>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-semibold">Name</span>
            <input className={PX.input} value={name} maxLength={MAX_NAME} autoComplete="off" onChange={(e) => { setName(e.target.value); setNameProblem(""); }} />
          </label>
          {nameProblem && <PlanProblem text={nameProblem} />}
          <span className={cx(PX.chip, "self-start")}>Added by your group, not verified</span>
          <p className={PX.meta}>
            Pinned from your link{s.km_from_baguio != null && !s.far ? `, about ${Math.round(s.km_from_baguio)} km from Baguio` : ""}. {ON_FILE}
          </p>
          {s.far ? (
            <PixelBox tone="alert" className="flex flex-col gap-2 p-3">
              <p className="text-sm font-semibold text-danger-text">{farLine(s.km_from_baguio ?? 0)}</p>
              <p className="text-sm">That&apos;s fine for a stop on the way.</p>
              <div className="flex flex-wrap gap-2">
                <PixelButton variant="secondary" onClick={onNext}>Add it anyway</PixelButton>
                <PixelButton variant="secondary" onClick={() => { setPinned(null); setText(""); field.current?.focus(); }}>Pick another place</PixelButton>
              </div>
            </PixelBox>
          ) : (
            <PixelButton variant="primary" className="w-full px-4 py-3" onClick={onNext}>Next</PixelButton>
          )}
        </div>
      )}

      {!pinned && (
        <>
          <p className="text-sm">Not listed? Paste its Google Maps link to pin it.</p>
          <PixelButton variant="secondary" className="inline-flex items-center self-start px-4 text-sm" onClick={onNoteOnly}>Add it as a note, no pin</PixelButton>
        </>
      )}
      <PixelButton variant="secondary" className="inline-flex items-center self-start px-4 text-sm" onClick={onBack}>Back</PixelButton>
    </div>
  );
}

/** Ripple options from the server's one proposal: move the later stops, or drop some, or leave them. */
function rippleWords(s: Suggestion, rowName: (key: string) => string, rowTime: (key: string) => string | null): { legend: string; take: string } | null {
  if (!s.ripple.length) return null;
  const drops = s.ripple.filter((r) => "drop" in r);
  if (drops.length) {
    const names = drops.map((r) => rowName(r.key));
    const named = names.length > 2 ? `${names.slice(0, 2).join(", ")} and ${names.length - 2} more` : names.join(" and ");
    return { legend: `${s.notes[0] ?? "The day runs long."} The stops after it:`, take: `Drop ${drops.length === 1 ? "the last one" : `the last ${drops.length}`}: ${named}` };
  }
  const moves = s.ripple.filter((r): r is { key: string; time: string } => "time" in r);
  const first = moves[0];
  const was = rowTime(first.key);
  const by = was ? (Number(first.time.slice(0, 2)) * 60 + Number(first.time.slice(3))) - (Number(was.slice(0, 2)) * 60 + Number(was.slice(3))) : 0;
  return { legend: `The day would now end at ${formatTime(moves[moves.length - 1].time)}. The stops after it:`, take: `Move them ${by} min later` };
}

/** The proposal (ux.md §4.4): time, how to get there, the later stops, what changes, and Apply. */
export function Proposal({ editor, chosen, at, kind, anchor, done, fit, from, rowName, rowTime, onApplied, onBack, onClash }: {
  editor: PlanEditor;
  chosen: Chosen;
  at: At;
  kind: "replace" | "add" | "move";
  anchor: string | null;
  done: Done;
  fit: string;
  from: string | null;
  rowName: (key: string) => string;
  rowTime: (key: string) => string | null;
  onApplied: (focus: Focus) => void;
  onBack: () => void;
  onClash: () => void;
}) {
  const s = chosen.suggestion;
  const slotKept = kind === "replace";
  const [time, setTime] = useState(s.time);
  const [plan, setPlan] = useState(chosen.name);
  const [changing, setChanging] = useState(false);
  const [draft, setDraft] = useState({ time: s.time, plan: chosen.name });
  const [ripple, setRipple] = useState(true);
  const [applying, setApplying] = useState(false);
  const [problem, setProblem] = useState("");
  const heading = useRef<HTMLParagraphElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const words = rippleWords(s, rowName, rowTime);
  const off = !editor.can || applying;

  // The server's lines describe its own slot and name; the user's are the ones that will be saved
  const lines: ChangeLine[] = s.changes
    .filter((l) => ripple || l.part !== "ripple")
    .map((l) => (l.part === "stop" && l.word === "New" ? { ...l, text: `${formatTime(time)} ${plan}` } : l));

  async function onApply() {
    if (off) return;
    setApplying(true);
    setProblem("");
    let place = chosen.place;
    if (chosen.link) {
      const r = await editor.addPlace(chosen.link, plan.slice(0, MAX_NAME));
      console.info("[tg-trip] plan place add ok=%s", planOutcome(r));
      if (!r.ok) {
        setApplying(false);
        return setProblem(planFailureMessage(r));
      }
      place = { trip_place_id: r.body.id };
    }
    const out = await editor.save(`plan-${kind}`, (g) => applySuggestion(g, at, s, { place, plan, time, ripple: ripple && !!words }), done, anchor);
    setApplying(false);
    if (out.ok) return onApplied(out.focus);
    if (out.ignored) return;
    if (out.clash) return onClash();
    setProblem(out.message);
  }

  function onSaveSlot(e: FormEvent) {
    e.preventDefault();
    if (!/^\d{2}:\d{2}$/.test(draft.time)) return setProblem("Pick a time first.");
    if (!draft.plan.trim()) return setProblem("Type what you'll do first.");
    setProblem("");
    setTime(draft.time);
    setPlan(draft.plan.trim().slice(0, 120));
    setChanging(false);
  }

  return (
    <div className="flex flex-col gap-3">
      <p ref={heading} tabIndex={-1} className="sr-only">Proposed change</p>
      <section className="flex flex-col gap-1">
        <p className="text-sm font-semibold">Time</p>
        {changing ? (
          <form onSubmit={onSaveSlot} noValidate className="flex flex-col gap-2">
            {!slotKept && (
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-semibold">Time</span>
                <input type="time" className={PX.input} value={draft.time} onChange={(e) => setDraft({ ...draft, time: e.target.value })} />
              </label>
            )}
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-semibold">What you&apos;ll do</span>
              <input className={PX.input} value={draft.plan} maxLength={120} onChange={(e) => setDraft({ ...draft, plan: e.target.value })} />
            </label>
            <div className="flex flex-wrap gap-2">
              <PixelButton type="submit" variant="primary">Save</PixelButton>
              <PixelButton variant="secondary" onClick={() => setChanging(false)}>Cancel</PixelButton>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-lg font-bold break-words tabular-nums">{formatTime(time)} · {plan}</p>
            <PixelButton variant="secondary" onClick={() => { setDraft({ time, plan }); setChanging(true); }}>Change</PixelButton>
          </div>
        )}
        <p className={PX.meta}>{fit}</p>
      </section>

      <section className="flex flex-col gap-1 border-t-2 border-border pt-3">
        {from === null ? (
          <p className="text-sm font-semibold">From the start of the day</p>
        ) : (
          <>
            <p className="text-sm font-semibold">From {from}</p>
            {chosen.place || chosen.link ? <LegLine leg={s.leg} /> : <p className="text-sm">A note with no pin, so there&apos;s no travel estimate.</p>}
          </>
        )}
      </section>

      {words && (
        <fieldset className="flex flex-col gap-2 border-t-2 border-border pt-3">
          <legend className="mb-1 text-sm font-semibold">{words.legend}</legend>
          <PixelChoice name="ripple" value="take" checked={ripple} onChange={() => setRipple(true)} className="flex min-h-11 items-center gap-2 px-3 py-2 text-left text-sm">
            {words.take}
          </PixelChoice>
          <PixelChoice name="ripple" value="leave" checked={!ripple} onChange={() => setRipple(false)} className="flex min-h-11 items-center gap-2 px-3 py-2 text-left text-sm">
            Leave them as they are
          </PixelChoice>
        </fieldset>
      )}

      <section className="flex flex-col gap-1 border-t-2 border-border pt-3">
        <p className="text-sm font-semibold">What changes</p>
        <ChangeList lines={lines} />
        <p className={PX.meta}>
          {slotKept ? "This stop's tick and photos stay with it." : kind === "move" ? "Its tick and photos move with it." : ""}
          {ripple && words && s.ripple.some((r) => "drop" in r) ? " Dropped stops' ticks and photos are hidden. Undo brings them back." : ""}
        </p>
      </section>

      {problem && <PlanProblem text={problem} />}
      <PixelButton variant="primary" className="w-full px-4 py-3" aria-disabled={off || undefined} onClick={onApply}>
        {applying ? "Applying..." : "Apply"}
      </PixelButton>
      <p className={PX.meta}>Nothing changes until you tap Apply.</p>
      <PixelButton variant="secondary" className="inline-flex items-center self-start px-4 text-sm" onClick={onBack}>Back</PixelButton>
    </div>
  );
}
