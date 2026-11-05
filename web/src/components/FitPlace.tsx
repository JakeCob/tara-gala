"use client";

// TG-61 owner round 4, ux.md §4.8: "Where does it fit?" Step 2 of Add a place: up to three slots the server ranked,
// the best first and checked, or the group's own choice of day and stop. A card is a preview: Apply stays on the
// proposal that Next opens, so nothing is saved here.
import { useState } from "react";
import { PX, PixelButton, PixelChoice, cx } from "@/components/pixel";
import { formatTime } from "@/lib/api";
import { type Guide, type Mark, marksByKey, rowShows } from "@/lib/guide";
import { type Suggestion, fitSuggestion, noteSuggestion, toStored } from "@/lib/planEdit";
import { NO_FIT, fitFooter, fitLines, levelLabel } from "@/lib/planLines";
import { type SuggestIn, planFailureMessage } from "@/lib/trip";
import { PlanProblem } from "./PlanBits";
import type { PlanEditor } from "./PlanEditor";
import type { Chosen } from "./PlaceInput";

export type Slot = { day: number; after: string };
/** Where step 2 was left, so the proposal's Back returns to the same choice. */
export type FitState = { pick: number; manual: boolean; day: number; after: string | null };

export default function FitPlace({ editor, guide, marks, chosen, start, onNext, onBack }: {
  editor: PlanEditor;
  guide: Guide;
  marks: readonly Mark[];
  chosen: Chosen;
  start: FitState;
  onNext: (slot: Slot, suggestion: Suggestion, state: FitState) => void;
  onBack: () => void;
}) {
  const s = chosen.suggestion;
  const fits = s.fits ?? [];
  // A note with no pin has nothing to send for a ranking: the group chooses the day itself
  const ranked = !!(chosen.place || chosen.link);
  const [pick, setPick] = useState(Math.min(start.pick, Math.max(0, fits.length - 1)));
  const [manual, setManual] = useState(start.manual || !ranked);
  const [day, setDay] = useState(start.day);
  const [after, setAfter] = useState<string | null>(start.after);
  const [finding, setFinding] = useState(false);
  const [problem, setProblem] = useState("");
  const picks = marksByKey(marks);
  const rows = new Map(guide.days.flatMap((d) => d.rows.map((r) => [r.key, { plan: r.plan, time: r.time, place: r.place?.name ?? null }] as const)));
  const row = (k: string) => rows.get(k) ?? null;
  const dayRows = guide.days.find((d) => d.day === day)?.rows.filter((r) => rowShows(r, picks)) ?? [];
  const anchor = after && dayRows.some((r) => r.key === after) ? after : (dayRows.at(-1)?.key ?? null);
  const state = (): FitState => ({ pick, manual, day, after: anchor });

  function onPicked() {
    console.info("[tg-trip] plan fit pick=%d of=%d", pick, fits.length);
    const f = fits[pick];
    if (f) onNext({ day: f.day, after: f.after }, fitSuggestion(s, f), state());
  }

  // Choose the day myself: a suggestion for that slot, as Add after gives (no ranking, no past-day filter: ux.md §4.8)
  async function onOwn() {
    if (!anchor || finding) return;
    const slot = { day, after: anchor };
    if (!ranked) {
      return onNext(slot, noteSuggestion(toStored(guide), { after: anchor }, chosen.name), state());
    }
    setFinding(true);
    setProblem("");
    const place = (chosen.place ?? { link: chosen.link! }) as SuggestIn["place"];
    const r = await editor.suggest({ after: anchor }, place);
    setFinding(false);
    if (!r.ok) return setProblem(planFailureMessage(r));
    const { fits: _fits, ...one } = r.body;
    void _fits;
    onNext(slot, { ...one, name: chosen.name }, state());
  }

  if (manual) {
    return (
      <div className="flex flex-col gap-3">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold">World</legend>
          {guide.days.map((d) => (
            <PixelChoice key={d.day} name="fit-world" value={String(d.day)} checked={d.day === day} onChange={() => { setDay(d.day); setAfter(null); }}
              className="flex min-h-11 items-center gap-2 px-3 py-2 text-left text-sm">
              World {d.day}
            </PixelChoice>
          ))}
        </fieldset>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-semibold">After</span>
          <select className={PX.input} value={anchor ?? ""} onChange={(e) => setAfter(e.target.value)}>
            {dayRows.map((r) => (
              <option key={r.key} value={r.key}>Level {levelLabel(guide, marks, r.key)} · {formatTime(r.time)} {r.plan}</option>
            ))}
          </select>
        </label>
        {problem && <PlanProblem text={problem} />}
        <PixelButton variant="primary" className="w-full px-4 py-3" aria-disabled={finding || !anchor || undefined} onClick={onOwn}>
          {finding ? "Finding where it fits..." : "Next"}
        </PixelButton>
        <div className="flex flex-wrap gap-2">
          <PixelButton variant="secondary" className="inline-flex items-center px-4 text-sm" onClick={() => (ranked ? setManual(false) : onBack())}>Back</PixelButton>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {fits.length === 0 ? (
        <p className="text-sm">{NO_FIT}</p>
      ) : (
        <>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-semibold">Pick one</legend>
            {fits.map((f, i) => {
              const l = fitLines(f, row);
              return (
                <PixelChoice key={`${f.day}-${f.after}`} name="fit" value={String(i)} checked={i === pick} onChange={() => setPick(i)}
                  className="flex min-h-11 items-start gap-2 px-3 py-2 text-left text-sm">
                  <span className="flex min-w-0 flex-col gap-0.5 break-words">
                    {i === 0 && <span className="font-bold">Best fit</span>}
                    <span className="font-bold tabular-nums">{l.when}</span>
                    <span>{l.slot}</span>
                    {l.chip && <span className={cx(PX.chip, "self-start text-xs")}>{l.chip}</span>}
                    <span className="font-normal">{l.travel}</span>
                    <span className="font-normal">{l.moves}</span>
                    {l.why && <span className="text-xs font-normal">{l.why}</span>}
                  </span>
                </PixelChoice>
              );
            })}
          </fieldset>
          {fitFooter(fits, s.lat != null).map((t) => <p key={t} className={PX.meta}>{t}</p>)}
          {problem && <PlanProblem text={problem} />}
          <PixelButton variant="primary" className="w-full px-4 py-3" onClick={onPicked}>Next</PixelButton>
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <PixelButton variant="secondary" className="inline-flex items-center px-4 text-sm" onClick={onBack}>Back</PixelButton>
        <PixelButton variant="secondary" className="inline-flex items-center px-4 text-sm" onClick={() => {
          console.info("[tg-trip] plan fit manual fits=%d", fits.length);
          setManual(true);
        }}>Choose the day myself</PixelButton>
      </div>
    </div>
  );
}
