"use client";

// TG-53: the dialog behind Mark paid, Add proof and Change proof. A native dialog like WorldSheet's, but a backdrop tap
// does nothing, because it would lose a chosen picture. The picture stays in memory until the save, and WalletView
// mounts this once per opening, so one payment's receipt can't carry over to another.
import { useEffect, useId, useRef, useState } from "react";
import { DialogBox, PX, PixelBox, PixelButton } from "@/components/pixel";
import { BlobImage } from "@/components/PhotoViewer";
import { ACCEPT, THUMB_BOX, picked } from "@/components/TripFiles";
import { fitPhoto } from "@/lib/shrink";
import { failureMessage, formatPeso, markPaid, sameTransfer, walletApi, type Transfer, type Wallet } from "@/lib/wallet";

export type ProofTarget = { mode: "mark"; transfer: Transfer; settlementId: null } | { mode: "add" | "change"; transfer: Transfer; settlementId: string };

type Stage = "ready" | "saving" | "removing" | "upload_failed" | "remove_failed" | "changed";
type Changed = "amounts" | "undone";

const TITLE = { mark: "Mark as paid", add: "Add proof", change: "Change proof" };
const SAVED = { add: "Proof added.", change: "Proof changed." };
const UPLOAD_FAILED = {
  mark: "Marked as paid, but the screenshot didn't upload. Check your signal and try again.",
  add: "The screenshot didn't upload. Check your signal and try again.",
  change: "The screenshot didn't upload. Your old proof is still there. Check your signal and try again.",
};
const CHANGED = {
  amounts: "The amounts changed while this was open. Close this and check Settle up.",
  undone: "This payment was undone. Close this and check Settle up.",
};
const REMOVE_FAILED = "The proof wasn't removed. Try again in a minute.";
const PRIVACY = "Everyone with this wallet link can see it. Crop out your balance first. Deleted 14 days after the trip or after you add it, whichever is later.";

export default function ProofDialog({ slug, wallet, target, nameOf, onWallet, onClosed }: {
  slug: string;
  wallet: Wallet;
  target: ProofTarget;
  nameOf: (id: string) => string;
  onWallet: (wallet: Wallet, notice?: string) => void;
  /** After the dialog has closed. `saved`: something was stored, so the result, not the opening button, gets focus. */
  onClosed: (saved: boolean) => void;
}) {
  const { mode, transfer } = target;
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const holding = useRef(false); // a request is out: set in the handlers, so a second tap in the same tick sees it
  const saved = useRef(false);
  const [stage, setStage] = useState<Stage>("ready");
  const [changed, setChanged] = useState<Changed>("amounts");
  const [picture, setPicture] = useState<Blob | null>(null);
  const [fitting, setFitting] = useState(false);
  const [alert, setAlert] = useState<string | null>(null);
  const [retryId, setRetryId] = useState<string | null>(null); // the upload failed: Try again sends only the picture
  const [rejected, setRejected] = useState(false);

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);

  // A reload can pull the payment out from under an open dialog. Not while saving: that request's result decides
  const paymentId = target.settlementId ?? retryId;
  const undone = paymentId !== null && !wallet.settlements.some((s) => s.id === paymentId);
  const stale = stage === "ready" && mode === "mark" ? (sameTransfer(wallet, transfer) ? null : "amounts")
    : (stage === "ready" || stage === "upload_failed") && undone ? "undone" : null;
  if (stale) {
    setChanged(stale);
    setStage("changed");
  }

  const busy = stage === "saving" || stage === "removing";
  const paid = mode === "mark" && retryId !== null && stage !== "changed"; // the payment stands, whatever the picture does
  const retrying = retryId !== null && stage !== "changed";
  const problem = stage === "changed" ? CHANGED[changed] : alert;

  function close() {
    if (!holding.current) dialog.current?.close();
  }

  function finish(next: Wallet, notice: string) {
    holding.current = false; // before close(), or onClose would reopen it
    saved.current = true;
    onWallet(next, notice);
    dialog.current?.close();
  }

  function onDialogClose() {
    // Escape can't be held off for good, and Android's back may not be either, so a save brings the dialog straight back
    if (holding.current) dialog.current?.showModal();
    else onClosed(saved.current);
  }

  async function onPick() {
    if (!picker.current || holding.current) return;
    setFitting(true);
    const p = await picked(picker.current, fitPhoto);
    setFitting(false);
    if (!p) return;
    if ("problem" in p) return setAlert(p.problem);
    setPicture(p.picture);
    setAlert(null);
    if (stage === "remove_failed") setStage("ready");
  }

  function pick() {
    if (!holding.current) picker.current?.click();
  }

  async function save() {
    if (holding.current || fitting) return;
    holding.current = true;
    setAlert(null);
    setStage("saving");
    const r = await markPaid(walletApi, slug, transfer, picture, paymentId ?? undefined);
    if (mode === "mark") console.info("[tg-wallet] proof mark outcome=%s", r.stage);
    else console.info("[tg-wallet] proof %s ok=%s", mode, r.stage === "done" ? "yes" : r.stage === "upload_failed" ? r.failure.why : "no");
    if (r.stage === "done") return finish(r.wallet, mode === "mark" ? (picture ? "Marked as paid, with proof." : "Marked as paid.") : SAVED[mode]);
    holding.current = false;
    if (r.stage === "not_saved") {
      setAlert(failureMessage(r.failure));
      return setStage("ready");
    }
    if (r.wallet) onWallet(r.wallet);
    if (r.failure.why === "not_found") {
      setChanged("undone"); // the wallet link is fine: the payment went while this was uploading
      return setStage("changed");
    }
    setRetryId(r.settlementId);
    setRejected(r.failure.why === "rejected");
    setAlert(r.failure.why === "rejected" ? failureMessage(r.failure) : UPLOAD_FAILED[mode]);
    setStage("upload_failed");
  }

  async function remove() {
    if (holding.current || target.settlementId === null) return;
    if (!window.confirm("Remove this proof for everyone?")) return;
    holding.current = true;
    setAlert(null);
    setStage("removing");
    const r = await walletApi.removeProof(slug, target.settlementId);
    console.info("[tg-wallet] proof remove ok=%s", r.ok ? "yes" : r.why);
    if (r.ok) return finish(r.wallet, "Proof removed.");
    if (r.why === "not_found" && r.detail === "Proof not found") {
      // Another phone or the sweep got there first, so what was asked for is true
      const fresh = await walletApi.get(slug);
      return finish(fresh.ok ? fresh.wallet : wallet, "Proof removed.");
    }
    holding.current = false;
    if (r.why === "not_found") {
      setChanged("undone");
      return setStage("changed");
    }
    setAlert(REMOVE_FAILED);
    setStage("remove_failed");
  }

  const off = busy || undefined;
  const form = stage !== "changed" && !retrying && (
    <>
      {!picture && mode === "mark" && (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-semibold">Add proof</p>
          <p className="text-sm text-muted">Optional. Skip it if you paid in cash.</p>
        </div>
      )}
      {!picture && mode === "change" && <p className="text-sm text-muted">Replace it with a new screenshot, or remove it.</p>}
      {picture ? (
        <div className="flex items-start gap-3">
          <BlobImage blob={picture} alt="" width={72} height={96} className={THUMB_BOX} />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <p className="text-sm font-semibold">{mode === "change" ? "Your new screenshot" : "Your screenshot"}</p>
            <div className="flex flex-wrap gap-2">
              <PixelButton variant="secondary" aria-disabled={off} onClick={pick}>
                Change
              </PixelButton>
              {mode !== "change" && (
                <PixelButton variant="secondary" aria-disabled={off} onClick={() => !holding.current && setPicture(null)}>
                  Remove
                </PixelButton>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <PixelButton variant="secondary" aria-disabled={off} onClick={pick}>
            {mode === "change" ? "Choose new screenshot" : "Add screenshot"}
          </PixelButton>
          {mode === "change" && (
            <PixelButton variant="secondary" aria-disabled={off} onClick={remove}>
              {stage === "removing" ? "Removing..." : "Remove proof"}
            </PixelButton>
          )}
        </div>
      )}
      {picture && <p className={PX.meta}>{PRIVACY}</p>}
    </>
  );
  const primary = stage === "changed" || rejected ? null : retrying ? "Try again" : mode === "mark" ? "Mark paid" : picture ? "Save proof" : null;

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={(e) => holding.current && e.preventDefault()}
      onClose={onDialogClose}
      className="m-0 mt-auto md:my-auto mx-auto mb-4 w-[calc(100%-2rem)] max-w-md max-h-[70dvh] overflow-y-auto bg-transparent p-0 text-foreground backdrop:bg-screen-ink/60"
    >
      <DialogBox>
        <div className="flex flex-row-reverse items-start justify-between gap-3">
          {/* First in the DOM, so showModal() focuses Close */}
          <PixelButton variant="secondary" aria-disabled={off} onClick={close}>
            Close
          </PixelButton>
          <h2 id={titleId} className={`${PX.dataHeading} min-w-0 break-words`}>
            {paid ? "Marked as paid" : TITLE[mode]}
          </h2>
        </div>
        {stage !== "changed" && (
          <p className="min-w-0 text-sm break-words">
            <span className="font-semibold">{nameOf(transfer.from_member)}</span> {mode === "mark" && !paid ? "pays" : "paid"}{" "}
            <span className="font-semibold">{nameOf(transfer.to_member)}</span> <span className="tabular-nums font-bold">{formatPeso(transfer.amount_centavos)}</span>
          </p>
        )}
        {problem && (
          <PixelBox as="p" role="alert" tone="alertText" className="p-4 text-sm">
            {problem}
          </PixelBox>
        )}
        <input ref={picker} type="file" accept={ACCEPT} hidden onChange={onPick} />
        {form}
        {primary && (
          <PixelButton variant="primary" className="px-4 py-3" aria-disabled={off || fitting || undefined} onClick={save}>
            {stage === "saving" ? "Saving..." : primary}
          </PixelButton>
        )}
      </DialogBox>
    </dialog>
  );
}
