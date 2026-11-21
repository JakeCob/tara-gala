// TG-70 O3 (plan Rev 3 §3 O3, B14 to B19, B14a, B20a, B24; review-plan D1): the sender, as a plain function so node can
// test it. OutboxRunner.tsx wires it to the page's events and a timer, on every page. It never reads the flag: an outbox
// that holds something is drained even with the flag off (B24), safely, because the id makes a resend a replay (O1).
import { afterSend, due, runnerLog, sendLog, type Queued, type QueuedBody, type SendOutcome } from "./outbox.ts";
import type { OutboxStore } from "./outboxStore.ts";
import type { Wallet, WalletResult } from "./wallet.ts";

export const SEND_TIMEOUT_MS = 15000; // B11: a send with no answer by then counts as no signal
export const OUTBOX_EVENT = "tg-outbox"; // the runner → the open wallet (WaitingList)
export const OUTBOX_KICK = "tg-outbox-kick"; // the wallet → the runner: a row was queued, so arm the timer
/** The page's row in flight (one at a time), for a Waiting box that mounts mid-run: its Remove is disabled (B20a). */
export const outboxSending = new Set<string>();

/** One try's news for the open wallet: `sending` before it, its outcome after, and one `end` per run that sent anything. */
export type OutboxEvent =
  | { outcome: "sending"; slug: string; id: string }
  | { outcome: SendOutcome["kind"]; slug: string; id: string; row: Queued; wallet?: Wallet }
  | { outcome: "end" };

export type RunnerDeps = {
  store: OutboxStore;
  send: (slug: string, body: QueuedBody, opts: { timeoutMs: number }) => Promise<WalletResult>;
  onLine: () => boolean;
  now: () => number;
  dispatch: (e: OutboxEvent) => void;
  sending: Set<string>; // the row in flight: OutboxRunner passes outboxSending, a test its own
};

const MIN_WAIT_MS = 1000; // a held, due row waits for its confirm: never a busy loop

/** The timer's next run: the earliest waiting row's nextAt (or a 429's holdUntil, if later), in ms from now. */
function nextDelay(rows: Queued[], now: number): number | null {
  const at = rows
    .filter((q) => q.state === "waiting")
    .map((q) => Math.max(Date.parse(q.nextAt), q.holdUntil ? Date.parse(q.holdUntil) : 0));
  return at.length ? Math.max(MIN_WAIT_MS, Math.min(...at) - now) : null;
}

/** The row as the store holds it now, if it's still waiting: Remove may have taken it since the run began (M1). */
async function stillWaiting(d: RunnerDeps, id: string): Promise<Queued | null> {
  const now = (await d.store.list()).find((q) => q.id === id);
  return now && now.state === "waiting" ? now : null;
}

/** One try of one row, and what it did to the store. `dropLine` sends again at once with budget_key null (B18). */
async function sendOne(d: RunnerDeps, row: Queued): Promise<SendOutcome> {
  let q = row;
  for (;;) {
    d.dispatch({ outcome: "sending", slug: q.slug, id: q.id });
    d.sending.add(q.id);
    let r: WalletResult;
    const start = d.onLine(); // D1: online at the start or the end may have reached the server
    try {
      r = await d.send(q.slug, q.body, { timeoutMs: SEND_TIMEOUT_MS });
    } finally {
      d.sending.delete(q.id);
    }
    const out = afterSend(q, r, { now: d.now(), online: { start, end: d.onLine() } });
    console.info(sendLog(out.kind, out.row.tries));
    const kept = out.kind === "sent" || out.kind === "replayedGone" || (await stillWaiting(d, q.id)) !== null;
    if (out.kind === "sent" || out.kind === "replayedGone") await d.store.remove(q.id);
    else if (kept) await d.store.update(out.row); // never put back a row removed while it was in flight
    d.dispatch({ outcome: out.kind, slug: q.slug, id: q.id, row: out.row, wallet: r.ok ? r.wallet : undefined });
    if (out.kind !== "dropLine" || !kept) return out;
    q = out.row;
  }
}

/** One run: the due rows, oldest first, one at a time (B14). A trigger sends rows in backoff too (S1). */
async function runOnce(d: RunnerDeps, trigger: boolean): Promise<number | null> {
  let rows: Queued[];
  try {
    rows = await d.store.list();
  } catch {
    return null; // no IndexedDB: the store has logged it (B23)
  }
  const list = due(rows, d.now(), { trigger, held: d.store.held });
  if (list.length) console.info(runnerLog(list.length));
  let sent = 0;
  for (const row of list) {
    if (d.store.held.has(row.id)) continue; // B20a: its Remove confirm opened during this run
    const fresh = await stillWaiting(d, row.id); // M1: removed (or failed) since the run began: never sent
    if (!fresh) continue;
    const out = await sendOne(d, fresh);
    sent++;
    if (out.kind === "retry" && out.row.why === "offline" && !d.onLine()) break; // no signal: the rest wait for the next trigger
  }
  if (sent) d.dispatch({ outcome: "end" });
  try {
    return nextDelay(await d.store.list(), d.now());
  } catch {
    return null;
  }
}

/** The page's runner. Runs asked while one is running wait and run once more after it, so a row is never sent twice. */
export function outboxRunner(d: RunnerDeps): { run: (trigger: boolean) => Promise<number | null> } {
  let running: Promise<number | null> | null = null;
  let again: boolean | null = null; // a run asked meanwhile, and whether any of those was a trigger
  async function loop(trigger: boolean): Promise<number | null> {
    try {
      let next = await runOnce(d, trigger);
      while (again !== null) {
        const t = again;
        again = null;
        next = await runOnce(d, t);
      }
      return next;
    } finally {
      running = null; // a send that throws mustn't leave the page's runner stuck
      again = null;
    }
  }
  return {
    run(trigger) {
      if (running) {
        again = (again ?? false) || trigger;
        return running;
      }
      running = loop(trigger);
      return running;
    },
  };
}
