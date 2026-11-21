"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PX, PixelBox, PixelButton, SectionTitle } from "@/components/pixel";
import {
  BOX_INTRO,
  CHIP_SENDING,
  CHIP_WAITING,
  FORM_BUSY,
  MAYBE_LANDED,
  NO_NOTE,
  REMOVE,
  REMOVED,
  REMOVE_KEEP,
  TO_FORM,
  WHERE_NOTE,
  boxTitle,
  forWallet,
  paidBy,
  removeAsk,
  savedAt,
  sentLines,
  type Queued,
  type SentNote,
} from "@/lib/outbox";
import { OUTBOX_EVENT, type OutboxEvent } from "@/lib/outboxRunner";
import { outbox } from "@/lib/outboxStore";
import { formatPeso, type Member, type Wallet } from "@/lib/wallet";
import { failedLine } from "@/lib/walletRequest";

export type OutboxBox = {
  rows: Queued[]; // this wallet's, waiting and failed, oldest first
  now: number; // when they were read: "saved 7:42 AM" today, with the date on another day
  sending: string | null; // the row whose send is in flight (its chip reads Sending...)
  lines: string[]; // the box's live region: QUEUED, the run's sent lines, REMOVED
  say: (line: string) => void;
  clear: () => void;
  reload: () => Promise<void>;
};

/**
 * TG-70 O3 (plan §3 O3, ux.md §2 and §3): this wallet's rows in this browser's outbox, and what the runner says about
 * them. Each sent wallet lands through `onWallet` (landWallet: a lower rev never replaces the screen). The lines stay
 * until a reload or the next write (WalletView calls clear). Off (the flag), it reads nothing.
 */
export function useOutbox(slug: string, onWallet: (w: Wallet) => void, enabled: boolean): OutboxBox {
  const [rows, setRows] = useState<Queued[]>([]);
  const [now, setNow] = useState(0);
  const [sending, setSending] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const run = useRef<SentNote[]>([]); // this run's sent and gone rows, for one set of lines at its end
  const wallet = useRef(onWallet);
  useEffect(() => {
    wallet.current = onWallet;
  });
  const reload = useCallback(
    () =>
      outbox.list().then(
        (all) => {
          setRows(forWallet(all, slug));
          setNow(Date.now());
        },
        () => setRows([]), // no IndexedDB: nothing was kept here
      ),
    [slug],
  );
  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);
  useEffect(() => {
    if (!enabled) return;
    const on = (ev: Event) => {
      const e = (ev as CustomEvent<OutboxEvent>).detail;
      if (e.outcome === "end") {
        if (run.current.length) setLines(sentLines(run.current, formatPeso));
        run.current = [];
        return;
      }
      if (e.slug !== slug) return;
      if (e.outcome === "sending") return setSending(e.id);
      setSending(null);
      if (e.outcome === "sent" || e.outcome === "replayedGone") run.current.push({ kind: e.outcome, row: e.row });
      if (e.wallet) wallet.current(e.wallet);
      void reload();
    };
    window.addEventListener(OUTBOX_EVENT, on);
    return () => window.removeEventListener(OUTBOX_EVENT, on);
  }, [enabled, slug, reload]);
  return { rows, now, sending, lines, say: useCallback((line: string) => setLines([line]), []), clear: useCallback(() => setLines([]), []), reload };
}

/** A row the wallet refused (B19a's line), and MAYBE_LANDED when a try may have reached it (B11b). Its own box (W1). */
function Failed({ q }: { q: Queued }) {
  return (
    <PixelBox tone="alertText" className="flex flex-col gap-1 p-3 text-sm">
      <p>{failedLine(q)}</p>
      {q.mayHaveLanded && <p className={PX.meta}>{MAYBE_LANDED}</p>}
    </PixelBox>
  );
}

/**
 * TG-70 ux.md §2: the Waiting for signal box at the top of Expenses. A card per row: its note and ₱, who paid and when
 * it was saved, then the chip (waiting or Sending...) or the failed line with Put it in the form. Remove asks first, and
 * the runner skips the row while its confirm is open (B20a). When the last row leaves, only the line stays (§3).
 */
export default function WaitingList({ box, members, formBusy, onToForm }: {
  box: OutboxBox;
  members: Member[];
  formBusy: string | null; // the row whose Put it in the form met a dirty form
  onToForm: (q: Queued) => void;
}) {
  const [asking, setAsking] = useState<string | null>(null);
  // A confirm open when the box goes away (another page, a reload of the list) mustn't leave its row held
  useEffect(() => () => {
    if (asking) outbox.held.delete(asking);
  }, [asking]);
  if (!box.rows.length && !box.lines.length) return null;

  function ask(id: string) {
    outbox.held.add(id);
    setAsking(id);
  }

  function keep(id: string) {
    outbox.held.delete(id);
    setAsking(null);
    requestAnimationFrame(() => document.getElementById(`remove-${id}`)?.focus()); // back where the confirm opened
  }

  async function remove(id: string) {
    const maybe = box.rows.find((q) => q.id === id)?.mayHaveLanded ? "yes" : "no";
    try {
      await outbox.remove(id);
    } catch {
      // no IndexedDB now: the row can't be there either
    }
    outbox.held.delete(id);
    setAsking(null);
    console.info("[tg-outbox] remove maybe=%s", maybe);
    box.say(REMOVED);
    await box.reload();
  }

  return (
    <PixelBox as="section" aria-labelledby={box.rows.length ? "waiting-title" : undefined} aria-label={box.rows.length ? undefined : CHIP_WAITING} className="flex flex-col gap-3 p-4">
      {box.rows.length > 0 && (
        <div className="flex flex-col gap-1">
          <SectionTitle id="waiting-title" tabIndex={-1} className="focus-pixel">
            {boxTitle(box.rows.length)}
          </SectionTitle>
          <p className={PX.meta}>{BOX_INTRO}</p>
          <p className={PX.meta}>{WHERE_NOTE}</p>
        </div>
      )}
      <div aria-live="polite" className="flex flex-col gap-1 text-sm empty:hidden">
        {box.lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      {box.rows.length > 0 && (
        <ul className="flex flex-col gap-3">
          {box.rows.map((q) => (
            <PixelBox as="li" key={q.id} className="flex flex-col gap-2 p-4">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 break-words font-semibold">{q.body.note.trim() || NO_NOTE}</span>
                <span className="font-bold tabular-nums">{formatPeso(q.body.amount_centavos)}</span>
              </div>
              <p className={PX.meta}>
                {paidBy(q.body, members)} · {savedAt(q.savedAt, box.now)}
              </p>
              {q.state === "failed" && <Failed q={q} />}
              {formBusy === q.id && <p className="text-sm">{FORM_BUSY}</p>}
              {asking === q.id ? (
                <div className="flex flex-col gap-2" onKeyDown={(e) => {
                  if (e.key === "Escape") keep(q.id);
                }}>
                  <p className="text-sm">{removeAsk(q)}</p>
                  <div className="flex flex-wrap gap-2">
                    <PixelButton variant="primary" className="px-4 text-sm" onClick={() => void remove(q.id)}>
                      {REMOVE}
                    </PixelButton>
                    {/* ux §2: it starts on Keep it, so a stray Enter or double tap never removes */}
                    <PixelButton variant="secondary" autoFocus onClick={() => keep(q.id)}>
                      {REMOVE_KEEP}
                    </PixelButton>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  {q.state === "waiting" && (
                    <span className="border-2 border-frame bg-accent px-2 py-0.5 text-xs font-semibold text-accent-ink">
                      {box.sending === q.id ? CHIP_SENDING : CHIP_WAITING}
                    </span>
                  )}
                  {q.state === "failed" && (
                    <PixelButton variant="secondary" onClick={() => onToForm(q)}>
                      {TO_FORM}
                    </PixelButton>
                  )}
                  <PixelButton variant="secondary" id={`remove-${q.id}`} aria-disabled={box.sending === q.id || undefined} onClick={() => box.sending !== q.id && ask(q.id)}>
                    {REMOVE}
                  </PixelButton>
                </div>
              )}
            </PixelBox>
          ))}
        </ul>
      )}
    </PixelBox>
  );
}
