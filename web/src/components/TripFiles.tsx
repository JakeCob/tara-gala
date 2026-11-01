"use client";

import { useEffect, useRef, useState } from "react";
import { PX, PixelBox, PixelButton, PixelLink, SectionTitle, cx } from "@/components/pixel";
import { BlobImage, PhotoViewer } from "@/components/PhotoViewer";
import { fitForUpload } from "@/lib/shrink";
import { ticketLabel } from "@/lib/ticketWallet";
import { type Trip, type TripFile, type TripResult, MAX_SHARED_TICKETS, deleteLine, fetchFile, tripApi } from "@/lib/trip";
import { type Member, walletApi } from "@/lib/wallet";

type Write = (action: string, op: () => Promise<TripResult>, done: string) => Promise<boolean>;
type Shown = { blob: Blob; label: string } | null;
const ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

/** One shared picture, fetched once (the service worker keeps a copy for offline). */
export function useFile(slug: string, file: TripFile | undefined) {
  const [got, setGot] = useState<{ id: string; blob: Blob | null } | null>(null);
  useEffect(() => {
    if (!file) return;
    let live = true;
    fetchFile(slug, file.id).then((blob) => live && setGot({ id: file.id, blob }));
    return () => {
      live = false;
    };
  }, [slug, file]);
  return file && got?.id === file.id ? got.blob : null;
}

export function Thumb({ slug, file, alt }: { slug: string; file: TripFile; alt: string }) {
  const blob = useFile(slug, file);
  const box = "h-24 w-[72px] shrink-0 border-2 border-frame bg-screen-paper object-cover object-top";
  return blob ? <BlobImage blob={blob} alt={alt} width={72} height={96} className={box} /> : <span aria-hidden="true" className={box} />;
}

/** Shrinks a picked picture if needed; null and a reason when it can't be shared. */
async function picked(input: HTMLInputElement): Promise<{ file: File; picture: Blob } | { problem: string } | null> {
  const file = input.files?.[0];
  input.value = "";
  if (!file) return null;
  if (!ACCEPT.split(",").includes(file.type)) return { problem: "That file isn't a picture. Use a photo or screenshot." };
  const picture = await fitForUpload(file);
  return picture ? { file, picture } : { problem: "That picture is too big to share. Take a screenshot of it instead." };
}

async function show(slug: string, file: TripFile, label: string, setShown: (s: Shown) => void, onFail: (text: string) => void) {
  const blob = await fetchFile(slug, file.id);
  console.info("[tg-trip] file show kind=%s ok=%s", file.kind, blob ? "yes" : "no");
  if (blob) setShown({ blob, label });
  else onFail("Couldn't open that picture. Open the trip once with signal to keep it on this phone.");
}

/** TG-52 PR 2: the party's bus tickets, shared with everyone on the trip until 14 days after it. */
export function SharedTickets({ trip, busy, write, onFail }: { trip: Trip; busy: boolean; write: Write; onFail: (text: string) => void }) {
  const picker = useRef<HTMLInputElement>(null);
  const [shown, setShown] = useState<Shown>(null);
  const tickets = trip.files.filter((f) => f.kind === "ticket");

  async function onPick() {
    const p = picker.current && (await picked(picker.current));
    if (!p) return;
    if ("problem" in p) return onFail(p.problem);
    await write("ticket-add", () => tripApi.addFile(trip.share_slug, "ticket", p.picture, { label: ticketLabel(p.file.name) }), "Ticket shared with the trip.");
  }

  return (
    <section aria-labelledby="tickets-title" className="flex flex-col gap-3">
      <SectionTitle id="tickets-title">Bus tickets</SectionTitle>
      <p className="text-sm text-muted">
        Everyone on the trip sees these. They&apos;re deleted from the trip 14 days after you come home.
      </p>
      <input ref={picker} type="file" accept={ACCEPT} hidden onChange={onPick} />
      {tickets.length > 0 && (
        <ul className="flex flex-col gap-3">
          {tickets.map((t) => (
            <PixelBox as="li" key={t.id} className="flex items-start gap-3 p-4">
              <Thumb slug={trip.share_slug} file={t} alt="" />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <p className={cx(PX.dataHeading, "min-w-0 break-words")}>{t.label}</p>
                <p className={PX.meta}>{deleteLine(t.delete_after)}</p>
                <div className="flex flex-wrap gap-2">
                  <PixelButton variant="accent" aria-label={`Show ${t.label}`} onClick={() => show(trip.share_slug, t, t.label, setShown, onFail)}>
                    Show
                  </PixelButton>
                  <PixelButton variant="secondary" aria-label={`Remove ${t.label}`} disabled={busy}
                    onClick={() => window.confirm(`Remove "${t.label}" from the trip for everyone?`) &&
                      write("ticket-remove", () => tripApi.deleteFile(trip.share_slug, t.id), "Ticket removed from the trip.")}>
                    Remove
                  </PixelButton>
                </div>
              </div>
            </PixelBox>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {tickets.length < MAX_SHARED_TICKETS && (
          <PixelButton variant="primary" className="px-4 text-sm" disabled={busy} onClick={() => picker.current?.click()}>
            Share a ticket
          </PixelButton>
        )}
        <PixelLink variant="secondary" href="/tickets" className="inline-flex items-center px-4 text-sm">
          My tickets on this phone
        </PixelLink>
      </div>
      <PhotoViewer photo={shown} onClose={() => setShown(null)} logTag="tg-trip" />
    </section>
  );
}

/** TG-52 PR 2: each person's payout QR, on their name in the trip's wallet, so whoever owes them can pay it. */
export function PayoutQrs({ trip, busy, write, onFail }: { trip: Trip; busy: boolean; write: Write; onFail: (text: string) => void }) {
  const walletSlug = trip.wallet?.share_slug;
  const [members, setMembers] = useState<{ wallet: string; list: Member[] } | null>(null);
  const [shown, setShown] = useState<Shown>(null);
  const [forWho, setForWho] = useState<Member | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!walletSlug) return;
    let live = true;
    walletApi.get(walletSlug).then((r) => live && r.ok && setMembers({ wallet: walletSlug, list: r.wallet.members }));
    return () => {
      live = false;
    };
  }, [walletSlug]);

  if (!walletSlug) return null;
  const people = members?.wallet === walletSlug ? members.list : [];
  const qrOf = (id: string) => trip.files.find((f) => f.kind === "payout_qr" && f.member_id === id);

  async function onPick() {
    const who = forWho;
    const p = picker.current && (await picked(picker.current));
    if (!p || !who) return;
    if ("problem" in p) return onFail(p.problem);
    await write("qr-add", () => tripApi.addFile(trip.share_slug, "payout_qr", p.picture, { member_id: who.id }), `${who.name}'s QR saved.`);
  }

  return (
    <section aria-labelledby="qrs-title" className="flex flex-col gap-3">
      <SectionTitle id="qrs-title">Payout QRs</SectionTitle>
      <p className="text-sm text-muted">
        Each person&apos;s GCash, Maya or bank QR, so whoever owes them can pay at the end. Everyone on the trip sees them. They&apos;re
        deleted from the trip 14 days after you come home.
      </p>
      <input ref={picker} type="file" accept={ACCEPT} hidden onChange={onPick} />
      {people.length === 0 ? (
        <p className={PX.meta}>Opening the wallet&apos;s people...</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {people.map((m) => {
            const qr = qrOf(m.id);
            return (
              <PixelBox as="li" key={m.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <span className="min-w-0 break-words font-semibold">{m.name}</span>
                <span className="flex flex-wrap gap-2">
                  {qr && (
                    <PixelButton variant="accent" aria-label={`Show ${m.name}'s QR`} onClick={() => show(trip.share_slug, qr, `${m.name}'s QR`, setShown, onFail)}>
                      Show QR
                    </PixelButton>
                  )}
                  <PixelButton variant="secondary" aria-label={`${qr ? "Replace" : "Add"} ${m.name}'s QR`} disabled={busy}
                    onClick={() => { setForWho(m); picker.current?.click(); }}>
                    {qr ? "Replace" : "Add QR"}
                  </PixelButton>
                  {qr && (
                    <PixelButton variant="secondary" aria-label={`Remove ${m.name}'s QR`} disabled={busy}
                      onClick={() => write("qr-remove", () => tripApi.deleteFile(trip.share_slug, qr.id), `${m.name}'s QR removed.`)}>
                      Remove
                    </PixelButton>
                  )}
                </span>
              </PixelBox>
            );
          })}
        </ul>
      )}
      <PhotoViewer photo={shown} onClose={() => setShown(null)} logTag="tg-trip" />
    </section>
  );
}

/** TG-52 PR 2: the hotel's booking screenshot, inside the hotel card. */
export function HotelProof({ trip, busy, write, onFail }: { trip: Trip; busy: boolean; write: Write; onFail: (text: string) => void }) {
  const picker = useRef<HTMLInputElement>(null);
  const [shown, setShown] = useState<Shown>(null);
  const proof = trip.files.find((f) => f.kind === "hotel_proof");

  async function onPick() {
    const p = picker.current && (await picked(picker.current));
    if (!p) return;
    if ("problem" in p) return onFail(p.problem);
    await write("hotel-proof-add", () => tripApi.addFile(trip.share_slug, "hotel_proof", p.picture), "Booking screenshot saved.");
  }

  return (
    <div className="flex flex-wrap gap-2">
      <input ref={picker} type="file" accept={ACCEPT} hidden onChange={onPick} />
      {proof && (
        <PixelButton variant="accent" className="px-4 text-sm" onClick={() => show(trip.share_slug, proof, "Hotel booking", setShown, onFail)}>
          Show booking
        </PixelButton>
      )}
      <PixelButton variant="secondary" className="px-4 text-sm" disabled={busy} onClick={() => picker.current?.click()}>
        {proof ? "Replace booking screenshot" : "Add booking screenshot"}
      </PixelButton>
      <PhotoViewer photo={shown} onClose={() => setShown(null)} logTag="tg-trip" />
    </div>
  );
}
