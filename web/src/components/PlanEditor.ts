// TG-61: what the trip page hands the map and its dialogs for editing the plan. The page owns the plan on screen, its
// version and every save (review M1): a control only says what to change, as a function of the plan as it is when the
// save goes out, so a change is never worked out from a plan nobody sees any more.
import type { ReactNode } from "react";
import type { Guide } from "@/lib/guide";
import type { GuideIn, SpotLite, Suggestion } from "@/lib/planEdit";
import type { Done, PlanEdits } from "@/lib/planLines";
import type { Answer, SuggestIn, TripPlace } from "@/lib/trip";

/** The level to focus once a change is on screen, and its World (a move can take it to another one). */
export type Focus = { key: string; day: number } | null;
/** A save's outcome. ok: the new plan is on screen. ignored: a tap while waiting, so nothing was sent. */
export type SaveOutcome = { ok: true; guide: Guide; focus: Focus } | { ok: false; message: string; clash: boolean; ignored?: boolean };

export type PlanEditor = {
  editing: boolean;
  /** Controls that change the plan are live: online, no plan write out, and the newest plan on screen (ux.md §3.3) */
  can: boolean;
  online: boolean;
  /** A plan write is out: ticks wait too, but only for this (options.md §3.10) */
  writing: boolean;
  /** The edit bar's line. A dialog that stays open after a save repeats it (ux.md §3.3) */
  status: string;
  places: TripPlace[];
  spots: SpotLite[] | null;
  wantSpots: () => void;
  edits: PlanEdits | null;
  save: (action: string, edit: (g: GuideIn) => GuideIn | null, done: Done, anchor: string | null) => Promise<SaveOutcome>;
  suggest: (at: SuggestIn["at"], place: SuggestIn["place"]) => Promise<Answer<Suggestion>>;
  addPlace: (link: string, name: string) => Promise<Answer<TripPlace>>;
  /** The edit bar and the plan's own notices, drawn above the World tabs. addPlace opens Add a place (ux.md §4.8) */
  top: (addPlace: () => void) => ReactNode;
  /** Outside edit mode: Edit the plan and Add a place, under Trip progress's intro (ux.md §2, §4.8) */
  entry: (addPlace: () => void) => ReactNode;
  /** Add a place applied from outside edit mode switches into it, so the bar shows the result and Undo */
  startEditing: () => void;
};
