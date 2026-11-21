// TG-70: the outbox for expenses saved with no signal. A queued add keeps its own id (the expense's uuid), so a resend is
// a replay the API answers from that id alone (plan §0): never sent twice. This file decides; outboxStore.ts keeps the
// rows and O3's runner and Waiting box act. Pure: type-only imports, no state, so `node --test` runs it.
// Every string is ux.md §6's, word for word. Logs carry outcomes and counts only: never a name, a note, a member id,
// the slug or the expense id.
import type { ExpenseBodyV2, Member, WalletFailed, WalletFailure, WalletResult } from "./wallet.ts";

/** The body as sent: buildBody always sets the amount, itemized included. */
export type QueuedBody = ExpenseBodyV2 & { id: string; amount_centavos: number };
export type Queued = {
  id: string; // = body.id, the store's key
  slug: string;
  body: QueuedBody;
  savedAt: string; // when Save was tapped
  tries: number; // sends so far, the Save's own included
  nextAt: string; // the timer's next try
  state: "waiting" | "failed";
  why?: WalletFailure; // the last failure's why
  detail?: string; // the last refusal's code
  seq?: number; // item_no_one's item
  lineDropped?: boolean; // B18: budget_key was dropped once already
  mayHaveLanded?: true; // B11b: a try may have reached the server
  holdUntil?: string; // B14a: a 429's Retry-After, the only thing a trigger waits for
};
/** One try's facts, read by the caller. D1: navigator.onLine when the try starts and when it ends. */
export type Try = { now: number; online: { start: boolean; end: boolean } };
export type SendOutcome = { kind: "sent" | "replayedGone" | "retry" | "dropLine" | "failed"; row: Queued };
export type SentNote = { kind: "sent" | "replayedGone"; row: Queued };

// ---------------------------------------------------------------- the copy (ux.md §6)

export const QUEUED = "No signal, so it's saved here. It sends by itself once there's signal, while Tara Gala is open here.";
export const OFFLINE_CUE = "No signal: this will wait here and send later.";
export const BOX_TITLE = "Waiting for signal";
export const BOX_INTRO = "Saved here only. They send by themselves once there's signal, while Tara Gala is open here. Balances and Settle up count them once they're sent.";
export const WHERE_NOTE = "\"Here\" means this browser. Messenger, Safari, Chrome and the home-screen app each keep their own list, so open Tara Gala the same way again to send these.";
export const CHIP_WAITING = "Waiting for signal";
export const CHIP_SENDING = "Sending...";
export const FAILED = "Couldn't send. "; // + the refusal's sentence (walletRequest.failedLine)
export const FAILED_ANY = "Couldn't send. Put it in the form to check it, or remove it.";
export const FAILED_OFF = "Couldn't send. That kind of split is switched off right now. Put it in the form to save it another way, or remove it.";
export const MAYBE_LANDED = "A try may have reached the wallet already. Check Expenses before you put it in the form.";
export const NO_NOTE = "An expense"; // B27: a note is 1 to 60 characters, so this is only a guard
export const TO_FORM = "Put it in the form";
export const FORM_BUSY = "Finish or clear the form first.";
export const REMOVE = "Remove";
export const REMOVE_ASK = "Remove this expense? It was never sent, so nobody else has it.";
export const REMOVE_ASK_MAYBE = "Remove this expense? A try may have reached the wallet without an answer coming back. Check Expenses for it first, so it isn't added twice.";
export const REMOVE_KEEP = "Keep it";
export const REMOVED = "Removed.";
export const BANNER_WAIT = "expenses you add will wait here";

export const boxTitle = (n: number) => `${BOX_TITLE} (${n})`;

// ---------------------------------------------------------------- the id

/** The expense's own uuid, made on Save: crypto.randomUUID, or a v4 from getRandomValues where that's missing. */
export function newExpenseId(c: Pick<Crypto, "getRandomValues"> & Partial<Pick<Crypto, "randomUUID">> = globalThis.crypto): string {
  if (typeof c.randomUUID === "function") return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------- one try's outcome

const AGAIN: WalletFailure[] = ["offline", "server", "rate_limited"];
const STEPS_S = [30, 60, 120, 300]; // then the 5 min cap
const LINE_CODES = ["unknown_budget_line", "budget_line_category"];
const iso = (ms: number) => new Date(ms).toISOString();

/** Try again later: no signal, a timeout, a 5xx or a 429. Anything else is the route's answer. */
export function shouldQueue(r: WalletResult): boolean {
  return !r.ok && AGAIN.includes(r.why);
}

/** B11b: the request may have reached the server: a timeout, a 5xx, or a fetch that threw while online (D1: at its start or end). */
export function mayHaveLanded(r: WalletResult, online: Try["online"]): boolean {
  if (r.ok) return false;
  if (r.timedOut || r.why === "server") return true;
  return r.why === "offline" && (online.start || online.end);
}

/** Milliseconds to the next try after `tries` failed ones (0 = the first): 30 s, 60 s, 2 min, then 5 min. A 429's Retry-After only adds. */
export function backoff(tries: number, retryAfterS?: number): number {
  const step = STEPS_S[Math.min(Math.max(tries, 0), STEPS_S.length - 1)];
  return Math.max(step, retryAfterS ?? 0) * 1000;
}

type Core = Pick<Queued, "id" | "slug" | "body" | "savedAt" | "tries" | "lineDropped">;

/** What every outcome keeps of a row, one more try counted. A hold, a code or a may-have-landed is the new outcome's to set. */
function core(q: Queued): Core {
  return { id: q.id, slug: q.slug, body: q.body, savedAt: q.savedAt, tries: q.tries + 1, ...(q.lineDropped ? { lineDropped: true } : {}) };
}

/** A waiting row after a try that shouldQueue said yes to. `c.tries` counts the tries made, this one included. */
function waiting(c: Core, r: WalletFailed, t: Try, wasMaybe: boolean): Queued {
  const retryAfter = r.why === "rate_limited" ? r.retryAfter : undefined;
  const out: Queued = { ...c, nextAt: iso(t.now + backoff(c.tries - 1, retryAfter)), state: "waiting", why: r.why };
  if (retryAfter !== undefined) out.holdUntil = iso(t.now + retryAfter * 1000);
  if (wasMaybe || mayHaveLanded(r, t.online)) out.mayHaveLanded = true;
  return out;
}

/** The row for a Save that shouldQueue said yes to: the Save was try 1. */
export function queuedRow(slug: string, body: QueuedBody, r: WalletFailed, t: Try): Queued {
  return waiting({ id: body.id, slug, body, savedAt: iso(t.now), tries: 1 }, r, t, false);
}

/**
 * What one send did (B11b, B15 to B19). With F1's order the API's replay check runs before every refusal, so a route
 * refusal means this id was never stored and clears mayHaveLanded; a Pydantic 422 (no code) keeps it: the rollback case.
 */
export function afterSend(q: Queued, r: WalletResult, t: Try): SendOutcome {
  if (r.ok) return { kind: r.wallet.expenses.some((e) => e.id === q.id) ? "sent" : "replayedGone", row: q };
  const c = core(q);
  if (shouldQueue(r)) return { kind: "retry", row: waiting(c, r, t, !!q.mayHaveLanded) };
  if (r.why === "rejected" && r.detail && LINE_CODES.includes(r.detail) && !q.lineDropped) {
    // B18: once, with "Not sorted yet", the same id and everything else as it was; sent again in the same run
    return { kind: "dropLine", row: { ...c, body: { ...q.body, budget_key: null }, lineDropped: true, nextAt: iso(t.now), state: "waiting" } };
  }
  const failed: Queued = { ...c, nextAt: q.nextAt, state: "failed", why: r.why };
  if (r.detail !== undefined) failed.detail = r.detail;
  if (r.seq !== undefined) failed.seq = r.seq;
  if (q.mayHaveLanded && r.why === "rejected" && r.detail === undefined) failed.mayHaveLanded = true;
  return { kind: "failed", row: failed };
}

// ---------------------------------------------------------------- which rows

const oldestFirst = (rows: Queued[]) => [...rows].sort((a, b) => Date.parse(a.savedAt) - Date.parse(b.savedAt)); // stable: ties keep stored order

/**
 * The rows to send now, oldest first. With a trigger (`online`, a page opening, the tab becoming visible; S1) every
 * waiting row goes, except one inside a 429's Retry-After. The timer alone waits for nextAt. Held rows (an open Remove
 * confirm, B20a) and failed rows never go.
 */
export function due(rows: Queued[], now: number, opts: { trigger?: boolean; held?: ReadonlySet<string> } = {}): Queued[] {
  const ready = (q: Queued) => (opts.trigger ? !q.holdUntil || Date.parse(q.holdUntil) <= now : Date.parse(q.nextAt) <= now);
  return oldestFirst(rows.filter((q) => q.state === "waiting" && !opts.held?.has(q.id) && ready(q)));
}

/** This wallet's rows, waiting and failed: the Waiting box's list and Settle up's count. */
export function forWallet(rows: Queued[], slug: string): Queued[] {
  return oldestFirst(rows.filter((q) => q.slug === slug));
}

// ---------------------------------------------------------------- the lines

const noteOf = (q: Queued) => q.body.note.trim() || NO_NOTE;
const named = (q: Queued, peso: (c: number) => string) => `${noteOf(q)}, ${peso(q.body.amount_centavos)}`;

/** B15, B16, B18: one run's lines for the box's live region: the sent (one or many), then each dropped line, then each gone. */
export function sentLines(outcomes: SentNote[], peso: (centavos: number) => string): string[] {
  const sent = outcomes.filter((o) => o.kind === "sent" && !o.row.lineDropped);
  const dropped = outcomes.filter((o) => o.kind === "sent" && o.row.lineDropped);
  const gone = outcomes.filter((o) => o.kind === "replayedGone");
  const lines: string[] = [];
  if (sent.length === 1) lines.push(`Sent. ${named(sent[0].row, peso)}, is in the wallet now.`);
  if (sent.length > 1) lines.push(`Sent ${sent.length} waiting expenses. They're in the wallet now.`);
  for (const o of dropped) lines.push(`Sent ${named(o.row, peso)}, without its budget line, because the plan's lines changed. Pick one in Details.`);
  for (const o of gone) lines.push(`${named(o.row, peso)}, was already sent, and someone deleted it since.`);
  return lines;
}

/** "Ana paid", or "Ana and 1 more paid" with several payers. A name the wallet no longer has reads "Someone". */
export function paidBy(body: QueuedBody, members: Member[]): string {
  const ids = "payers" in body && body.payers ? body.payers.map((p) => p.member_id) : ["paid_by" in body ? body.paid_by : ""];
  const name = members.find((m) => m.id === ids[0])?.name ?? "Someone";
  return ids.length > 1 ? `${name} and ${ids.length - 1} more paid` : `${name} paid`;
}

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "Asia/Manila" });
// h23 parts, not Intl's 12-hour output: browsers put a narrow no-break space before "PM" (offline.ts T27-13)
const HHMM = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Manila" });
const YMD = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Manila" });

// Copy of offline.ts's to12Hour (plain-module rule: no import of it), so the spacing matches the banner and the trip cards
function to12Hour(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** "saved 7:42 AM" today, "saved Nov 26, 12:10 PM" on another day: Manila time, whatever the phone's zone. */
export function savedAt(at: string, now: number): string {
  const d = new Date(at);
  const time = to12Hour(HHMM.format(d));
  return YMD.format(d) === YMD.format(new Date(now)) ? `saved ${time}` : `saved ${DAY.format(d)}, ${time}`;
}

/** B22: Settle up's line, counting waiting and failed rows: neither is in the wallet. */
export function settleLine(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? "1 expense is still waiting for signal here, so this isn't final yet." : `${n} expenses are still waiting for signal here, so this isn't final yet.`;
}

/** B20: which question Remove asks. */
export function removeAsk(q: Queued): string {
  return q.mayHaveLanded ? REMOVE_ASK_MAYBE : REMOVE_ASK;
}

// ---------------------------------------------------------------- logs (plan §7)

export const sendLog = (kind: SendOutcome["kind"], tries: number) => `[tg-outbox] send outcome=${kind} tries=${tries}`;
export const runnerLog = (n: number) => `[tg-outbox] runner start due=${n}`;
