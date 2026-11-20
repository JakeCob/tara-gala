"use client";

// TG-64: the recap page /r/<slug> (ux.md §3 and §4). Read-only: the trip's map as travelled, with only what the group
// picked to show. Pictures load through the recap's own URLs, and nothing is kept on this phone.

import { type Ref, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PX, PageTitle, PixelBox, PixelButton, PixelLink, SectionTitle, cx } from "@/components/pixel";
import { BlobImage, PhotoViewer } from "@/components/PhotoViewer";
import LevelMap from "@/components/LevelMap";
import { arrivalTime } from "@/lib/people";
import { type Recap, type RecapPhoto, type RecapResult, allLevels, countLine, fetchRecap, fetchRecapFile, recapDates, recapFileUrl } from "@/lib/recap";
import type { TripFile } from "@/lib/trip";

type Load = { state: "loading" } | RecapResult;

const FIRST_PHOTOS = 6;
const TILE = "aspect-[3/4] w-full border-2 border-frame bg-screen-paper object-cover";
const AVATAR_BOX = "h-10 w-10 shrink-0 border-2 border-frame bg-screen-paper object-cover text-screen-ink";
const peso = (centavos: number) => `₱${(centavos / 100).toLocaleString("en-PH", { maximumFractionDigits: 0 })}`;

/** The map takes trip files; a recap photo is only its id and row */
const asFile = (p: RecapPhoto): TripFile => ({
  id: p.id, kind: "photo", label: "", member_id: null, content_type: "", bytes: 0, delete_after: null, row_key: p.row_key, attendee_id: null, created_at: "",
});

export default function RecapView({ slug }: { slug: string }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [tries, setTries] = useState(0);

  useEffect(() => {
    let live = true;
    void fetchRecap(slug).then((r) => live && setLoad(r));
    return () => {
      live = false;
    };
  }, [slug, tries]);

  if (!("ok" in load)) {
    return (
      <div className="flex flex-col gap-3">
        <PageTitle>Trip recap</PageTitle>
        <p className={PX.meta}>Opening the recap...</p>
      </div>
    );
  }
  if (!load.ok) {
    return (
      <div className="flex flex-col gap-4">
        <PageTitle>Trip recap</PageTitle>
        {load.why === "gone" ? (
          <>
            <p className="text-sm">{"This recap isn't shared any more. Ask whoever sent it for a new link."}</p>
            <PixelLink variant="secondary" href="/" className="self-start">Plan your own trip</PixelLink>
          </>
        ) : (
          <>
            <PixelBox as="p" tone="alertText" role="alert" className="p-3 text-sm">{"Couldn't open the recap. Check your signal and try again."}</PixelBox>
            <PixelButton variant="secondary" className="self-start" onClick={() => { setLoad({ state: "loading" }); setTries((n) => n + 1); }}>
              Try again
            </PixelButton>
          </>
        )}
      </div>
    );
  }
  return <RecapBody slug={slug} recap={load.recap} />;
}

function RecapBody({ slug, recap }: { slug: string; recap: Recap }) {
  const levels = useMemo(() => allLevels(recap), [recap]);
  const anyDone = levels.some((l) => l.done);
  const fetchPhoto = useCallback((id: string) => fetchRecapFile(recapFileUrl(slug, "photo", id)), [slug]);
  const files = useMemo(() => (recap.photos ?? []).map(asFile), [recap.photos]);
  const captions = useMemo(() => new Map(levels.map((l) => [l.row.key, `${l.label} · ${l.row.plan}`])), [levels]);
  const caption = (p: RecapPhoto) => (p.row_key && captions.get(p.row_key)) || "On the trip";

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <PageTitle>Trip recap</PageTitle>
        <p className="text-lg font-bold break-words">{recap.name}</p>
        <p className="text-sm">{recapDates(recap.start_date, recap.return_date)}</p>
        <p className="text-sm tabular-nums">{countLine(recap)}</p>
        {recap.still_on && <p className="text-sm">The trip is still on. This page fills in as the group ticks stops and adds photos.</p>}
      </header>

      {recap.guide && (
        <section aria-labelledby="recap-trip" className="flex flex-col gap-3">
          <SectionTitle id="recap-trip">The trip</SectionTitle>
          <p className="text-sm text-muted md:max-w-prose">
            Each stop is a level. Done ones have a tick and the time the group ticked it.{recap.photos ? " Tap one for its photos." : ""}
          </p>
          {!anyDone && <p className="text-sm">No stops ticked yet.</p>}
          <LevelMap guide={recap.guide} marks={recap.marks} recap photos={recap.photos ? { files, fetch: fetchPhoto } : undefined} />
        </section>
      )}

      {recap.photos && recap.photos.length > 0 && <Album photos={recap.photos} caption={caption} fetchPhoto={fetchPhoto} />}

      {recap.people.list && (
        <PixelBox as="section" aria-labelledby="recap-people" className="flex flex-col gap-3 p-4">
          <SectionTitle id="recap-people">Who came</SectionTitle>
          <p className="text-sm">{`${recap.people.count} came. Times are when each got to the meet-up, ${recapDates(recap.start_date, recap.start_date)}.`}</p>
          <ul className="flex flex-col">
            {recap.people.list.map((p, i) => (
              <li key={i} className="flex items-center gap-3 border-b-2 border-border py-2 last:border-b-0">
                <Face slug={slug} id={p.avatar_id} name={p.name} />
                <span className="min-w-0 flex-1 break-words">{p.name}</span>
                {p.arrived_at ? <span className="text-sm whitespace-nowrap tabular-nums">{arrivalTime(p.arrived_at)}</span> : <span className={PX.meta}>Joined later</span>}
              </li>
            ))}
          </ul>
        </PixelBox>
      )}

      {recap.spending && (
        <PixelBox as="section" aria-labelledby="recap-spending" className="flex flex-col gap-2 p-4">
          <SectionTitle id="recap-spending">Spending</SectionTitle>
          <p className="text-base"><span className="font-bold tabular-nums">{peso(recap.spending.total_centavos)}</span> in all</p>
          <p className={PX.meta}>{"From the group's shared wallet."}</p>
        </PixelBox>
      )}

      <PixelBox className="flex flex-col gap-3 p-4">
        <p className="text-sm">{"This is one group's trip. Bus times and fares change, so check today's on Buses before you go."}</p>
        <div className="flex flex-wrap gap-2">
          <PixelLink variant="secondary" href="/buses">{"See today's buses"}</PixelLink>
          <PixelLink variant="secondary" href="/">Plan your own trip</PixelLink>
        </div>
      </PixelBox>
    </div>
  );
}

function Album({ photos, caption, fetchPhoto }: { photos: RecapPhoto[]; caption: (p: RecapPhoto) => string; fetchPhoto: (id: string) => Promise<Blob | null> }) {
  const [all, setAll] = useState(false);
  const [shown, setShown] = useState<{ blob: Blob; label: string } | null>(null);
  const firstNew = useRef<HTMLButtonElement>(null);
  const list = all ? photos : photos.slice(0, FIRST_PHOTOS);

  useEffect(() => {
    if (all) firstNew.current?.focus(); // the first tile Show all revealed
  }, [all]);

  return (
    <section aria-labelledby="recap-photos" className="flex flex-col gap-3">
      <SectionTitle id="recap-photos">Photos</SectionTitle>
      <ul className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {list.map((p, i) => (
          <PixelBox as="li" key={p.id} className="flex flex-col gap-2 p-2">
            <PhotoTile photo={p} label={caption(p)} fetchPhoto={fetchPhoto} buttonRef={i === FIRST_PHOTOS ? firstNew : undefined}
              onShow={(blob) => setShown({ blob, label: caption(p) })} />
          </PixelBox>
        ))}
      </ul>
      {!all && photos.length > FIRST_PHOTOS && (
        <PixelButton variant="secondary" className="self-start px-4 text-sm" onClick={() => setAll(true)}>
          {`Show all ${photos.length} photos`}
        </PixelButton>
      )}
      <PhotoViewer photo={shown} onClose={() => setShown(null)} logTag="tg-recap" />
    </section>
  );
}

function PhotoTile({ photo, label, fetchPhoto, buttonRef, onShow }: {
  photo: RecapPhoto; label: string; fetchPhoto: (id: string) => Promise<Blob | null>; buttonRef?: Ref<HTMLButtonElement>; onShow: (blob: Blob) => void;
}) {
  const [got, setGot] = useState<Blob | null | undefined>(undefined); // undefined: still loading
  useEffect(() => {
    let live = true;
    void fetchPhoto(photo.id).then((blob) => live && setGot(blob));
    return () => {
      live = false;
    };
  }, [fetchPhoto, photo.id]);
  return (
    <button ref={buttonRef} type="button" className="focus-pixel flex flex-col gap-2 text-left" aria-label={`Photo: ${label}`} onClick={() => got && onShow(got)}>
      {got ? <BlobImage blob={got} alt="" width={160} height={213} className={TILE} />
        : got === null ? <span className={cx(TILE, "flex items-center justify-center p-2 text-center text-xs")}>{"Couldn't load this photo."}</span>
        : <span aria-hidden="true" className={TILE} />}
      <span className="line-clamp-2 text-xs">{label}</span>
    </button>
  );
}

/** A profile photo through the recap's own URL, or the initial plate as on the trip's list */
function Face({ slug, id, name }: { slug: string; id: string | null; name: string }) {
  const [blob, setBlob] = useState<Blob | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    void fetchRecapFile(recapFileUrl(slug, "avatar", id)).then((b) => live && setBlob(b));
    return () => {
      live = false;
    };
  }, [slug, id]);
  if (blob) return <BlobImage blob={blob} alt="" width={40} height={40} className={AVATAR_BOX} />;
  return (
    <span aria-hidden="true" className={cx(AVATAR_BOX, "inline-flex items-center justify-center text-sm font-bold")}>
      {[...name][0]?.toUpperCase()}
    </span>
  );
}
