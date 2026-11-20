// TG-64 slot C, the map's recap mode and the trip page's Trip recap box. Run with `npm test` (node --test, Node 22.18+
// type stripping). Ids W6 to W9 are plan.md §5's. Web has no component runner, so these are the API client and source
// checks; tg-test's M1 to M3 run the box and the map end to end. The trip and its names are made up.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { format } from "node:util";
import * as tripLib from "./trip.ts";
import { FLAG_DEFAULTS } from "./flags.ts";

const WEB = new URL("../../", import.meta.url);
const read = (p: string) => (existsSync(new URL(p, WEB)) ? readFileSync(new URL(p, WEB), "utf8").replaceAll("&apos;", "'") : "");
const code = (src: string) => src.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const map = () => read("src/components/LevelMap.tsx");
const box = () => read("src/components/TripRecap.tsx");
const tripView = () => read("src/components/TripView.tsx");
const between = (src: string, from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from) + 1));

const SLUG = "b".repeat(32);
const SETTINGS = { photos: true, people: "names", spending: "total" };
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function sent(run: () => Promise<unknown>, status = 200, body: unknown = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  const result = await run();
  return { ...calls[0], calls, result };
}

// ---------------------------------------------------------------- LevelMap's recap mode (W6, W7)

test("T64-W6 LevelMap's props: recap mode, and Photos fetch their own bytes with Add and Delete optional", () => {
  const src = map();
  assert.match(src, /recap\?: true;/);
  const photos = between(src, "export type Photos = {", "};");
  assert.match(photos, /files: TripFile\[\];/);
  assert.match(photos, /fetch: \(id: string\) => Promise<Blob \| null>;/, "the trip passes fetchFile, the recap its own URL");
  assert.match(photos, /onAdd\?: \(rowKey: string \| null, picked: File\[\]\) => void;/);
  assert.match(photos, /onDelete\?: \(file: TripFile\) => void;/);
  assert.doesNotMatch(photos, /slug/, "the map no longer knows whose link it is");
  assert.doesNotMatch(code(src), /fetchFile|photos\.slug|<Thumb slug=/, "every picture comes through photos.fetch");
  assert.match(src, /photos\.fetch\(/);
});

test("T64-W6b recap mode: no Yellow next tile, no data-next, no trip menu", () => {
  const src = map();
  assert.match(src, /const next = [^;\n]*!recap[^;\n]*nextLevel\(list\)[^;\n]*;/, "next is null in recap mode, so neither data-next nor the yellow tile is drawn");
  assert.equal(src.match(/data-next=\{l\.row\.key === next \? "" : undefined\}/g)?.length, 1, "data-next only through next");
  assert.equal(src.match(/l\.row\.key === next \? "bg-flag-yellow" : "bg-screen-paper"/g)?.length, 1, "the yellow tile only through next");
  assert.match(src, /\{!recap && \(\s*<nav aria-label="Trip menu"/, "Buses, Budget, To-do, Sources and Album are the trip page's");
});

test("T64-W6c a done level's sign says when, in Manila time, and how many photos; a level not done says so to a screen reader", () => {
  const src = map();
  assert.match(src, /import \{[^}]*\bdoneTime\b[^}]*\} from "@\/lib\/recap";/);
  const sign = between(src, '<span className="min-w-0 max-w-88 flex-1 pixel-frame', "</button>");
  assert.match(sign, /text-xs font-semibold/);
  assert.match(sign, /<span aria-hidden="true">✓<\/span> Done \{doneTime\(/, "✓ Done 9:41 AM, the tick hidden from a screen reader");
  assert.match(sign, /` · \$\{shots\} photo\$\{shots === 1 \? "" : "s"\}`/, " · 2 photos on the same line");
  assert.match(sign, /sr-only">, not ticked</);
});

test("T64-W6d the level dialog in recap mode: Done and its time, its photos, Close, and no Add or Delete without their handlers", () => {
  const src = map();
  const dialog = between(src, "function LevelDialog", "function Buses");
  assert.match(dialog, /Done \{doneTime\(/);
  assert.match(dialog, /\{photos\.onAdd && \(/, "Add photos here only with onAdd");
  assert.equal(dialog.match(/photos\.onAdd\(/g)?.length, 1);
  const album = src.slice(src.indexOf("function Album"));
  assert.match(album, /\{photos\.onAdd && \(/, "the Album's Add photos only with onAdd");
  assert.match(album, /\{photos\.onDelete && \(/, "and its Delete only with onDelete");
  assert.match(dialog, /photos\.fetch\(f\.id\)/);
});

test("T64-W7 the trip page passes fetch into the map's photos, so the trip's photos still load", () => {
  const src = tripView();
  const photos = between(src, "photos={{", "busy={");
  assert.match(photos, /fetch: \(id\) => fetchFile\(slug, id\),/);
  assert.doesNotMatch(photos, /^\s+slug,$/m, "no slug in Photos");
  assert.match(photos, /onAdd: async \(rowKey, picked\) => \{/, "the trip keeps Add");
  assert.match(photos, /onDelete: \(file\) => void write\("photo-delete"/, "and Delete");
  assert.doesNotMatch(src, /<LevelMap[^>]*\brecap\b/, "the trip page's map is never in recap mode");
});

// ---------------------------------------------------------------- the trip page's Trip recap box (W8)

test("T64-W8 tripApi.setRecap is one PUT with exactly the three settings; stopRecap is a DELETE", async () => {
  const trip = { share_slug: SLUG, recap: { slug: "e".repeat(32), ...SETTINGS } };
  const on = await sent(() => tripLib.tripApi.setRecap(SLUG, SETTINGS as never), 200, trip);
  assert.match(on.url, new RegExp(`/sessions/${SLUG}/recap$`));
  assert.equal(on.init.method, "PUT");
  assert.deepEqual(JSON.parse(String(on.init.body)), SETTINGS);
  assert.deepEqual(on.result, { ok: true, trip });
  assert.equal(on.calls.length, 1);
  const off = await sent(() => tripLib.tripApi.stopRecap(SLUG), 200, { ...trip, recap: { slug: null, photos: false, people: "none", spending: "none" } });
  assert.match(off.url, new RegExp(`/sessions/${SLUG}/recap$`));
  assert.equal(off.init.method, "DELETE");
  assert.equal(off.init.body, undefined);
});

test("T64-W8b TripRecap: one PUT for turning it on and for every change, one DELETE, and every control held offline", () => {
  const src = code(box());
  assert.ok(src, "src/components/TripRecap.tsx exists");
  assert.equal(src.match(/tripApi\.setRecap\(/g)?.length, 1, "turning on and each change send the same one PUT");
  assert.match(src, /tripApi\.setRecap\(slug, \{ photos[^}]*, people[^}]*, spending[^}]*\}\)/, "with all three fields");
  assert.equal(src.match(/tripApi\.stopRecap\(/g)?.length, 1);
  assert.match(src, /<fieldset\b/);
  for (const legend of ["Photos", "People", "Spending"]) assert.match(src, new RegExp(`<legend[^>]*>${legend}</legend>|as="legend"[^>]*>${legend}<`), legend);
  assert.match(src, /type="checkbox"/, "the album is one checkbox");
  assert.match(src, /<PixelChoice\b/, "People and Spending are pills");
  assert.match(src, /aria-disabled=\{!online/, "offline holds every control in place, still focusable");
  assert.doesNotMatch(src, /(?<!aria-)disabled=\{!online/);
  assert.match(src, /Changing the recap needs signal\./);
  assert.match(src, /role="status"/);
  assert.match(src, /role="alert"|tone="alertText"/);
});

test("T64-W8c TripRecap's words are ux.md §2's, with Rev 1's Never on it", () => {
  const src = box();
  for (const words of [
    "Trip recap",
    "A read-only page of the trip to share with anyone: the map as you went, with the times you ticked each stop. Add only what you pick below.",
    "Show the album. Faces of the group may be in it.",
    "Just how many came", "Names and arrival times", "Names, times and profile photos", "Don't show", "The group's total",
    "Never on it: tickets, QRs, the hotel booking (its address, reference and notes), who owes whom, or this trip's link. The map shows the plan's places and notes as written, including where you're staying and any names.",
    " Anyone with the recap link can see it.",
    "Turn on the recap link", "Turn off the recap link", "The recap link is on.", "Anyone with it sees the map and what's picked below. Changes show at once.",
    "Share recap link", "Open the recap", "Link copied. Send it to whoever you like.", "Copy this link and send it to whoever you like.",
    "Couldn't save that. Try again with signal.", "The recap link is off.",
    "shows the album now", "hides the album now", "shows only how many came now", "shows names now", "shows names and profile photos now",
    "hides spending now", "shows the group's total now",
  ]) {
    assert.ok(src.includes(words), words);
  }
  assert.match(src, /Saved\. The recap \$\{/, "Saved. The recap <clause>.");
  assert.match(src, /window\.confirm\("Turn off the recap link\? It stops working for everyone who has it\. Turning it on again makes a new link, starting from the map only\."\)/);
  assert.doesNotMatch(src, /Each person's share|per_person/, "owner decision 7: the total only");
});

test("T64-W8d Share and Open: the share sheet through runShare, ux's text, and /r/ in a new tab", () => {
  const src = box();
  assert.match(src, /runShare\(shareDeps\(navigator\)/);
  assert.match(src, /text: `How "\$\{trip\.name\}" went, on Tara Gala\.`/);
  assert.match(src, /\/r\/\$\{/);
  assert.match(src, /target="_blank"/);
  assert.match(src, /rel="noopener noreferrer"/);
  assert.doesNotMatch(src, /variant="primary"/, "Share the trip keeps the page's one red button");
});

test("T64-W8e the box's logs: recap-on, recap-off and recap-set <part>, never a slug or a name", () => {
  const src = code(box());
  assert.match(src, /console\.info\("\[tg-trip\] recap-on/);
  assert.match(src, /console\.info\("\[tg-trip\] recap-off/);
  assert.match(src, /console\.info\("\[tg-trip\] recap-set %s/);
  assert.doesNotMatch(src, /console\.\w+\([^)]*\b(slug|name|trip\.recap\.slug)\b/);
  assert.equal(format("[tg-trip] recap-set %s", "people"), "[tg-trip] recap-set people", "the part is a word, never a value");
});

test("T64-W8f the trip page mounts the box behind the flag, once, before Delete this trip", () => {
  const src = tripView();
  assert.match(src, /import TripRecap from "\.\/TripRecap";/);
  assert.equal(src.match(/<TripRecap\b/g)?.length, 1);
  assert.match(src, /\{flags\.recapLinks && <TripRecap\b/);
  assert.ok(src.indexOf("<TripRecap") < src.indexOf("<DeleteTrip"), "Delete this trip stays last");
});

// ---------------------------------------------------------------- the flag (W9)

test("T64-W9 recapLinks: off by default, read from NEXT_PUBLIC_RECAP_LINKS, and documented", () => {
  assert.equal((FLAG_DEFAULTS as Record<string, boolean>).recapLinks, false);
  assert.match(read("src/lib/flags.ts"), /recapLinks: parseFlag\(process\.env\.NEXT_PUBLIC_RECAP_LINKS, FLAG_DEFAULTS\.recapLinks\)/);
  assert.match(read(".env.example"), /^NEXT_PUBLIC_RECAP_LINKS=false$/m);
  assert.match(readFileSync(new URL("../../../README.md", import.meta.url), "utf8"), /\| `RECAP_LINKS` \| `NEXT_PUBLIC_RECAP_LINKS` \| `false` \|/);
});
