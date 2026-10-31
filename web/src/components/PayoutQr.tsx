"use client";

import { useEffect, useRef, useState } from "react";
import { PixelBox, PixelButton, SectionTitle } from "@/components/pixel";
import { BlobImage, PhotoViewer } from "@/components/PhotoViewer";
import { deletePayoutQr, loadPayoutQr, savePayoutQr, type PayoutQr as StoredQr } from "@/lib/payoutStore";
import { checkTicketFile } from "@/lib/ticketWallet";

type Saved = { state: "loading" } | { state: "none" } | { state: "ready"; qr: StoredQr } | { state: "unavailable" };

async function readQr(): Promise<Saved> {
  try {
    const qr = await loadPayoutQr();
    console.info("[tg-wallet] payout qr saved=%s", qr !== null);
    return qr ? { state: "ready", qr } : { state: "none" };
  } catch (err) {
    console.warn("[tg-wallet] payout qr storage unavailable", err instanceof Error ? err.name : err);
    return { state: "unavailable" };
  }
}

/** This phone's payout QR, or null when there isn't one (or storage is blocked). For the settle-up's "Show my QR". */
export async function loadMyQr(): Promise<StoredQr | null> {
  const s = await readQr();
  return s.state === "ready" ? s.qr : null;
}

/**
 * TG-50: my payout QR (GCash, Maya or a bank's InstaPay QR). Owner decision: it stays on this phone and is never
 * uploaded. When someone pays me, I show it full screen and they scan it with their own app.
 */
export default function PayoutQr() {
  const [saved, setSaved] = useState<Saved>({ state: "loading" });
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [shown, setShown] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    readQr().then((s) => live && setSaved(s));
    return () => {
      live = false;
    };
  }, []);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const check = checkTicketFile(file, 0);
    if (!check.ok) {
      console.info("[tg-wallet] payout qr refused");
      setNotice({ text: check.message, error: true });
      return;
    }
    try {
      await savePayoutQr({ type: file.type, size: file.size, addedAt: new Date().toISOString(), blob: file });
      const persisted = await navigator.storage?.persist?.().catch(() => false);
      console.info("[tg-wallet] payout qr saved persistent=%s", persisted);
      setSaved(await readQr());
      setNotice({ text: "Saved on this phone.", error: false });
    } catch (err) {
      console.warn("[tg-wallet] payout qr save failed", err instanceof Error ? err.name : err);
      setNotice({ text: "Couldn't save that photo. Try again.", error: true });
    }
  }

  async function remove() {
    if (!window.confirm("Delete your payout QR from this phone?")) return;
    try {
      await deletePayoutQr();
      console.info("[tg-wallet] payout qr deleted");
      setSaved(await readQr());
      setNotice({ text: "Payout QR deleted.", error: false });
    } catch (err) {
      console.warn("[tg-wallet] payout qr delete failed", err instanceof Error ? err.name : err);
      setNotice({ text: "Couldn't delete it. Try again.", error: true });
    }
  }

  return (
    <section aria-labelledby="payout-title" className="flex flex-col gap-3">
      <SectionTitle id="payout-title">My payout QR</SectionTitle>
      <PixelBox className="flex flex-col gap-3 p-4">
        <p className="text-sm text-muted">
          Your GCash, Maya or bank QR, for when someone pays you back. It stays on this phone; nothing is uploaded.
        </p>
        <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={onFile} />

        {saved.state === "ready" && (
          <div className="flex items-start gap-3">
            <BlobImage blob={saved.qr.blob} alt="" width={72} height={72} className="h-[72px] w-[72px] shrink-0 border-2 border-frame bg-screen-paper object-contain" />
            <div className="flex flex-wrap gap-2">
              <PixelButton variant="accent" onClick={() => setShown(true)}>
                Show
              </PixelButton>
              <PixelButton variant="secondary" onClick={() => picker.current?.click()}>
                Replace
              </PixelButton>
              <PixelButton variant="secondary" onClick={remove}>
                Delete
              </PixelButton>
            </div>
          </div>
        )}
        {saved.state === "none" && (
          <PixelButton variant="secondary" className="inline-flex items-center self-start px-4 text-sm" onClick={() => picker.current?.click()}>
            Add my QR
          </PixelButton>
        )}
      </PixelBox>
      {saved.state === "unavailable" && (
        <PixelBox as="p" tone="alertText" className="p-4 text-sm">
          This browser can&apos;t keep a QR here. Private browsing often blocks it. Keep it in your photos instead.
        </PixelBox>
      )}

      <div aria-live="polite" className="flex flex-col empty:-mt-3">
        {notice &&
          (notice.error ? (
            <PixelBox as="p" tone="alertText" className="p-4 text-sm">
              {notice.text}
            </PixelBox>
          ) : (
            <p className="text-sm">{notice.text}</p>
          ))}
      </div>

      <PhotoViewer photo={shown && saved.state === "ready" ? { blob: saved.qr.blob, label: "My payout QR" } : null} onClose={() => setShown(false)} logTag="tg-wallet" />
    </section>
  );
}
