"use client";

import { useReducer, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { fetchPremade, manilaToday, postPlan, type PlanRequestBody } from "@/lib/api";
import { formatTravelDate } from "@/lib/direction";
import { flags } from "@/lib/flags";
import { DEFAULT_PARTY, type Party } from "@/lib/party";
import {
  FIELD_INPUT_ID,
  PLAN_COPY,
  SUBMIT_ID,
  buildPlanRequest,
  dateBounds,
  formMode,
  formValues,
  initialForm,
  initialRun,
  lengthHint,
  planFormReducer,
  planRunReducer,
  sortPremade,
  statusShown,
  statusText,
  validatePlanForm,
  type FormValues,
} from "@/lib/planForm";
import PartyPicker from "./PartyPicker";
import PartyStage from "./PartyStage";
import { BudgetBox, DatesBox, VibeBox } from "./PlanFields";
import { PlanErrorBox, PremadeResults } from "./PlanResults";
import { UI } from "./planUi";
import { usePlanRequests } from "./usePlanRequests";
import { useSpawn } from "./useSpawn";

const subscribeNothing = () => () => {};

/**
 * The planner form on /plan. TG-15 owns the party (the stage and the steppers); TG-21 adds dates, budget and vibe,
 * then either POSTs /plan (live) or shows the ready-made trips (the default), per formMode. Not saved between visits.
 */
export default function PlanForm() {
  const [party, setParty] = useState<Party>(DEFAULT_PARTY);
  const spawn = useSpawn();
  const router = useRouter();
  const mode = formMode(flags);
  // Today in Manila, read on the client only so the prerendered shell does not bake in a date (TG-31)
  const today = useSyncExternalStore(subscribeNothing, manilaToday, () => "");
  const [form, dispatch] = useReducer(planFormReducer, initialForm);
  const [run, runDispatch] = useReducer(planRunReducer, initialRun);
  const requests = usePlanRequests();
  const sent = useRef<PlanRequestBody | null>(null); // Try again resends exactly this

  const values = formValues(form, today);
  const errors = form.attempted && today ? validatePlanForm(values, today, formatTravelDate, mode) : [];
  const busy = run.phase === "planning" || run.phase === "loadingPremade" || run.phase === "opening";

  async function plan(payload: PlanRequestBody) {
    const req = requests.begin();
    if (!req) return;
    const { id, signal } = req;
    sent.current = payload;
    runDispatch({ type: "start", kind: "plan", id });
    try {
      if (navigator.onLine === false) {
        runDispatch({ type: "planResult", id, result: { kind: "offline" } });
        return;
      }
      const result = await postPlan(payload, { signal });
      runDispatch({ type: "planResult", id, result });
      if (result.kind === "ok") router.push("/i/" + encodeURIComponent(result.slug));
    } finally {
      requests.end();
    }
  }

  async function loadPremade(v: FormValues) {
    const req = requests.begin();
    if (!req) return;
    const { id } = req;
    runDispatch({ type: "start", kind: "premade", id });
    try {
      const result = await fetchPremade();
      const sorted = result.kind === "ok" ? { kind: "ok" as const, list: sortPremade(result.list, v.date, v.returnDate) } : result;
      runDispatch({ type: "premadeResult", id, result: sorted });
    } finally {
      requests.end();
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy || mode === "none") return;
    const now = manilaToday(); // fresh, in case the page was left open past Manila midnight
    const v = formValues(form, now);
    dispatch({ type: "submitted" });
    const found = validatePlanForm(v, now, formatTravelDate, mode);
    if (found.length) {
      document.getElementById(FIELD_INPUT_ID[found[0].field])?.focus();
      return;
    }
    // Enter from a field submits; the fieldset then disables that field, and focus would drop to <body> (TG-21 review 2)
    document.getElementById(SUBMIT_ID)?.focus();
    if (mode === "live") plan(buildPlanRequest(v, party));
    else loadPremade(v);
  }

  const copy = mode === "live" ? PLAN_COPY.live : PLAN_COPY.premade;
  const label =
    run.phase === "planning" ? PLAN_COPY.live.working : run.phase === "loadingPremade" ? PLAN_COPY.premade.working : copy.submit;

  // Capture phase: a tap or key during a spawn finishes it before the button's click starts the next one
  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4" onPointerDownCapture={spawn.skip} onKeyDownCapture={spawn.skip}>
      <PartyStage party={party} spawning={spawn.active} step={spawn.step} fixedRows />
      <PartyPicker party={party} onChange={setParty} onAdd={(i) => spawn.start([i])} />
      {/* Locked while a request runs; the picker and the submit button stay out, so focus never drops */}
      <fieldset disabled={busy} role="none" className="contents">
        <DatesBox
          values={values}
          bounds={dateBounds(today, values.date)}
          hint={lengthHint(values.date, values.returnDate)}
          errors={errors}
          onDate={(value) => dispatch({ type: "setDate", value, today })}
          onReturn={(value) => dispatch({ type: "setReturn", value })}
        />
        <BudgetBox
          value={form.budget}
          errors={errors}
          onChange={(value) => dispatch({ type: "setBudget", value })}
          onBlur={() => dispatch({ type: "blurBudget" })}
        />
        <VibeBox
          chips={form.chips}
          note={form.note}
          errors={errors}
          onToggle={(chip) => dispatch({ type: "toggleChip", chip })}
          onNote={(value) => dispatch({ type: "setNote", value })}
        />
      </fieldset>
      {mode === "none" ? (
        <div className={UI.box}>
          <p className="text-sm">{PLAN_COPY.none}</p>
          <Link href="/" className={UI.secondaryBtn}>
            {PLAN_COPY.actions.searchBuses}
          </Link>
        </div>
      ) : (
        <button type="submit" id={SUBMIT_ID} className={`${UI.submitBtn} w-full`} aria-disabled={busy}>
          {label}
        </button>
      )}
      <p role="status" className={statusShown(run) ? UI.meta : "sr-only"}>
        {statusText(run, mode, values)}
      </p>
      {run.error && (
        <PlanErrorBox
          view={run.error}
          flags={flags}
          busy={busy}
          onRetry={() => sent.current && plan(sent.current)}
          onPremade={() => loadPremade(values)}
        />
      )}
      {run.premade && (
        <PremadeResults
          key={run.id}
          premade={run.premade}
          date={values.date}
          returnDate={values.returnDate}
          busy={busy}
          onRetry={() => loadPremade(values)}
        />
      )}
    </form>
  );
}
