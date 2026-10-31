"use client";

import { useEffect, useState } from "react";
import { PX, PixelBox, PixelButton, PixelChoice, PixelLink, SectionTitle, cx } from "@/components/pixel";
import PayoutQr, { loadMyQr } from "@/components/PayoutQr";
import { PhotoViewer } from "@/components/PhotoViewer";
import { runShare, shareDeps, type ShareOutcome } from "@/lib/itinerary";
import {
  failureMessage,
  formatPeso,
  leftToAssign,
  netLine,
  parsePeso,
  rememberWallet,
  splitEqual,
  walletApi,
  whenLine,
  whoAmI,
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
  const [newName, setNewName] = useState("");
  const [shareNote, setShareNote] = useState("");
  const [qr, setQr] = useState<{ blob: Blob; label: string } | null>(null);

  useEffect(() => {
    let live = true;
    walletApi.get(slug).then((r) => {
      if (!live) return;
      console.info("[tg-wallet] load ok=%s", r.ok ? "yes" : r.why);
      if (r.ok) {
        rememberWallet({ slug, name: r.wallet.name });
        setLoad({ state: "ready", wallet: r.wallet });
      } else {
        // Offline with a copy on screen: keep showing it; the offline banner says so
        setLoad((prev) => (prev.state === "ready" && r.why === "offline" ? prev : { state: "error", why: r.why }));
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

  function chooseMe(id: string | null) {
    rememberWallet({ slug, name: wallet.name, me: id });
    setMeChoice(id);
    console.info("[tg-wallet] me chosen=%s", id !== null);
  }

  async function write(action: string, op: () => Promise<WalletResult>, done: string): Promise<WalletResult> {
    setBusy(true);
    setNotice(null);
    const r = await op();
    setBusy(false);
    console.info("[tg-wallet] %s ok=%s", action, r.ok ? "yes" : r.why);
    if (!r.ok) {
      setNotice({ text: failureMessage(r), error: true });
      return r;
    }
    setLoad({ state: "ready", wallet: r.wallet });
    setNotice({ text: done, error: false });
    void walletApi.get(slug); // the service worker saves GETs, not this write: refresh the offline copy
    return r;
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
            <SectionTitle id="settle-title">Settle up</SectionTitle>
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
                      <p className={PX.meta}>Ask {nameOf(t.to_member)} to show their QR, then pay it in your GCash, Maya or bank app.</p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {t.to_member === me && (
                        <PixelButton variant="accent" onClick={showMyQr}>
                          Show my QR
                        </PixelButton>
                      )}
                      <PixelButton
                        variant="secondary"
                        disabled={busy}
                        onClick={() => {
                          if (!window.confirm(`Mark ${nameOf(t.from_member)} → ${nameOf(t.to_member)} ${formatPeso(t.amount_centavos)} as paid?`)) return;
                          void write("settle", () => walletApi.settle(slug, t), "Marked as paid.");
                        }}
                      >
                        Mark paid
                      </PixelButton>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {owedToMe > 0 && <p className={PX.meta}>Your QR opens from this phone only; it isn&apos;t shared with the group.</p>}
          </PixelBox>
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

          {wallet.settlements.length > 0 && (
            <section aria-labelledby="paid-title" className="flex flex-col gap-2">
              <SectionTitle id="paid-title">Payments made</SectionTitle>
              <ul className="flex flex-col gap-2">
                {wallet.settlements.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span>
                      {nameOf(s.from_member)} paid {nameOf(s.to_member)} <span className="tabular-nums font-semibold">{formatPeso(s.amount_centavos)}</span>
                    </span>
                    <PixelButton
                      variant="secondary"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm("Undo this payment? It goes back on the settle-up list.")) return;
                        void write("settle undo", () => walletApi.undoSettlement(slug, s.id), "Payment undone.");
                      }}
                    >
                      Undo
                    </PixelButton>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <PayoutQr />
        </div>
      </div>

      <PhotoViewer photo={qr} onClose={() => setQr(null)} logTag="tg-wallet" />
    </div>
  );
}
