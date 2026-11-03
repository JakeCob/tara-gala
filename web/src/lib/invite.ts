// TG-58 PR 2: the invite link. A second, limited key to a trip: it shows the trip's name and dates, the names on its list
// and how many said yes, and takes a yes or no. It never opens the trip, so this file knows nothing of the trip's link,
// and its answers go through the network only: the service worker doesn't list /invites (F5).

import { API_URL } from "./api.ts";
import { tripFailureMessage } from "./trip.ts";

export type Answer = "yes" | "no";
export type InvitePerson = { id: string; name: string };
/** Everything the invite can read. `closed`: the trip has ended, and `people` is then empty */
export type Invite = { name: string; start_date: string; return_date: string; coming: number; closed: boolean; people: InvitePerson[] };
export type AnswerOut = { attendee_id: string; name: string; answer: Answer };
/** Someone on the list, or a new name */
export type Who = { attendee_id: string } | { name: string };

export type InviteFailure = "offline" | "dead" | "rate_limited" | "server" | "rejected";
export type InviteResult<T> = { ok: true; value: T } | { ok: false; why: InviteFailure; detail?: string };

const DEAD = "This invitation doesn't work any more. Ask the group for a new link.";
const DETAIL: Record<string, string> = {
  name_taken: "That name is on the list already. Pick it above.",
  party_full: "This trip's list is full. Ask the group.",
  unknown_attendee: "That person isn't on the list any more. Refresh and try again.",
  photo_taken: "This name already has a photo. Ask the group to change it.",
  invite_closed: "This trip has ended, so answers are closed.",
};

/** One plain sentence for a failed call. A dead link has its own; the rest read as on the trip page. */
export function inviteMessage(r: { why: InviteFailure; detail?: string }): string {
  if (r.why === "dead") return DEAD;
  if (r.why === "rejected" && r.detail && DETAIL[r.detail]) return DETAIL[r.detail];
  return tripFailureMessage({ why: r.why, detail: r.detail });
}

/** "5 people are coming so far." */
export function countLine(coming: number): string {
  if (coming === 0) return "Nobody's said yes yet.";
  return coming === 1 ? "1 person is coming so far." : `${coming} people are coming so far.`;
}

async function call<T>(path: string, init?: { body?: unknown; raw?: Blob }): Promise<InviteResult<T>> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      cache: "no-store",
      method: init ? "POST" : "GET",
      headers: init?.raw ? { "content-type": init.raw.type } : init ? { "content-type": "application/json" } : undefined,
      body: init?.raw ?? (init ? JSON.stringify(init.body) : undefined),
    });
  } catch {
    return { ok: false, why: "offline" };
  }
  if (res.status === 204) return { ok: true, value: null as T };
  if (res.ok) return { ok: true, value: (await res.json()) as T };
  if (res.status === 404) return { ok: false, why: "dead" };
  if (res.status === 429) return { ok: false, why: "rate_limited" };
  if (res.status >= 500) return { ok: false, why: "server" };
  const body = await res.json().catch(() => null);
  return { ok: false, why: "rejected", detail: typeof body?.detail === "string" ? body.detail : undefined };
}

const at = (slug: string) => `/invites/${encodeURIComponent(slug)}`;

export const inviteApi = {
  get: (slug: string) => call<Invite>(at(slug)),
  answer: (slug: string, who: Who, answer: Answer) => call<AnswerOut>(`${at(slug)}/answers`, { body: { ...who, answer } }),
  /** Fills an empty photo slot with the phone's square picture; the invite can't replace one */
  addPhoto: (slug: string, attendeeId: string, picture: Blob) =>
    call<null>(`${at(slug)}/attendees/${encodeURIComponent(attendeeId)}/photo`, { raw: picture }),
};

// ---------------------------------------------------------------- what this phone remembers

/** This phone's answer to one invite, so coming back shows it, as a wallet remembers who you are */
export type SavedAnswer = { attendee_id: string; name: string; answer: Answer; photo?: true };
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
const key = (slug: string) => `tg-invite-${slug}`;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // some private modes throw on access
  }
}

export function readAnswer(slug: string, store: Storage | null = storage()): SavedAnswer | null {
  try {
    const raw = JSON.parse(store?.getItem(key(slug)) ?? "null");
    const ok = !!raw && typeof raw === "object" && typeof raw.attendee_id === "string" && typeof raw.name === "string" &&
      (raw.answer === "yes" || raw.answer === "no");
    return ok ? { attendee_id: raw.attendee_id, name: raw.name, answer: raw.answer, ...(raw.photo === true ? { photo: true } : {}) } : null;
  } catch {
    return null;
  }
}

export function rememberAnswer(slug: string, saved: SavedAnswer, store: Storage | null = storage()): void {
  try {
    store?.setItem(key(slug), JSON.stringify(saved));
  } catch {
    // full or blocked: the answer is still on the list, this phone just won't show it next time
  }
}

/** `Not Fe?`: this invite only, so one phone can answer for someone else */
export function forgetAnswer(slug: string, store: Storage | null = storage()): void {
  try {
    store?.removeItem(key(slug));
  } catch {
    // as above
  }
}
