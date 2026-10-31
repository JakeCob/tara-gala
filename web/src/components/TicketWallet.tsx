"use client";

import { useEffect, useRef, useState, type ComponentPropsWithoutRef } from "react";
import { PX, PixelBox, PixelButton, cx } from "@/components/pixel";
import { clearTickets, deleteTicket, listTickets, saveTicket } from "@/lib/ticketStore";
import { addedLine, checkTicketFile, ticketLabel, type StoredTicket } from "@/lib/ticketWallet";

type Wallet = { state: "loading" } | { state: "ready"; tickets: StoredTicket[] } | { state: "unavailable" };
type Notice = { text: string; error: boolean };

const NONE: StoredTicket[] = [];
const ADD_ID = "add-tickets";

/** A stored photo. Its object URL goes straight onto the element and is freed when the photo changes or unmounts. */
function BlobImage({ blob, alt, ...rest }: { blob: Blob; alt: string } & Omit<ComponentPropsWithoutRef<"img">, "src" | "alt">) {
  const img = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const url = URL.createObjectURL(blob);
    if (img.current) img.current.src = url;
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  // eslint-disable-next-line @next/next/no-img-element -- a local blob: URL, which next/image can't load
  return <img ref={img} alt={alt} {...rest} />;
}

async function readWallet(): Promise<Wallet> {
  try {
    const tickets = await listTickets();
    console.info("[tg-tickets] loaded count=%d", tickets.length);
    return { state: "ready", tickets };
  } catch (err) {
    console.warn("[tg-tickets] storage unavailable", err instanceof Error ? err.name : err);
    return { state: "unavailable" };
  }
}

/**
 * TG-50 story 5: bus e-ticket photos saved on this phone (IndexedDB), listed newest first, and shown full screen on a
 * light page with the screen kept awake, so the conductor can scan the QR without signal.
 */
export default function TicketWallet() {
  const [wallet, setWallet] = useState<Wallet>({ state: "loading" });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<StoredTicket | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const wake = useRef<WakeLockSentinel | null>(null);
  const tickets = wallet.state === "ready" ? wallet.tickets : NONE;

  useEffect(() => {
    let live = true;
    readWallet().then((w) => live && setWallet(w));
    return () => {
      live = false;
    };
  }, []);

  function say(text: string, error = false) {
    setNotice({ text, error });
  }

  /** A delete takes the focused button with it: focus goes to Add ticket photos, which is always there. */
  function afterDelete(text: string) {
    say(text);
    document.getElementById(ADD_ID)?.focus();
  }

  async function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    e.target.value = ""; // so the same photo can be picked again after a delete
    if (files.length === 0 || wallet.state !== "ready") return;
    setBusy(true);
    let count = wallet.tickets.length;
    let saved = 0;
    let problem = "";
    for (const file of files) {
      const check = checkTicketFile(file, count);
      if (!check.ok) {
        problem ||= check.message;
        continue;
      }
      try {
        await saveTicket({ id: crypto.randomUUID(), label: ticketLabel(file.name), type: file.type, size: file.size, addedAt: new Date().toISOString(), blob: file });
        count++;
        saved++;
      } catch (err) {
        const reason = err instanceof Error ? err.name : String(err);
        console.warn("[tg-tickets] save failed", reason);
        problem ||= reason === "QuotaExceededError" ? "This phone is out of space for tickets. Delete an old one or free some space." : "Couldn't save that photo. Try again.";
      }
    }
    console.info("[tg-tickets] added=%d refused=%d", saved, files.length - saved);
    if (saved > 0) {
      // Ask the browser not to clear the site's storage when the phone runs low
      const persisted = await navigator.storage?.persist?.().catch(() => false);
      console.info("[tg-tickets] persistent storage=%s", persisted);
    }
    setWallet(await readWallet());
    setBusy(false);
    if (problem) say(saved > 0 ? `Saved ${saved}. ${problem}` : problem, true);
    else say(`Saved ${saved} ticket${saved === 1 ? "" : "s"} on this phone.`);
  }

  async function remove(t: StoredTicket) {
    if (!window.confirm(`Delete "${t.label}" from this phone?`)) return;
    try {
      await deleteTicket(t.id);
      console.info("[tg-tickets] deleted one");
      setWallet(await readWallet());
      afterDelete("Ticket deleted.");
    } catch (err) {
      console.warn("[tg-tickets] delete failed", err instanceof Error ? err.name : err);
      say("Couldn't delete that ticket. Try again.", true);
    }
  }

  async function removeAll() {
    if (!window.confirm(`Delete all ${tickets.length} tickets from this phone?`)) return;
    try {
      await clearTickets();
      console.info("[tg-tickets] deleted all count=%d", tickets.length);
      setWallet(await readWallet());
      afterDelete("All tickets deleted.");
    } catch (err) {
      console.warn("[tg-tickets] delete all failed", err instanceof Error ? err.name : err);
      say("Couldn't delete the tickets. Try again.", true);
    }
  }

  async function show(t: StoredTicket) {
    setShown(t);
    dialog.current?.showModal();
    try {
      wake.current = (await navigator.wakeLock?.request("screen")) ?? null;
    } catch {
      wake.current = null; // refused (battery saver, or no permission): the ticket still shows
    }
    console.info("[tg-tickets] show wakeLock=%s", wake.current !== null);
  }

  function onClose() {
    wake.current?.release().catch(() => {});
    wake.current = null;
    setShown(null);
  }

  return (
    <div className="flex flex-col gap-4">
      <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={onFiles} />
      <PixelButton id={ADD_ID} variant="primary" className="px-4 py-3 md:self-start md:px-8" disabled={busy || wallet.state !== "ready"} onClick={() => picker.current?.click()}>
        {busy ? "Saving..." : "Add ticket photos"}
      </PixelButton>

      {/* empty:-mt-4 cancels the gap before the first notice without hiding the live region */}
      <div aria-live="polite" className="flex flex-col empty:-mt-4">
        {notice &&
          (notice.error ? (
            <PixelBox as="p" tone="alertText" className="p-4 text-sm">
              {notice.text}
            </PixelBox>
          ) : (
            <p className="text-sm">{notice.text}</p>
          ))}
      </div>

      {wallet.state === "loading" && <p className={PX.meta}>Opening your tickets...</p>}

      {wallet.state === "unavailable" && (
        <PixelBox as="p" tone="alertText" className="p-4 text-sm">
          This browser can&apos;t save tickets here. Private browsing often blocks it. Keep a screenshot in your photos instead.
        </PixelBox>
      )}

      {wallet.state === "ready" && tickets.length === 0 && (
        <PixelBox as="p" className="p-4 text-sm">
          No tickets yet. Add a photo or screenshot of your bus e-ticket, and it opens here even without signal.
        </PixelBox>
      )}

      {tickets.length > 0 && (
        <>
          <ul className="flex flex-col gap-3 md:grid md:grid-cols-[repeat(auto-fill,minmax(20rem,1fr))] md:gap-4">
            {tickets.map((t) => (
              <PixelBox as="li" key={t.id} className="flex items-start gap-3 p-4">
                <BlobImage blob={t.blob} alt="" width={72} height={96} className="h-24 w-[72px] shrink-0 border-2 border-frame bg-screen-paper object-cover object-top" />
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <p className={cx(PX.dataHeading, "min-w-0 break-words")}>{t.label}</p>
                  <p className={PX.meta}>{addedLine(t.addedAt)}</p>
                  <div className="flex flex-wrap gap-2">
                    <PixelButton variant="accent" aria-label={`Show ${t.label}`} onClick={() => show(t)}>
                      Show
                    </PixelButton>
                    <PixelButton variant="secondary" aria-label={`Delete ${t.label}`} onClick={() => remove(t)}>
                      Delete
                    </PixelButton>
                  </div>
                </div>
              </PixelBox>
            ))}
          </ul>
          <PixelButton variant="secondary" className="inline-flex items-center self-start px-4 text-sm" onClick={removeAll}>
            Delete all tickets
          </PixelButton>
        </>
      )}

      {/* Full screen on the fixed light screen, whatever the theme: QR scanners want a light page */}
      <dialog ref={dialog} onClose={onClose} aria-label={shown?.label ?? "Ticket"} className="m-0 h-dvh max-h-none w-full max-w-none bg-screen-paper p-0 text-screen-ink">
        <div className="mx-auto flex h-full max-w-md flex-col gap-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 break-words text-sm font-bold">{shown?.label}</p>
            <PixelButton variant="secondary" autoFocus onClick={() => dialog.current?.close()}>
              Close
            </PixelButton>
          </div>
          {shown && <BlobImage blob={shown.blob} alt={`Ticket: ${shown.label}`} className="min-h-0 w-full flex-1 object-contain" />}
        </div>
      </dialog>
    </div>
  );
}
