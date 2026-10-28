"use client";

// The overworld map's detail sheet (TG-22, ux.md 3): one native dialog element whose content is the tapped row.
// Escape closes it natively; Close and a backdrop tap close it too. The map returns focus to the row.
import { useId, type CSSProperties, type RefObject } from "react";
import { googleMapsUrl } from "@/lib/mapLinks";
import { SPRITES, spriteSrc, type SpriteName } from "@/lib/sprites";
import { legSheet, mapsLabel, mapsTarget, rowData, stopSheet, type Formatters, type MapsTarget } from "@/lib/world";
import type { Itinerary } from "@/lib/itinerary";
import TripCard from "@/components/TripCard";
import { DialogBox, PX, PixelButton, PixelLink } from "@/components/pixel";

/** A TG-33 sprite at a whole-number scale. Decorative: the text next to it says the same thing. */
export function Sprite({ name, scale = 2, className = "", style }: { name: SpriteName; scale?: 1 | 2 | 3; className?: string; style?: CSSProperties }) {
  const width = SPRITES[name].w * scale;
  const height = SPRITES[name].h * scale;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- pixel art: next/image would resample PNG art and needs dangerouslyAllowSVG
    <img
      src={spriteSrc(name)}
      width={width}
      height={height}
      alt=""
      className={`pixelated ${className}`}
      style={style}
      draggable={false}
      decoding="async"
      onError={() => {
        console.warn("[tg-map] sprite failed %s", name);
      }}
    />
  );
}

/** "Open in Google Maps" (ux.md 3.3): from where the phone is, to the place. Rendered offline too. */
export function MapsLink({ target }: { target: MapsTarget }) {
  return (
    <PixelLink
      variant="primary"
      external
      href={googleMapsUrl(target.place, target.travelmode)}
      aria-label={mapsLabel(target.name)}
      className="flex w-full items-center justify-center gap-1 px-4 py-3"
    >
      Open in Google Maps <span aria-hidden="true">↗</span>
    </PixelLink>
  );
}

function Rows({ rows, strong }: { rows: [string, string][]; strong?: string }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted">{label}</dt>
          <dd className={`min-w-0 break-words ${label === strong ? "font-semibold" : ""}`}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Checked({ text }: { text: string }) {
  return (
    <p className="flex items-center gap-2 text-xs text-muted">
      {/* A sprite never sits straight on a themed card (ux-guide 1.3): the badge gets its fixed paper plate */}
      <span className="pixel-frame bg-screen-paper p-0.5 inline-flex">
        <Sprite name="ui-badge-verified" scale={1} />
      </span>
      {text}
    </p>
  );
}

type Props = {
  itinerary: Itinerary;
  rowId: string | null;
  f: Formatters;
  dialogRef: RefObject<HTMLDialogElement | null>;
  onClose(): void;
};

export default function WorldSheet({ itinerary: it, rowId, f, dialogRef, onClose }: Props) {
  const titleId = useId();
  const data = rowId ? rowData(it, rowId) : null;
  const target = rowId ? mapsTarget(it, rowId) : null;

  let title = "";
  let body = null;
  if (data?.kind === "leg") {
    const sheet = legSheet(data.leg, f);
    title = sheet.title;
    body = (
      <>
        <Rows rows={sheet.rows} strong="Signboard" />
        <Checked text={sheet.checked} />
        <p className="text-xs text-muted">{sheet.note}</p>
      </>
    );
  } else if (data?.kind === "stop") {
    const sheet = stopSheet(data.stop, f);
    title = sheet?.title ?? "";
    body = sheet && <Rows rows={sheet.rows} />;
  } else if (data?.kind === "bus") {
    const t = data.trip;
    title = `${t.operator_name} · ${t.origin_name} → ${t.destination_name}`;
    // The same card as the search page: times, +1 day, fare, Checked, terminal links and Book
    // TripCard leaves confirm_note to the list on search, so the sheet adds it: Checked plus confirm, as on every trip
    body = (
      <>
        <ul className="flex flex-col">
          <TripCard trip={t} />
        </ul>
        <p className="text-xs text-muted">{t.confirm_note}</p>
      </>
    );
  } else if (data?.kind === "terminal") {
    const t = data.trip;
    title = data.end === "origin" ? t.origin_name : t.destination_name;
    const when =
      data.end === "origin"
        ? `Departs ${f.time(t.departure_time)}`
        : t.arrives_around
          ? `Arrives ${f.time(t.arrives_around)}${f.dayOffset(t.arrives_day_offset)}`
          : null;
    body = when && <p className="text-sm tabular-nums">{when}</p>;
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={onClose}
      // A tap on the backdrop lands on the dialog itself; taps inside land on the box
      onClick={(e) => e.target === e.currentTarget && e.currentTarget.close()}
      className="m-0 mt-auto mx-auto mb-4 w-[calc(100%-2rem)] max-w-md max-h-[70dvh] overflow-y-auto bg-transparent p-0 text-foreground backdrop:bg-screen-ink/60"
    >
      <DialogBox>
        <div className="flex flex-row-reverse items-start justify-between gap-3">
          {/* First in the DOM, so showModal() focuses Close */}
          <PixelButton variant="secondary" onClick={() => dialogRef.current?.close()}>
            Close
          </PixelButton>
          <h2 id={titleId} className={`${PX.dataHeading} min-w-0 break-words`}>
            {title}
          </h2>
        </div>
        {body}
        {target && <MapsLink target={target} />}
      </DialogBox>
    </dialog>
  );
}
