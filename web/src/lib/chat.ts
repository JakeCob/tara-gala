// TG-61 PR 2: the chatbot's log, kept only on this phone (ux.md §10), and how its answers are read. Pure apart from
// chatStorage(): no fetch, no React. The server stores nothing from a chat; only an applied change becomes a version.
import type { Guide } from "./guide.ts";
import type { GuideIn } from "./planEdit.ts";
import type { ChangeLine } from "./planLines.ts";
import type { PlanBase } from "./trip.ts";

export const MAX_SENT = 10; // turns per request (options.md §7)
export const MAX_TEXT = 1000; // characters per turn
export const MAX_KEPT = 30; // turns kept on the phone (ux.md §10)

// ---- the wire (agreed with the API builder, 2026-11-05) ----------------------------------------------

export type ChatMessage = { role: "user" | "assistant"; text: string };
export type ChatIn = { base: PlanBase; messages: ChatMessage[]; focus: { key: string } | null };
/** Where a place the chatbot can't pin would go, if it named one; keys were checked against the base */
export type LinkAt = { after: string } | { replace: string } | { first_of_day: number } | null;
export type NeedLink = { name: string; at: LinkAt };
export type ChatProposal = { guide: Guide; stored: GuideIn; changes: ChangeLine[]; base: PlanBase };
export type ChatOut = { reply: string; proposal: ChatProposal | null; outcome: "proposal" | "answer" | "no_fit"; need_link: NeedLink | null };
export type ChatFailure = "offline" | "not_found" | "busy" | "cap" | "off" | "clash" | "server" | "rejected";
export type ChatAnswer = { ok: true; body: ChatOut } | { ok: false; why: ChatFailure; retryAt?: string | null; clash?: PlanBase };

// ---- the log ---------------------------------------------------------------------------------------

/** open: the newest proposal, with Apply and Not this. lapsed: an older one, or one from before a reload */
export type ProposalState = "open" | "applied" | "declined" | "lapsed";
export type Entry =
  | { kind: "user"; text: string }
  | { kind: "bot"; text: string; changes?: ChangeLine[]; proposal?: ProposalState; needLink?: NeedLink | null; noFit?: boolean }
  /** The app's own lines (limits, no signal, a clash), one per "\n": shown, never sent or kept. again: offer Ask again */
  | { kind: "alert"; text: string; again?: boolean };

export const storeKey = (slug: string) => `tg-chat:${slug}`;

type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };

/** This phone's localStorage, or null where reading it throws (private mode, blocked storage) */
export function chatStorage(): Store | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

const isLine = (l: unknown): l is ChangeLine => {
  const o = l as ChangeLine;
  return !!o && typeof o.word === "string" && typeof o.text === "string" && (o.day === null || typeof o.day === "number");
};
const isAt = (a: unknown): a is LinkAt => {
  if (a === null) return true;
  const o = a as Record<string, unknown>;
  if (!o || typeof o !== "object") return false;
  return typeof o.after === "string" || typeof o.replace === "string" || typeof o.first_of_day === "number";
};
const isNeedLink = (n: unknown): n is NeedLink => !!n && typeof (n as NeedLink).name === "string" && isAt((n as NeedLink).at);
const STATES: ProposalState[] = ["open", "applied", "declined", "lapsed"];

/** One stored entry, or null if it isn't one. Only the words on screen: never a plan, a base or an alert */
function keep(e: unknown): Entry | null {
  const o = e as Record<string, unknown>;
  if (!o || typeof o !== "object" || typeof o.text !== "string") return null;
  if (o.kind === "user") return { kind: "user", text: o.text };
  if (o.kind !== "bot") return null;
  const out: Entry = { kind: "bot", text: o.text };
  if (Array.isArray(o.changes) && o.changes.every(isLine)) out.changes = o.changes.map((l) => ({ word: l.word, day: l.day, text: l.text }));
  if (typeof o.proposal === "string" && (STATES as string[]).includes(o.proposal)) out.proposal = o.proposal as ProposalState;
  if (isNeedLink(o.needLink)) out.needLink = { name: o.needLink.name, at: o.needLink.at };
  if (o.noFit === true) out.noFit = true;
  return out;
}

export function loadLog(store: Store | null, slug: string): Entry[] {
  if (!store) return [];
  try {
    const raw = store.getItem(storeKey(slug));
    const list: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    // A proposal from before a reload can't be applied: its plan may be old (ux.md §10)
    return list.map(keep).filter((e): e is Entry => !!e).map((e) => (e.kind === "bot" && e.proposal === "open" ? { ...e, proposal: "lapsed" as const } : e)).slice(-MAX_KEPT);
  } catch {
    return [];
  }
}

/** false when the store can't take it: the log then lasts as long as the page */
export function saveLog(store: Store | null, slug: string, log: readonly Entry[]): boolean {
  if (!store) return false;
  try {
    store.setItem(storeKey(slug), JSON.stringify(log.map(keep).filter((e): e is Entry => !!e).slice(-MAX_KEPT)));
    return true;
  } catch {
    return false;
  }
}

export function clearLog(store: Store | null, slug: string): void {
  try {
    store?.removeItem(storeKey(slug));
  } catch {
    // nothing to do: the page's own log is cleared anyway
  }
}

/** Adds an entry. A new proposal takes the buttons from any older one (ux.md §10: only the newest keeps them) */
export function addEntry(log: readonly Entry[], e: Entry): Entry[] {
  const before = e.kind === "bot" && e.proposal === "open" ? log.map((x) => (x.kind === "bot" && x.proposal === "open" ? { ...x, proposal: "lapsed" as const } : x)) : log;
  return [...before, e].slice(-MAX_KEPT);
}

/** The open proposal is applied or turned down */
export function settle(log: readonly Entry[], to: "applied" | "declined"): Entry[] {
  return log.map((x) => (x.kind === "bot" && x.proposal === "open" ? { ...x, proposal: to } : x));
}

/** What the server is sent: the last 10 turns as plain text, the app's own lines left out */
export function toSend(log: readonly Entry[]): ChatMessage[] {
  return log
    .filter((e): e is Exclude<Entry, { kind: "alert" }> => e.kind !== "alert")
    .slice(-MAX_SENT)
    .map((e) => ({ role: e.kind === "user" ? "user" : "assistant", text: e.text.slice(0, MAX_TEXT) }));
}

export function chatRequest(base: PlanBase, log: readonly Entry[], text: string, focus: string | null): ChatIn {
  return { base, messages: toSend([...log, { kind: "user", text: text.trim() }]), focus: focus ? { key: focus } : null };
}

// ---- reading an answer -----------------------------------------------------------------------------

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const isoOrNull = (v: unknown): string | null => (typeof v === "string" && ISO.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);

function isOut(b: unknown): b is ChatOut {
  const o = b as ChatOut;
  if (!o || typeof o !== "object" || typeof o.reply !== "string") return false;
  if (!["proposal", "answer", "no_fit"].includes(o.outcome)) return false;
  if (o.need_link !== null && o.need_link !== undefined && !isNeedLink(o.need_link)) return false;
  const p = o.proposal;
  if (p === null) return true;
  return !!p && typeof p === "object" && !!p.guide && !!p.stored && Array.isArray(p.changes) && p.changes.every(isLine)
    && !!p.base && typeof p.base.itinerary_slug === "string" && typeof p.base.seq === "number";
}

/** Every answer of POST /plan/chat, read in one place. status "offline": the request never got an answer */
export function chatAnswer(status: number | "offline", body: unknown): ChatAnswer {
  if (status === "offline") return { ok: false, why: "offline" };
  const o = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (status >= 200 && status < 300) return isOut(body) ? { ok: true, body: { ...body, need_link: body.need_link ?? null } } : { ok: false, why: "server" };
  if (status === 429) return { ok: false, why: o.detail === "chat_cap" ? "cap" : "busy", retryAt: isoOrNull(o.retry_at) };
  if (status === 503 && o.detail === "chat_off") return { ok: false, why: "off" };
  if (status === 409 && o.detail === "plan_changed") return { ok: false, why: "clash", clash: { itinerary_slug: String(o.itinerary_slug), seq: Number(o.seq) } };
  if (status === 404) return { ok: false, why: "not_found" };
  if (status >= 500) return { ok: false, why: "server" };
  return { ok: false, why: "rejected" };
}

// ---- ux.md §10's lines -----------------------------------------------------------------------------

export const FIRST_MESSAGE = `Kumusta! Tell me what to change, like "add merienda after Burnham Park" or "mas chill ang Day 2". I only use places on Tara Gala and ones your group added. Nothing changes until someone taps Apply.`;
export const PRIVACY_LINE = "This chat is kept only on this phone. To answer, your messages and the plan are sent to an AI service. The group sees only changes you apply.";
export const THINKING = "The chatbot is thinking...";
export const APPLIED = "Applied. It's in Changes, and Undo takes it back.";
export const NOT_APPLIED = "Not applied.";
export const NO_FIT = "The chatbot couldn't make a change that fits the plan. Try asking another way.";
export const APPLY_CLASH = ["Someone just changed the plan, so this change wasn't applied.", "Ask again and the chatbot will use the newer plan."];
/** A question sent while another phone was saving: the page fetches the newer plan, then the person asks again */
export const ASK_CLASH = ["Someone just changed the plan.", "Ask again and the chatbot will use the newer plan."];
export const CLEAR_CONFIRM = "Clear this chat on this phone? Applied changes stay.";
export const needLinkLine = (name: string) => `${name} isn't on Tara Gala yet, so I can't pin it. Paste its Google Maps link and I'll fit it in.`;
export const askLine = (name: string) => `What should we do at ${name}, and is there something similar nearby?`;

/** "4:10 PM" in Manila (UTC+8 all year), whatever this phone's clock zone */
export function manilaClock(iso: string): string {
  const d = new Date(Date.parse(iso) + 8 * 3_600_000);
  const h = d.getUTCHours();
  return `${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** The limits and the other failures that ux.md §10 words; anything else gets the caller's generic line */
export function chatFailureLines(r: { why: ChatFailure; retryAt?: string | null }): string[] | null {
  switch (r.why) {
    case "busy":
      return [`The chatbot has answered 20 messages for this trip this hour. ${r.retryAt ? `Try again after ${manilaClock(r.retryAt)}` : "Try again later"}, or change the plan by hand.`];
    case "cap":
      return ["The chatbot is done for today. You can still change the plan by hand."];
    case "off":
      return ["The chatbot is off right now. You can still change the plan by hand."];
    case "offline":
      return ["The chatbot needs signal."];
    case "clash":
      return ASK_CLASH;
    default:
      return null;
  }
}
