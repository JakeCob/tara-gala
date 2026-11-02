"use client";

import { useEffect, useRef, useState } from "react";
import { PX, PixelBox, PixelButton, PixelChoice, PixelLink, SectionTitle, cx } from "@/components/pixel";
import PayoutQr, { loadMyQr } from "@/components/PayoutQr";
import { PhotoViewer } from "@/components/PhotoViewer";
import ProofDialog, { type ProofTarget } from "@/components/ProofDialog";
import { type TripFile, fetchFile, knownTrips, tripApi } from "@/lib/trip";
import { runShare, shareDeps, type ShareOutcome } from "@/lib/itinerary";
import {
  failureMessage,
  fetchProof,
  formatPeso,
  leftToAssign,
  netLine,
  parsePeso,
  proofControls,
  proofState,
  rememberWallet,
  splitEqual,
  walletApi,
  whenLine,
  whoAmI,
  type Settlement,
  type Transfer,
  type Wallet,
  type WalletFailure,
  type WalletResult,
} from "@/lib/wallet";

type Load = { state: "loading" } | { state: "ready"; wallet: Wallet } | { state: "error"; why: WalletFailure };
type Notice = { text: string; error: boolean };
type ExpenseBody = Parameters<typeof walletApi.addExpense>[1];

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

/** The add-an-expense form. Equal by default among everyone; custom amounts per person on request. */
function ExpenseForm({ wallet, me, busy, onAdd, onError }: {
  wallet: Wallet;
  me: string;
  busy: boolean;
  onAdd: (body: ExpenseBody) => Promise<boolean>;
  onError: (text: string) => void;
}) {
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [paidBy, setPaidBy] = useState(me);
  const [mode, setMode] = useState<"equal" | "custom">("equal");
  const [left, setLeft] = useState<Set<string>>(new Set()); // people left out of an equal split; newcomers are in
  const [custom, setCustom] = useState<Record<string, string>>({});
  const members = wallet.members;
  const payer = members.some((m) => m.id === paidBy) ? paidBy : me;
  const total = parsePeso(amount);
  const among = members.filter((m) => !left.has(m.id)).map((m) => m.id);
  const preview = total ? splitEqual(total, among, payer) : {};
  const parts = members.map((m) => (custom[m.id]?.trim() ? parsePeso(custom[m.id], { allowZero: true }) : 0));
  const remaining = total && parts.every((p) => p !== null) ? leftToAssign(total, parts as number[]) : null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (total === null) return onError("Enter an amount, like 450 or 1,151.50.");
    if (!note.trim()) return onError("Say what it was for, like Taxi to Burnham Park.");
    let body: ExpenseBody;
    if (mode === "equal") {
      if (among.length === 0) return onError("Pick at least one person to split it with.");
      body = { paid_by: payer, amount_centavos: total, note: note.trim(), split_among: among };
    } else {
      if (parts.some((p) => p === null)) return onError("Check the amounts: pesos, like 300 or 150.50.");
      if (remaining !== 0) return onError(`The amounts need to add up to ${formatPeso(total)}. ${remaining! > 0 ? `${formatPeso(remaining!)} is left.` : `They're ${formatPeso(-remaining!)} over.`}`);
      body = {
        paid_by: payer,
        amount_centavos: total,
        note: note.trim(),
        shares: members.map((m, i) => ({ member_id: m.id, share_centavos: parts[i] as number })).filter((s) => s.share_centavos > 0),
      };
    }
    if (await onAdd(body)) {
      setAmount("");
      setNote("");
      setCustom({});
    }
  }

  return (
    <PixelBox as="form" onSubmit={onSubmit} noValidate aria-labelledby="add-title" className="flex flex-col gap-3 p-4">
      <SectionTitle id="add-title">Add an expense</SectionTitle>
      <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-semibold">Amount</span>
          <span className="flex">
            <span aria-hidden="true" className={PX.inputPrefix}>₱</span>
            <input id="expense-amount" className={cx(PX.input, "w-full min-w-0")} inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </span>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-semibold">What for</span>
          <input className={cx(PX.input, "w-full min-w-0")} maxLength={60} placeholder="Taxi, dinner, entrance" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-semibold">Paid by</span>
        <select className={PX.input} value={payer} onChange={(e) => setPaidBy(e.target.value)}>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id === me ? `${m.name} (you)` : m.name}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-semibold">Split</legend>
        <div className="grid grid-cols-2 gap-2">
          <PixelChoice name="split-mode" value="equal" checked={mode === "equal"} onChange={() => setMode("equal")}>
            Equally
          </PixelChoice>
          <PixelChoice name="split-mode" value="custom" checked={mode === "custom"} onChange={() => setMode("custom")}>
            Custom amounts
          </PixelChoice>
        </div>
        <ul className="flex flex-col gap-2">
          {members.map((m, i) => (
            <li key={m.id} className="flex min-h-11 items-center justify-between gap-3 text-sm">
              {mode === "equal" ? (
                <>
                  <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      className="h-5 w-5 shrink-0 accent-[var(--primary)]"
                      checked={!left.has(m.id)}
                      onChange={(e) => setLeft((s) => {
                        const next = new Set(s);
                        if (e.target.checked) next.delete(m.id);
                        else next.add(m.id);
                        return next;
                      })}
                    />
                    <span className="min-w-0 break-words">{m.name}</span>
                  </label>
                  <span className="tabular-nums text-muted">{preview[m.id] !== undefined ? formatPeso(preview[m.id]) : ""}</span>
                </>
              ) : (
                <label className="flex min-w-0 flex-1 items-center justify-between gap-3">
                  <span className="min-w-0 break-words">{m.name}</span>
                  <input
                    className={cx(PX.input, "w-28 text-right tabular-nums")}
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0"
                    aria-invalid={parts[i] === null || undefined}
                    value={custom[m.id] ?? ""}
                    onChange={(e) => setCustom((c) => ({ ...c, [m.id]: e.target.value }))}
                  />
                </label>
              )}
            </li>
          ))}
        </ul>
        {mode === "custom" && remaining !== null && (
          <p className="text-sm tabular-nums" aria-live="polite">
            {remaining === 0 ? "Adds up." : remaining > 0 ? `${formatPeso(remaining)} left to assign.` : `${formatPeso(-remaining)} too much.`}
          </p>
        )}
      </fieldset>
      <PixelButton type="submit" variant="primary" className="px-4 py-3" disabled={busy}>
        {busy ? "Saving..." : "Add expense"}
      </PixelButton>
    </PixelBox>
  );
}

/**
 * TG-50: one shared trip wallet, opened by its secret link. Anyone with the link reads and writes; this phone
 * remembers which person it is. The API recomputes balances and the settle-up on every write.
 */
export default function WalletView({ slug }: { slug: string }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [reloads, setReloads] = useState(0);
  const [meChoice, setMeChoice] = useState<string | null | undefined>(undefined); // undefined: what this phone remembers
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [settleNotice, setSettleNotice] = useState<Notice | null>(null); // TG-53: in view of the Settle up box
  const [proof, setProof] = useState<ProofTarget | null>(null);
  const proofOpen = useRef(false); // a failed reload mustn't take an open dialog and its picture with the page
  const [opening, setOpening] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [shareNote, setShareNote] = useState("");
  const [qr, setQr] = useState<{ blob: Blob; label: string } | null>(null);
  // TG-52 PR 2: the payout QRs shared on the trip that holds this wallet (if this phone knows that trip)
  const [tripQrs, setTripQrs] = useState<{ trip: string; files: TripFile[] } | null>(null);

  useEffect(() => {
    let live = true;
    walletApi.get(slug).then((r) => {
      if (!live) return;
      console.info("[tg-wallet] load ok=%s", r.ok ? (r.saved ? "saved" : "yes") : r.why);
      if (r.ok) {
        rememberWallet({ slug, name: r.wallet.name });
        // A saved copy can predate what's on screen: it would bring a paid debt back, and tell an open dialog it was undone
        setLoad((prev) => (prev.state === "ready" && prev.wallet.share_slug === slug && r.saved ? prev : { state: "ready", wallet: r.wallet }));
      } else {
        // Offline with a copy on screen: keep showing it; the offline banner says so
        setLoad((prev) => (prev.state === "ready" && (r.why === "offline" || proofOpen.current) ? prev : { state: "error", why: r.why }));
      }
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
    setLoad({ state: "ready", wallet: r.wallet });
    say({ text: done, error: false });
    void walletApi.get(slug); // the service worker saves GETs, not this write: refresh the offline copy
    return r;
  }

  function openProof(target: ProofTarget) {
    proofOpen.current = true;
    setNotice(null);
    setSettleNotice(null);
    setProof(target);
  }

  function proofSaved(next: Wallet, text?: string) {
    setLoad({ state: "ready", wallet: next });
    if (text) setSettleNotice({ text, error: false });
    void walletApi.get(slug);
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
            wallet={wallet}
            me={me}
            busy={busy}
            onError={(text) => setNotice({ text, error: true })}
            onAdd={async (body) => (await write("expense add", () => walletApi.addExpense(slug, body), "Expense added.")).ok}
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
                            void write("settle undo", () => walletApi.undoSettlement(slug, s.id), "Payment undone.", setSettleNotice).then(() => requestAnimationFrame(toSettleUp));
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

          <section aria-labelledby="expenses-title" className="flex flex-col gap-3">
            <SectionTitle id="expenses-title">Expenses</SectionTitle>
            {wallet.expenses.length === 0 ? (
              <p className="text-sm text-muted">Nothing yet.</p>
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
                        void write("expense delete", () => walletApi.deleteExpense(slug, e.id), "Expense deleted.").then(() =>
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
        </div>
      </div>

      {proof && <ProofDialog slug={slug} wallet={wallet} target={proof} nameOf={nameOf} onWallet={proofSaved} onClosed={proofClosed} />}
      <PhotoViewer photo={qr} onClose={() => setQr(null)} logTag="tg-wallet" />
    </div>
  );
}
