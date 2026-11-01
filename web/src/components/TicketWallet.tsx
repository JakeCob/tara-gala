"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { PX, PixelBox, PixelButton, cx } from "@/components/pixel";
import { BlobImage, PhotoViewer } from "@/components/PhotoViewer";
import { clearTickets, deleteTicket, listTickets, saveTicket } from "@/lib/ticketStore";
import { fitForUpload } from "@/lib/shrink";
import { addedLine, checkTicketFile, ticketLabel, type StoredTicket } from "@/lib/ticketWallet";
import { knownTripsRaw, parseKnownTrips, tripApi, tripFailureMessage } from "@/lib/trip";

const subscribeNothing = () => () => {};

type Wallet = { state: "loading" } | { state: "ready"; tickets: StoredTicket[] } | { state: "unavailable" };
type Notice = { text: string; error: boolean };

const NONE: StoredTicket[] = [];
const ADD_ID = "add-tickets";

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
  // TG-52 PR 2: a ticket can be shared with a trip this phone has opened. Nothing uploads unless someone taps it.
  const tripsRaw = useSyncExternalStore(subscribeNothing, knownTripsRaw, () => null);
  const trips = useMemo(() => parseKnownTrips(tripsRaw), [tripsRaw]);
  const [tripChoice, setTripChoice] = useState("");
  const toTrip = trips.find((t) => t.slug === tripChoice) ?? trips[0];
  const picker = useRef<HTMLInputElement>(null);
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

  async function shareToTrip(t: StoredTicket) {
    if (!toTrip) return;
    setBusy(true);
    const picture = await fitForUpload(t.blob);
    const r = picture ? await tripApi.addFile(toTrip.slug, "ticket", picture, { label: t.label.slice(0, 40) }) : null;
    setBusy(false);
    console.info("[tg-tickets] share to trip ok=%s", r?.ok ? "yes" : r ? r.why : "too_big");
    if (!r) return say("That ticket is too big to share. Take a screenshot of it instead.", true);
    if (!r.ok) return say(tripFailureMessage(r), true);
    say(`Shared with ${r.trip.name}. Everyone on the trip can open it now.`);
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

      {tickets.length > 0 && trips.length > 1 && (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-semibold">Share tickets with</span>
          <select className={PX.input} value={toTrip?.slug ?? ""} onChange={(e) => setTripChoice(e.target.value)}>
            {trips.map((t) => (
              <option key={t.slug} value={t.slug}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
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
                    <PixelButton variant="accent" aria-label={`Show ${t.label}`} onClick={() => setShown(t)}>
                      Show
                    </PixelButton>
                    {toTrip && (
                      <PixelButton variant="secondary" aria-label={`Add ${t.label} to ${toTrip.name}`} disabled={busy} onClick={() => shareToTrip(t)}>
                        Add to trip
                      </PixelButton>
                    )}
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

      <PhotoViewer photo={shown} onClose={() => setShown(null)} logTag="tg-tickets" />
    </div>
  );
}
