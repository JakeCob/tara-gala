"use client";

import { useEffect, useRef, useState } from "react";
import { PX, PixelBox, PixelButton, cx } from "@/components/pixel";
import { PhotoViewer } from "@/components/PhotoViewer";
import { Thumb } from "@/components/TripFiles";
import { Sprite } from "@/components/WorldSheet";
import { formatClass, formatTime, formatVerified } from "@/lib/api";
import { type BusTable, type Guide, type Mark, marksByKey, pickMark, placeIcon, rowMark, todoMark, whereNow } from "@/lib/guide";
import {
  GOAL_POINT, TILE_PX, type Level, levelPoints, levels, placeMapsUrl, roadPath, startPoint, startWorld, worldHeight,
} from "@/lib/levelMap";
import { chibi } from "@/lib/sprites";
import { type TripFile, fetchFile } from "@/lib/trip";

export type Photos = {
  slug: string;
  files: TripFile[];
  onAdd: (rowKey: string | null, picked: File[]) => void;
  onDelete: (file: TripFile) => void;
};

type Props = {
  guide: Guide;
  /** The trip's ticks and picks; without them the map is read-only (the plan's own page) */
  marks?: readonly Mark[];
  busy?: boolean;
  /** The last write's failure: the trip's own notice sits behind the level dialog, so the dialog repeats it */
  problem?: string | null;
  onTick?: (key: string, done: boolean) => void;
  onPick?: (pickKey: string, option: string) => void;
  photos?: Photos;
};

type Menu = "buses" | "budget" | "todo" | "sources" | "album";
const peso = (n: number) => `₱${n.toLocaleString("en-PH", { maximumFractionDigits: 0 })}`;
const ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

/**
 * TG-52: the trip as a game level map (owner, 2026-11-02). One world per day; each row is a level on a road that winds
 * up the green screen from START to GOAL. A done level wears a badge, the group's chibi stands on the latest-ticked
 * level, and tapping a level opens its dialog: what to do, Done or Not yet, and that level's photos. Below the map, a
 * menu opens the buses, budget, to-dos, sources and the trip's album.
 */
export default function LevelMap({ guide, marks, busy, problem, onTick, onPick, photos }: Props) {
  const live = !!onTick;
  const byKey = marksByKey(marks ?? []);
  const [world, setWorld] = useState(() => startWorld(guide, marks ?? []));
  const [open, setOpen] = useState<Level | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const here = marks ? whereNow(guide, marks) : null;
  const day = guide.days.find((d) => d.day === world) ?? guide.days[0];
  const list = levels(day, byKey);
  const points = levelPoints(list.length);
  const height = worldHeight(list.length);
  const start = startPoint(list.length);
  const chosen = day.pick ? byKey.get(pickMark(day.pick.key))?.value : undefined;
  const photosAt = (key: string | null) => photos?.files.filter((f) => f.kind === "photo" && f.row_key === key) ?? [];
  const current = open && list.find((l) => l.row.key === open.row.key); // stays fresh as ticks land

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-xl font-bold text-balance">{guide.title}</h2>
        {guide.summary && <p className="text-sm text-muted md:max-w-prose">{guide.summary}</p>}
      </header>

      <nav aria-label="Days" className="flex flex-wrap gap-2">
        {guide.days.map((d) => {
          const ls = levels(d, byKey);
          const done = ls.filter((l) => l.done).length;
          return (
            <PixelButton key={d.day} variant={d.day === world ? "primary" : "secondary"} aria-pressed={d.day === world}
              aria-label={marks ? `World ${d.day}, ${done} of ${ls.length} done` : `World ${d.day}`}
              className="min-w-0 flex-1 whitespace-nowrap px-1 text-xs md:px-3 md:text-sm" onClick={() => setWorld(d.day)}>
              <span className="font-bold">World {d.day}</span>
              {marks && <span className="ml-1 tabular-nums">{done}/{ls.length}</span>}
            </PixelButton>
          );
        })}
      </nav>

      <div className="flex flex-col gap-1">
        <h3 className={cx(PX.dataHeading, "text-balance")}>{day.title}</h3>
        {day.intro && <p className="text-sm md:max-w-prose">{day.intro}</p>}
      </div>

      {day.pick && (
        <PixelBox className="flex flex-col gap-2 p-4">
          <p className="font-semibold">{day.pick.title}</p>
          <ul className="flex flex-col gap-2">
            {day.pick.options.map((o) => (
              <li key={o.id} className="flex flex-wrap items-start justify-between gap-2 border-b border-border pb-2 last:border-b-0 last:pb-0">
                <span className="min-w-0 flex-1 text-sm">
                  <span className="font-semibold">{o.id}. {o.label}</span> · leave {formatTime(o.leave)}
                  {o.what && <span className="block text-muted">{o.what}</span>}
                </span>
                {onPick && (
                  <PixelButton variant={chosen === o.id ? "primary" : "secondary"} className="px-3 text-sm" disabled={busy}
                    aria-pressed={chosen === o.id} onClick={() => onPick(day.pick!.key, o.id)}>
                    {chosen === o.id ? "Picked" : `Pick ${o.id}`}
                  </PixelButton>
                )}
              </li>
            ))}
          </ul>
          {marks && <p className={PX.meta}>{chosen ? `The group picked ${chosen}.` : "Nobody has picked yet: the map shows every option."}</p>}
        </PixelBox>
      )}

      {/* The world: a fixed light screen in both themes, like the title screen and the overworld map */}
      <section aria-label={`World ${day.day} map`} className="pixel-frame bg-screen relative mx-auto w-full max-w-md overflow-hidden" style={{ height }}>
        <svg aria-hidden="true" className="absolute inset-0 h-full w-full" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none">
          <path d={roadPath(points, start, GOAL_POINT)} fill="none" className="stroke-screen-ink" strokeWidth={30} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          <path d={roadPath(points, start, GOAL_POINT)} fill="none" className="stroke-screen-paper" strokeWidth={3} strokeDasharray="10 12" vectorEffect="non-scaling-stroke" />
        </svg>
        <span className={cx("absolute -translate-x-1/2 -translate-y-1/2 pixel-frame bg-screen-paper px-2 py-0.5", PX.pressStart)} style={{ left: `${GOAL_POINT.x}%`, top: GOAL_POINT.y }}>
          Goal
        </span>
        <span className={cx("absolute -translate-x-1/2 -translate-y-1/2 pixel-frame bg-screen-paper px-2 py-0.5", PX.pressStart)} style={{ left: `${start.x}%`, top: start.y }}>
          Start
        </span>
        <ol className="contents">
          {list.map((l, i) => {
            const p = points[i];
            const icon = placeIcon(l.row.place);
            const left = p.x < 50;
            const isHere = here?.key === l.row.key;
            const shots = photosAt(l.row.key).length;
            return (
              <li key={l.row.key} data-level={l.row.key} className="contents">
                <button type="button" onClick={() => setOpen(l)}
                  aria-label={`Level ${l.label}, ${formatTime(l.row.time)}, ${l.row.plan}${l.done ? ", done" : ""}${isHere ? ", the group is here" : ""}`}
                  className={cx("focus-pixel absolute flex items-center justify-center pixel-frame", l.done ? "bg-screen-paper" : "bg-screen")}
                  style={{ left: `calc(${p.x}% - ${TILE_PX / 2}px)`, top: p.y - TILE_PX / 2, width: TILE_PX, height: TILE_PX }}>
                  {icon ? <Sprite name={icon} scale={2} className={cx(!l.done && marks && "opacity-70")} /> : <span className="text-lg font-bold text-screen-ink">?</span>}
                  <span aria-hidden="true" className="absolute -bottom-3 left-1/2 -translate-x-1/2 whitespace-nowrap border-2 border-screen-ink bg-screen-paper px-1 text-xs font-bold leading-tight text-screen-ink tabular-nums">{l.label}</span>
                  {l.done && <span aria-hidden="true" className="absolute -top-3 -right-3"><Sprite name="ui-badge-verified" scale={2} /></span>}
                  {isHere && <span aria-hidden="true" data-party="" className="absolute -top-9 left-1/2 -translate-x-1/2"><Sprite name={chibi("adult", "idle-1")} scale={1} /></span>}
                </button>
                <span aria-hidden="true"
                  className={cx("absolute pixel-frame bg-screen-paper px-2 py-1 text-xs leading-snug text-screen-ink", l.done && "opacity-70")}
                  style={left ? { left: `calc(${p.x}% + ${TILE_PX / 2 + 10}px)`, right: 8, top: p.y - 22 } : { right: `calc(${100 - p.x}% + ${TILE_PX / 2 + 10}px)`, left: 8, top: p.y - 22 }}>
                  <span className="font-semibold tabular-nums">{formatTime(l.row.time)}</span>
                  <span className="line-clamp-2 block">{l.row.plan}</span>
                  {shots > 0 && <span className="block">{shots} photo{shots === 1 ? "" : "s"}</span>}
                </span>
              </li>
            );
          })}
        </ol>
      </section>
      {day.tips.length > 0 && (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
          {day.tips.map((t) => <li key={t}>{t}</li>)}
        </ul>
      )}

      <nav aria-label="Trip menu" className="flex flex-wrap gap-2">
        {([["buses", "Buses"], ["budget", "Budget"], ["todo", "To-do"], ["sources", "Sources"], ...(photos ? [["album", "Album"]] : [])] as [Menu, string][]).map(([key, name]) => (
          <PixelButton key={key} variant={menu === key ? "primary" : "secondary"} aria-pressed={menu === key} className="px-3 text-sm"
            onClick={() => setMenu(menu === key ? null : key)}>
            <span className="font-bold">{name}</span>
          </PixelButton>
        ))}
      </nav>
      {menu === "buses" && (
        <div className="flex flex-col gap-5">
          <Buses table={guide.getting_there} />
          <Buses table={guide.getting_home} />
        </div>
      )}
      {menu === "budget" && <Budget guide={guide} />}
      {menu === "todo" && <Todo guide={guide} byKey={byKey} live={live} busy={busy} onTick={onTick} />}
      {menu === "sources" && <Sources guide={guide} />}
      {menu === "album" && photos && <Album photos={photos} guide={guide} busy={busy} />}

      {current && (
        <LevelDialog level={current} live={live} busy={busy} problem={problem} photos={photos} shots={photosAt(current.row.key)}
          onClose={() => setOpen(null)} onTick={onTick} />
      )}
    </div>
  );
}

function LevelDialog({ level, live, busy, problem, photos, shots, onClose, onTick }: {
  level: Level; live: boolean; busy?: boolean; problem?: string | null; photos?: Photos; shots: TripFile[]; onClose: () => void; onTick?: (key: string, done: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [shown, setShown] = useState<{ blob: Blob; label: string } | null>(null);
  const r = level.row;
  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);

  async function show(f: TripFile) {
    if (!photos) return;
    const blob = await fetchFile(photos.slug, f.id);
    console.info("[tg-trip] file show kind=%s ok=%s", f.kind, blob ? "yes" : "no");
    if (blob) setShown({ blob, label: `Level ${level.label}` });
  }

  return (
    <dialog ref={dialog} onClose={(e) => e.target === e.currentTarget && onClose()} aria-label={`Level ${level.label}`}
      className="m-auto w-[min(28rem,calc(100%-2rem))] bg-transparent p-0 backdrop:bg-black/50">
      <div className="pixel-box flex flex-col gap-3 bg-screen-paper p-4 text-screen-ink">
        <p className="text-sm font-bold tabular-nums">Level {level.label} · {formatTime(r.time)}</p>
        <p className="text-lg font-bold">{r.plan}</p>
        {r.note && <p className="text-sm">{r.note}</p>}
        {r.place?.name && (
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-semibold">{r.place.name}</span>
            <a className="underline underline-offset-2 focus-pixel" href={placeMapsUrl(r.place.name)} target="_blank" rel="noopener noreferrer">
              Google Maps<span aria-hidden="true">&nbsp;↗</span>
            </a>
          </p>
        )}
        {live && (
          <PixelButton variant={level.done ? "secondary" : "primary"} className="px-4 py-3" disabled={busy} aria-pressed={level.done}
            onClick={() => onTick?.(rowMark(r), !level.done)}>
            {level.done ? "Done ✓ (tap to undo)" : "Mark done!"}
          </PixelButton>
        )}
        {photos && (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-semibold">{shots.length ? `${shots.length} photo${shots.length === 1 ? "" : "s"} here` : "No photos here yet"}</p>
            {shots.length > 0 && (
              <ul className="flex gap-2 overflow-x-auto pb-1">
                {shots.map((f) => (
                  <li key={f.id} className="shrink-0">
                    <button type="button" className="focus-pixel block" aria-label="Show this photo" onClick={() => show(f)}>
                      <Thumb slug={photos.slug} file={f} alt="" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <input ref={picker} type="file" accept={ACCEPT} multiple hidden
              onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ""; if (files.length) photos.onAdd(r.key, files); }} />
            <PixelButton variant="secondary" className="self-start px-4 text-sm" disabled={busy} onClick={() => picker.current?.click()}>
              Add photos here
            </PixelButton>
          </div>
        )}
        {problem && <p role="alert" className="pixel-frame bg-screen px-2 py-1 text-sm font-semibold text-screen-ink">{problem}</p>}
        <PixelButton variant="secondary" className="self-end px-4 text-sm" autoFocus onClick={() => dialog.current?.close()}>
          Close
        </PixelButton>
      </div>
      <PhotoViewer photo={shown} onClose={() => setShown(null)} logTag="tg-trip" />
    </dialog>
  );
}

function Buses({ table }: { table: BusTable }) {
  const booked = table.buses.find((b) => b.booked)?.trip;
  const first = table.buses[0]?.trip?.operator_name;
  return (
    <section className="flex flex-col gap-2">
      <h3 className={PX.dataHeading}>{table.title}</h3>
      {table.intro && <p className="text-sm">{table.intro}</p>}
      <PixelBox className="overflow-x-auto p-0">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b-2 border-border">
              <th scope="col" className="px-3 py-2 font-semibold">Departs</th>
              <th scope="col" className="px-3 py-2 font-semibold">{first ?? "Bus"}</th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">Fare</th>
              <th scope="col" className="px-3 py-2 font-semibold">Note</th>
            </tr>
          </thead>
          <tbody>
            {table.buses.map((b) => (
              <tr key={b.trip_id} className={cx("border-b border-border last:border-b-0", b.booked && "font-bold")}>
                <td className="px-3 py-2 whitespace-nowrap tabular-nums">{b.trip ? formatTime(b.trip.departure_time) : "?"}</td>
                <td className="px-3 py-2">
                  {b.trip ? `${b.trip.operator_name !== first ? `${b.trip.operator_name} ` : ""}${formatClass(b.trip.service_class)}` : "No longer listed"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{b.trip?.fare_php != null ? peso(b.trip.fare_php) : "?"}</td>
                <td className="px-3 py-2">{b.booked ? `✓ ${b.note || "Booked"}` : b.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </PixelBox>
      <p className={PX.meta}>
        Times and fares from the operator&apos;s schedule data{booked ? `, ${formatVerified(booked.last_verified_at).replace(/^Checked/, "last checked")}` : ""}. {booked?.confirm_note ?? ""}
      </p>
      {table.tips.length > 0 && (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
          {table.tips.map((t) => <li key={t}>{t}</li>)}
        </ul>
      )}
    </section>
  );
}

function Budget({ guide }: { guide: Guide }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className={PX.dataHeading}>Budget per person</h3>
      {guide.budget.summary && <p className="text-sm">{guide.budget.summary}</p>}
      <PixelBox className="overflow-x-auto p-0">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b-2 border-border">
              <th scope="col" className="px-3 py-2 font-semibold">Item</th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">Estimate (₱)</th>
            </tr>
          </thead>
          <tbody>
            {guide.budget.rows.map((b) => (
              <tr key={b.item} className="border-b border-border last:border-b-0">
                <td className="px-3 py-2">{b.item}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">{b.estimate}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </PixelBox>
      {guide.budget.excluded && <p className={PX.meta}>{guide.budget.excluded}</p>}
    </section>
  );
}

function Todo({ guide, byKey, live, busy, onTick }: {
  guide: Guide; byKey: ReadonlyMap<string, Mark>; live: boolean; busy?: boolean; onTick?: (key: string, done: boolean) => void;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className={PX.dataHeading}>To do before the trip</h3>
      <ul className="flex flex-col gap-1">
        {guide.todo.map((t) => {
          const done = t.done || byKey.get(todoMark(t))?.value === "done";
          return (
            <li key={t.key}>
              <label className={cx("flex min-h-11 items-start gap-3 text-sm", live && !t.done && "cursor-pointer")}>
                <input type="checkbox" className="mt-0.5 h-6 w-6 shrink-0" checked={done} disabled={!live || t.done || busy}
                  onChange={(e) => onTick?.(todoMark(t), e.target.checked)} />
                <span className={cx(done && "text-muted")}>{t.text}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Sources({ guide }: { guide: Guide }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className={PX.dataHeading}>Sources</h3>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
        {guide.sources.map((s) => (
          <li key={s.label}>{s.url ? <a className={PX.inlineLink} href={s.url} target="_blank" rel="noopener noreferrer">{s.label}</a> : s.label}</li>
        ))}
      </ul>
    </section>
  );
}

function Album({ photos, guide, busy }: { photos: Photos; guide: Guide; busy?: boolean }) {
  const picker = useRef<HTMLInputElement>(null);
  const [shown, setShown] = useState<{ blob: Blob; label: string } | null>(null);
  const all = photos.files.filter((f) => f.kind === "photo").slice().reverse();
  const where = (key: string | null) => {
    for (const d of guide.days) {
      const i = d.rows.findIndex((r) => r.key === key);
      if (i >= 0) return d.rows[i].plan;
    }
    return "On the trip";
  };
  async function show(f: TripFile) {
    const blob = await fetchFile(photos.slug, f.id);
    console.info("[tg-trip] file show kind=%s ok=%s", f.kind, blob ? "yes" : "no");
    if (blob) setShown({ blob, label: where(f.row_key) });
  }
  return (
    <section className="flex flex-col gap-3">
      <h3 className={PX.dataHeading}>Trip album</h3>
      <p className="text-sm text-muted">Everyone on the trip sees these and can delete them. Tap a level on the map to add photos there.</p>
      <input ref={picker} type="file" accept={ACCEPT} multiple hidden
        onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ""; if (files.length) photos.onAdd(null, files); }} />
      <PixelButton variant="secondary" className="self-start px-4 text-sm" disabled={busy} onClick={() => picker.current?.click()}>
        Add photos
      </PixelButton>
      {all.length === 0 ? (
        <p className="text-sm">No photos yet.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {all.map((f) => (
            <PixelBox as="li" key={f.id} className="flex flex-col gap-2 p-2">
              <button type="button" className="focus-pixel self-center" aria-label={`Show the photo at ${where(f.row_key)}`} onClick={() => show(f)}>
                <Thumb slug={photos.slug} file={f} alt="" />
              </button>
              <p className="line-clamp-2 text-xs">{where(f.row_key)}</p>
              <PixelButton variant="secondary" className="px-2 text-xs" disabled={busy}
                onClick={() => window.confirm("Delete this photo for everyone?") && photos.onDelete(f)}>
                Delete
              </PixelButton>
            </PixelBox>
          ))}
        </ul>
      )}
      <PhotoViewer photo={shown} onClose={() => setShown(null)} logTag="tg-trip" />
    </section>
  );
}
