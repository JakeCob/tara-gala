// Party state for the chibi passenger picker (TG-15). Plain module: Node's type stripping runs it in tests.
// The planner form (TG-21), overworld map (TG-22) and share page (TG-23) read the party through these helpers.
import type { ChibiLook, PassengerType } from "./sprites.ts";

export type Passenger = { type: PassengerType }; // no passenger names, which would end up on the public share page
export type Party = readonly Passenger[];

export const MAX_PARTY = 10; // = TG-20 PlanRequest.party max_length
export const PICKER_TYPES: readonly PassengerType[] = ["adult", "student", "senior", "pwd"];
export const DEFAULT_PARTY: Party = [{ type: "adult" }];

export const TYPE_LABEL: Record<PassengerType, string> = { adult: "Adult", student: "Student", senior: "Senior", pwd: "PWD" };
export const TYPE_HINT: Record<PassengerType, string> = {
  adult: "Regular fare",
  student: "With school ID",
  senior: "With senior citizen ID",
  pwd: "With PWD ID",
};
export const DISCOUNT_NOTE =
  "Student, senior and PWD fares need a valid ID at the terminal. Some operators don't give these discounts on online bookings.";

const ARTICLE: Record<PassengerType, string> = { adult: "an adult", student: "a student", senior: "a senior", pwd: "a PWD passenger" };

// Summary nouns, in summary order. child and other only come from saved data (TG-20 and TG-24 allow child).
const NOUNS: readonly (readonly [string, string, string])[] = [
  ["adult", "adult", "adults"],
  ["student", "student", "students"],
  ["senior", "senior", "seniors"],
  ["pwd", "PWD", "PWD"],
  ["child", "child", "children"],
  ["other", "other", "others"],
];

// A list check, not a key lookup, so prototype keys like "constructor" are not picker types
export function isPickerType(t: string): t is PassengerType {
  return (PICKER_TYPES as readonly string[]).includes(t);
}

// The tag under a chibi on the stage; saved data may hold child or unknown types (tag only, no sprite)
export function tagLabel(t: string): string {
  if (isPickerType(t)) return TYPE_LABEL[t];
  return t === "child" ? "Child" : "Other";
}

export function counts(p: readonly { type: string }[]): Record<PassengerType, number> {
  const c: Record<PassengerType, number> = { adult: 0, student: 0, senior: 0, pwd: 0 };
  for (const x of p) if (isPickerType(x.type)) c[x.type]++;
  return c;
}

export function canAdd(p: Party): boolean {
  return p.length < MAX_PARTY;
}

export function canRemove(p: Party, t: PassengerType): boolean {
  return p.length > 1 && p.some((x) => x.type === t);
}

// Returns the same array when the party is full, so callers can skip a re-render
export function add(p: Party, t: PassengerType): Party {
  return canAdd(p) ? [...p, { type: t }] : p;
}

// Removes the last-added passenger of type t; the same array when it can't
export function remove(p: Party, t: PassengerType): Party {
  if (!canRemove(p, t)) return p;
  const i = p.map((x) => x.type).lastIndexOf(t);
  return [...p.slice(0, i), ...p.slice(i + 1)];
}

export function partySummary(p: readonly { type: string }[]): string {
  if (p.length === 0) return "No passengers.";
  const n = new Map<string, number>();
  for (const x of p) {
    const key = isPickerType(x.type) || x.type === "child" ? x.type : "other";
    n.set(key, (n.get(key) ?? 0) + 1);
  }
  const parts = NOUNS.filter(([key]) => n.has(key)).map(([key, one, many]) => {
    const k = n.get(key) ?? 0;
    return `${k} ${k === 1 ? one : many}`;
  });
  const full = p.length >= MAX_PARTY ? ` Party is full (${MAX_PARTY} max).` : "";
  return `Party of ${p.length}: ${parts.join(", ")}.${full}`;
}

export function addLabel(t: PassengerType): string {
  return `Add ${ARTICLE[t]}`;
}

export function removeLabel(t: PassengerType): string {
  return `Remove ${ARTICLE[t]}`;
}

// TG-48: the looks each type cycles through, in the order passengers are added. The first adult is a casual look and
// genders alternate (manager decision); every type has one Kayumanggi and one light-skinned look (tg-ux2 H1).
export const LOOKS: Readonly<Record<PassengerType, readonly ChibiLook[]>> = {
  adult: ["adult-casual-f", "adult-casual-m", "adult-filipiniana", "adult-barong"],
  student: ["student-girl", "student-boy"],
  senior: ["senior-lola", "senior-lolo"],
  pwd: ["pwd-woman", "pwd-man"],
};

/** The look of the index-th passenger of this type (0 = the first one added). Child or unknown types: null. */
export function lookFor(type: string, index: number): ChibiLook | null {
  if (!isPickerType(type)) return null;
  const list = LOOKS[type];
  const i = Number.isInteger(index) && index >= 0 ? index : 0;
  return list[i % list.length];
}

/**
 * Each passenger's look: its ordinal among passengers of the same type, in party order. remove() drops a type's
 * last passenger, so nobody else's look changes, and a saved party gets the same looks with nothing stored.
 */
export function partyLooks(p: readonly { type: string }[]): (ChibiLook | null)[] {
  const seen = new Map<string, number>();
  return p.map(({ type }) => {
    const n = seen.get(type) ?? 0;
    seen.set(type, n + 1);
    return lookFor(type, n);
  });
}
