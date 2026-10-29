"use client";

// The itinerary as a vertical overworld (TG-22, ux.md 1 to 6). It's an ordered list in plan order, drawn as a world:
// the grass, the path and the sprites are decoration behind readable signs. Renders from props only, so it works
// from saved data offline (TG-27). The layout rules live in lib/world.ts.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { formatDayOffset, formatTime, formatVerified } from "@/lib/api";
import { formatTravelDate } from "@/lib/direction";
import { formatPeso, issuesFor, partySummary, type Itinerary } from "@/lib/itinerary";
import { formatFare, formatMinutes, modeLabel } from "@/lib/lastMile";
import { SPRITES, modeSprite, placeSprite, spriteSrc, type SpriteName } from "@/lib/sprites";
import {
  CHANGED,
  MIN_WORLD,
  mapsTarget,
  rowData,
  scenery,
  signBoxes,
  trackGeometry,
  turnRotations,
  usableWidth,
  worldLayout,
  worldSections,
  type Formatters,
  type SceneryItem,
  type Side,
  type SignLines,
  type WorldRow,
} from "@/lib/world";
import { useSpawn } from "@/components/useSpawn";
import PartyStage from "@/components/PartyStage";
import WorldSheet, { MapsLink, Sprite } from "@/components/WorldSheet";
import { PX, SectionTitle } from "@/components/pixel";

const F: Formatters = {
  time: formatTime,
  dayOffset: formatDayOffset,
  verified: formatVerified,
  travelDate: formatTravelDate,
  modeLabel,
  fare: formatFare,
  minutes: formatMinutes,
  peso: formatPeso,
  partySummary,
  issuesFor,
  placeSprite,
  modeSprite,
};

const TILE = 32;
const SIGN = `${PX.screenChip} block min-w-0 break-words`;
const tile = (name: SpriteName): CSSProperties => ({
  backgroundImage: `url(${spriteSrc(name)})`,
  backgroundSize: `${TILE}px`,
});

type Geometry = ReturnType<typeof trackGeometry> & { W: number };

/** Where a row's box, track and sign sit for its side (ux.md 2.1): the sign is on the side away from the track. */
function placement(side: Side, g: Geometry) {
  const signs = signBoxes(g.W);
  if (side === "left") {
    return { trackX: g.leftX, boxLeft: g.leftX, boxWidth: g.W - 8 - g.leftX, signLeft: signs.left.x - g.leftX, signWidth: signs.left.width };
  }
  return { trackX: g.rightX, boxLeft: 8, boxWidth: g.rightX + TILE - 8, signLeft: signs.right.x - 8, signWidth: signs.right.width };
}

function Track({ x, road }: { x: number; road?: boolean }) {
  return (
    <div
      aria-hidden="true"
      className="pixelated absolute inset-y-0"
      style={{ left: x, width: TILE, backgroundRepeat: "repeat-y", ...tile(road ? "tile-road" : "tile-path-straight") }}
    />
  );
}

function SignBody({ sign, bus }: { sign: SignLines; bus?: boolean }) {
  return (
    <>
      {bus && !sign.missing && <Sprite name="vehicle-bus" className="block" />}
      <span className="block text-sm font-bold">{sign.title}</span>
      {sign.lines.map((line) => (
        <span key={line} className={`block text-xs tabular-nums ${line === CHANGED ? "font-semibold text-screen-ink" : "text-screen-muted"}`}>
          {line}
        </span>
      ))}
      {sign.checked && (
        <span className="flex items-center gap-1 text-xs text-screen-muted">
          <Sprite name="ui-badge-verified" scale={1} />
          {sign.checked}
        </span>
      )}
    </>
  );
}

function rowSpriteStyle(name: SpriteName, boxX: number): CSSProperties {
  return { left: boxX + TILE / 2 - SPRITES[name].w }; // 2x art, centred on the track
}

type RowProps = { row: Extract<WorldRow, { kind: "node" | "leg" }>; g: Geometry; onOpen(id: string, el: HTMLElement): void };

function SignRow({ row, g, onOpen }: RowProps) {
  const p = placement(row.side, g);
  const isLeg = row.kind === "leg";
  const onTrack = !(isLeg && row.track === "road") ? row.sprite : null; // the bus sprite is too wide: it sits in the sign
  const inner = (
    <>
      {onTrack && (
        <Sprite name={onTrack} className="absolute top-1/2 -translate-y-1/2" style={rowSpriteStyle(onTrack, p.trackX - p.boxLeft)} />
      )}
      <span className={SIGN} style={{ marginLeft: p.signLeft, width: p.signWidth }}>
        <SignBody sign={row.sign} bus={isLeg && row.track === "road"} />
      </span>
    </>
  );
  return (
    <li className="relative z-[1]">
      <Track x={p.trackX} road={isLeg && row.track === "road"} />
      {row.sign.missing ? (
        // A row that didn't join has no sheet (plan B6), so it's not a button
        <div className="relative min-h-14 py-2" style={{ marginLeft: p.boxLeft, width: p.boxWidth }}>
          {inner}
        </div>
      ) : (
        <button type="button" onClick={(e) => onOpen(row.id, e.currentTarget)}
          className="group relative block min-h-14 py-2 text-left focus-pixel"
          style={{ marginLeft: p.boxLeft, width: p.boxWidth }}
        >
          {inner}
          {/* A second cue next to the focus outline, never instead of it */}
          <Sprite
            name="ui-cursor"
            scale={3}
            className="absolute top-3 z-10 hidden group-hover:block group-focus-visible:block"
            style={{ left: row.side === "left" ? p.signLeft - 26 : p.signWidth + 2 }}
          />
        </button>
      )}
    </li>
  );
}

// Scenery (TG-45) paints first and under z-0; sign and to-terminal rows are z-[1], so their focus outlines and
// the hover cursor always paint over it
function TurnRow({ from, to, g, decor }: { from: Side; to: Side; g: Geometry; decor?: SceneryItem }) {
  const { start, end } = turnRotations(from, to);
  const startX = from === "left" ? g.leftX : g.rightX;
  const endX = to === "left" ? g.leftX : g.rightX;
  return (
    <li aria-hidden="true" role="presentation" className="relative h-8">
      {decor && <Sprite name={decor.sprite} scale={1} className="absolute z-0 pointer-events-none" style={{ left: decor.x, top: decor.y }} />}
      <Sprite name="tile-path-corner" className="absolute top-0" style={{ left: startX, transform: `rotate(${start}deg)` }} />
      {Array.from({ length: g.straights }, (_, k) => (
        <Sprite key={k} name="tile-path-straight" className="absolute top-0" style={{ left: g.leftX + TILE + k * TILE, transform: "rotate(90deg)" }} />
      ))}
      <Sprite name="tile-path-corner" className="absolute top-0" style={{ left: endX, transform: `rotate(${end}deg)` }} />
    </li>
  );
}

function PlainRow({ side, g, children }: { side: Side; g: Geometry; children: ReactNode }) {
  const p = placement(side, g);
  return (
    <li className="relative z-[1]">
      <Track x={p.trackX} />
      <div className="relative min-h-14 py-2" style={{ marginLeft: p.boxLeft, width: p.boxWidth }}>
        <span className={SIGN} style={{ marginLeft: p.signLeft, width: p.signWidth }}>
          {children}
        </span>
      </div>
    </li>
  );
}

export default function OverworldMap({ itinerary }: { itinerary: Itinerary }) {
  const rows = useMemo(() => worldLayout(itinerary, F), [itinerary]);
  const sections = useMemo(() => worldSections(rows), [rows]);
  const party = rows[0].kind === "party" ? rows[0].summary : "";

  // The world's inner width: 316 at 380px (the first paint), re-measured on narrower or wider phones
  const worldRef = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(316);
  useEffect(() => {
    const el = worldRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setW((w) => usableWidth(Math.round(entry.contentRect.width), w)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const g: Geometry = { ...trackGeometry(W), W: Math.max(W, MIN_WORLD) }; // narrower worlds draw as a 320px phone's
  // Philippine decor in the outer gutters of every other turn row, seeded by the share slug (TG-45, ux.md 2.3)
  const decor = useMemo(() => scenery(rows, itinerary.share_slug, g.W), [rows, itinerary.share_slug, g.W]);
  const decorByRow = useMemo(() => new Map(decor.map((d) => [d.rowId, d])), [decor]);
  useEffect(() => {
    console.info("[tg-map] scenery n=%d w=%d", decor.length, g.W);
  }, [decor.length, g.W]);

  // The party spawns once when the map first renders; any tap, key or scroll skips it (TG-15's controller)
  const { active, step, start, skip } = useSpawn();
  useEffect(() => {
    start(itinerary.party.map((_, i) => i));
  }, [start, itinerary.party]);
  useEffect(() => {
    const onScroll = () => {
      skip();
      window.removeEventListener("scroll", onScroll);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [skip]);

  useEffect(() => {
    const missing = rows.filter((r) => (r.kind === "node" || r.kind === "leg") && r.sign.missing).length;
    console.info("[tg-map] render rows=%d days=%d missing=%d", rows.length, itinerary.days.length, missing);
  }, [rows, itinerary.days.length]);

  // One dialog for the page; its content is the tapped row. Focus goes back to that row on close.
  const dialogRef = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [sheetId, setSheetId] = useState<string | null>(null);
  useEffect(() => {
    if (sheetId && !dialogRef.current?.open) dialogRef.current?.showModal();
  }, [sheetId]);
  const open = (id: string, el: HTMLElement) => {
    const kind = rowData(itinerary, id)?.kind;
    if (!kind) return;
    console.info("[tg-map] sheet kind=%s", kind);
    opener.current = el;
    setSheetId(id);
  };
  const closed = () => {
    setSheetId(null);
    opener.current?.focus();
  };

  return (
    <div onPointerDownCapture={skip} onKeyDownCapture={skip}>
      {/* The game screen: a 9-slice frame over grass, fixed light in both themes (ux-guide 1.3) */}
      <div
        className="pixelated"
        style={{ border: "16px solid transparent", borderImage: `url(${spriteSrc("ui-dialog-frame")}) 8 / 16px stretch` }}
      >
        <div
          ref={worldRef}
          className="pixelated bg-screen text-screen-ink flex flex-col gap-0 pb-4"
          // The screen stays light in dark mode, so frames, text and the focus outline on it stay Ink rather than
          // the theme's Mint, Cream and Sun (which would vanish on Mint)
          style={
            {
              ...tile("tile-grass"),
              "--frame": "var(--color-screen-ink)",
              "--foreground": "var(--color-screen-ink)",
              "--focus": "var(--color-screen-ink)",
            } as CSSProperties
          }
        >
          <div className="px-2 pt-3 pb-2 flex flex-col gap-2">
            <p className={SIGN}>Your party · {party}</p>
            <PartyStage party={itinerary.party} spawning={active} step={step} fixedRows={false} />
          </div>
          {sections.map(({ banner, rows: list }) => (
            <section key={banner.id} aria-labelledby={banner.id} className="flex flex-col">
              <div className="mx-2 my-2 pixel-frame bg-flag-blue px-3 py-1 text-center">
                <SectionTitle onScreen="banner" id={banner.id}>{banner.text}</SectionTitle>
              </div>
              <ol className="flex flex-col">
                {list.map((r) => {
                  if (r.kind === "node" || r.kind === "leg") return <SignRow key={r.id} row={r} g={g} onOpen={open} />;
                  if (r.kind === "turn") return <TurnRow key={r.id} from={r.from} to={r.to} g={g} decor={decorByRow.get(r.id)} />;
                  if (r.kind === "free") {
                    return (
                      <PlainRow key={r.id} side={r.side} g={g}>
                        {r.text}
                      </PlainRow>
                    );
                  }
                  if (r.kind === "toTerminal") {
                    const target = mapsTarget(itinerary, r.id);
                    return (
                      <PlainRow key={r.id} side={r.side} g={g}>
                        <span className="block text-sm font-bold">{r.text}</span>
                        {target && (
                          <span className="mt-2 block">
                            <MapsLink target={target} />
                          </span>
                        )}
                      </PlainRow>
                    );
                  }
                  return null;
                })}
              </ol>
            </section>
          ))}
        </div>
      </div>
      <WorldSheet itinerary={itinerary} rowId={sheetId} f={F} dialogRef={dialogRef} onClose={closed} />
    </div>
  );
}
