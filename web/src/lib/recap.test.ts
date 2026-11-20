// TG-64 slot B, the recap page /r/<slug>, web side. Run with `npm test` (node --test, Node 22.18+ type stripping). Ids
// W1 to W5 are plan.md §5's. Web has no component runner, so RecapView's states are checked end to end by tg-test (M1 to
// M4); here are the pure helpers, the API client and the source checks. recap.fixture.json is a real RecapOut, recorded
// from the API's own tests over a made-up trip ("Baguio", Ana, Ben, Pia and Rex, a ₱18,000 wallet), with the sunrise
// pick made and everything on.
// `import()` inside each test, not a static import: before recap.ts exists, a static import would stop the whole file.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { format } from "node:util";

const WEB = new URL("../../", import.meta.url);
const read = (p: string) => (existsSync(new URL(p, WEB)) ? readFileSync(new URL(p, WEB), "utf8").replaceAll("&apos;", "'") : "");
const view = () => read("src/components/RecapView.tsx");
const page = () => read("src/app/r/[slug]/page.tsx");
const code = (src: string) => src.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const lib = () => import("./recap.ts");

const FIXTURE = JSON.parse(readFileSync(new URL("./recap.fixture.json", import.meta.url), "utf8"));
const SLUG = "d".repeat(32);
const PHOTO = "3d4b9de5-38ce-44b1-aa76-982f64f85d15";
const originalFetch = globalThis.fetch;
const originalInfo = console.info;

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.info = originalInfo;
});

/** Runs one call with fetch stubbed (or throwing, for no signal), and gives back what it sent and what it returned. */
async function sent(run: () => Promise<unknown>, status = 200, body: unknown = FIXTURE) {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (status === 0) throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  const result = await run();
  return { ...calls[0], calls, result };
}

/** The recap with some of it changed: a fresh copy each time. */
const recapWith = (change: Record<string, unknown> = {}) => ({ ...structuredClone(FIXTURE), ...change });

// ---------------------------------------------------------------- the helpers (W1 to W3)

test("T64-W0 the fixture is a real RecapOut with everything on, and nothing private in it", () => {
  assert.deepEqual(Object.keys(FIXTURE).sort(), ["guide", "marks", "name", "people", "photos", "return_date", "spending", "start_date", "still_on"]);
  assert.deepEqual(FIXTURE.guide.todo, []);
  assert.deepEqual(FIXTURE.guide.sources, []);
  assert.deepEqual(FIXTURE.guide.budget.rows, []);
  assert.ok(FIXTURE.marks.every((m: { key: string }) => !m.key.startsWith("todo:")));
  assert.deepEqual(FIXTURE.spending, { total_centavos: 1800000 });
  assert.equal(FIXTURE.people.count, 3);
  const text = JSON.stringify(FIXTURE);
  for (const banned of ["Rex", "share_slug", "invite_slug", "booking_ref", "wallet"]) assert.ok(!text.includes(banned), banned);
});

test("T64-W1 doneTime: a tick's updated_at in Manila time, across UTC midnight", async () => {
  const { doneTime } = await lib();
  const at = (updated_at: string) => doneTime({ key: "row:d1-01", value: "done", updated_at });
  assert.equal(at("2026-11-06T01:41:00Z"), "9:41 AM");
  assert.equal(at("2026-11-06T15:59:00Z"), "11:59 PM", "still Nov 6 in Manila");
  assert.equal(at("2026-11-06T16:05:00Z"), "12:05 AM", "UTC's 4 PM is Manila's midnight");
  assert.equal(at("2026-11-06T04:00:00Z"), "12:00 PM");
  assert.equal(at("2026-11-06T21:05:00+00:00"), "5:05 AM", "the API's own offset form");
  assert.doesNotMatch(at("2026-11-06T01:41:00Z"), /[  ]/, "a plain space, as formatTime's");
});

test("T64-W2 countLine: the stops always, then photos and who came, each only when it's on", async () => {
  const { countLine } = await lib();
  // The fixture's levels: 7 + 8 + 9 = 24 with the sunrise pick at B (d2-01 hides, d2-02 shows, d3-01 hides); 4 ticked
  assert.equal(countLine(recapWith()), "4 of 24 stops done · 3 photos · 3 came");
  assert.equal(countLine(recapWith({ photos: null })), "4 of 24 stops done · 3 came", "photos off: no photos part");
  assert.equal(countLine(recapWith({ people: { count: 3, list: null } })), "4 of 24 stops done · 3 photos · 3 came", "Just how many came keeps the count");
  assert.equal(countLine(recapWith({ photos: [FIXTURE.photos[2]], people: { count: 1, list: null } })), "4 of 24 stops done · 1 photo · 1 came");
  assert.equal(countLine(recapWith({ photos: [] })), "4 of 24 stops done · 0 photos · 3 came", "photos on and none yet");
  // Before a pick every option's rows show (guide.rowShows), so the count follows what levels() draws
  assert.equal(countLine(recapWith({ marks: [] })), "0 of 26 stops done · 3 photos · 3 came", "no pick: d2-01, d2-02 and d3-01 all show (7 + 9 + 10)");
  const unpicked = recapWith({ marks: FIXTURE.marks.filter((m: { key: string }) => m.key !== "pick:sunrise") });
  assert.equal(countLine(unpicked), "4 of 26 stops done · 3 photos · 3 came", "no pick: the tick on d2-02 counts, since it shows");
  const pickedA = recapWith({ marks: FIXTURE.marks.map((m: { key: string }) => (m.key === "pick:sunrise" ? { ...m, value: "A" } : m)) });
  assert.equal(countLine(pickedA), "3 of 25 stops done · 3 photos · 3 came", "pick A hides d2-02 (7 + 8 + 10): a tick on a row the pick hides isn't a stop done");
});

test("T64-W3 photosByRow: each level's photos, and On the trip for no row or a row that isn't a level", async () => {
  const { photosByRow } = await lib();
  const [a, b, loose] = FIXTURE.photos;
  assert.deepEqual(photosByRow(recapWith()), { rows: { "d1-01": [a, b] }, onTheTrip: [loose] });
  const gone = { id: "e0000000-0000-4000-8000-000000000001", row_key: "d9-99" };
  const unpicked = { id: "e0000000-0000-4000-8000-000000000002", row_key: "d2-01" };
  assert.deepEqual(photosByRow(recapWith({ photos: [a, gone, loose, unpicked] })), { rows: { "d1-01": [a] }, onTheTrip: [gone, loose, unpicked] },
    "a row the plan dropped, or one the pick hides, has no level to open: its photos stay in the album, in order");
  assert.deepEqual(photosByRow(recapWith({ photos: null })), { rows: {}, onTheTrip: [] });
});

// ---------------------------------------------------------------- the API client (W4)

test("T64-W4 fetchRecap: the recap, and gone, offline and server kept apart", async () => {
  const { fetchRecap } = await lib();
  const ok = await sent(() => fetchRecap(SLUG));
  assert.match(ok.url, new RegExp(`/recaps/${SLUG}$`));
  assert.equal(ok.init?.method ?? "GET", "GET");
  assert.equal(ok.init?.cache, "no-store", "the browser keeps no copy");
  assert.deepEqual(ok.result, { ok: true, recap: FIXTURE });
  assert.deepEqual((await sent(() => fetchRecap(SLUG), 404, { detail: "recap_not_found" })).result, { ok: false, why: "gone" });
  assert.deepEqual((await sent(() => fetchRecap(SLUG), 0)).result, { ok: false, why: "offline" }, "no signal isn't a dead link");
  for (const status of [500, 502, 503]) assert.deepEqual((await sent(() => fetchRecap(SLUG), status, {})).result, { ok: false, why: "server" }, String(status));
  assert.deepEqual((await sent(() => fetchRecap(SLUG), 429, { detail: "rate_limited" })).result, { ok: false, why: "server" },
    "a viewer over the read limit gets Try again, never the final \"isn't shared any more\"");
});

test("T64-W4b recapFileUrl: a photo or a profile photo, only through the recap's own link", async () => {
  const { recapFileUrl } = await lib();
  assert.match(recapFileUrl(SLUG, "photo", PHOTO), new RegExp(`/recaps/${SLUG}/photos/${PHOTO}$`));
  assert.match(recapFileUrl(SLUG, "avatar", PHOTO), new RegExp(`/recaps/${SLUG}/avatars/${PHOTO}$`));
});

test("T64-W4c the view log: ok and the parts that are on, never the slug, a name or an amount", async () => {
  const { fetchRecap } = await lib();
  const lines: string[] = [];
  console.info = (...args: unknown[]) => void lines.push(format(...args));
  await sent(() => fetchRecap(SLUG));
  await sent(() => fetchRecap(SLUG), 200, recapWith({ photos: null, people: { count: 3, list: null }, spending: null }));
  await sent(() => fetchRecap(SLUG), 404, { detail: "recap_not_found" });
  const views = lines.filter((l) => l.startsWith("[tg-recap] view "));
  assert.deepEqual(views, ["[tg-recap] view ok=true parts=photos,people,spending", "[tg-recap] view ok=true parts=", "[tg-recap] view ok=false parts="]);
  for (const line of lines) {
    for (const banned of [SLUG.slice(0, 9), "Ana", "Pia", "1800000", "18,000"]) assert.ok(!line.includes(banned), `${line}: ${banned}`);
  }
});

// ---------------------------------------------------------------- the page (W5)

test("T64-W5 page metadata: noindex, no referrer, no preview image and no trip name", () => {
  const src = page();
  assert.ok(src, "src/app/r/[slug]/page.tsx exists");
  assert.match(src, /title: "Trip recap · Tara Gala"/);
  assert.match(src, /robots: \{ index: false, follow: false \}/);
  assert.match(src, /referrer: "no-referrer"/);
  assert.match(src, /export const instant = false/);
  assert.doesNotMatch(src, /openGraph|twitter|generateMetadata/, "nothing per trip in the metadata, and no photo in a link preview");
  assert.match(src, /<RecapView\b/);
  assert.match(src, /Opening the recap\.\.\./);
});

test("T64-W5b RecapView draws the map read-only: recap mode, the recap's photo URLs, and no write", () => {
  const src = code(view());
  assert.ok(src, "src/components/RecapView.tsx exists");
  assert.equal(src.match(/<LevelMap\b/g)?.length, 1);
  const map = src.slice(src.indexOf("<LevelMap"), src.indexOf("/>", src.indexOf("<LevelMap")));
  assert.match(map, /\brecap\b/, "recap mode");
  for (const banned of ["onTick", "onPick", "editor", "onAdd", "onDelete", "onOpenLevel", "copyLine"]) assert.ok(!src.includes(banned), banned);
  assert.match(src, /recapFileUrl\(/, "photos and avatars load through the recap's own URLs");
  assert.match(src, /fetch: /, "the map's Photos.fetch");
  assert.match(src, /fetchRecap\(/);
});

test("T64-W5c no link leaks: the recap never touches the trip's link, its files, the wallet or the invite, and keeps nothing", () => {
  for (const file of ["src/components/RecapView.tsx", "src/lib/recap.ts", "src/app/r/[slug]/page.tsx"]) {
    const src = code(read(file));
    assert.ok(src, file);
    for (const banned of ["/t/", "share_slug", "useFile", "fetchFile", "rememberTrip", "knownTrips", "/sessions", "/wallets", "/invites",
      "tripApi", "walletApi", "inviteApi", "localStorage", "indexedDB", "caches."]) {
      assert.ok(!src.includes(banned), `${file}: ${banned}`);
    }
  }
});

test("T64-W5d the service worker keeps no recap: /recaps/ isn't an API path it caches, and /r/ isn't a saved page", () => {
  const sw = read("public/sw.js");
  const line = (name: string) => sw.split("\n").find((l) => l.startsWith(`const ${name} =`)) ?? "";
  assert.ok(line("API_PATHS") && line("SAVED_PAGE"));
  assert.ok(!line("API_PATHS").includes("recaps"));
  const saved = new Function(`${line("SAVED_PAGE")}\nreturn SAVED_PAGE;`)() as RegExp;
  assert.equal(saved.test(`/r/${SLUG}`), false);
  assert.equal(saved.test(`/t/${SLUG}`), true, "the check reads the real pattern");
});

test("T64-W5e RecapView's words are ux.md §7's, with Rev 1's who came", () => {
  const src = view();
  for (const words of [
    "Trip recap", "The trip is still on. This page fills in as the group ticks stops and adds photos.", "The trip",
    "Each stop is a level. Done ones have a tick and the time the group ticked it.", " Tap one for its photos.", "No stops ticked yet.",
    "Photos", "On the trip", "Couldn't load this photo.", "Who came", " came. Times are when each got to the meet-up, ", "Joined later",
    "Spending", " in all", "From the group's shared wallet.",
    "This is one group's trip. Bus times and fares change, so check today's on Buses before you go.", "See today's buses", "Plan your own trip",
    "This recap isn't shared any more. Ask whoever sent it for a new link.", "Couldn't open the recap. Check your signal and try again.", "Try again",
  ]) {
    assert.ok(src.includes(words), words);
  }
  assert.doesNotMatch(src, /Show all/, "ux review S1: paging, never everything at once (see W10)");
  assert.match(src, /`Photo: \$\{/, "a tile's name is its caption");
  assert.match(src, /href="\/buses"/);
  assert.match(src, /href="\/"/);
  assert.match(src, /<PageTitle\b[^>]*>\s*Trip recap\s*<\/PageTitle>/, "one h1");
  for (const h2 of ["The trip", "Photos", "Who came", "Spending"]) assert.match(src, new RegExp(`<SectionTitle[^>]*>${h2}</SectionTitle>`), h2);
  assert.match(src, /tabular-nums/);
  assert.doesNotMatch(code(src), /\beach person\b|owes|paid by|left over|\bover budget\b/i, "the total only, never a share or a judgement");
});

test("T64-W5f the recap page's own log line is recap.ts's only; RecapView logs no name", () => {
  const src = code(view());
  assert.ok(src, "src/components/RecapView.tsx exists");
  assert.doesNotMatch(src, /console\.\w+\([^)]*\b(name|slug)\b/);
});

// ---------------------------------------------------------------- the album pages (ux review S1, tg-review S1)

test("T64-W10 morePhotos: the first 8, then 24 more a tap, with the real number near the end", async () => {
  const { RECAP_FIRST_PHOTOS, RECAP_PHOTO_PAGE, morePhotos } = await lib();
  assert.deepEqual([RECAP_FIRST_PHOTOS, RECAP_PHOTO_PAGE], [8, 24]);
  assert.deepEqual(morePhotos(8, 300), { next: 32, label: "Show 24 more photos" });
  assert.deepEqual(morePhotos(8, 30), { next: 30, label: "Show 22 more photos" });
  assert.deepEqual(morePhotos(296, 300), { next: 300, label: "Show 4 more photos" });
  assert.deepEqual(morePhotos(299, 300), { next: 300, label: "Show 1 more photo" });
  assert.equal(morePhotos(300, 300), null, "every photo shows: no button, no line");
  assert.equal(morePhotos(5, 5), null);
  // A 300-photo album, the cap: the page shows 8, and no tap ever adds more than 24 tiles, so no more than 24 GETs
  let shown = Math.min(RECAP_FIRST_PHOTOS, 300);
  let taps = 0;
  for (let more = morePhotos(shown, 300); more; more = morePhotos(shown, 300)) {
    assert.ok(more.next - shown > 0 && more.next - shown <= 24, `tap ${taps + 1}: ${shown} to ${more.next}`);
    shown = more.next;
    taps++;
  }
  assert.deepEqual([shown, taps], [300, 13]);
});

test("T64-W10b RecapView pages its album: tiles for the shown count only, the next page on a tap, focus on the first new tile", () => {
  const src = code(view());
  assert.ok(src, "src/components/RecapView.tsx exists");
  const album = src.slice(src.indexOf("function Album("));
  assert.match(album, /useState\(RECAP_FIRST_PHOTOS\)/, "8 to start");
  assert.match(album, /photos\.slice\(0, shown\)\.map\(/, "a tile, and its one GET, only for what shows");
  assert.match(album, /const more = morePhotos\(shown, photos\.length\);/);
  assert.match(album, /\{more && \(/, "no button once every photo shows");
  assert.match(album, /setShown\(more\.next\)/);
  assert.match(album, /\{more\.label\}/);
  assert.doesNotMatch(album, /setAll|photos\.length > FIRST_PHOTOS/, "never everything at once");
});

test("T64-W11 the recap keeps at most 60 pictures in memory, the newest", async () => {
  const { RECAP_FILES_IN_MEMORY, fetchRecapFile, recapFileUrl, recapFilesInMemory } = await lib();
  assert.equal(RECAP_FILES_IN_MEMORY, 60, "fetchFile's FILES_IN_MEMORY");
  let gets = 0;
  globalThis.fetch = (async () => {
    gets++;
    return new Response(new Blob(["x"], { type: "image/jpeg" }), { status: 200 });
  }) as typeof fetch;
  const urls = Array.from({ length: 200 }, (_, i) => recapFileUrl("f".repeat(32), "photo", `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`));
  for (const url of urls) {
    await fetchRecapFile(url);
    assert.ok(recapFilesInMemory() <= 60, `${recapFilesInMemory()} kept`);
  }
  assert.equal(gets, 200);
  await fetchRecapFile(urls[199]);
  assert.equal(gets, 200, "the newest is still kept");
  await fetchRecapFile(urls[0]);
  assert.equal(gets, 201, "the oldest was let go, and is fetched again");
  assert.ok(recapFilesInMemory() <= 60);
});

