// TG-58: the trip's own list of people (separate from the wallet's members), their answers and their arrival at the first
// meet-up. A saved copy from before this deploy has no attendees, so everything reads the list through peopleOf.

import { formatTime } from "./api.ts";
import { marksByKey, rowShows, type Guide, type Mark } from "./guide.ts";
import type { Trip } from "./trip.ts";

export type Rsvp = "pending" | "yes" | "no";
export type Attendee = { id: string; name: string; rsvp: Rsvp; rsvp_at: string | null; arrived_at: string | null };

const MAX_NAMES_WAITING = 6; // past this the line gives a count: 20 names would push the rows down the page
const FIRST_MEET_UP = "First meet-up";

export function peopleOf(trip: Pick<Trip, "attendees">): Attendee[] {
  return trip.attendees ?? [];
}

export function counts(people: readonly Attendee[]): Record<Rsvp, number> {
  const n: Record<Rsvp, number> = { yes: 0, no: 0, pending: 0 };
  for (const p of people) n[p.rsvp]++;
  return n;
}

const named = (people: readonly Attendee[], rsvp: Rsvp) => people.filter((p) => p.rsvp === rsvp).map((p) => p.name).join(", ");

/** The lines in the Who's coming box: readable with no colour, and an empty one drops out. */
export function comingLines(people: readonly Attendee[]): string[] {
  return [["Coming", "yes"], ["Can't make it", "no"], ["No answer yet", "pending"]].flatMap(([label, rsvp]) => {
    const names = named(people, rsvp as Rsvp);
    return names ? [`${label}: ${names}`] : [];
  });
}

/** "5 coming, 1 can't make it, 2 haven't answered." */
export function comingSummary(people: readonly Attendee[]): string {
  const { yes, no, pending } = counts(people);
  const parts = [yes && `${yes} coming`, no && `${no} can't make it`, pending && `${pending} ${pending === 1 ? "hasn't" : "haven't"} answered`].filter(Boolean);
  return parts.length ? `${parts.join(", ")}.` : "";
}

/** Who the first meet-up waits for: everyone except a no, because many people never answer but do turn up. */
export function expected(people: readonly Attendee[]): Attendee[] {
  return people.filter((p) => p.rsvp !== "no");
}

function andList(names: string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function waitingLine(people: readonly Attendee[]): string {
  const due = expected(people);
  if (due.length === 0) return "Nobody's expected yet.";
  const missing = due.filter((p) => !p.arrived_at);
  const got = due.length - missing.length;
  if (missing.length === 0) return `Everyone's here: ${got} of ${due.length}.`;
  const who = missing.length > MAX_NAMES_WAITING ? `${missing.length} people` : andList(missing.map((p) => p.name));
  return `${got} of ${due.length} here. Waiting for ${who}.`;
}

/** Which face the box opens on: Who's here on the day the trip leaves, as long as someone's listed. */
export function openFace(today: string, trip: Pick<Trip, "start_date" | "attendees">): "here" | "coming" {
  return today === trip.start_date && peopleOf(trip).length > 0 ? "here" : "coming";
}

/** The heading over the rows: the first row showing on day 1. A trip with no plan can still take arrivals. */
export function meetLine(guide: Guide | null, marks: readonly Mark[]): string {
  const picks = marksByKey(marks);
  const row = guide?.days.find((d) => d.day === 1)?.rows.find((r) => rowShows(r, picks));
  return row ? `${formatTime(row.time)} · ${row.plan}` : FIRST_MEET_UP;
}

const manilaParts = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(iso))
    .reduce<Record<string, string>>((all, part) => ({ ...all, [part.type]: part.value }), {});

/** "09:12" in Manila, for a time input. */
export function arrivalInput(iso: string): string {
  const { hour, minute } = manilaParts(iso);
  return `${hour}:${minute}`;
}

/** "9:12 AM" in Manila. Phones disagree, so this is always the server's time. */
export function arrivalTime(iso: string): string {
  return formatTime(arrivalInput(iso));
}

/** A corrected time on the same Manila day as the tap, as the API's wall time. Null unless it's a real HH:MM. */
export function correctedAt(iso: string, hhmm: string): string | null {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm)) return null;
  const { year, month, day } = manilaParts(iso);
  return `${year}-${month}-${day}T${hhmm}:00`;
}
