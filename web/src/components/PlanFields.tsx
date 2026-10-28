import {
  FIELD_INPUT_ID,
  NOTE_MAX,
  PLAN_COPY,
  VIBE_CHIPS,
  chipLocked,
  type FieldError,
  type FieldId,
  type FormValues,
} from "@/lib/planForm";
import { PX, PixelBox, PixelChoice, SectionTitle } from "@/components/pixel";

const L = PLAN_COPY.labels;
// A box that holds a fieldset: the frame goes on the PixelBox around it, so it stays off the legend (a reset, not a look)
const FIELDSET = "m-0 min-w-0 border-0 p-0 flex flex-col gap-3";
const H = PLAN_COPY.hints;

const errorOf = (errors: readonly FieldError[], f: FieldId) => errors.find((e) => e.field === f)?.message;
const errorId = (f: FieldId) => `${FIELD_INPUT_ID[f]}-error`;
const describedBy = (...ids: (string | false | undefined)[]) => ids.filter(Boolean).join(" ") || undefined;

// Under its field, tied to the input by aria-describedby. No red: position, weight and aria-invalid carry it (ux §4)
function FieldMessage({ field, message }: { field: FieldId; message?: string }) {
  if (!message) return null;
  return (
    <p id={errorId(field)} className="text-sm font-semibold">
      {message}
    </p>
  );
}

type Bounds = { dateMin?: string; dateMax?: string; returnMin?: string; returnMax?: string };

/** "When are you going?" (ux §2.1). The return date follows the travel date in the reducer, not here. */
export function DatesBox(props: {
  values: FormValues;
  bounds: Bounds;
  hint: string | null;
  errors: readonly FieldError[];
  onDate(value: string): void;
  onReturn(value: string): void;
}) {
  const { values, bounds, hint, errors } = props;
  const dateError = errorOf(errors, "date");
  const returnError = errorOf(errors, "returnDate");
  return (
    <PixelBox className="p-4 flex flex-col gap-3">
      <fieldset className={FIELDSET}>
        <SectionTitle as="legend" className="mb-3">
          {L.dates}
        </SectionTitle>
        <label htmlFor={FIELD_INPUT_ID.date} className="text-sm font-semibold">
          {L.date}
        </label>
        <input
          id={FIELD_INPUT_ID.date}
          type="date"
          value={values.date}
          min={bounds.dateMin}
          max={bounds.dateMax}
          onChange={(e) => props.onDate(e.target.value)}
          aria-invalid={dateError ? true : undefined}
          aria-describedby={describedBy(dateError && errorId("date"))}
          className={`${PX.input} w-full min-w-0 placeholder:text-muted`}
        />
        <FieldMessage field="date" message={dateError} />
        <label htmlFor={FIELD_INPUT_ID.returnDate} className="text-sm font-semibold">
          {L.returnDate}
        </label>
        <input
          id={FIELD_INPUT_ID.returnDate}
          type="date"
          value={values.returnDate}
          min={bounds.returnMin}
          max={bounds.returnMax}
          onChange={(e) => props.onReturn(e.target.value)}
          aria-invalid={returnError ? true : undefined}
          aria-describedby={describedBy(returnError && errorId("returnDate"))}
          className={`${PX.input} w-full min-w-0 placeholder:text-muted`}
        />
        <FieldMessage field="returnDate" message={returnError} />
        {hint && <p className={PX.meta}>{hint}</p>}
      </fieldset>
    </PixelBox>
  );
}

/** "Budget (optional)" with a ₱ prefix (ux §2.2). Reformatted to 6,000 when the field loses focus, never while typing. */
export function BudgetBox(props: { value: string; errors: readonly FieldError[]; onChange(value: string): void; onBlur(): void }) {
  const error = errorOf(props.errors, "budget");
  const hintId = `${FIELD_INPUT_ID.budget}-hint`;
  return (
    <PixelBox className="p-4 flex flex-col gap-3">
      <SectionTitle as="label" htmlFor={FIELD_INPUT_ID.budget}>
        {L.budget}
        <span className="sr-only">{H.budgetSr}</span>
      </SectionTitle>
      <div className="flex items-stretch">
        <span aria-hidden="true" className={PX.inputPrefix}>
          ₱
        </span>
        <input
          id={FIELD_INPUT_ID.budget}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          onBlur={props.onBlur}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(hintId, error && errorId("budget"))}
          className={`${PX.input} w-full min-w-0 flex-1`}
        />
      </div>
      <FieldMessage field="budget" message={error} />
      <p id={hintId} className={PX.meta}>
        {H.budget}
      </p>
    </PixelBox>
  );
}

/** "What's the vibe?": up to 2 chips plus a short note (ux §2.3). A 3rd chip is aria-disabled and does nothing. */
export function VibeBox(props: {
  chips: readonly string[];
  note: string;
  errors: readonly FieldError[];
  onToggle(chip: string): void;
  onNote(value: string): void;
}) {
  const { chips, note, errors } = props;
  const vibeError = errorOf(errors, "vibe");
  const noteError = errorOf(errors, "note");
  const hintId = `${FIELD_INPUT_ID.vibe}-hint`;
  const limitId = `${FIELD_INPUT_ID.note}-limit`;
  return (
    <PixelBox className="p-4 flex flex-col gap-3">
      <fieldset className={FIELDSET} aria-describedby={describedBy(hintId, vibeError && errorId("vibe"))}>
        <SectionTitle as="legend" className="mb-1">
          {L.vibe}
        </SectionTitle>
        <p id={hintId} className={PX.meta}>
          {H.vibe}
        </p>
        <FieldMessage field="vibe" message={vibeError} />
        <div className="flex flex-wrap gap-2">
          {VIBE_CHIPS.map((chip, i) => {
            const checked = chips.includes(chip);
            const locked = chipLocked(chips, chip);
            return (
              // PixelChoice's MenuCursor marks a checked chip; a 3rd chip is aria-disabled and its click does nothing
              <PixelChoice
                key={chip}
                type="checkbox"
                name="vibe"
                value={chip}
                checked={checked}
                onChange={() => !locked && props.onToggle(chip)}
                inputProps={{
                  id: i === 0 ? FIELD_INPUT_ID.vibe : undefined,
                  "aria-disabled": locked || undefined,
                  "aria-invalid": i === 0 && vibeError ? true : undefined,
                  "aria-describedby": i === 0 && vibeError ? errorId("vibe") : undefined,
                  onClick: (e) => locked && e.preventDefault(),
                }}
              >
                {chip}
              </PixelChoice>
            );
          })}
        </div>
        <label htmlFor={FIELD_INPUT_ID.note} className="text-sm font-semibold">
          {L.note}
        </label>
        <input
          id={FIELD_INPUT_ID.note}
          type="text"
          maxLength={NOTE_MAX}
          value={note}
          placeholder={H.notePlaceholder}
          autoComplete="off"
          onChange={(e) => props.onNote(e.target.value)}
          aria-invalid={noteError ? true : undefined}
          aria-describedby={describedBy(limitId, noteError && errorId("note"))}
          className={`${PX.input} w-full min-w-0 placeholder:text-muted`}
        />
        <span id={limitId} className="sr-only">
          {H.noteLimit}
        </span>
        <span aria-hidden="true" className={`${PX.meta} self-end tabular-nums`}>
          {note.length}/{NOTE_MAX}
        </span>
        <FieldMessage field="note" message={noteError} />
      </fieldset>
    </PixelBox>
  );
}
