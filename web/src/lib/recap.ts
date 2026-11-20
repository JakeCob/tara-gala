// TG-64: the read-only recap link, /r/<slug>. Anyone with it sees the trip's map as travelled and only what the group
// picked to show. This file knows nothing of the trip's own link: it reads /recaps/<slug> only, and the service worker
// keeps no copy of it (no /recaps in its API paths, no /r/ in its saved pages), so a stranger's phone saves nothing.

import { API_URL } from "./api.ts";
import { type Guide, type Mark, marksByKey } from "./guide.ts";
import { levels } from "./levelMap.ts";

export type RecapPhoto = { id: string; row_key: string | null };
/** Someone who came: said yes, or was marked here. avatar_id is their id, only with profile photos on and one there */
export type RecapPerson = { name: string; arrived_at: string | null; avatar_id: string | null };
/** list is null unless names are on; count is always there */
export type RecapPeople = { count: number; list: RecapPerson[] | null };
/** The API's RecapOut. photos is null while photos are off; spending is null unless it's on and something was spent */
export type Recap = {
  name: string;
  start_date: string;
  return_date: string;
  still_on: boolean;
  guide: Guide | null;
  marks: Mark[];
  photos: RecapPhoto[] | null;
  people: RecapPeople;
  spending: { total_centavos: number } | null;
};

export type RecapResult = { ok: true; recap: Recap } | { ok: false; why: "gone" | "offline" | "server" };

const at = (slug: string) => `${API_URL}/recaps/${encodeURIComponent(slug)}`;

/** A photo's or a profile photo's bytes, through the recap's own link and its toggles only */
export function recapFileUrl(slug: string, kind: "photo" | "avatar", id: string): string {
  return `${at(slug)}/${kind === "photo" ? "photos" : "avatars"}/${encodeURIComponent(id)}`;
}

/** The parts the group picked to show, for the log: never a value */
function parts(r: Recap): string {
  return [r.photos ? "photos" : "", r.people.list ? "people" : "", r.spending ? "spending" : ""].filter(Boolean).join(",");
}

/** The recap. A 404 is the one answer for a link that's off, wrong or deleted; anything else can be tried again */
export async function fetchRecap(slug: string): Promise<RecapResult> {
  let res: Response;
  try {
    res = await fetch(at(slug), { cache: "no-store" });
  } catch {
    console.info("[tg-recap] view ok=%s parts=%s", false, "");
    return { ok: false, why: "offline" };
  }
  if (!res.ok) {
    console.info("[tg-recap] view ok=%s parts=%s", false, "");
    return { ok: false, why: res.status === 404 ? "gone" : "server" };
  }
  const recap = (await res.json()) as Recap;
  console.info("[tg-recap] view ok=%s parts=%s", true, parts(recap));
  return { ok: true, recap };
}

const blobs = new Map<string, Promise<Blob | null>>();

/** One picture's bytes from a recapFileUrl, fetched once per page (the browser keeps no copy: the answers are no-cache) */
export function fetchRecapFile(url: string): Promise<Blob | null> {
  const known = blobs.get(url);
  if (known) return known;
  const got = (async () => {
    try {
      const res = await fetch(url, { cache: "no-store" });
      return res.ok ? await res.blob() : null;
    } catch {
      return null;
    }
  })();
  blobs.set(url, got);
  void got.then((blob) => blob || blobs.delete(url)); // offline or gone: try again next time
  return got;
}

const MANILA_TIME = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit", hour12: true });

/** "9:41 AM": when the stop was last ticked, in Manila time */
export function doneTime(mark: Mark): string {
  return MANILA_TIME.format(new Date(mark.updated_at)).replace(/[  ]/g, " ");
}

/** "Fri, Nov 6 to Sun, Nov 8" */
export function recapDates(start: string, back: string): string {
  const f = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  };
  return start === back ? f(start) : `${f(start)} to ${f(back)}`;
}

/** The levels the map draws: each day's rows as they show for the picks */
export function allLevels(r: Recap) {
  const byKey = marksByKey(r.marks);
  return (r.guide?.days ?? []).flatMap((d) => levels(d, byKey));
}

/** "18 of 24 stops done · 23 photos · 6 came": photos only while they're on; the stops and the count always */
export function countLine(r: Recap): string {
  const ls = allLevels(r);
  const line = [`${ls.filter((l) => l.done).length} of ${ls.length} stops done`];
  if (r.photos) line.push(`${r.photos.length} photo${r.photos.length === 1 ? "" : "s"}`);
  line.push(`${r.people.count} came`);
  return line.join(" · ");
}

/** Each level's photos by its row key, and On the trip: no row, or a row that isn't a level on the map any more */
export function photosByRow(r: Recap): { rows: Record<string, RecapPhoto[]>; onTheTrip: RecapPhoto[] } {
  const shown = new Set(allLevels(r).map((l) => l.row.key));
  const rows: Record<string, RecapPhoto[]> = {};
  const onTheTrip: RecapPhoto[] = [];
  for (const p of r.photos ?? []) {
    if (p.row_key && shown.has(p.row_key)) (rows[p.row_key] ??= []).push(p);
    else onTheTrip.push(p);
  }
  return { rows, onTheTrip };
}
