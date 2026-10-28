// Planner form logic (TG-21). RED stub: the signatures are final, the bodies throw until GREEN.
import type { Passenger } from "./party.ts";
import type { PlanRequestBody, PostPlanResult, PremadeResult, PremadeSummary } from "./api.ts";
import type { Flags } from "./flags.ts";

const todo = (): never => {
  throw new Error("TG-21: not implemented");
};

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

export const VIBE_CHIPS: readonly string[] = [];
export const MAX_CHIPS = 0;
export const NOTE_MAX = 0;
export const VIBE_MAX = 0;
export const BUDGET_MIN = 0;
export const BUDGET_MAX = 0;
export const NOTE_OK = /(?!)/u;
export const DEADLINE_MESSAGE = "";
export const FIELD_ORDER: readonly FieldId[] = [];
export const FIELD_INPUT_ID: Record<FieldId, string> = { date: "", returnDate: "", budget: "", vibe: "", note: "" };
export const PLAN_ERROR_CODES: Record<string, { retry: boolean; premade: boolean }> = {};
export const PLAN_COPY = {
  live: { submit: "", working: "", before: "", workingLine: "" },
  premade: { submit: "", working: "", before: "" },
  ready: "",
  none: "",
  labels: { dates: "", date: "", returnDate: "", budget: "", vibe: "", note: "" },
  hints: { budget: "", budgetSr: "", vibe: "", notePlaceholder: "", noteLimit: "" },
  list: { heading: "", match: "", see: "", untitled: "", empty: "", unavailable: "", failed: "" },
  actions: { tryAgain: "", seePremade: "", searchBuses: "" },
};
export const initialForm: FormState = { date: null, returnDate: null, budget: "", chips: [], note: "", attempted: false };
export const initialRun: RunState = { phase: "idle", id: 0, slug: null, error: null, premade: null };

export const addDays = (_iso: string, _n: number): string => todo();
export const daysBetween = (_from: string, _to: string): number => todo();
export const initialDates = (_today: string): { date: string; returnDate: string } => todo();
export const dateBounds = (_today: string, _travel: string): Bounds => todo();
export const shiftReturn = (_prevTravel: string, _prevReturn: string, _nextTravel: string): string => todo();
export const lengthHint = (_date: string, _ret: string): string | null => todo();
export const parseBudget = (_raw: string): { ok: true; value: number | null } | { ok: false } => todo();
export const formatBudget = (_n: number): string => todo();
export const toggleChip = (_chips: readonly string[], _chip: string): readonly string[] => todo();
export const chipLocked = (_chips: readonly string[], _chip: string): boolean => todo();
export const buildVibe = (_chips: readonly string[], _note: string): string => todo();
export const validatePlanForm = (_v: FormValues, _today: string, _formatDate: (iso: string) => string, _mode: FormMode): FieldError[] =>
  todo();
export const buildPlanRequest = (_v: FormValues, _party: readonly Passenger[]): PlanRequestBody => todo();
export const planErrorView = (_r: PlanErrorInput): ErrorView => todo();
export const formMode = (_flags: Pick<Flags, "plannerLive" | "premadeItineraries">): FormMode => todo();
export const showPremadeAction = (_view: ErrorView, _flags: Pick<Flags, "plannerLive" | "premadeItineraries">): boolean => todo();
export const matchesDates = (_s: PremadeSummary, _date: string, _ret: string): boolean => todo();
export const sortPremade = (_list: readonly PremadeSummary[], _date: string, _ret: string): PremadeSummary[] => todo();
export const premadeCountLine = (_n: number, _matching: number): string => todo();
export const premadePlaces = (_names: readonly string[]): string => todo();
export const premadeMeta = (_days: number, _stops: number): string => todo();
export const formValues = (_s: FormState, _today: string): FormValues => todo();
export const planFormReducer = (_s: FormState, _a: FormAction): FormState => todo();
export const planRunReducer = (_s: RunState, _a: RunAction): RunState => todo();
export const statusText = (_run: RunState, _mode: FormMode, _dates: { date: string; returnDate: string }): string => todo();
