"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { PX, PixelBox, PixelButton, PixelCardLink, PixelLink, SectionTitle, cx } from "@/components/pixel";
import { fetchPremade, type PremadeSummary } from "@/lib/api";
import {
  type Hotel, type PlanGuide, type Trip, type TripLoad, type TripResult, afterGet, afterSaved, answerFrom, datesLine, fetchFile, fillGuide, forgetTrip, hotelMapsUrl,
  hotelTime, mapSlot, rememberTrip, savedTrip, slugFromLink, toInput, toWallTime, tripApi, tripFailureMessage, tripProblem,
} from "@/lib/trip";
import LevelMap from "./LevelMap";
import { HotelProof, PayoutQrs, SharedTickets } from "./TripFiles";
import TripPeople from "./TripPeople";
import { fetchItinerary, savedItinerary } from "@/lib/api";
import { fitPhoto } from "@/lib/shrink";
import { failureMessage, knownWalletsRaw, parseKnownWallets, rememberWallet, walletApi } from "@/lib/wallet";

type Notice = { text: string; error: boolean };
const subscribeNothing = () => () => {};
const NO_HOTEL: Hotel = { name: "", address: "", check_in: null, check_out: null, booking_ref: "", notes: "" };

/** This phone's note of the trip, with its wallet so the wallet page can find the payout QRs */
const remember = (trip: Trip) =>
  rememberTrip({ slug: trip.share_slug, name: trip.name, start_date: trip.start_date, wallet_slug: trip.wallet?.share_slug ?? null });

/** Fetch every shared ticket, QR and booking once, so the service worker keeps them: tickets have to open at the
 * terminal offline. Not again on each 30-second poll. Photos are kept as they're viewed instead: up to 300 of them is
 * too much to fetch up front. */
function keepFilesOffline(trip: Trip, kept: Set<string>) {
  for (const f of trip.files) {
    if (f.kind !== "photo" && !kept.has(f.id)) void fetchFile(trip.share_slug, f.id).then((blob) => blob && kept.add(f.id));
  }
}

/**
 * TG-52: one trip, by its secret link. The plan, the shared wallet, the hotel, and the shared tickets and payout QRs
 * live here; the plan and the wallet keep their own links and pages. Everyone with the link can change it, as with a wallet. The service worker keeps the
 * last copy, so it opens offline once it has been opened with signal.
 */
export default function TripView({ slug }: { slug: string }) {
  const router = useRouter();
  const [load, setLoad] = useState<TripLoad>({ state: "loading" });
  const [reloads, setReloads] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const keptFiles = useRef(new Set<string>());
  const shownAt = useRef(0); // TG-54: how new the trip on screen is: when its GET left, or when a write landed

  // TG-57: the worker's copy shows at once, so the map doesn't wait on two API calls in a row. The GET below replaces it
  useEffect(() => {
    let live = true;
    void savedTrip(slug).then((saved) => {
      if (!live || !saved) return;
      console.info("[tg-trip] load saved copy");
      shownAt.current ||= saved.savedAt;
      setLoad((prev) => afterSaved(prev, saved.trip));
    });
    return () => {
      live = false;
    };
  }, [slug]);

  useEffect(() => {
    let live = true;
    const left = Date.now();
    tripApi.get(slug).then((r) => {
      if (!live) return;
      const from = answerFrom(r, left);
      const overtaken = from < shownAt.current;
      console.info("[tg-trip] load ok=%s", r.ok ? (overtaken ? "overtaken" : r.savedAt ? "saved" : "yes") : r.why);
      if (r.ok && !overtaken) {
        shownAt.current = from;
        remember(r.trip);
        keepFilesOffline(r.trip, keptFiles.current);
      }
      setLoad((prev) => afterGet(prev, r, slug, overtaken));
    });
    return () => {
      live = false;
    };
  }, [slug, reloads]);

  // Others change the trip from their phones: fetch again whenever this one comes back to the app, and every
  // 30 seconds while it's open, so the progress map moves on every phone
  useEffect(() => {
    const onVisible = () => document.visibilityState === "visible" && setReloads((n) => n + 1);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(() => document.visibilityState === "visible" && setReloads((n) => n + 1), 30_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, []);

  // The plan's guide (day tables, buses, pick, budget, to-dos): the trip's checklist and progress map
  const planSlug = load.state === "ready" ? load.trip.itinerary_slug : null;
  const [guide, setGuide] = useState<PlanGuide | null>(null);
  const retry = guide?.plan === planSlug && guide?.failed ? reloads : 0; // a failed fetch tries again with the polls
  useEffect(() => {
    if (!planSlug) return;
    let live = true;
    void savedItinerary(planSlug).then((saved) => {
      if (!live || !saved) return;
      console.info("[tg-trip] guide saved copy");
      setGuide((prev) => fillGuide(prev, { plan: planSlug, guide: saved.body.guide ?? null }));
    });
    fetchItinerary(planSlug).then(
      (it) => live && setGuide({ plan: planSlug, guide: it?.guide ?? null }),
      () => {
        console.info("[tg-trip] guide failed live=%s", live);
        if (live) setGuide((prev) => fillGuide(prev, { plan: planSlug, guide: null, failed: true })); // offline with no copy: the rest of the trip still shows
      },
    );
    return () => {
      live = false;
    };
  }, [planSlug, retry]);

  // TG-57: a first open's GETs go past the service worker: ask again once it's here, so the next open has its copies.
  // Only the worker needs these answers, so the GET the screen is waiting on carries on
  useEffect(() => {
    const keepCopies = () => {
      console.info("[tg-trip] worker took over, saving copies");
      void tripApi.get(slug);
      if (planSlug) fetchItinerary(planSlug).catch(() => undefined);
    };
    navigator.serviceWorker?.addEventListener("controllerchange", keepCopies);
    return () => navigator.serviceWorker?.removeEventListener("controllerchange", keepCopies);
  }, [slug, planSlug]);

  if (load.state === "loading") return <p className="text-sm text-muted">Opening the trip...</p>;
  if (load.state === "error") {
    return (
      <PixelBox as="p" tone="alertText" className="p-4 text-sm">
        {load.why === "offline" ? "No signal, and this trip isn't saved on this phone yet. Open it once with signal." : tripFailureMessage({ why: load.why })}
      </PixelBox>
    );
  }
  const trip = load.trip;

  async function write(action: string, op: () => Promise<TripResult>, done: string): Promise<boolean> {
    setBusy(true);
    setNotice(null);
    const r = await apply(action, op);
    setBusy(false);
    setNotice(r.ok ? { text: done, error: false } : { text: tripFailureMessage(r), error: true });
    return r.ok;
  }

  /** A write with no notice, for controls that show their own result (TG-58). */
  async function apply(action: string, op: () => Promise<TripResult>): Promise<TripResult> {
    const r = await op();
    console.info("[tg-trip] %s ok=%s", action, r.ok ? "yes" : r.why);
    if (!r.ok) return r;
    shownAt.current = Date.now();
    setLoad({ state: "ready", trip: r.trip });
    remember(r.trip);
    void tripApi.get(slug); // the service worker saves GETs, not this write: refresh the offline copy
    return r;
  }

  const onFail = (text: string) => setNotice({ text, error: true });
  const slot = mapSlot(trip.itinerary_slug, guide);
  const theGuide = slot === "frame" ? null : slot;
  return (
    <div className="flex flex-col gap-6">
    <div className="flex flex-col gap-6 md:grid md:grid-cols-2 md:items-start">
      <TripHeader trip={trip} busy={busy} write={write} />
      <TripPeople trip={trip} plan={slot} apply={apply} />
    </div>
    {slot === "frame" && (
      <section data-map-loading aria-label="Trip progress" aria-busy="true" className="flex flex-col gap-3">
        <SectionTitle>Trip progress</SectionTitle>
        <div className="grid min-h-[70vh]">
          <PixelBox className="flex justify-center p-4">
            <p className="text-sm text-muted">Opening the map...</p>
          </PixelBox>
        </div>
      </section>
    )}
    {theGuide && (
      <section aria-labelledby="progress-title" className="flex flex-col gap-3">
        <SectionTitle id="progress-title">Trip progress</SectionTitle>
        <p className="text-sm text-muted md:max-w-prose">
          Each stop is a level. Tap one to mark it done or add photos, from any phone. The group stands on the last level done.
        </p>
        <LevelMap
          guide={theGuide}
          marks={trip.marks}
          photos={{
            slug,
            files: trip.files,
            onAdd: async (rowKey, picked) => {
              let added = 0;
              let skipped = 0;
              for (const file of picked) {
                const photo = await fitPhoto(file);
                if (!photo) {
                  skipped++;
                  continue;
                }
                const ok = await write("photo-add", () => tripApi.addFile(slug, "photo", photo, rowKey ? { row_key: rowKey } : {}), "");
                if (!ok) {
                  if (added) setNotice((n) => n && { ...n, text: `${added} of ${picked.length} photos added. ${n.text}` });
                  return;
                }
                added++;
              }
              console.info("[tg-trip] photo-add added=%d skipped=%d", added, skipped);
              if (skipped) setNotice({ text: `${skipped === 1 ? "One picture" : `${skipped} pictures`} couldn't be shrunk to share. Try a screenshot instead.`, error: true });
              else if (added) setNotice({ text: `${added} photo${added === 1 ? "" : "s"} added.`, error: false });
            },
            onDelete: (file) => void write("photo-delete", () => tripApi.deleteFile(slug, file.id), "Photo deleted."),
          }}
          busy={busy}
          problem={notice?.error ? notice.text : null}
          said={notice && !notice.error ? notice.text : ""}
          onOpenLevel={() => setNotice(null)}
          onTick={(key, done) =>
            write(done ? "tick" : "untick", () => (done ? tripApi.mark(slug, key, "done") : tripApi.unmark(slug, key)), done ? "Ticked." : "Unticked.")
          }
          onPick={(pickKey, option) => write("pick", () => tripApi.mark(slug, `pick:${pickKey}`, option), `Picked ${option}.`)}
        />
      </section>
    )}
    <div className="flex flex-col gap-5 md:grid md:grid-cols-2 md:items-start md:gap-6">
      <div className="flex flex-col gap-5">
        <PlanSection trip={trip} busy={busy} write={write} />
        <SharedTickets trip={trip} busy={busy} write={write} onFail={onFail} />
        <WalletSection trip={trip} busy={busy} write={write} setNotice={setNotice} />
        <PayoutQrs trip={trip} busy={busy} write={write} onFail={onFail} />
      </div>
      <div className="flex flex-col gap-5">
        <HotelSection trip={trip} busy={busy} write={write} onFail={onFail} />
        <div aria-live="polite">
          {notice &&
            (notice.error ? (
              <PixelBox as="p" tone="alertText" className="p-4 text-sm">
                {notice.text}
              </PixelBox>
            ) : (
              <p className="text-sm">{notice.text}</p>
            ))}
        </div>
        <DeleteTrip
          trip={trip}
          onDeleted={() => {
            forgetTrip(slug);
            router.push("/trip");
          }}
        />
      </div>
    </div>
    </div>
  );
}

/** A form's problem, in the alert box the wallet uses */
function Problem({ text }: { text: string }) {
  return (
    <PixelBox as="p" tone="alertText" role="alert" className="p-3 text-sm">
      {text}
    </PixelBox>
  );
}

type Write = (action: string, op: () => Promise<TripResult>, done: string) => Promise<boolean>;

function TripHeader({ trip, busy, write }: { trip: Trip; busy: boolean; write: Write }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(trip.name);
  const [start, setStart] = useState(trip.start_date);
  const [back, setBack] = useState(trip.return_date);
  const [problem, setProblem] = useState("");
  const [shared, setShared] = useState("");

  // The trip may have moved on from the copy this first drew, by a saved copy (TG-57) or another phone
  function openEditor() {
    if (!editing) {
      setName(trip.name);
      setStart(trip.start_date);
      setBack(trip.return_date);
    }
    setEditing((v) => !v);
  }

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    const p = tripProblem(name, start, back);
    if (p) return setProblem(p);
    setProblem("");
    if (await write("update", () => tripApi.update(trip.share_slug, { name: name.trim(), start_date: start, return_date: back }), "Trip details saved.")) setEditing(false);
  }

  async function onShare() {
    const url = `${window.location.origin}/t/${trip.share_slug}`;
    try {
      if (navigator.share) await navigator.share({ title: trip.name, url });
      else {
        await navigator.clipboard.writeText(url);
        setShared("Link copied. Send it to everyone on the trip.");
      }
    } catch {
      // cancelled: nothing to say
    }
  }

  return (
    <PixelBox className="flex flex-col gap-3 p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-bold break-words">{trip.name}</h2>
        <p className="text-sm text-muted">{datesLine(trip.start_date, trip.return_date)}</p>
      </div>
      <p className="text-sm text-muted">Anyone with this trip&apos;s link can see and change it, so share it only with the people coming.</p>
      <div className="flex flex-wrap gap-2">
        <PixelButton variant="primary" className="px-4 text-sm" onClick={onShare}>
          Share the trip
        </PixelButton>
        <PixelButton variant="secondary" className="px-4 text-sm" onClick={openEditor} aria-expanded={editing}>
          {editing ? "Close" : "Edit name and dates"}
        </PixelButton>
      </div>
      {shared && <p role="status" className="text-sm">{shared}</p>}
      {editing && (
        <form onSubmit={onSave} noValidate className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-semibold">Trip name</span>
            <input className={PX.input} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex min-w-0 flex-col gap-1 text-sm">
              <span className="font-semibold">Leave</span>
              <input type="date" className={cx(PX.input, "w-full")} value={start} onChange={(e) => setStart(e.target.value)} />
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-sm">
              <span className="font-semibold">Come home</span>
              <input type="date" className={cx(PX.input, "w-full")} value={back} onChange={(e) => setBack(e.target.value)} />
            </label>
          </div>
          {problem && <Problem text={problem} />}
          <PixelButton type="submit" variant="primary" className="self-start px-4 text-sm" disabled={busy}>
            Save
          </PixelButton>
        </form>
      )}
    </PixelBox>
  );
}

function PlanSection({ trip, busy, write }: { trip: Trip; busy: boolean; write: Write }) {
  const [premade, setPremade] = useState<PremadeSummary[]>([]);
  const [link, setLink] = useState("");
  const [problem, setProblem] = useState("");

  useEffect(() => {
    if (trip.itinerary_slug) return;
    let live = true;
    fetchPremade().then((r) => live && r.kind === "ok" && setPremade(r.list));
    return () => {
      live = false;
    };
  }, [trip.itinerary_slug]);

  async function attach(share: string) {
    setProblem("");
    if (await write("itinerary-attach", () => tripApi.attachItinerary(trip.share_slug, share), "Plan added to the trip.")) setLink("");
  }

  function onPaste(e: React.FormEvent) {
    e.preventDefault();
    const share = slugFromLink(link, "itinerary");
    if (!share) return setProblem("Paste the plan's link, like tara-gala-ph.vercel.app/i/…");
    void attach(share);
  }

  return (
    <section aria-labelledby="plan-title" className="flex flex-col gap-3">
      <SectionTitle id="plan-title">The plan</SectionTitle>
      {trip.itinerary_slug ? (
        <>
          <PixelCardLink href={`/i/${trip.itinerary_slug}`} className="flex items-center justify-between gap-3 p-4">
            <span className="flex flex-col gap-1">
              <span className="font-bold">Open the plan</span>
              <span className={PX.meta}>Buses, stops and the map, day by day.</span>
            </span>
            <span aria-hidden="true">→</span>
          </PixelCardLink>
          <PixelButton variant="secondary" className="self-start px-4 text-sm" disabled={busy}
            onClick={() => write("itinerary-detach", () => tripApi.detachItinerary(trip.share_slug), "Plan taken off the trip. It still has its own link.")}>
            Use a different plan
          </PixelButton>
        </>
      ) : (
        <PixelBox className="flex flex-col gap-3 p-4">
          <p className="text-sm text-muted">No plan yet. Pick a ready-made trip, paste a plan&apos;s link, or plan one.</p>
          {premade.length > 0 && (
            <ul className="flex flex-col gap-2">
              {premade.map((p) => (
                <li key={p.share_slug}>
                  <PixelButton variant="secondary" className="w-full px-4 text-left text-sm" disabled={busy} onClick={() => attach(p.share_slug)}>
                    {p.vibe ? `Use the ${p.vibe} trip` : `Use a ${p.day_count}-day trip`} ({p.stop_count} stops)
                  </PixelButton>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={onPaste} noValidate className="flex items-end gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
              <span className="font-semibold">Plan link</span>
              <input className={cx(PX.input, "w-full")} value={link} inputMode="url" autoComplete="off" onChange={(e) => setLink(e.target.value)} />
            </label>
            <PixelButton type="submit" variant="primary" className="px-4 text-sm" disabled={busy}>
              Add
            </PixelButton>
          </form>
          {problem && <Problem text={problem} />}
          <PixelLink variant="secondary" href="/plan" className="inline-flex items-center self-start px-4 text-sm">
            Plan a trip
          </PixelLink>
        </PixelBox>
      )}
    </section>
  );
}

function WalletSection({ trip, busy, write, setNotice }: { trip: Trip; busy: boolean; write: Write; setNotice: (n: Notice | null) => void }) {
  const raw = useSyncExternalStore(subscribeNothing, knownWalletsRaw, () => null);
  const mine = useMemo(() => parseKnownWallets(raw), [raw]);
  const [me, setMe] = useState("");
  const [link, setLink] = useState("");
  const [problem, setProblem] = useState("");
  const [starting, setStarting] = useState(false);

  async function onStart(e: React.FormEvent) {
    e.preventDefault();
    const name = me.trim();
    if (!name || name.length > 30) return setProblem("Add your name (up to 30 letters). Others add themselves in the wallet.");
    setProblem("");
    setStarting(true);
    const w = await walletApi.create(trip.name, [name]);
    console.info("[tg-trip] wallet-create ok=%s", w.ok ? "yes" : w.why);
    setStarting(false);
    if (!w.ok) return setNotice({ text: failureMessage(w), error: true });
    rememberWallet({ slug: w.wallet.share_slug, name: w.wallet.name, me: w.wallet.members[0].id });
    await write("wallet-attach", () => tripApi.attachWallet(trip.share_slug, w.wallet.share_slug), "Wallet started for this trip.");
  }

  function onPaste(e: React.FormEvent) {
    e.preventDefault();
    const share = slugFromLink(link, "wallet");
    if (!share) return setProblem("Paste the wallet's link, like tara-gala-ph.vercel.app/w/…");
    setProblem("");
    void write("wallet-attach", () => tripApi.attachWallet(trip.share_slug, share), "Wallet added to the trip.");
  }

  return (
    <section aria-labelledby="money-title" className="flex flex-col gap-3">
      <SectionTitle id="money-title">Shared expenses</SectionTitle>
      {trip.wallet ? (
        <>
          <PixelCardLink href={`/w/${trip.wallet.share_slug}`} className="flex items-center justify-between gap-3 p-4">
            <span className="flex min-w-0 flex-col gap-1">
              <span className="break-words font-bold">{trip.wallet.name}</span>
              <span className={PX.meta}>Who paid what, and who pays whom at the end.</span>
            </span>
            <span aria-hidden="true">→</span>
          </PixelCardLink>
          <PixelButton variant="secondary" className="self-start px-4 text-sm" disabled={busy}
            onClick={() => write("wallet-detach", () => tripApi.detachWallet(trip.share_slug), "Wallet taken off the trip. It still has its own link.")}>
            Use a different wallet
          </PixelButton>
        </>
      ) : (
        <PixelBox className="flex flex-col gap-3 p-4">
          <p className="text-sm text-muted">No wallet yet. Start one for this trip, or add one you already use.</p>
          <form onSubmit={onStart} noValidate className="flex items-end gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
              <span className="font-semibold">Your name</span>
              <input className={cx(PX.input, "w-full")} value={me} maxLength={30} autoComplete="given-name" onChange={(e) => setMe(e.target.value)} />
            </label>
            <PixelButton type="submit" variant="primary" className="px-4 text-sm" disabled={busy || starting}>
              {starting ? "Starting..." : "Start"}
            </PixelButton>
          </form>
          {mine.length > 0 && (
            <ul className="flex flex-col gap-2">
              {mine.map((w) => (
                <li key={w.slug}>
                  <PixelButton variant="secondary" className="w-full px-4 text-left text-sm" disabled={busy}
                    onClick={() => write("wallet-attach", () => tripApi.attachWallet(trip.share_slug, w.slug), "Wallet added to the trip.")}>
                    Use “{w.name}”
                  </PixelButton>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={onPaste} noValidate className="flex items-end gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
              <span className="font-semibold">Wallet link</span>
              <input className={cx(PX.input, "w-full")} value={link} inputMode="url" autoComplete="off" onChange={(e) => setLink(e.target.value)} />
            </label>
            <PixelButton type="submit" variant="secondary" className="px-4 text-sm" disabled={busy}>
              Add
            </PixelButton>
          </form>
          {problem && <Problem text={problem} />}
        </PixelBox>
      )}
    </section>
  );
}

function HotelSection({ trip, busy, write, onFail }: { trip: Trip; busy: boolean; write: Write; onFail: (text: string) => void }) {
  const [editing, setEditing] = useState(false);
  const hotel = trip.hotel;
  return (
    <section aria-labelledby="hotel-title" className="flex flex-col gap-3">
      <SectionTitle id="hotel-title">Where we&apos;re staying</SectionTitle>
      {hotel && !editing ? (
        <PixelBox className="flex flex-col gap-2 p-4">
          <p className="break-words font-bold">{hotel.name}</p>
          {hotel.address && <p className="break-words text-sm">{hotel.address}</p>}
          {(hotel.check_in || hotel.check_out) && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              {hotel.check_in && (<><dt className="text-muted">Check in</dt><dd>{hotelTime(hotel.check_in)}</dd></>)}
              {hotel.check_out && (<><dt className="text-muted">Check out</dt><dd>{hotelTime(hotel.check_out)}</dd></>)}
            </dl>
          )}
          {hotel.booking_ref && <p className="text-sm"><span className="text-muted">Booking </span><span className="font-semibold">{hotel.booking_ref}</span></p>}
          {hotel.notes && <p className="whitespace-pre-line break-words text-sm">{hotel.notes}</p>}
          <div className="flex flex-wrap gap-2 pt-1">
            <PixelLink variant="secondary" href={hotelMapsUrl(hotel)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center px-4 text-sm">
              Google Maps<span aria-hidden="true">&nbsp;↗</span>
            </PixelLink>
            <PixelButton variant="secondary" className="px-4 text-sm" onClick={() => setEditing(true)}>
              Edit
            </PixelButton>
          </div>
          <HotelProof trip={trip} busy={busy} write={write} onFail={onFail} />
        </PixelBox>
      ) : (
        <HotelForm
          key={hotel ? "edit" : "new"}
          hotel={hotel ?? NO_HOTEL}
          busy={busy}
          onCancel={hotel ? () => setEditing(false) : undefined}
          onRemove={hotel ? () => write("hotel-remove", () => tripApi.removeHotel(trip.share_slug), "Hotel removed.").then((ok) => ok && setEditing(false)) : undefined}
          onSave={(h) => write("hotel-set", () => tripApi.setHotel(trip.share_slug, h), "Hotel saved.").then((ok) => ok && setEditing(false))}
        />
      )}
    </section>
  );
}

function HotelForm({ hotel, busy, onSave, onCancel, onRemove }: {
  hotel: Hotel; busy: boolean; onSave: (h: Hotel) => void; onCancel?: () => void; onRemove?: () => void;
}) {
  const [h, setH] = useState({ ...hotel, check_in: toInput(hotel.check_in), check_out: toInput(hotel.check_out) });
  const [problem, setProblem] = useState("");
  const field = (key: keyof Hotel) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setH((prev) => ({ ...prev, [key]: e.target.value }));

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!h.name.trim()) return setProblem("Add the hotel's name.");
    const check_in = toWallTime(h.check_in ?? "");
    const check_out = toWallTime(h.check_out ?? "");
    if (check_in && check_out && check_out <= check_in) return setProblem("Check out has to be after check in.");
    setProblem("");
    onSave({ name: h.name.trim(), address: h.address.trim(), check_in, check_out, booking_ref: h.booking_ref.trim(), notes: h.notes.trim() });
  }

  return (
    <PixelBox as="form" onSubmit={onSubmit} noValidate className="flex flex-col gap-3 p-4">
      {!onCancel && <p className="text-sm text-muted">Add the hotel so everyone has the address and times.</p>}
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-semibold">Hotel name</span>
        <input className={PX.input} value={h.name} maxLength={80} onChange={field("name")} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-semibold">Address</span>
        <input className={PX.input} value={h.address} maxLength={200} autoComplete="off" onChange={field("address")} />
      </label>
      <div className="grid grid-cols-1 gap-2">
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          <span className="font-semibold">Check in</span>
          <input type="datetime-local" className={cx(PX.input, "w-full")} value={h.check_in ?? ""} onChange={field("check_in")} />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          <span className="font-semibold">Check out</span>
          <input type="datetime-local" className={cx(PX.input, "w-full")} value={h.check_out ?? ""} onChange={field("check_out")} />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-semibold">Booking reference</span>
        <input className={PX.input} value={h.booking_ref} maxLength={40} autoComplete="off" onChange={field("booking_ref")} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-semibold">Notes</span>
        <textarea className={PX.input} rows={2} value={h.notes} maxLength={300} onChange={field("notes")} />
      </label>
      {problem && <Problem text={problem} />}
      <div className="flex flex-wrap gap-2">
        <PixelButton type="submit" variant="primary" className="px-4 text-sm" disabled={busy}>
          Save hotel
        </PixelButton>
        {onCancel && (
          <PixelButton variant="secondary" className="px-4 text-sm" onClick={onCancel}>
            Cancel
          </PixelButton>
        )}
        {onRemove && (
          <PixelButton variant="secondary" className="px-4 text-sm" disabled={busy} onClick={onRemove}>
            Remove hotel
          </PixelButton>
        )}
      </div>
    </PixelBox>
  );
}

function DeleteTrip({ trip, onDeleted }: { trip: Trip; onDeleted: () => void }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  async function onDelete(e: React.FormEvent) {
    e.preventDefault();
    if (typed.trim().toLowerCase() !== trip.name.toLowerCase()) return setProblem("Type the trip's name exactly to delete it.");
    setBusy(true);
    const r = await tripApi.remove(trip.share_slug, typed);
    setBusy(false);
    console.info("[tg-trip] delete ok=%s", r.ok ? "yes" : r.why);
    if (!r.ok) return setProblem(tripFailureMessage(r));
    onDeleted();
  }

  return (
    <details className="text-sm">
      <summary className="cursor-pointer font-semibold">Delete this trip</summary>
      <form onSubmit={onDelete} noValidate className="mt-3 flex flex-col gap-3">
        <p className="text-muted">
          This deletes the trip, its hotel, its list of people and their photos, and its shared tickets and QRs from the server, not from phones that already saved the trip. The plan and the wallet keep their own links. Type <span className="font-semibold text-foreground">{trip.name}</span> to confirm.
        </p>
        <input className={PX.input} value={typed} autoComplete="off" aria-label="Trip name, to confirm" onChange={(e) => setTyped(e.target.value)} />
        {problem && <Problem text={problem} />}
        <PixelButton type="submit" variant="secondary" className="self-start px-4" disabled={busy}>
          {busy ? "Deleting..." : "Delete the trip"}
        </PixelButton>
      </form>
    </details>
  );
}
