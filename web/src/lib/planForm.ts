// Planner form logic (TG-21): dates, budget, vibe, the POST /plan payload, error copy, the pre-made list and the
// form and request reducers. Plain module: Node's type stripping runs it in tests. The limits mirror TG-20's
// api/app/planner.py; each constant names the field it follows.
import type { Passenger } from "./party.ts";
import type { PlanRequestBody, PostPlanResult, PremadeResult, PremadeSummary } from "./api.ts";
import type { Flags } from "./flags.ts";

export type FormMode = "live" | "premade" | "none";
export type FieldId = "date" | "returnDate" | "budget" | "vibe" | "note";
export type FieldError = { field: FieldId; message: string };
export type FormValues = { date: string; returnDate: string; budget: string; chips: readonly string[]; note: string };
export type FormState = {
  date: string | null; // null: use the default from today
  returnDate: string | null;
  budget: string;
  chips: readonly string[];
  note: string;
  attempted: boolean;
};
export type FormAction =
  | { type: "setDate"; value: string; today: string }
  | { type: "setReturn"; value: string }
  | { type: "setBudget"; value: string }
  | { type: "blurBudget" }
  | { type: "toggleChip"; chip: string }
  | { type: "setNote"; value: string }
  | { type: "submitted" };
export type ErrorView = { message: string; retry: boolean; premade: boolean };
export type PlanErrorInput = { status: number; body: unknown } | "network" | "timeout" | "offline";
export type PremadeView = { kind: "list"; list: PremadeSummary[] } | { kind: "empty" } | { kind: "unavailable" } | { kind: "failed" };
export type RunPhase = "idle" | "planning" | "loadingPremade" | "opening" | "error" | "premade";
export type RunState = { phase: RunPhase; id: number; slug: string | null; error: ErrorView | null; premade: PremadeView | null };
export type RunAction =
  | { type: "start"; kind: "plan" | "premade"; id: number }
  | { type: "planResult"; id: number; result: PostPlanResult | { kind: "offline" } }
  | { type: "premadeResult"; id: number; result: PremadeResult };
type Bounds = { dateMin?: string; dateMax?: string; returnMin?: string; returnMax?: string };
type ModeFlags = Pick<Flags, "plannerLive" | "premadeItineraries">;

export const VIBE_CHIPS: readonly string[] = ["Food trip", "Chill", "Nature", "Sightseeing", "Shopping", "Cafe hopping"];
export const MAX_CHIPS = 2;
export const NOTE_MAX = 30;
export const VIBE_MAX = 60; // PlanRequest.vibe max_length
export const BUDGET_MIN = 500; // PlanRequest.budget_php ge
export const BUDGET_MAX = 200_000; // PlanRequest.budget_php le
export const MAX_TRIP_DAYS = 6; // MAX_TRIP_DAYS: return_date at most this many days after date
export const MAX_DAYS_AHEAD = 365; // MAX_DAYS_AHEAD
export const DEFAULT_TRIP_DAYS = 2;
// PlanRequest.vibe pattern ^[\w ,.'&!?-]+$, with Python's Unicode \w spelt out (JS \w is ASCII only)
export const NOTE_OK = /^[\p{L}\p{N}_ ,.'&!?-]+$/u;
export const DEADLINE_MESSAGE = "Planning took too long. Try again, or pick a pre-made itinerary."; // MESSAGES["deadline"]

export const FIELD_ORDER: readonly FieldId[] = ["date", "returnDate", "budget", "vibe", "note"];
export const FIELD_INPUT_ID: Record<FieldId, string> = {
  date: "plan-date",
  returnDate: "plan-return",
  budget: "plan-budget",
  vibe: "plan-chip-0", // the first chip takes focus for a vibe error
  note: "plan-note",
};
// The submit button: Enter from a field focuses it before the request, so the busy fieldset can't drop focus
export const SUBMIT_ID = "plan-submit";

// One entry per TG-20 MESSAGES code: may the user retry, and is the ready-made list offered (ux §5.2)
export const PLAN_ERROR_CODES: Record<string, { retry: boolean; premade: boolean }> = {
  no_valid_plan: { retry: true, premade: true },
  refused: { retry: true, premade: true },
  llm_unavailable: { retry: true, premade: true },
  deadline: { retry: true, premade: true },
  daily_cap: { retry: false, premade: true },
  rate_limited: { retry: false, premade: true },
  no_data: { retry: false, premade: true },
  not_configured: { retry: false, premade: true },
};

export const PLAN_COPY = {
  live: {
    submit: "Tara, plan my trip",
    working: "Planning...",
    before: "We build your plan only from buses and spots on file.",
    workingLine: "Building your plan from buses and spots on file. This can take up to 2 minutes.",
  },
  premade: {
    submit: "Tara, show trip ideas",
    working: "Loading trip ideas...",
    before: "Pick from ready-made trips built from buses and spots on file.",
  },
  ready: "Your plan is ready. Opening it...",
  none: "The planner isn't available yet. You can still search buses.",
  labels: {
    dates: "When are you going?",
    date: "Travel date",
    returnDate: "Return date",
    budget: "Budget (optional)",
    vibe: "What's the vibe?",
    note: "Anything else? (optional)",
  },
  hints: {
    budget: "For the whole group: buses, rides, food and entrance fees.",
    budgetSr: " in pesos",
    vibe: "Pick up to 2.",
    notePlaceholder: "e.g. strawberries, no hiking",
    noteLimit: "Up to 30 characters.",
  },
  list: {
    heading: "Trip ideas",
    match: "Matches your dates",
    see: "See this trip",
    untitled: "Trip idea",
    empty: "No ready-made trips on file yet.",
    unavailable: "Ready-made trips aren't available right now.",
    failed: "Could not load trip ideas. Check your connection and try again.",
  },
  actions: { tryAgain: "Try again", seePremade: "See ready-made trips", searchBuses: "Search buses" },
};

const MSG = {
  date: "Pick a travel date.",
  datePast: "Pick a travel date from today onwards.",
  dateFar: "Pick a travel date within the next year.",
  ret: "Pick a return date.",
  retBefore: "Pick a return date on or after your travel date.",
  retFar: (by: string) => `Trips can be up to 7 days. Pick a return date by ${by}.`,
  budget: "Enter a budget from ₱500 to ₱200,000, or leave it empty.",
  vibe: "Pick a vibe, or write a short note.",
  note: "Use letters, numbers and simple punctuation (, . ' & ! ? -).",
  invalid: "Some details didn't pass our checks. Check the dates, budget and vibe, and try again.",
  network: "Could not reach the planner. Check your connection and try again.",
  offline: "You're offline. Planning needs a connection.",
  generic: "Something went wrong while planning. Try again, or pick a ready-made trip.",
};

export const initialForm: FormState = { date: null, returnDate: null, budget: "", chips: [], note: "", attempted: false };
export const initialRun: RunState = { phase: "idle", id: 0, slug: null, error: null, premade: null };

// --- Dates: YYYY-MM-DD strings, computed in UTC so the device's time zone can't shift a day ---

function utc(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(utc(s)).toISOString().slice(0, 10) === s;
}

export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

export function initialDates(today: string): { date: string; returnDate: string } {
  if (!isIsoDate(today)) return { date: "", returnDate: "" }; // "" until today is read on the client
  return { date: today, returnDate: addDays(today, DEFAULT_TRIP_DAYS) };
}

export function dateBounds(today: string, travel: string): Bounds {
  const hasToday = isIsoDate(today);
  const hasTravel = isIsoDate(travel);
  return {
    dateMin: hasToday ? today : undefined,
    dateMax: hasToday ? addDays(today, MAX_DAYS_AHEAD) : undefined,
    returnMin: hasTravel ? travel : undefined,
    returnMax: hasTravel ? addDays(travel, MAX_TRIP_DAYS) : undefined,
  };
}

// Keeps the trip length when the travel date moves; leaves the return date alone while a date is half-typed
export function shiftReturn(prevTravel: string, prevReturn: string, nextTravel: string): string {
  if (!isIsoDate(prevTravel) || !isIsoDate(prevReturn) || !isIsoDate(nextTravel)) return prevReturn;
  const length = Math.min(Math.max(daysBetween(prevTravel, prevReturn), 0), MAX_TRIP_DAYS);
  return addDays(nextTravel, length);
}

export function lengthHint(date: string, ret: string): string | null {
  if (!isIsoDate(date) || !isIsoDate(ret) || ret < date) return null;
  const days = daysBetween(date, ret) + 1;
  return days === 1 ? "Day trip" : `${days} days in Baguio`;
}

// --- Budget ---

export function parseBudget(raw: string): { ok: true; value: number | null } | { ok: false } {
  if (raw.trim() === "") return { ok: true, value: null };
  const digits = raw.replace(/[\s,]/g, "").replace(/^(₱|php)/i, "");
  if (!/^\d+$/.test(digits)) return { ok: false }; // ASCII digits only: no decimals, units, signs or full-width
  const value = Number(digits);
  return value >= BUDGET_MIN && value <= BUDGET_MAX ? { ok: true, value } : { ok: false };
}

export function formatBudget(n: number): string {
  return n.toLocaleString("en-PH");
}

// --- Vibe ---

export function toggleChip(chips: readonly string[], chip: string): readonly string[] {
  if (chips.includes(chip)) return chips.filter((c) => c !== chip);
  if (chips.length >= MAX_CHIPS) return chips;
  return VIBE_CHIPS.filter((c) => c === chip || chips.includes(c)); // chip order, not click order
}

export function chipLocked(chips: readonly string[], chip: string): boolean {
  return chips.length >= MAX_CHIPS && !chips.includes(chip);
}

// NFC first: a pasted decomposed ñ (n + U+0303) fails both NOTE_OK and Python's \w. Then TG-20's one-line collapse.
function cleanNote(note: string): string {
  return note.normalize("NFC").split(/\s+/).filter(Boolean).join(" ");
}

export function buildVibe(chips: readonly string[], note: string): string {
  return [...VIBE_CHIPS.filter((c) => chips.includes(c)), cleanNote(note)].filter(Boolean).join(", ");
}

// --- Validation and payload ---

// Errors in page order. The pre-made list only uses the dates (for sorting), so that mode checks nothing else.
export function validatePlanForm(v: FormValues, today: string, formatDate: (iso: string) => string, mode: FormMode): FieldError[] {
  const errors: FieldError[] = [];
  const dateOk = isIsoDate(v.date);
  if (!dateOk) errors.push({ field: "date", message: MSG.date });
  else if (v.date < today) errors.push({ field: "date", message: MSG.datePast });
  else if (v.date > addDays(today, MAX_DAYS_AHEAD)) errors.push({ field: "date", message: MSG.dateFar });

  if (!isIsoDate(v.returnDate)) errors.push({ field: "returnDate", message: MSG.ret });
  else if (dateOk && v.returnDate < v.date) errors.push({ field: "returnDate", message: MSG.retBefore });
  else if (dateOk && daysBetween(v.date, v.returnDate) > MAX_TRIP_DAYS) {
    errors.push({ field: "returnDate", message: MSG.retFar(formatDate(addDays(v.date, MAX_TRIP_DAYS))) });
  }
  if (mode === "premade") return errors;

  if (!parseBudget(v.budget).ok) errors.push({ field: "budget", message: MSG.budget });
  const note = cleanNote(v.note);
  if (v.chips.length === 0 && !note) errors.push({ field: "vibe", message: MSG.vibe });
  else if (note && !NOTE_OK.test(note)) errors.push({ field: "note", message: MSG.note });
  return errors;
}

// Exactly TG-20's PlanRequest keys (extra="forbid"); the party is copied, so later edits can't change this request
export function buildPlanRequest(v: FormValues, party: readonly Passenger[]): PlanRequestBody {
  const body: PlanRequestBody = {
    date: v.date,
    return_date: v.returnDate,
    party: party.map((p) => ({ type: p.type })),
    vibe: buildVibe(v.chips, v.note),
  };
  const budget = parseBudget(v.budget);
  if (budget.ok && budget.value !== null) body.budget_php = budget.value;
  return body;
}

// --- Errors (ux §5.2): never a status code, a code or the raw detail ---

export function planErrorView(r: PlanErrorInput): ErrorView {
  if (r === "network") return { message: MSG.network, retry: true, premade: true };
  if (r === "timeout") return { message: DEADLINE_MESSAGE, retry: true, premade: true };
  if (r === "offline") return { message: MSG.offline, retry: false, premade: true };
  const detail = (r.body as { detail?: unknown } | null)?.detail;
  if (r.status === 422 && Array.isArray(detail)) return { message: MSG.invalid, retry: false, premade: false };
  if (detail && typeof detail === "object") {
    const { code, message } = detail as { code?: unknown; message?: unknown };
    const known = typeof code === "string" && Object.hasOwn(PLAN_ERROR_CODES, code) ? PLAN_ERROR_CODES[code] : null;
    if (known && typeof message === "string") return { message, ...known };
  }
  return { message: MSG.generic, retry: true, premade: true };
}

// --- Flags ---

export function formMode(flags: ModeFlags): FormMode {
  if (flags.plannerLive) return "live";
  return flags.premadeItineraries ? "premade" : "none";
}

export function showPremadeAction(view: ErrorView, flags: ModeFlags): boolean {
  return view.premade && flags.premadeItineraries;
}

// --- Pre-made list (ux §6) ---

export function matchesDates(s: PremadeSummary, date: string, ret: string): boolean {
  return s.return_date !== null && s.trip_date === date && s.return_date === ret;
}

export function sortPremade(list: readonly PremadeSummary[], date: string, ret: string): PremadeSummary[] {
  return [...list.filter((s) => matchesDates(s, date, ret)), ...list.filter((s) => !matchesDates(s, date, ret))];
}

export function premadeCountLine(n: number, matching: number): string {
  const ideas = `${n} trip idea${n === 1 ? "" : "s"}`;
  if (matching === 0) return `${ideas} · These are set for their own dates. Search buses for other days.`;
  return `${ideas} · ${matching} ${matching === 1 ? "matches" : "match"} your dates`;
}

export function premadePlaces(names: readonly string[]): string {
  const shown = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
}

export function premadeMeta(days: number, stops: number): string {
  return ` · ${days} day${days === 1 ? "" : "s"} · ${stops} stop${stops === 1 ? "" : "s"}`;
}

// --- Form reducer: dates stay derived from today until the user sets them, so nothing snaps in an effect ---

export function formValues(s: FormState, today: string): FormValues {
  const d = initialDates(today);
  return { date: s.date ?? d.date, returnDate: s.returnDate ?? d.returnDate, budget: s.budget, chips: s.chips, note: s.note };
}

export function planFormReducer(s: FormState, a: FormAction): FormState {
  switch (a.type) {
    case "setDate": {
      const prev = formValues(s, a.today);
      return { ...s, date: a.value, returnDate: shiftReturn(prev.date, prev.returnDate, a.value) };
    }
    case "setReturn":
      return { ...s, returnDate: a.value };
    case "setBudget":
      return { ...s, budget: a.value };
    case "blurBudget": {
      const b = parseBudget(s.budget);
      return b.ok && b.value !== null ? { ...s, budget: formatBudget(b.value) } : s;
    }
    case "toggleChip": {
      const chips = toggleChip(s.chips, a.chip);
      return chips === s.chips ? s : { ...s, chips };
    }
    case "setNote":
      return { ...s, note: a.value.slice(0, NOTE_MAX) };
    case "submitted":
      return { ...s, attempted: true };
  }
}

// --- Request reducer: one request at a time, and a result for an older request is dropped ---

export function planRunReducer(s: RunState, a: RunAction): RunState {
  switch (a.type) {
    case "start":
      if (s.phase === "planning" || s.phase === "loadingPremade") return s;
      return a.kind === "plan"
        ? { phase: "planning", id: a.id, slug: null, error: null, premade: null }
        : { phase: "loadingPremade", id: a.id, slug: null, error: s.error, premade: null }; // under the error box
    case "planResult": {
      if (a.id !== s.id || s.phase !== "planning") return s;
      const r = a.result;
      if (r.kind === "aborted") return s;
      if (r.kind === "ok") return { ...s, phase: "opening", slug: r.slug };
      const error = r.kind === "response" ? planErrorView({ status: r.status, body: r.body }) : planErrorView(r.kind);
      return { ...s, phase: "error", error };
    }
    case "premadeResult": {
      if (a.id !== s.id || s.phase !== "loadingPremade") return s;
      const r = a.result;
      const premade: PremadeView = r.kind === "ok" ? (r.list.length ? { kind: "list", list: r.list } : { kind: "empty" }) : { kind: r.kind };
      return { ...s, phase: "premade", premade };
    }
  }
}

// Whether the status line is shown. In the error and list phases the error box or the list already shows the same
// text, so the region goes sr-only: still in the DOM and still announcing, but each line appears once (TG-21 ux-review 2)
export function statusShown(run: RunState): boolean {
  return run.phase !== "error" && run.phase !== "premade";
}

// The one live status region (ux §7)
export function statusText(run: RunState, mode: FormMode, dates: { date: string; returnDate: string }): string {
  switch (run.phase) {
    case "idle":
      return mode === "live" ? PLAN_COPY.live.before : mode === "premade" ? PLAN_COPY.premade.before : "";
    case "planning":
      return PLAN_COPY.live.workingLine;
    case "loadingPremade":
      return PLAN_COPY.premade.working;
    case "opening":
      return PLAN_COPY.ready;
    case "error":
      return run.error?.message ?? "";
    case "premade": {
      const p = run.premade;
      if (!p) return "";
      if (p.kind === "list") {
        const matching = p.list.filter((s) => matchesDates(s, dates.date, dates.returnDate)).length;
        return premadeCountLine(p.list.length, matching);
      }
      return PLAN_COPY.list[p.kind];
    }
  }
}
