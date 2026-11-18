"use client";

// TG-66 ux §5: one expense's details, a native modal dialog named by its note. The money and the split come from the
// wallet on screen, so they open offline. Changes and Comments need signal (the worker caches neither). Comment writes
// happen here and hand their wallet to the parent, which applies the rev rule. Edit and Delete are the parent's (W3):
// this only asks for them. Logs carry counts and outcomes only.
import { useEffect, useId, useRef, useState } from "react";
import { DialogBox, PX, PixelBox, PixelButton, cx } from "@/components/pixel";
import {
  COMMENT_MAX,
  addedLine,
  categoryWords,
  chargeLabel,
  commentTooLong,
  commentsFromWrite,
  commentsLeft,
  deleteFailure,
  dayTime,
  historyLines,
  itemRows,
  loadExpenseHistory,
  mergeComments,
  payersDetail,
  splitHeading,
  splitRows,
  type CommentsState,
  type HistoryLine,
} from "@/lib/walletActivity";
import { failureMessage, formatPeso, walletApi, type Activity, type Expense, type Wallet, type WalletFailed } from "@/lib/wallet";

type Load<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "failed"; text: string };
type Notice = { text: string; error: boolean };

const MULTI_PAYER_LINE = "This one has more than one payer, so it can't be edited yet. You can delete it and add it again.";

/** A comment write's refusal in ux §9's words. */
function commentFailure(r: WalletFailed): string {
  if (r.detail === "feature_off") return "Comments aren't switched on right now.";
  if (r.detail === "comments_full") return "This expense has 50 comments, the most it can hold.";
  return failureMessage(r);
}

export default function ExpenseDetails({ slug, wallet, expense, me, online, activity, splits, multiPayer, busy, onWallet, onEdit, onDelete, onClosed }: {
  slug: string;
  wallet: Wallet;
  expense: Expense;
  /** This phone's person, or null: "Someone" */
  me: string | null;
  online: boolean;
  /** NEXT_PUBLIC_WALLET_ACTIVITY: Changes and Comments */
  activity: boolean;
  /** NEXT_PUBLIC_WALLET_SPLITS: Edit */
  splits: boolean;
  /** NEXT_PUBLIC_WALLET_MULTI_PAYER: with it off, an expense with several payers can't be edited (review S4) */
  multiPayer: boolean;
  /** A wallet write is out (the parent's) */
  busy: boolean;
  /** A comment write's wallet: its new rev and the card's comment_count. The parent applies the rev rule. */
  onWallet: (wallet: Wallet) => void;
  /** Edit: the dialog closes, then the parent opens the form on this expense. */
  onEdit: (expense: Expense) => void;
  /** Delete, already confirmed. Resolves true when it's gone (the dialog then closes), else the failure, said in here. */
  onDelete: (expense: Expense) => Promise<true | WalletFailed>;
  /** After the dialog has closed: the parent puts focus back on this expense's Details. */
  onClosed: () => void;
}) {
  const titleId = useId();
  const commentId = useId();
  const commentHint = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const holding = useRef(false); // a comment write is out: set in the handler, so a second tap in the same tick sees it
  const [history, setHistory] = useState<Load<{ rows: Activity[]; complete: boolean }>>({ state: "loading" });
  const [comments, setComments] = useState<Load<CommentsState>>({ state: "loading" });
  const [draft, setDraft] = useState("");
  const [writing, setWriting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const nameOf = (id: string | null | undefined) => wallet.members.find((m) => m.id === id)?.name ?? "Someone";
  const live = online && activity;

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);

  // Changes: this expense's add and edit rows, again after each edit (its version moves)
  const expenseId = expense.id;
  const version = expense.version;
  useEffect(() => {
    if (!live) return;
    let current = true;
    void loadExpenseHistory(walletApi, slug, { id: expenseId }).then((r) => {
      if (!current) return;
      setHistory(r.ok ? { state: "ready", value: { rows: r.rows, complete: r.complete } } : { state: "failed", text: failureMessage(r) });
    });
    return () => {
      current = false;
    };
  }, [live, slug, expenseId, version]);

  // Comments, again after any wallet write (rev), so another phone's delete-then-post shows too. An older answer never
  // replaces a newer list (B24a)
  const rev = wallet.rev ?? 0;
  useEffect(() => {
    if (!live) return;
    let current = true;
    void walletApi.comments(slug, expenseId).then((r) => {
      console.info("[tg-wallet] comments load ok=%s count=%d", r.ok ? "yes" : r.why, r.ok ? r.comments.length : 0);
      if (!current) return;
      if (r.ok) setComments((prev) => ({ state: "ready", value: mergeComments(prev.state === "ready" ? prev.value : null, { rev: r.rev, comments: r.comments }) }));
      else setComments((prev) => (prev.state === "ready" ? prev : { state: "failed", text: commentFailure(r) }));
    });
    return () => {
      current = false;
    };
  }, [live, slug, expenseId, rev]);

  function close() {
    dialog.current?.close();
  }

  async function post() {
    if (holding.current || !live) return;
    const body = draft.trim();
    if (!body) return setNotice({ text: "Type a comment first.", error: true });
    if (commentTooLong(body)) return setNotice({ text: `A comment holds up to ${COMMENT_MAX} characters.`, error: true });
    holding.current = true;
    setWriting(true);
    setNotice(null);
    const r = await walletApi.addComment(slug, expense.id, { body, by: me });
    console.info("[tg-wallet] comment add ok=%s count=%d", r.ok ? "yes" : r.why, r.ok ? r.comments.length : 0);
    holding.current = false;
    setWriting(false);
    if (!r.ok) {
      if (r.wallet) onWallet(r.wallet);
      return setNotice({ text: commentFailure(r), error: true }); // the typed text stays in the box
    }
    setComments((prev) => ({ state: "ready", value: mergeComments(prev.state === "ready" ? prev.value : null, commentsFromWrite(r)) }));
    onWallet(r.wallet);
    setDraft("");
    setNotice({ text: "Comment posted.", error: false });
  }

  async function removeComment(commentId: string) {
    if (holding.current || !live) return;
    if (!window.confirm("Delete this comment for everyone?")) return;
    holding.current = true;
    setWriting(true);
    setNotice(null);
    const r = await walletApi.deleteComment(slug, expense.id, commentId, me);
    console.info("[tg-wallet] comment delete ok=%s count=%d", r.ok ? "yes" : r.why, r.ok ? r.comments.length : 0);
    holding.current = false;
    setWriting(false);
    if (!r.ok) return setNotice({ text: commentFailure(r), error: true });
    setComments((prev) => ({ state: "ready", value: mergeComments(prev.state === "ready" ? prev.value : null, commentsFromWrite(r)) }));
    onWallet(r.wallet);
    setNotice({ text: "Comment deleted.", error: false });
  }

  async function remove() {
    if (busy || holding.current || !online) return;
    if (!window.confirm(`Delete "${expense.note}" (${formatPeso(expense.amount_centavos)}) for everyone? It stays in the activity list.`)) return;
    holding.current = true;
    setDeleting(true);
    setNotice(null);
    const r = await onDelete(expense);
    holding.current = false;
    setDeleting(false);
    console.info("[tg-wallet] details delete ok=%s", r === true ? "yes" : r.why);
    if (r === true) return close();
    setNotice({ text: deleteFailure(r), error: true }); // the parent's alert is behind the modal (ux review M1)
  }

  function edit() {
    if (busy || holding.current || !online) return;
    console.info("[tg-wallet] details edit opened");
    close();
    onEdit(expense);
  }

  const severalPayers = (expense.payers?.length ?? 0) > 1;
  const editable = splits && (multiPayer || !severalPayers);
  const rows = history.state === "ready" ? history.value.rows : null;
  const lines: HistoryLine[] = rows ? historyLines(rows, expense, wallet) : [];
  const left = commentsLeft(draft);
  const blocked = busy || writing || !online;

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onClose={onClosed}
      className="m-0 mt-auto md:my-auto mx-auto mb-4 w-[min(28rem,calc(100%-1rem))] max-h-[85dvh] overflow-y-auto bg-transparent p-0 text-foreground backdrop:bg-screen-ink/60"
    >
      <DialogBox>
        <div className="flex flex-row-reverse items-start justify-between gap-3">
          {/* First in the DOM, so showModal() focuses Close */}
          <PixelButton variant="secondary" onClick={close}>
            Close
          </PixelButton>
          <h2 id={titleId} className={cx(PX.dataHeading, "min-w-0 break-words")}>
            {expense.note}
          </h2>
        </div>

        <div className="flex flex-col gap-1">
          <p className="text-2xl font-extrabold tabular-nums">{formatPeso(expense.amount_centavos)}</p>
          {expense.category ? <p><span className={PX.chip}>{categoryWords(expense.category)}</span></p> : <p className={PX.meta}>{categoryWords(null)}</p>}
          <p className="text-sm break-words">Paid by {payersDetail(expense, wallet)}</p>
          <p className={PX.meta}>{addedLine(expense, rows, wallet)}</p>
        </div>

        <section aria-labelledby={`${titleId}-split`} className="flex flex-col gap-1">
          <h3 id={`${titleId}-split`} className="text-sm font-bold">
            {splitHeading(expense, wallet)}
          </h3>
          {expense.mode === "itemized" && (
            <ul className="flex flex-col gap-1 text-sm">
              {itemRows(expense, wallet).map((line, i) => (
                <li key={i} className="break-words">
                  {line}
                </li>
              ))}
              {(expense.charges ?? []).map((c) => (
                <li key={c.kind}>{chargeLabel(c)}</li>
              ))}
            </ul>
          )}
          <ul className="flex flex-col gap-1 text-sm">
            {splitRows(expense, wallet).map((r) => (
              <li key={r.member_id} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 break-words">{r.name}</span>
                <span className="tabular-nums">{r.detail}</span>
              </li>
            ))}
          </ul>
        </section>

        {activity && (
          <section aria-labelledby={`${titleId}-changes`} className="flex flex-col gap-2">
            <h3 id={`${titleId}-changes`} className="text-sm font-bold">
              Changes
            </h3>
            {!online ? (
              <p className={PX.meta}>Needs signal.</p>
            ) : history.state === "loading" ? (
              <p className={PX.meta}>Loading...</p>
            ) : history.state === "failed" ? (
              <p className={PX.meta}>{history.text}</p>
            ) : lines.length === 0 ? (
              <p className={PX.meta}>No changes yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {lines.map((l) => (
                  <li key={l.id} className="flex flex-col border-b-2 border-border pb-2 last:border-b-0 last:pb-0">
                    <p className="text-sm break-words">
                      <span className="font-semibold">{l.who}</span> {l.rest}
                    </p>
                    <p className={PX.meta}>{dayTime(l.at)}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {activity && (
          <section aria-labelledby={`${titleId}-comments`} className="flex flex-col gap-2">
            <h3 id={`${titleId}-comments`} className="text-sm font-bold">
              Comments
            </h3>
            {!online ? (
              <p className={PX.meta}>Needs signal.</p>
            ) : comments.state === "loading" ? (
              <p className={PX.meta}>Loading...</p>
            ) : comments.state === "failed" ? (
              <p className={PX.meta}>{comments.text}</p>
            ) : (
              comments.value.comments.length > 0 && (
                <ul className="flex flex-col gap-2">
                  {comments.value.comments.map((c) => (
                    <li key={c.id} className="flex flex-col gap-1 border-b-2 border-border pb-2 last:border-b-0 last:pb-0">
                      <p className="text-sm break-words">
                        <span className="font-semibold">{nameOf(c.author)}</span> {c.body}
                      </p>
                      <div className="flex items-center justify-between gap-3">
                        <p className={PX.meta}>{dayTime(c.created_at)}</p>
                        <PixelButton variant="secondary" aria-label={`Delete ${nameOf(c.author)}'s comment`} aria-disabled={blocked || undefined} onClick={() => void removeComment(c.id)}>
                          Delete
                        </PixelButton>
                      </div>
                    </li>
                  ))}
                </ul>
              )
            )}
            <label htmlFor={commentId} className="text-sm font-semibold">
              {me ? `Add a comment as ${nameOf(me)}` : "Add a comment"}
            </label>
            <textarea id={commentId} aria-describedby={commentHint} className={cx(PX.input, "min-h-20 w-full")} value={draft} onChange={(e) => setDraft(e.target.value)} />
            <div className="flex items-center justify-between gap-3">
              <p id={commentHint} className={PX.meta}>
                Everyone with the wallet link sees it.{left ? ` ${left}` : ""}
              </p>
              <PixelButton variant="secondary" aria-disabled={blocked || undefined} onClick={() => void post()}>
                {writing ? "Saving..." : "Post"}
              </PixelButton>
            </div>
          </section>
        )}

        <div aria-live="polite" className="flex flex-col empty:hidden">
          {notice &&
            (notice.error ? (
              <PixelBox as="p" tone="alertText" className="p-4 text-sm">
                {notice.text}
              </PixelBox>
            ) : (
              <p className="text-sm">{notice.text}</p>
            ))}
        </div>

        <div className="flex flex-col gap-2 border-t-3 border-frame pt-3">
          {splits && !editable && <p className={PX.meta}>{MULTI_PAYER_LINE}</p>}
          <div className="flex flex-wrap gap-2">
            {editable && (
              <PixelButton variant="secondary" aria-disabled={busy || !online || undefined} onClick={edit}>
                Edit
              </PixelButton>
            )}
            <PixelButton variant="secondary" aria-disabled={busy || !online || undefined} onClick={() => void remove()}>
              {deleting ? "Deleting..." : "Delete expense"}
            </PixelButton>
          </div>
        </div>
      </DialogBox>
    </dialog>
  );
}
