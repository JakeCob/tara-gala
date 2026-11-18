"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { PX, PixelBox, PixelButton, PixelLink, SectionTitle, cx } from "@/components/pixel";
import PayoutQr, { loadMyQr } from "@/components/PayoutQr";
import { PhotoViewer } from "@/components/PhotoViewer";
import ProofDialog, { type ProofTarget } from "@/components/ProofDialog";
import ActivityList from "@/components/wallet/ActivityList";
import CategoryBox from "@/components/wallet/CategoryBox";
import ExpenseDetails from "@/components/wallet/ExpenseDetails";
import ExpenseForm, { type ExpenseSubmit, type SubmitContext } from "@/components/wallet/ExpenseForm";
import { flags } from "@/lib/flags";
import { cardMeta, payersWords } from "@/lib/walletActivity";
import { categoryLabel, showingLine } from "@/lib/walletCategories";
import { addOutcome, addedBy, editOutcome, screenParts, visibleExpenses } from "@/lib/walletView";
import { type TripFile, fetchFile, knownTrips, tripApi } from "@/lib/trip";
import { runShare, shareDeps, type ShareOutcome } from "@/lib/itinerary";
import {
  afterGet,
  afterWrite,
  failureMessage,
  fetchProof,
  formatPeso,
  netLine,
  proofControls,
  proofState,
  rememberWallet,
  walletApi,
  whenLine,
  whoAmI,
  type Expense,
  type ExpensePatch,
  type Settlement,
  type Transfer,
  type Wallet,
  type WalletFailed,
  type WalletLoad,
  type WalletResult,
} from "@/lib/wallet";

type Notice = { text: string; error: boolean };
/** The form's own alert (ux §6, §9): a 409, a refused split or edit. `asAmounts`: ux §9's Save as Amounts under it. */
type FormAlert = { text: string; asAmounts: boolean };
type Editing = { expense: Expense; addedBy: string | null };

const parts = screenParts(flags);
// navigator.onLine, kept live: Details' Edit, Delete and Post need signal (ux §5)
const subscribeOnline = (on: () => void) => {
  window.addEventListener("online", on);
  window.addEventListener("offline", on);
  return () => {
    window.removeEventListener("online", on);
    window.removeEventListener("offline", on);
  };
};

const SHARED: Record<ShareOutcome, string> = {
  done: "",
  silent: "",
  copied: "Link copied. Send it to everyone on the trip.",
  manual: "Your phone didn't let us copy it. Copy the address from the browser bar instead.",
};

/** The one live region for results and errors. empty:-mt-* cancels its gap until it has something to say. */
function NoticeArea({ notice, className }: { notice: Notice | null; className: string }) {
  return (
    <div aria-live="polite" className={className}>
      {notice &&
        (notice.error ? (
          <PixelBox as="p" tone="alertText" className="p-4 text-sm">
            {notice.text}
          </PixelBox>
        ) : (
          <p className="text-sm">{notice.text}</p>
        ))}
    </div>
  );
}

/**
 * TG-50: one shared trip wallet, opened by its secret link. Anyone with the link reads and writes; this phone
 * remembers which person it is. The API recomputes balances and the settle-up on every write.
 */
export default function WalletView({ slug }: { slug: string }) {
  const [load, setLoad] = useState<WalletLoad>({ state: "loading" });
  const [reloads, setReloads] = useState(0);
  const [meChoice, setMeChoice] = useState<string | null | undefined>(undefined); // undefined: what this phone remembers
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [settleNotice, setSettleNotice] = useState<Notice | null>(null); // TG-53: in view of the Settle up box
  const [proof, setProof] = useState<ProofTarget | null>(null);
  const proofOpen = useRef(false); // a failed reload mustn't take an open dialog (a proof's, or TG-66's Details) with the page
  // TG-66 W3: the form (W1's), Details (W2's) and the Categories filter
  const [editing, setEditing] = useState<Editing | null>(null);
  const [formKey, setFormKey] = useState(0); // a new key remounts the form: back to Add, or on a newer version after a 409
  const [formAlert, setFormAlert] = useState<FormAlert | null>(null);
  const lastSubmit = useRef<SubmitContext | null>(null); // the form's last submit: its asAmounts is ux §9's Save as Amounts
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null); // what opened Details: focus goes back there (tg-ux2 W2 S1)
  const [uncategorizedOnly, setUncategorizedOnly] = useState(false);
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const shownAt = useRef(0); // TG-65: how new the wallet on screen is: when its GET left, or when a write landed
  const [opening, setOpening] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [shareNote, setShareNote] = useState("");
  const [qr, setQr] = useState<{ blob: Blob; label: string } | null>(null);
  // TG-52 PR 2: the payout QRs shared on the trip that holds this wallet (if this phone knows that trip)
  const [tripQrs, setTripQrs] = useState<{ trip: string; files: TripFile[] } | null>(null);

  useEffect(() => {
    let live = true;
    const left = Date.now();
    walletApi.get(slug).then((r) => {
      if (!live) return;
      const overtaken = left < shownAt.current; // a write landed after this GET left: its answer is the wallet before it
      console.info("[tg-wallet] load ok=%s", r.ok ? (overtaken ? "overtaken" : r.saved ? "saved" : "yes") : r.why);
      if (r.ok && !overtaken) {
        if (!r.saved) shownAt.current = left;
        rememberWallet({ slug, name: r.wallet.name });
      }
      setLoad((prev) => afterGet(prev, r, slug, overtaken, proofOpen.current));
    });
    return () => {
      live = false;
    };
  }, [slug, reloads]);

  // Others add expenses from their phones: fetch again whenever this one comes back to the app
  useEffect(() => {
    const onVisible = () => document.visibilityState === "visible" && setReloads((n) => n + 1);
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  useEffect(() => {
    const trip = knownTrips().find((t) => t.wallet_slug === slug);
    if (!trip) return;
    let live = true;
    tripApi.get(trip.slug).then((r) => {
      if (!live || !r.ok || r.trip.wallet?.share_slug !== slug) return;
      setTripQrs({ trip: trip.slug, files: r.trip.files.filter((f) => f.kind === "payout_qr") });
      console.info("[tg-wallet] trip qrs count=%d", r.trip.files.filter((f) => f.kind === "payout_qr").length);
    });
    return () => {
      live = false;
    };
  }, [slug, reloads]);

  if (load.state === "loading") return <p className="text-sm text-muted">Opening the wallet...</p>;
  if (load.state === "error") {
    return (
      <PixelBox as="p" tone="alertText" className="p-4 text-sm">
        {load.why === "offline" ? "No signal, and this wallet isn't saved on this phone yet. Open it once with signal." : failureMessage({ why: load.why })}
      </PixelBox>
    );
  }

  const wallet = load.wallet;
  const remembered = meChoice !== undefined ? meChoice : whoAmI(slug);
  const me = wallet.members.some((m) => m.id === remembered) ? remembered : null;
  const nameOf = (id: string) => wallet.members.find((m) => m.id === id)?.name ?? "Someone";
  const sharedQr = (memberId: string) => tripQrs?.files.find((f) => f.member_id === memberId);
  const by = me; // who's writing, as ?by= on settle, undo, delete and proofs, whatever the flags (plan §2 addendum); never in a body
  const paymentLine = (s: Transfer) => `${nameOf(s.from_member)} paid ${nameOf(s.to_member)} ${formatPeso(s.amount_centavos)}`;

  async function showTheirQr(memberId: string) {
    const file = sharedQr(memberId);
    const blob = file && tripQrs ? await fetchFile(tripQrs.trip, file.id) : null;
    console.info("[tg-wallet] show shared qr ok=%s", blob ? "yes" : "no");
    if (blob) setQr({ blob, label: `${nameOf(memberId)}'s QR` });
    else setNotice({ text: "Couldn't open that QR. Open the trip once with signal to keep it on this phone.", error: true });
  }

  function chooseMe(id: string | null) {
    rememberWallet({ slug, name: wallet.name, me: id });
    setMeChoice(id);
    console.info("[tg-wallet] me chosen=%s", id !== null);
  }

  async function write(action: string, op: () => Promise<WalletResult>, done: string, say: (n: Notice) => void = setNotice): Promise<WalletResult> {
    setBusy(true);
    setNotice(null);
    setSettleNotice(null);
    const r = await op();
    setBusy(false);
    console.info("[tg-wallet] %s ok=%s", action, r.ok ? "yes" : r.why);
    if (!r.ok) {
      say({ text: failureMessage(r), error: true });
      return r;
    }
    landWallet(r.wallet);
    say({ text: done, error: false });
    return r;
  }

  /**
   * Every wallet a write brings back (TG-66 B27): marked newest before its state, so no GET answer can slip between,
   * then the rev rule, so an older write answer never replaces a newer screen. The worker saves GETs, not writes:
   * refresh the offline copy.
   */
  function landWallet(next: Wallet) {
    // Only ever called from event handlers and write callbacks, never while rendering; the compiler can't see that
    // through proofSaved and the children's onWallet, so it flags the clock
    // eslint-disable-next-line react-hooks/purity
    shownAt.current = Date.now();
    setLoad((prev) => afterWrite(prev, next));
    void walletApi.get(slug);
  }

  function openProof(target: ProofTarget) {
    proofOpen.current = true;
    setNotice(null);
    setSettleNotice(null);
    setProof(target);
  }

  function proofSaved(next: Wallet, text?: string) {
    landWallet(next);
    if (text) setSettleNotice({ text, error: false });
  }

  /** Settle up's results sit under its heading, which may be far from the button that asked. Call it after the frame. */
  function toSettleUp() {
    const heading = document.getElementById("settle-title");
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView({ block: "center" }); // clear of the tab bar and the offline banner, with the notice under it
  }

  function proofClosed(saved: boolean) {
    proofOpen.current = false;
    setProof(null);
    // After the frame: close() hands focus back to the opening button first, and that button may have gone
    requestAnimationFrame(() => {
      if (saved || document.activeElement === document.body) toSettleUp();
    });
  }

  async function showProof(s: Settlement, label: string) {
    if (opening) return;
    setSettleNotice(null);
    setOpening(s.id);
    const blob = await fetchProof(slug, s.id);
    setOpening(null);
    console.info("[tg-wallet] proof show ok=%s", blob ? "yes" : "no");
    if (blob) return setQr({ blob, label });
    setSettleNotice({ text: "Couldn't open that proof. Try again with signal.", error: true });
    requestAnimationFrame(toSettleUp);
  }

  // ---------------------------------------------------------------- TG-66 W3: add, edit, Details

  /** Back to the expense after an edit or a Cancel: its Details button, in view (ux §6). After the frame: it re-rendered. */
  function toExpense(id: string) {
    requestAnimationFrame(() => {
      const button = document.getElementById(`details-${id}`);
      button?.scrollIntoView({ block: "center" });
      button?.focus({ preventScroll: true });
    });
  }

  function closeForm(backTo: string | null) {
    setEditing(null);
    setFormAlert(null);
    setFormKey((k) => k + 1);
    if (backTo) toExpense(backTo);
  }

  /** W1's form hands over the body it built (by flag: today's byte for byte, or v2) and, for an edit, a PATCH. */
  async function submitExpense(body: ExpenseSubmit, ctx: SubmitContext): Promise<boolean> {
    lastSubmit.current = ctx;
    setFormAlert(null);
    if (ctx.edit) return editing ? saveEdit(editing, body as ExpensePatch) : false;
    setBusy(true);
    setNotice(null);
    setSettleNotice(null);
    const before = load.state === "ready" ? load.wallet : wallet;
    const r = await walletApi.addExpense(slug, body);
    setBusy(false);
    console.info("[tg-wallet] expense add ok=%s", r.ok ? "yes" : r.why);
    const out = addOutcome(before, body, r);
    if (!out.ok) {
      // Today's body keeps today's place for its refusal (the wallet's alert); a v2 one goes in the form (ux §9)
      if ("mode" in body) setFormAlert({ text: out.alert, asAmounts: out.asAmounts });
      else setNotice({ text: out.alert, error: true });
      return false;
    }
    landWallet(out.wallet);
    setNotice({ text: out.text, error: false });
    return true;
  }

  async function saveEdit(current: Editing, body: ExpensePatch): Promise<boolean> {
    setBusy(true);
    setNotice(null);
    setSettleNotice(null);
    const r = await walletApi.editExpense(slug, current.expense.id, body);
    let actor: string | null = null;
    if (!r.ok && r.detail === "expense_changed" && flags.walletActivity && online) {
      // Who changed it, for the alert's line: the expense's newest row
      const h = await walletApi.activity(slug, { expenseId: current.expense.id, limit: 1 });
      const row = h.ok ? h.rows[0] : undefined;
      if (row?.action === "expense_edit") actor = wallet.members.find((m) => m.id === row.actor)?.name ?? null;
    }
    setBusy(false);
    const out = editOutcome(r, body, current.expense, actor);
    console.info("[tg-wallet] expense edit ok=%s outcome=%s", r.ok ? "yes" : r.why, out.kind);
    if (out.kind === "saved") {
      landWallet(out.wallet);
      setNotice({ text: out.text, error: false });
      closeForm(current.expense.id);
      return true;
    }
    if (out.kind === "changed") {
      // Their version in the form, and what they changed in its alert: never a silent overwrite (B26)
      landWallet(out.wallet);
      setEditing({ expense: out.expense, addedBy: current.addedBy });
      setFormKey((k) => k + 1);
      setFormAlert({ text: out.alert, asAmounts: false });
      return false;
    }
    if (out.kind === "gone") {
      if (out.wallet) landWallet(out.wallet);
      closeForm(null);
      setNotice({ text: out.alert, error: true });
      return false;
    }
    setFormAlert({ text: out.alert, asAmounts: out.asAmounts }); // the form stays open with what was typed
    return false;
  }

  /** Details' Edit: the form at the top switches to this expense, scrolls into view and takes focus (ux §6). */
  function startEdit(expense: Expense) {
    opener.current = null; // focus goes to the form's title, not back into the list
    setEditing({ expense, addedBy: null });
    setFormAlert(null);
    setFormKey((k) => k + 1);
    requestAnimationFrame(() => document.getElementById("add-title")?.scrollIntoView({ block: "start" }));
    if (!flags.walletActivity || !online) return;
    void walletApi.activity(slug, { expenseId: expense.id, limit: 50 }).then((h) => {
      if (!h.ok) return;
      const who = addedBy(h.rows, wallet);
      setEditing((e) => (e && e.expense.id === expense.id ? { ...e, addedBy: who } : e));
    });
  }

  /** The Categories nudge's link (ux §7): the list shows only the expenses with no category, with a Show all line above. */
  function showUncategorized() {
    setUncategorizedOnly(true);
    requestAnimationFrame(() => document.getElementById("expenses-title")?.scrollIntoView({ block: "start" }));
  }

  function openDetails(id: string, from: HTMLElement | null) {
    opener.current = from;
    proofOpen.current = true;
    setNotice(null);
    setDetailsId(id);
  }

  /** Details' Delete, already confirmed there. With the version shown, so a stale one is refused (B13). */
  async function deleteFromDetails(e: Expense): Promise<true | WalletFailed> {
    setBusy(true);
    const r = await walletApi.deleteExpense(slug, e.id, e.version, by);
    setBusy(false);
    console.info("[tg-wallet] expense delete ok=%s", r.ok ? "yes" : r.why);
    if (!r.ok) {
      if (r.wallet) landWallet(r.wallet); // expense_changed or expense_gone: the wallet as it is now
      return r;
    }
    landWallet(r.wallet);
    setNotice({ text: "Expense deleted.", error: false });
    if (editing?.expense.id === e.id) closeForm(null);
    return true;
  }

  async function addMe(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return setNotice({ text: "Type your name first.", error: true });
    const r = await write("member add", () => walletApi.addMember(slug, name), "Added you to the wallet.");
    if (r.ok) chooseMe(r.wallet.members.find((m) => m.name.toLowerCase() === name.toLowerCase())?.id ?? null);
  }

  async function share() {
    const url = `${location.origin}/w/${slug}`;
    const outcome = await runShare(shareDeps(navigator), { title: "Tara Gala trip wallet", text: `Log what you paid on "${wallet.name}".`, url });
    console.info("[tg-wallet] share outcome=%s", outcome);
    setShareNote(SHARED[outcome]);
  }

  async function showMyQr() {
    const mine = await loadMyQr();
    if (!mine) return setNotice({ text: "Add your payout QR below first, then show it here.", error: true });
    setQr({ blob: mine.blob, label: "My payout QR" });
  }

  if (me === null) {
    return (
      <div className="flex flex-col gap-4 md:max-w-xl">
        <p className="text-lg font-bold break-words">{wallet.name}</p>
        <PixelBox as="section" aria-labelledby="who-title" className="flex flex-col gap-3 p-4">
          <SectionTitle id="who-title">Which one are you?</SectionTitle>
          <p className="text-sm text-muted">This phone remembers, so your expenses default to you.</p>
          <ul className="grid grid-cols-2 gap-2">
            {wallet.members.map((m) => (
              <li key={m.id} className="grid">
                <PixelButton variant="secondary" className="justify-center px-3 text-sm" onClick={() => chooseMe(m.id)}>
                  {m.name}
                </PixelButton>
              </li>
            ))}
          </ul>
          <form onSubmit={addMe} className="flex items-end gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
              <span className="font-semibold">Not on the list? Add your name</span>
              <input className={cx(PX.input, "w-full")} maxLength={30} value={newName} onChange={(e) => setNewName(e.target.value)} />
            </label>
            <PixelButton type="submit" variant="secondary" disabled={busy}>
              Add me
            </PixelButton>
          </form>
        </PixelBox>
        <NoticeArea notice={notice} className="flex flex-col empty:-mt-4" />
      </div>
    );
  }

  const owedToMe = wallet.transfers.filter((t) => t.to_member === me).length;
  const detailsExpense = detailsId ? (wallet.expenses.find((e) => e.id === detailsId) ?? null) : null;
  const filtering = parts.categories && uncategorizedOnly;
  const listed = visibleExpenses(wallet.expenses, filtering);
  const formNotice: ReactNode = (
    <div aria-live="polite" className="flex flex-col gap-2 empty:hidden">
      {formAlert && (
        <PixelBox as="p" tone="alertText" className="p-4 text-sm">
          {formAlert.text}
        </PixelBox>
      )}
      {formAlert?.asAmounts && (
        <PixelButton variant="secondary" className="inline-flex items-center self-start px-4 text-sm" aria-disabled={busy || undefined} onClick={() => !busy && void lastSubmit.current?.asAmounts()}>
          Save as Amounts
        </PixelButton>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <p className="text-lg font-bold break-words">{wallet.name}</p>
        <p className="text-sm">
          <span className="tabular-nums font-bold">{formatPeso(wallet.total_centavos)}</span> spent so far · {wallet.members.length} people · you&apos;re{" "}
          <span className="font-semibold">{nameOf(me)}</span>{" "}
          <button type="button" className={cx(PX.inlineLink, "min-h-11")} onClick={() => chooseMe(null)}>
            Not you?
          </button>
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <PixelButton variant="secondary" onClick={share}>
            Share wallet link
          </PixelButton>
          <PixelButton variant="secondary" onClick={() => setReloads((n) => n + 1)}>
            Refresh
          </PixelButton>
          <PixelLink variant="secondary" href="/wallet" className="inline-flex items-center px-4 text-sm">
            All wallets
          </PixelLink>
        </div>
        <p role="status" className="text-sm empty:hidden">
          {shareNote}
        </p>
      </div>

      <NoticeArea notice={notice} className="flex flex-col empty:-mt-5" />

      <div className="flex flex-col gap-5 md:grid md:grid-cols-2 md:gap-6 md:items-start">
        <div className="flex flex-col gap-5">
          <ExpenseForm
            key={formKey}
            wallet={wallet}
            me={me}
            busy={busy}
            flags={flags}
            editing={editing}
            notice={flags.walletSplits || flags.walletMultiPayer ? formNotice : undefined} // flags off: today's form, element for element (B28)
            onSubmit={submitExpense}
            onCancel={() => closeForm(editing?.expense.id ?? null)}
            onError={(text) => setNotice({ text, error: true })}
          />

          <PixelBox as="section" aria-labelledby="settle-title" className="flex flex-col gap-3 p-4">
            <SectionTitle id="settle-title" tabIndex={-1} className="focus-pixel">Settle up</SectionTitle>
            <NoticeArea notice={settleNotice} className="flex flex-col empty:-mt-3" />
            {wallet.transfers.length === 0 ? (
              <p className="text-sm text-muted">
                {wallet.expenses.length === 0 ? "Add expenses, and this works out who pays whom." : "All square. Nobody owes anything."}
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {wallet.transfers.map((t) => (
                  <li key={`${t.from_member}-${t.to_member}`} className="flex flex-col gap-2 border-b-2 border-border pb-3 last:border-b-0 last:pb-0">
                    <p className="text-sm">
                      <span className="font-semibold">{nameOf(t.from_member)}</span> pays <span className="font-semibold">{nameOf(t.to_member)}</span>{" "}
                      <span className="tabular-nums font-bold">{formatPeso(t.amount_centavos)}</span>
                    </p>
                    {t.from_member === me && (
                      <p className={PX.meta}>
                        {sharedQr(t.to_member)
                          ? `Open ${nameOf(t.to_member)}'s QR, then scan it in your GCash, Maya or bank app. Screenshot the receipt for proof.`
                          : `Ask ${nameOf(t.to_member)} to show their QR, then pay it in your GCash, Maya or bank app. Screenshot the receipt for proof.`}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {t.from_member === me && sharedQr(t.to_member) && (
                        <PixelButton variant="accent" onClick={() => showTheirQr(t.to_member)}>
                          Show {nameOf(t.to_member)}&apos;s QR
                        </PixelButton>
                      )}
                      {t.to_member === me && (
                        <PixelButton variant="accent" onClick={showMyQr}>
                          Show my QR
                        </PixelButton>
                      )}
                      <PixelButton variant="secondary" disabled={busy} onClick={() => openProof({ mode: "mark", transfer: t, settlementId: null })}>
                        Mark paid
                      </PixelButton>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {owedToMe > 0 && <p className={PX.meta}>Your QR opens from this phone only; it isn&apos;t shared with the group.</p>}
          </PixelBox>

          {wallet.settlements.length > 0 && (
            <PixelBox as="section" aria-labelledby="paid-title" className="flex flex-col gap-3 p-4">
              <SectionTitle id="paid-title">Payments made</SectionTitle>
              <ul className="flex flex-col gap-3">
                {wallet.settlements.map((s) => {
                  const line = paymentLine(s);
                  const can = proofControls(s, me);
                  return (
                    <li key={s.id} className="flex flex-col gap-2 border-b-2 border-border pb-3 last:border-b-0 last:pb-0">
                      <p className="min-w-0 text-sm break-words">
                        {nameOf(s.from_member)} paid {nameOf(s.to_member)} <span className="tabular-nums font-semibold">{formatPeso(s.amount_centavos)}</span>
                      </p>
                      {proofState(s) === "deleted" && <p className={PX.meta}>Proof deleted.</p>}
                      <div className="flex flex-wrap gap-2">
                        {can.show && (
                          <PixelButton variant="secondary" aria-label={`Show proof for ${line}`} aria-disabled={opening === s.id || undefined} onClick={() => showProof(s, line)}>
                            {opening === s.id ? "Opening..." : "Show proof"}
                          </PixelButton>
                        )}
                        {can.add && (
                          <PixelButton variant="secondary" aria-label={`Add proof for ${line}`} disabled={busy} onClick={() => openProof({ mode: "add", transfer: s, settlementId: s.id })}>
                            Add proof
                          </PixelButton>
                        )}
                        {can.change && (
                          <PixelButton variant="secondary" aria-label={`Change proof for ${line}`} disabled={busy} onClick={() => openProof({ mode: "change", transfer: s, settlementId: s.id })}>
                            Change proof
                          </PixelButton>
                        )}
                        <PixelButton
                          variant="secondary"
                          aria-label={`Undo ${line}`}
                          disabled={busy}
                          onClick={() => {
                            const ask = s.has_proof
                              ? "Undo this payment? It goes back on the settle-up list, and its proof is deleted for everyone."
                              : "Undo this payment? It goes back on the settle-up list.";
                            if (!window.confirm(ask)) return;
                            void write("settle undo", () => walletApi.undoSettlement(slug, s.id, by), "Payment undone.", setSettleNotice).then(() => requestAnimationFrame(toSettleUp));
                          }}
                        >
                          Undo
                        </PixelButton>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </PixelBox>
          )}
        </div>

        <div className="flex flex-col gap-5">
          <PixelBox as="section" aria-labelledby="balance-title" className="flex flex-col gap-2 p-4">
            <SectionTitle id="balance-title">Balances</SectionTitle>
            <ul className="flex flex-col gap-2">
              {wallet.balances.map((b) => (
                <li key={b.member_id} className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                  <span className="min-w-0 break-words font-semibold">
                    {nameOf(b.member_id)}
                    {b.member_id === me ? " (you)" : ""}
                  </span>
                  <span className="tabular-nums">{netLine(b.net_centavos)}</span>
                  <span className={cx(PX.meta, "w-full tabular-nums")}>
                    paid {formatPeso(b.paid_centavos)} · share {formatPeso(b.share_centavos)}
                  </span>
                </li>
              ))}
            </ul>
          </PixelBox>

          {parts.categories && <CategoryBox wallet={wallet} me={me} onShowUncategorized={showUncategorized} />}

          <section aria-labelledby="expenses-title" className="flex flex-col gap-3">
            <SectionTitle id="expenses-title">Expenses</SectionTitle>
            {filtering && (
              <p className="text-sm">
                {showingLine(listed.length).text}{" "}
                <button type="button" className={cx(PX.inlineLink, "min-h-11")} onClick={() => setUncategorizedOnly(false)}>
                  {showingLine(listed.length).link}
                </button>
              </p>
            )}
            {wallet.expenses.length === 0 ? (
              <p className="text-sm text-muted">Nothing yet.</p>
            ) : parts.compactCards ? (
              <ul className="flex flex-col gap-3">
                {listed.map((e) => (
                  <PixelBox as="li" key={e.id} className="flex flex-col gap-1 p-4">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className={cx(PX.dataHeading, "min-w-0 break-words")}>{e.note}</p>
                      <p className="tabular-nums font-bold">{formatPeso(e.amount_centavos)}</p>
                    </div>
                    {parts.categories &&
                      (e.category ? (
                        <p>
                          <span className={PX.chip}>{categoryLabel(e.category)}</span>
                        </p>
                      ) : (
                        <p className={PX.meta}>No category yet</p>
                      ))}
                    <p className={PX.meta}>
                      Paid by {payersWords(e, wallet)} · {whenLine(e.created_at)}
                    </p>
                    <p className={cx(PX.meta, "break-words")}>{cardMeta(e, wallet)}</p>
                    <PixelButton
                      id={`details-${e.id}`}
                      variant="secondary"
                      className="mt-1 inline-flex items-center self-start px-4 text-sm"
                      aria-label={`Details of ${e.note}`}
                      onClick={(ev) => openDetails(e.id, ev.currentTarget)}
                    >
                      Details
                    </PixelButton>
                  </PixelBox>
                ))}
              </ul>
            ) : (
              <ul className="flex flex-col gap-3">
                {wallet.expenses.map((e) => (
                  <PixelBox as="li" key={e.id} className="flex flex-col gap-1 p-4">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className={cx(PX.dataHeading, "min-w-0 break-words")}>{e.note}</p>
                      <p className="tabular-nums font-bold">{formatPeso(e.amount_centavos)}</p>
                    </div>
                    <p className={PX.meta}>
                      Paid by {nameOf(e.paid_by)} · {whenLine(e.created_at)}
                    </p>
                    <p className={cx(PX.meta, "break-words")}>
                      {e.shares.map((s) => `${nameOf(s.member_id)} ${formatPeso(s.share_centavos)}`).join(" · ")}
                    </p>
                    <PixelButton
                      variant="secondary"
                      className="mt-1 inline-flex items-center self-start px-4 text-sm"
                      aria-label={`Delete ${e.note}`}
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm(`Delete "${e.note}" (${formatPeso(e.amount_centavos)}) for everyone?`)) return;
                        void write("expense delete", () => walletApi.deleteExpense(slug, e.id, undefined, by), "Expense deleted.").then(() =>
                          document.getElementById("expense-amount")?.focus(),
                        );
                      }}
                    >
                      Delete
                    </PixelButton>
                  </PixelBox>
                ))}
              </ul>
            )}
          </section>

          <PayoutQr />

          {parts.activity && <ActivityList slug={slug} wallet={wallet} online={online} onOpenExpense={(id) => openDetails(id, document.activeElement as HTMLElement | null)} />}
        </div>
      </div>

      {detailsExpense && (
        <ExpenseDetails
          key={detailsExpense.id}
          slug={slug}
          wallet={wallet}
          expense={detailsExpense}
          me={me}
          online={online}
          activity={flags.walletActivity}
          splits={flags.walletSplits}
          multiPayer={flags.walletMultiPayer}
          busy={busy}
          onWallet={landWallet}
          onEdit={startEdit}
          onDelete={deleteFromDetails}
          onClosed={() => {
            const id = detailsExpense.id;
            const back = opener.current;
            proofOpen.current = false;
            setDetailsId(null);
            if (!back) return; // Edit: the form's title has focus
            // After the frame: the opener may have re-rendered (an activity line) or gone (a deleted expense)
            requestAnimationFrame(() => (back.isConnected ? back : (document.getElementById(`details-${id}`) ?? document.getElementById("expense-amount")))?.focus());
          }}
        />
      )}
      {proof && (
        <ProofDialog slug={slug} wallet={wallet} target={proof} nameOf={nameOf} by={me} onWallet={proofSaved} onClosed={proofClosed} />
      )}
      <PhotoViewer photo={qr} onClose={() => setQr(null)} logTag="tg-wallet" />
    </div>
  );
}
