"use client";

import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PX, PixelBox, PixelButton, cx } from "@/components/pixel";
import { BlobImage, PhotoViewer } from "@/components/PhotoViewer";
import { THUMB_BOX } from "@/components/TripFiles";
import { Sprite } from "@/components/WorldSheet";
import { formatClass, formatTime, formatVerified } from "@/lib/api";
import { type BusTable, type Guide, type GuideRow, type Mark, marksByKey, pickMark, placeIcon, rowMark, todoMark, whereNow } from "@/lib/guide";
import {
  BAND_PX, SIGN_DROP, SIGN_GAP, SNAKE_MIN_PX, START_POINT, TILE_PX, type Level, goalPoint, levelPoints, levelScenery, levels, nextLevel, pixelRoad, placeMapsUrl, roadStops, runsPath, snakeMap, snakeRoad, snakeScenery,
  startWorld, worldHeight, worldTabs,
} from "@/lib/levelMap";
import { lookFor } from "@/lib/party";
import { chibiLook, spriteSrc } from "@/lib/sprites";
import { busChangedLine, busNotice, busWarningLine } from "@/lib/planLines";
import { doneTime } from "@/lib/recap";
import type { TripFile } from "@/lib/trip";
import { fnv1a, usableWidth } from "@/lib/world";
import type { NeedLink } from "@/lib/chat";
import BusSwap, { type BusAt, swapTitle } from "./BusSwap";
import { LegLine } from "./PlanBits";
import type { Focus, PlanEditor } from "./PlanEditor";
import { BudgetEdits, PickEdits, SourcesEdits, TodoEdits } from "./PlanTextEditors";
import StopChange, { PlanDialog } from "./StopChange";
import BudgetPanel, { SpendingNote } from "./BudgetPanel";
import type { Spending } from "./BudgetPanel";

export type Photos = {
  files: TripFile[];
  /** One picture's bytes: the trip page's own file route, or the recap's (TG-64) */
  fetch: (id: string) => Promise<Blob | null>;
  /** Without them there's no Add photos or Delete: the recap's map is read-only */
  onAdd?: (rowKey: string | null, picked: File[]) => void;
  onDelete?: (file: TripFile) => void;
};

type Props = {
  guide: Guide;
  /** The trip's ticks and picks; without them the map is read-only (the plan's own page) */
  marks?: readonly Mark[];
  busy?: boolean;
  /** The last write's failure: the trip's own notice sits behind the level dialog, so the dialog repeats it */
  problem?: string | null;
  /** The last write's success, for the same reason */
  said?: string;
  onOpenLevel?: () => void;
  onTick?: (key: string, done: boolean) => void;
  onPick?: (pickKey: string, option: string) => void;
  photos?: Photos;
  /** TG-61: the trip page's plan editor. The plan's own page (/i/) never passes one, so it can't be edited there */
  editor?: PlanEditor;
  /** TG-61: "Your group's own copy of the plan, last changed ..." under the summary */
  copyLine?: string | null;
  /** TG-64: the recap's map. No next level, no trip menu, and each done level says when it was ticked. Pass no onTick,
   * onPick or editor with it, so nothing can be changed */
  recap?: true;
  /** TG-62 GW2: the wallet's spending for the Budget panel. Only the trip page passes it, and only with
   * NEXT_PUBLIC_BUDGET_LINES on; without it the panel is today's table */
  spending?: Spending;
  /** TG-67: the plan's city, for the province in a spot's Google Maps search. Without it, Baguio's */
  city?: string;
  /** TG-69: where the trip page's Next up card sends the map; a new n each time. Only the trip page passes it */
  jump?: { day?: number; key?: string; menu?: "buses" | "todo"; n: number };
};

type Menu = "buses" | "budget" | "todo" | "sources" | "album";
const peso = (n: number) => `₱${n.toLocaleString("en-PH", { maximumFractionDigits: 0 })}`;
const ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
const ALBUM_PAGE = 24; // the album downloads what it shows: about 7 MB a page, against 90 MB for a full trip
const BAND = "absolute inset-0 mx-auto"; // over the whole world on a phone; centred at BAND_PX on a wide row
const GROUP = lookFor("adult", 0)!; // the group on the map: the first look of the one cast (TG-48)

/**
 * TG-52: the trip as a game level map (owner, 2026-11-02). One world per day; each row is a level on a road that winds
 * down the green screen from START to GOAL. A done level wears a badge, the group's chibi stands on the latest-ticked
 * level, and tapping a level opens its dialog: what to do, Done or Not yet, and that level's photos. Below the map, a
 * menu opens the buses, budget, to-dos, sources and the trip's album.
 */
export default function LevelMap({ guide, marks, busy, problem, said, onOpenLevel, onTick, onPick, photos, editor, copyLine, recap, spending, city, jump }: Props) {
  const live = !!onTick;
  const byKey = marksByKey(marks ?? []);
  const [world, setWorld] = useState(() => startWorld(guide, marks ?? []));
  const [open, setOpen] = useState<{ key: string; tap: number } | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [adding, setAdding] = useState(false); // TG-61: Add a stop to World N
  const [placing, setPlacing] = useState(false); // TG-61 round 4: Add a place, which asks where it fits
  const addPlace = () => setPlacing(true);
  const [swapping, setSwapping] = useState<BusAt | null>(null); // TG-61: Swap this bus, from the Buses panel
  // The chatbot's Paste a Google Maps link: the find step at the place it named (after or instead of a stop), or a World
  const [linking, setLinking] = useState<{ key: string | null; world: number; start: "find" | "replace" } | null>(null);
  const focusTo = useRef<string | null>(null); // TG-61: the level to focus once a change is on screen
  const editing = !!editor?.editing;
  const warned = (["getting_there", "getting_home"] as const).flatMap((table) => guide[table].buses.flatMap((b, index) => (b.warning ? [{ table, index }] : [])));
  const here = marks ? whereNow(guide, marks) : null;
  const day = guide.days.find((d) => d.day === world) ?? guide.days[0];
  const tabs = worldTabs(guide.days.length); // TG-67: 3 per row past 3 Worlds; Baguio's 3 keep today's row
  const list = levels(day, byKey);
  const screen = useRef<HTMLElement>(null);
  const [W, setW] = useState(0);
  const snake = W >= SNAKE_MIN_PX ? snakeMap(list.length, W) : null;
  const points = snake?.points ?? levelPoints(list.length);
  const height = snake?.height ?? worldHeight(list.length);
  const goal = snake?.goal ?? goalPoint(list.length);
  const start = snake?.start ?? START_POINT;
  const u = snake ? "px" : "%"; // a point's x: the zig-zag's are % of its band, the snake's are px of the row
  const band = snake ? undefined : BAND_PX;
  const chosen = day.pick ? byKey.get(pickMark(day.pick.key))?.value : undefined;
  const photosAt = (key: string | null) => photos?.files.filter((f) => f.kind === "photo" && f.row_key === key) ?? [];
  // Stays fresh as ticks land. W-10: if another phone removes the open stop (or moves it to another World), its dialog
  // stays, with the stop as it was last seen, so a change in progress can say what happened (ux §6)
  const [kept, setKept] = useState<Level | null>(null);
  const found = open && list.find((l) => l.row.key === open.key);
  if (found && kept?.row !== found.row) setKept(found);
  const current = found || (open && kept?.row.key === open.key ? kept : undefined);
  const next = marks && !recap ? nextLevel(list) : null; // a record has no next level: every tile not done is plain
  const atStart = !!marks && !list.some((l) => l.done); // no ticks in this world yet: the group waits at START
  const shownSpending = recap ? undefined : spending; // TG-62 Rev 1 S1: the recap never shows the budget (TG-64 §2.2)

  // The road draws on the screen's real width, so it stays chunky pixels at any size. Measured before paint, or a
  // desktop would flash the phone's map first (TG-56)
  useLayoutEffect(() => {
    const el = screen.current;
    if (!el) return;
    setW((w) => usableWidth(el.clientWidth, w));
    const ro = new ResizeObserver(([entry]) => setW((w) => usableWidth(Math.round(entry.contentRect.width), w)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A world is about 1,000px tall and the next level can be anywhere on it: after a tab tap (not on first load) show it
  const tabTapped = useRef(false);
  useEffect(() => {
    if (!tabTapped.current) return;
    tabTapped.current = false;
    const target = screen.current?.querySelector("[data-next]") ?? screen.current?.querySelector("[data-level] button");
    target?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  });
  // The first marks can be a saved copy (TG-57): follow the group until someone picks a World, and leave an open dialog's World alone
  const tabPicked = useRef(false);
  const groupDay = here?.day;
  const inDialog = !!current; // not open: that stays set when another phone's pick takes the dialog's row away
  useEffect(() => {
    if (groupDay && !tabPicked.current && !inDialog) setWorld(groupDay);
  }, [groupDay, inDialog]);
  // After a change, focus its level once it's drawn, and centre it (ux.md §3.1). Like the tab scroll above: after any render
  useEffect(() => {
    const key = focusTo.current;
    const button = key && screen.current?.querySelector<HTMLElement>(`[data-level="${key}"] button`);
    if (!button) return; // not drawn yet, or hidden by a pick: a later render tries again
    focusTo.current = null;
    button.focus();
    button.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  });
  const changed = (focus: Focus) => {
    setOpen(null);
    setAdding(false);
    setPlacing(false);
    setSwapping(null);
    setLinking(null);
    if (!focus) return;
    focusTo.current = focus.key;
    tabPicked.current = true;
    setWorld(focus.day); // a move can take it to another World
  };
  /** From a proposal: the stop's dialog gives way to the chat, which sends this message at once (ux.md §4.4) */
  const askChat = (text: string, focus: string | null) => {
    setOpen(null);
    setAdding(false);
    setPlacing(false);
    editor?.chat?.open({ text, focus }); // the page's chat (audit G1)
  };
  const linkFor = (need: NeedLink) => {
    const at = need.at;
    const key = at && "after" in at ? at.after : at && "replace" in at ? at.replace : null;
    const home = key ? guide.days.find((d) => d.rows.some((r) => r.key === key))?.day : undefined;
    const toWorld = home ?? (at && "first_of_day" in at && guide.days.some((d) => d.day === at.first_of_day) ? at.first_of_day : day.day);
    console.info("[tg-trip] chat pin-ask find at=%s", home ? (at && "replace" in at ? "replace" : "after") : "world");
    tabPicked.current = true;
    setWorld(toWorld);
    setLinking({ key: home ? key : null, world: toWorld, start: home && at && "replace" in at ? "replace" : "find" });
  };
  // The page's chat closed on Paste a Google Maps link: open the find step there, once per tap (audit G1: the map may
  // have been redrawn meanwhile). Like the focus effect above: after any render
  const linkSeen = useRef(0);
  useEffect(() => {
    const ask = editor?.chat?.need;
    if (!ask || ask.n === linkSeen.current) return;
    linkSeen.current = ask.n;
    editor?.chat?.took(ask.n);
    linkFor(ask.need);
  });
  const linkDay = linking ? guide.days.find((d) => d.day === linking.world) : undefined;
  const linkLevel = linking?.key && linkDay ? (levels(linkDay, byKey).find((l) => l.row.key === linking.key) ?? null) : null;

  const goTo = (n: number) => {
    if (n !== world) tabTapped.current = true;
    tabPicked.current = true;
    setWorld(n);
  };
  // TG-69: the Next up card moves the map. A World goes through goTo, the tab tap's own path, so closing the dialog
  // doesn't snap back to the group's day (review M1); then the level's dialog, as a tap on it opens it, or a menu panel
  const moveTo = (to: NonNullable<Props["jump"]>) => {
    if (to.day !== undefined) {
      goTo(to.day);
      tabTapped.current = true; // goTo's scroll to the lit level, on the World already showing too; no second scroll (review D1)
    }
    if (to.key) {
      onOpenLevel?.();
      setOpen((o) => ({ key: to.key!, tap: (o?.tap ?? 0) + 1 }));
    }
    if (to.menu) {
      // The panel it opens scrolls in once it's drawn (showPanel); one that's already open scrolls in now
      if (menu === to.menu && panel.current) scrollToPanel(panel.current);
      else {
        panelDue.current = true;
        setMenu(to.menu);
      }
    }
  };
  // The open Buses or To-do panel, by a ref, so the jump's target draws no attribute (TG68-T2 pins the menu's markup)
  const panel = useRef<HTMLElement | null>(null);
  const panelDue = useRef(false);
  const scrollToPanel = (el: HTMLElement) => el.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  const showPanel = (el: HTMLElement | null) => {
    panel.current = el;
    if (!el || !panelDue.current) return;
    panelDue.current = false;
    scrollToPanel(el);
  };
  // Once per tap: the n seen on mount never replays, so a remount or a poll doesn't reopen anything. Like the chat's
  // find step above: after any render
  const lastJump = useRef(jump?.n);
  useEffect(() => {
    if (!jump || jump.n === lastJump.current) return;
    lastJump.current = jump.n;
    moveTo(jump);
  });

  return (
    <div className="flex flex-col gap-4">
      {editor && !editing && editor.entry(addPlace)}
      <header className="flex flex-col gap-1">
        <h2 className="text-xl font-bold text-balance">{guide.title}</h2>
        {guide.summary && <p className="text-sm text-muted md:max-w-prose">{guide.summary}</p>}
        {copyLine && <p className={PX.meta}>{copyLine}</p>}
      </header>

      {/* TG-68 ux §7: the Trip menu and its open panel above the day's block, the Days row and the map: it's the whole trip's */}
      {!recap && (
        <nav aria-label="Trip menu" className="grid grid-cols-3 gap-2 lg:flex lg:flex-wrap">
          {([["buses", "Buses"], ["budget", "Budget"], ["todo", "To-do"], ["sources", "Sources"], ...(photos ? [["album", "Album"]] : [])] as [Menu, string][]).map(([key, name]) => (
            <PixelButton key={key} variant={menu === key ? "primary" : "secondary"} aria-pressed={menu === key} className="px-3 text-sm"
              onClick={() => {
                if (key === "budget" && menu !== "budget") shownSpending?.onOpen();
                console.info("[tg-trip] menu %s=%s", key, menu === key ? "close" : "open"); // TG-68: the menu sits above the map now
                setMenu(menu === key ? null : key);
              }}>
              <span className="font-bold">{name}</span>
            </PixelButton>
          ))}
        </nav>
      )}
      {menu === "buses" && (
        <div ref={showPanel} className="flex flex-col gap-5">
          <Buses table={guide.getting_there} onSwap={editor && ((index) => setSwapping({ table: "getting_there", index }))} can={!!editor?.can} />
          <Buses table={guide.getting_home} onSwap={editor && ((index) => setSwapping({ table: "getting_home", index }))} can={!!editor?.can} />
        </div>
      )}
      {menu === "budget" &&
        (editing && editor ? (
          <EditPanel title="Budget per person"><BudgetEdits editor={editor} guide={guide} /></EditPanel>
        ) : shownSpending?.load !== undefined && shownSpending.load !== "loading" && shownSpending.load.ok && shownSpending.load.budget.state === "ok" ? (
          <BudgetPanel guide={guide} budget={shownSpending.load.budget} walletSlug={shownSpending.walletSlug} me={shownSpending.me} returnDate={shownSpending.returnDate} today={shownSpending.today} />
        ) : (
          <Budget guide={guide}>{shownSpending && <SpendingNote load={shownSpending.load} />}</Budget>
        ))}
      {menu === "todo" && <Todo guide={guide} byKey={byKey} live={live} busy={busy} onTick={onTick} editor={editing ? editor : undefined} panel={showPanel} />}
      {menu === "sources" && (editing && editor ? <EditPanel title="Sources"><SourcesEdits editor={editor} guide={guide} /></EditPanel> : <Sources guide={guide} />)}
      {menu === "album" && photos && <Album photos={photos} guide={guide} busy={busy} />}

      <div className="flex flex-col gap-1">
        <h3 className={cx(PX.dataHeading, "text-balance")}>{day.title}</h3>
        {day.intro && <p className="text-sm md:max-w-prose">{day.intro}</p>}
      </div>

      {day.pick && (
        <PixelBox className="flex flex-col gap-2 p-4 md:max-w-2xl">
          <p className="font-semibold">{day.pick.title}</p>
          {editing && editor ? <PickEdits editor={editor} day={day} chosen={chosen} /> : <ul className="flex flex-col gap-2">
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
          </ul>}
          {marks && <p className={PX.meta}>{chosen ? `The group picked ${chosen}.` : "Nobody has picked yet: the map shows every option."}</p>}
        </PixelBox>
      )}

      {day.tips.length > 0 && (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
          {day.tips.map((t) => <li key={t}>{t}</li>)}
        </ul>
      )}

      {editor?.top(addPlace)}
      {editor && warned.length > 0 && (
        <PixelBox tone="alert" className="flex flex-col gap-2 p-3 md:max-w-2xl">
          <p className="text-sm font-semibold text-danger-text">{busNotice(warned.length)}</p>
          <PixelButton variant="secondary" className="inline-flex items-center self-start px-4 text-sm"
            onClick={() => { setMenu("buses"); requestAnimationFrame(() => document.querySelector("[data-bus-warning]")?.scrollIntoView({ block: "center" })); }}>
            Show buses
          </PixelButton>
        </PixelBox>
      )}

      <nav aria-label="Days" className={tabs.nav}>
        {guide.days.map((d) => {
          const ls = levels(d, byKey);
          const done = ls.filter((l) => l.done).length;
          return (
            <PixelButton key={d.day} variant={d.day === world ? "primary" : "secondary"} aria-pressed={d.day === world}
              aria-label={marks ? `World ${d.day}, ${done} of ${ls.length} done` : `World ${d.day}`}
              className={tabs.tab} onClick={() => goTo(d.day)}>
              <span className="font-bold">World {d.day}</span>
              {marks && <span className="ml-1 tabular-nums">{done}/{ls.length}</span>}
            </PixelButton>
          );
        })}
      </nav>

      {/* The world: a fixed light screen in both themes, so it frames and focuses in Ink as the overworld map does */}
      {/* The zig-zag's stops and levels sit in a centred band, so they stay together on a tablet (TG-55); from lg the snake has the whole row (TG-56) */}
      <div className="w-full">
        <section ref={screen} aria-label={`World ${day.day} map`} className="pixel-frame bg-screen pixelated relative w-full overflow-hidden"
          style={{
            height,
            backgroundImage: `url(${spriteSrc("tile-grass")})`, backgroundSize: "32px",
            "--frame": "var(--color-screen-ink)",
            "--focus": "var(--color-screen-ink)",
            "--foreground": "var(--color-screen-ink)",
          } as CSSProperties}>
          {W > 0 && <WorldGround W={W} count={list.length} world={day.day} />}
          <div aria-hidden="true" className="absolute inset-x-2 top-2 pixel-frame bg-flag-blue px-3 py-1 text-center">
            <span className={cx(PX.h2, "text-screen-paper")}>World {day.day}</span>
          </div>
          <div className={BAND} style={{ maxWidth: band }}>
            <span aria-hidden="true" className="absolute" style={{ left: `calc(${start.x}${u} + ${snake ? 116 : -100}px)`, top: start.y - 12 }}><Sprite name="vehicle-bus" scale={1} /></span>
            <span className={cx("absolute -translate-x-1/2 -translate-y-1/2 pixel-frame bg-screen-paper px-2 py-0.5", PX.pressStart)} style={{ left: `${start.x}${u}`, top: start.y }}>
              Start
            </span>
            {atStart && (
              <span aria-hidden="true" data-party="" className="absolute z-10" style={{ left: `calc(${start.x}${u} + ${snake ? 48 : 40}px)`, top: start.y - 16 }}>
                <Sprite name={chibiLook(GROUP, "idle-1")} scale={2} />
              </span>
            )}
            <span className={cx("absolute inline-flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 pixel-frame bg-flag-yellow px-2 py-0.5", PX.pressStart)} style={{ left: `${goal.x}${u}`, top: goal.y }}>
              <Sprite name="ui-star" scale={1} />Goal<Sprite name="ui-star" scale={1} />
            </span>
          </div>
          <ol className={BAND} style={{ maxWidth: band }}>
            {list.map((l, i) => {
              const p = points[i];
              const left = p.x < 50;
              const isHere = here?.key === l.row.key;
              const shots = photosAt(l.row.key).length;
              return (
                <li key={l.row.key} data-level={l.row.key} className="contents">
                  <button type="button" onClick={() => { onOpenLevel?.(); setOpen((o) => ({ key: l.row.key, tap: (o?.tap ?? 0) + 1 })); }} data-next={l.row.key === next ? "" : undefined}
                    className={cx("focus-pixel absolute flex gap-2 text-left", snake ? "items-start" : "-translate-y-1/2 items-center", !snake && !left && "flex-row-reverse", isHere && "z-10")}
                    style={snake ? { left: p.x - TILE_PX / 2, top: p.y - TILE_PX / 2, width: TILE_PX + SIGN_GAP + snake.sign }
                      : left ? { left: `calc(${p.x}% - ${TILE_PX / 2}px)`, right: 8, top: p.y } : { right: `calc(${100 - p.x}% - ${TILE_PX / 2}px)`, left: 8, top: p.y }}>
                    <span className="sr-only">Level {l.label}, </span>
                    <span className={cx("relative flex shrink-0 items-center justify-center pixel-frame", l.row.key === next ? "bg-flag-yellow" : "bg-screen-paper")} style={{ width: TILE_PX, height: TILE_PX }}>
                      <Sprite name={placeIcon(l.row.place) ?? "place-other"} scale={2} />
                      <span aria-hidden="true" className={cx("absolute -bottom-3 left-1/2 -translate-x-1/2 whitespace-nowrap", PX.screenTag)}>{l.label}</span>
                      {l.done && <span aria-hidden="true" className="absolute -top-3 -right-3"><Sprite name="ui-badge-verified" scale={2} /></span>}
                      {isHere && <span aria-hidden="true" data-party="" className="absolute -top-12 left-1/2 -translate-x-1/2"><Sprite name={chibiLook(GROUP, "idle-1")} scale={2} className="max-w-none" /></span>}
                    </span>
                    <span className="min-w-0 max-w-88 flex-1 pixel-frame bg-screen-paper px-2 py-1 leading-snug text-screen-ink" style={snake ? { marginTop: TILE_PX / 2 + SIGN_DROP } : undefined}>
                      <span className="block text-sm font-bold tabular-nums">{formatTime(l.row.time)}</span>
                      <span className="block text-xs">{l.row.plan}</span>
                      {l.row.place?.kind === "trip_place" && <span className="mt-0.5 inline-block text-xs font-semibold">Added by your group</span>}
                      {recap && l.done ? (
                        <span className="block text-xs font-semibold text-screen-ink">
                          <span aria-hidden="true">✓</span> Done {doneTime(byKey.get(rowMark(l.row))!)}{shots > 0 && ` · ${shots} photo${shots === 1 ? "" : "s"}`}
                        </span>
                      ) : shots > 0 && <span className="block text-xs">{shots} photo{shots === 1 ? "" : "s"}</span>}
                      {l.done && <span className="sr-only">, done</span>}
                      {recap && !l.done && <span className="sr-only">, not ticked</span>}
                      {isHere && <span className="sr-only">, the group is here</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      </div>

      {editing && editor && (
        <div className="flex flex-wrap gap-2">
          <PixelButton variant="secondary" className="inline-flex items-center px-4 text-sm" aria-disabled={!editor.can || undefined} onClick={() => editor.can && setAdding(true)}>
            Add a stop to World {day.day}
          </PixelButton>
          {editor.chat && (
            <PixelButton variant="secondary" className="inline-flex items-center px-4 text-sm"
              onClick={() => {
                console.info("[tg-trip] chat open from=map");
                editor.chat?.open(null);
              }}>
              Ask the chatbot
            </PixelButton>
          )}
        </div>
      )}

      {open && current && (
        // Keyed by tap: each one gets its own dialog, because showModal runs once on mount. close() shuts a dialog at once
        // but its close event waits for the next frame, so that event only clears its own tap (TG-54).
        <LevelDialog key={open.tap} level={current} live={live} busy={busy} problem={problem} said={said} photos={photos} shots={photosAt(current.row.key)} city={city}
          doneMark={recap && current.done ? byKey.get(rowMark(current.row)) : undefined}
          onClose={() => setOpen((o) => (o?.tap === open.tap ? null : o))} onTick={onTick}
          change={editor && { editor, guide, marks: marks ?? [], files: photos?.files ?? [], world: day.day, onDone: changed, onAsk: editor.chat ? askChat : undefined }} />
      )}
      {adding && editor && (
        <PlanDialog label={`Add a stop to World ${day.day}`} bare onClose={() => setAdding(false)}>
          <StopChange editor={editor} guide={guide} marks={marks ?? []} files={photos?.files ?? []} level={null} world={day.day} start="find" onClose={() => setAdding(false)} onDone={changed}
            onAsk={editor.chat ? askChat : undefined} />
        </PlanDialog>
      )}
      {linking && editor && (
        <PlanDialog label={linkLevel ? (linking.start === "replace" ? `Replace Level ${linkLevel.label}` : `Add a stop after Level ${linkLevel.label}`) : `Add a stop to World ${linking.world}`} bare onClose={() => setLinking(null)}>
          <StopChange editor={editor} guide={guide} marks={marks ?? []} files={photos?.files ?? []} level={linkLevel} world={linking.world} start={linkLevel ? linking.start : "find"}
            onClose={() => setLinking(null)} onDone={changed} />
        </PlanDialog>
      )}
      {placing && editor && (
        <PlanDialog label="Add a place" bare onClose={() => setPlacing(false)}>
          <StopChange editor={editor} guide={guide} marks={marks ?? []} files={photos?.files ?? []} level={null} world={day.day} start="fit" onClose={() => setPlacing(false)} onAsk={editor.chat ? askChat : undefined}
            onDone={(focus) => {
              if (!editor.editing) editor.startEditing(); // opened outside edit mode: the bar shows the result and Undo
              changed(focus);
            }} />
        </PlanDialog>
      )}
      {swapping && editor && (
        <PlanDialog label={swapTitle(guide[swapping.table].buses[swapping.index])} onClose={() => setSwapping(null)}>
          <BusSwap editor={editor} guide={guide} at={swapping} onApplied={changed} />
        </PlanDialog>
      )}
    </div>
  );
}

/** The pixel road and the scenery, which only change with the world, its levels or the screen's width. */
function WorldGround({ W, count, world }: { W: number; count: number; world: number }) {
  const map = useMemo(() => (W >= SNAKE_MIN_PX ? snakeMap(count, W) : null), [W, count]);
  const H = map?.height ?? worldHeight(count);
  const road = useMemo(() => {
    const r = map ? snakeRoad(map, W) : pixelRoad(roadStops(levelPoints(count), START_POINT, goalPoint(count), W), W, H);
    return { curb: runsPath(r.curb), asphalt: runsPath(r.asphalt), dash: runsPath(r.dash) };
  }, [map, W, H, count]);
  const scenery = useMemo(() => {
    const seed = fnv1a(`world-${world}`);
    return map ? snakeScenery(map, W, seed) : levelScenery(levelPoints(count), W, seed);
  }, [map, W, count, world]);
  return (
    <>
      <svg aria-hidden="true" className="absolute top-0 left-0" width={W} height={H} viewBox={`0 0 ${W} ${H}`} shapeRendering="crispEdges">
        <path d={road.curb} className="fill-screen-paper" />
        <path d={road.asphalt} className="fill-screen-ink" />
        <path d={road.dash} className="fill-screen-paper" />
      </svg>
      {scenery.map((d) => (
        <span key={`${d.name}-${d.x}-${d.y}`} aria-hidden="true" className="pointer-events-none absolute" style={{ left: d.x, top: d.y }}>
          <Sprite name={d.name} scale={2} />
        </span>
      ))}
    </>
  );
}

/** TG-61: what the level dialog needs to change its stop, on the trip page only. */
type Change = { editor: PlanEditor; guide: Guide; marks: readonly Mark[]; files: readonly TripFile[]; world: number; onDone: (focus: Focus) => void; onAsk?: (text: string, focus: string | null) => void };

/** The booked bus that sets a bus row's time, and its warning if the schedule dropped it (ux.md §7). */
function bookedFor(guide: Guide, row: GuideRow) {
  const table = row.bus === "outbound" ? "getting_there" : row.bus === "return" ? "getting_home" : null;
  return table ? guide[table].buses.find((b) => b.booked) : undefined;
}

function LevelDialog({ level, live, busy, problem, said, photos, shots, doneMark, onClose, onTick, change, city }: {
  level: Level; live: boolean; busy?: boolean; problem?: string | null; said?: string; photos?: Photos; shots: TripFile[];
  /** TG-64: the recap's dialog says when the stop was ticked */
  doneMark?: Mark;
  onClose: () => void; onTick?: (key: string, done: boolean) => void;
  change?: Change;
  /** TG-67: the plan's city, for the province in the Google Maps search */
  city?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [shown, setShown] = useState<{ blob: Blob; label: string } | null>(null);
  // In edit mode a tap opens the change menu; otherwise Change this stop swaps the content to it (ux.md §4.1)
  const [changing, setChanging] = useState(!!change?.editor.editing);
  const r = level.row;
  const booked = change ? bookedFor(change.guide, r) : undefined;
  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);

  async function show(f: TripFile) {
    if (!photos) return;
    const blob = await photos.fetch(f.id);
    console.info("[tg-trip] file show kind=%s ok=%s", f.kind, blob ? "yes" : "no");
    if (blob) setShown({ blob, label: `Level ${level.label}` });
  }

  return (
    <dialog ref={dialog} onClose={(e) => e.target === e.currentTarget && onClose()} aria-label={`Level ${level.label}`}
      // A tap on the backdrop lands on the dialog itself; taps inside land on the box
      onClick={(e) => e.target === e.currentTarget && e.currentTarget.close()}
      className="m-auto w-[min(28rem,calc(100%-2rem))] bg-transparent p-0 text-foreground backdrop:bg-screen-ink/60">
      <div className="pixel-box flex flex-col gap-3 bg-card p-4 text-foreground">
        {changing && change ? (
          <StopChange editor={change.editor} guide={change.guide} marks={change.marks} files={change.files} level={level} world={change.world} start="menu"
            onClose={() => dialog.current?.close()} onBack={change.editor.editing ? undefined : () => setChanging(false)} onDone={change.onDone} onAsk={change.onAsk} />
        ) : (<>
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm font-bold tabular-nums">Level {level.label} · {formatTime(r.time)}</p>
          {/* First in the DOM, so showModal() focuses Close */}
          <PixelButton variant="secondary" onClick={() => dialog.current?.close()}>
            Close
          </PixelButton>
        </div>
        <p className="text-lg font-bold">{r.plan}</p>
        {r.bus && change && busChangedLine(change.editor.edits, r.plan) && <p className={PX.meta}>{busChangedLine(change.editor.edits, r.plan)}</p>}
        {doneMark && <p className="text-sm font-semibold">Done {doneTime(doneMark)}</p>}
        {r.note && <p className="text-sm">{r.note}</p>}
        {r.place?.name && r.place.kind === "trip_place" ? (
          // TG-61: a place the group pinned from a link; never "verified" (ux.md §5)
          <div className="flex flex-col gap-2">
            <p className="text-sm font-semibold break-words">{r.place.name}</p>
            <span className={cx(PX.chip, "self-start")}>Added by your group, not verified</span>
            <a className={cx(PX.btn.secondary.skin, PX.btn.secondary.layout, "self-start")} href={placeMapsUrl({ name: r.place.name, kind: r.place.kind, lat: r.place.lat, lng: r.place.lng, city })}
              target="_blank" rel="noopener noreferrer">
              Directions in Google Maps<span aria-hidden="true">&nbsp;↗</span>
            </a>
          </div>
        ) : r.place?.name && (
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-semibold">{r.place.name}</span>
            <a className={PX.inlineLink} href={placeMapsUrl({ name: r.place.name, kind: r.place.kind, city })} target="_blank" rel="noopener noreferrer">
              Google Maps<span aria-hidden="true">&nbsp;↗</span>
            </a>
          </p>
        )}
        {r.leg && (
          <div className="flex flex-col gap-1">
            <p className="text-sm font-semibold">How to get here</p>
            <LegLine leg={r.leg} />
          </div>
        )}
        {booked?.warning && <p className="text-sm font-semibold">{busWarningLine(booked.warning, booked.date)}</p>}
        {live && (
          <PixelButton variant={level.done ? "secondary" : "primary"} className="px-4 py-3" aria-disabled={busy}
            onClick={() => !busy && onTick?.(rowMark(r), !level.done)}>
            {level.done ? "Done ✓ (tap to undo)" : "Mark done!"}
          </PixelButton>
        )}
        {photos && (shots.length > 0 || photos.onAdd) && (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-semibold">{shots.length ? `${shots.length} photo${shots.length === 1 ? "" : "s"} here` : "No photos here yet"}</p>
            {shots.length > 0 && (
              <ul className="flex gap-2 overflow-x-auto pb-1">
                {shots.map((f) => (
                  <li key={f.id} className="shrink-0">
                    <button type="button" className="focus-pixel block" aria-label="Show this photo" onClick={() => show(f)}>
                      <PhotoThumb fetch={photos.fetch} file={f} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {photos.onAdd && (<>
              <input ref={picker} type="file" accept={ACCEPT} multiple hidden
                onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ""; if (files.length && photos.onAdd) photos.onAdd(r.key, files); }} />
              <PixelButton variant="secondary" className="self-start px-4 text-sm" aria-disabled={busy} onClick={() => !busy && picker.current?.click()}>
                Add photos here
              </PixelButton>
            </>)}
          </div>
        )}
        {problem && <PixelBox as="p" tone="alertText" role="alert" className="p-2 text-sm">{problem}</PixelBox>}
        <p role="status" className="text-sm empty:sr-only">{said}</p>
        {change && change.editor.online && (
          <div className="border-t-2 border-border pt-3">
            <PixelButton variant="secondary" aria-disabled={!change.editor.can || undefined} onClick={() => change.editor.can && setChanging(true)}>
              {booked?.warning ? "Change the bus" : "Change this stop"}
            </PixelButton>
          </div>
        )}
        </>)}
      </div>
      <PhotoViewer photo={shown} onClose={() => setShown(null)} logTag="tg-trip" />
    </dialog>
  );
}

function Buses({ table, onSwap, can }: { table: BusTable; onSwap?: (index: number) => void; can?: boolean }) {
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
      {onSwap && table.buses.map((b, i) => b.warning && (
        <PixelBox key={b.trip_id} data-bus-warning="" className="flex flex-col gap-2 p-3">
          <p className="text-sm">
            {b.trip ? `${formatTime(b.trip.departure_time)} ${b.trip.operator_name}: ` : ""}{busWarningLine(b.warning, b.date)}
          </p>
          {b.booked && <p className="text-sm">You marked it booked, so check your ticket with {b.trip?.operator_name ?? "the bus company"} before you swap.</p>}
          <PixelButton variant="secondary" className="inline-flex items-center self-start px-4 text-sm" aria-disabled={!can || undefined} onClick={() => can && onSwap(i)}>Swap this bus</PixelButton>
        </PixelBox>
      ))}
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

/** Today's table. TG-62 GW2: `children` is ux §5's line under it (SpendingNote); with the flag off there's none */
function Budget({ guide, children }: { guide: Guide; children?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 md:max-w-2xl">
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
      {children}
    </section>
  );
}

function Todo({ guide, byKey, live, busy, onTick, editor, panel }: {
  guide: Guide; byKey: ReadonlyMap<string, Mark>; live: boolean; busy?: boolean; onTick?: (key: string, done: boolean) => void; editor?: PlanEditor;
  /** TG-69: the map's ref to its open panel, so the Next up card's jump can scroll to it */
  panel?: (el: HTMLElement | null) => void;
}) {
  const item = (t: Guide["todo"][number]) => {
    const done = t.done || byKey.get(todoMark(t))?.value === "done";
    return (
      <label className={cx("flex min-h-11 items-start gap-3 text-sm", live && !t.done && "cursor-pointer")}>
        <input type="checkbox" className="mt-0.5 h-6 w-6 shrink-0" checked={done} disabled={!live || t.done || busy}
          onChange={(e) => onTick?.(todoMark(t), e.target.checked)} />
        <span className={cx("break-words", done && "text-muted")}>{t.text}</span>
      </label>
    );
  };
  return (
    <section ref={panel} className="flex flex-col gap-2">
      <h3 className={PX.dataHeading}>To do before the trip</h3>
      {editor ? (
        <TodoEdits editor={editor} guide={guide} show={item} />
      ) : (
        <ul className="flex flex-col gap-1">
          {guide.todo.map((t) => <li key={t.key}>{item(t)}</li>)}
        </ul>
      )}
    </section>
  );
}

/** A panel's heading over its editor, in edit mode. */
function EditPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 md:max-w-2xl">
      <h3 className={PX.dataHeading}>{title}</h3>
      {children}
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
  const [shownCount, setShownCount] = useState(ALBUM_PAGE);
  const all = photos.files.filter((f) => f.kind === "photo").slice().reverse();
  const where = (key: string | null) => {
    for (const d of guide.days) {
      const i = d.rows.findIndex((r) => r.key === key);
      if (i >= 0) return d.rows[i].plan;
    }
    return "On the trip";
  };
  async function show(f: TripFile) {
    const blob = await photos.fetch(f.id);
    console.info("[tg-trip] file show kind=%s ok=%s", f.kind, blob ? "yes" : "no");
    if (blob) setShown({ blob, label: where(f.row_key) });
  }
  return (
    <section className="flex flex-col gap-3">
      <h3 className={PX.dataHeading}>Trip album</h3>
      <p className="text-sm text-muted">Everyone on the trip sees these and can delete them. Tap a level on the map to add photos there.</p>
      {photos.onAdd && (<>
        <input ref={picker} type="file" accept={ACCEPT} multiple hidden
          onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ""; if (files.length) photos.onAdd?.(null, files); }} />
        <PixelButton variant="secondary" className="self-start px-4 text-sm" disabled={busy} onClick={() => picker.current?.click()}>
          Add photos
        </PixelButton>
      </>)}
      {all.length === 0 ? (
        <p className="text-sm">No photos yet.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {all.slice(0, shownCount).map((f) => (
            <PixelBox as="li" key={f.id} className="flex flex-col gap-2 p-2">
              <button type="button" className="focus-pixel self-center" aria-label={`Show the photo at ${where(f.row_key)}`} onClick={() => show(f)}>
                <PhotoThumb fetch={photos.fetch} file={f} />
              </button>
              <p className="line-clamp-2 text-xs">{where(f.row_key)}</p>
              {photos.onDelete && (
                <PixelButton variant="secondary" className="px-2 text-xs" disabled={busy}
                  onClick={() => window.confirm("Delete this photo for everyone?") && photos.onDelete?.(f)}>
                  Delete
                </PixelButton>
              )}
            </PixelBox>
          ))}
        </ul>
      )}
      {all.length > shownCount && (
        <PixelButton variant="secondary" className="self-start px-4 text-sm" onClick={() => setShownCount((n) => n + ALBUM_PAGE)}>
          Show {Math.min(ALBUM_PAGE, all.length - shownCount)} more
        </PixelButton>
      )}
      <PhotoViewer photo={shown} onClose={() => setShown(null)} logTag="tg-trip" />
    </section>
  );
}

/** One photo's thumbnail, through the map's own fetch: the trip's file route, or the recap's */
function PhotoThumb({ fetch, file }: { fetch: Photos["fetch"]; file: TripFile }) {
  const [got, setGot] = useState<{ id: string; blob: Blob | null } | null>(null);
  // review M2: by id only, as useFile was. A caller's new function (an inline fetch, a poll's render) never fetches again:
  // past 60 thumbs fetchFile's cache can't hold them all, so every render would download the whole album
  const get = useRef(fetch);
  useEffect(() => {
    get.current = fetch;
  });
  useEffect(() => {
    let live = true;
    get.current(file.id).then((blob) => live && setGot({ id: file.id, blob }));
    return () => {
      live = false;
    };
  }, [file.id]);
  const blob = got?.id === file.id ? got.blob : null;
  return blob ? <BlobImage blob={blob} alt="" width={72} height={96} className={THUMB_BOX} /> : <span aria-hidden="true" className={THUMB_BOX} />;
}
