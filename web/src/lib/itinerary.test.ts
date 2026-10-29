// TG-23: share-link helpers (plan.md lib/itinerary.ts) and fetchItinerary. Data below is made up for tests only.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  SLUG_PATTERN,
  dateRange,
  dayHeading,
  formatPeso,
  isValidSlug,
  issueNotice,
  issuesFor,
  joinNames,
  nextShareStep,
  partySummary,
  runShare,
  shareDeps,
  shareMethod,
  shareText,
  shareUrl,
  type PlanIssue,
} from "./itinerary.ts";
import { API_URL, fetchItinerary } from "./api.ts";
import { formatTravelDate } from "./direction.ts";
import { partySummary as pickerPartySummary } from "./party.ts";

const WEB = new URL("../../", import.meta.url);
const REPO = new URL("../", WEB);
const TZS = ["America/Los_Angeles", "Pacific/Kiritimati", "Asia/Manila"];
const originalTZ = process.env.TZ;
const originalFetch = globalThis.fetch;

afterEach(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
  globalThis.fetch = originalFetch;
});

// --- T23-W1 / W2 slugs ---------------------------------------------------------------------------

test("valid slugs: DB hex, premade, mixed, 100 characters", () => {
  for (const s of ["a1b2c3d4e5f6", "premade-chill", "A_b-9", "a".repeat(100)]) assert.equal(isValidSlug(s), true, s);
});

test("invalid slugs never reach the API", () => {
  const bad = ["", "a".repeat(101), "a/b", "a b", "a%20", "ñ", "<script>", "..", "a.b", "abc\n", "\nabc"];
  for (const s of bad) assert.equal(isValidSlug(s), false, JSON.stringify(s));
});

test("the web slug pattern is the API's pattern (drift guard)", () => {
  const py = readFileSync(new URL("api/app/itineraries.py", REPO), "utf8");
  const m = py.match(/^SLUG = re\.compile\(r"([^"]+)"\)/m);
  assert.ok(m, "SLUG = re.compile(r\"...\") not found in itineraries.py");
  assert.equal(SLUG_PATTERN.source, m[1]);
  assert.equal(SLUG_PATTERN.flags, "");
});

// --- T23-W3 to W5 sharing ------------------------------------------------------------------------

test("share URL is origin + /i/ + slug, with no query or hash", () => {
  assert.equal(shareUrl("https://example.test", "premade-chill"), "https://example.test/i/premade-chill");
  assert.equal(shareUrl("http://localhost:3020", "a1b2c3d4e5f6"), "http://localhost:3020/i/a1b2c3d4e5f6");
  const url = shareUrl("https://example.test", "a1b2c3d4e5f6");
  assert.doesNotMatch(url, /[?#]/);
  assert.equal(shareUrl("https://example.test", "a b"), "https://example.test/i/a%20b"); // encoded
});

test("share method: Web Share first, then clipboard, then manual", () => {
  assert.equal(shareMethod({ share: true, clipboard: true }), "share");
  assert.equal(shareMethod({ share: true, clipboard: false }), "share");
  assert.equal(shareMethod({ share: false, clipboard: true }), "copy");
  assert.equal(shareMethod({ share: false, clipboard: false }), "manual");
});

test("share steps: cancel is silent, other share errors copy, copy errors go manual", () => {
  const err = (name: string) => ({ name });
  assert.equal(nextShareStep("share", null), "done");
  assert.equal(nextShareStep("share", err("AbortError")), "silent");
  assert.equal(nextShareStep("share", err("NotAllowedError")), "copy");
  assert.equal(nextShareStep("share", err("TypeError")), "copy");
  assert.equal(nextShareStep("copy", null), "done");
  assert.equal(nextShareStep("copy", err("NotAllowedError")), "manual");
  assert.equal(nextShareStep("copy", err("TypeError")), "manual");
  // a cancelled share sheet never falls through to copying
  assert.ok(!["copy", "manual"].includes(nextShareStep("share", err("AbortError"))));
});

// --- runShare: the whole Share tap, with fake browser APIs (RED re-audit gap B) -------------------

const PAYLOAD = { title: "Tara Gala trip plan", text: "Our Baguio trip, Fri, Nov 6 – Sun, Nov 8", url: "https://example.test/i/a1b2c3d4e5f6" };

function fakes(opts: { share?: Error | "ok"; copy?: Error | "ok" }) {
  const calls = { share: [] as unknown[], copy: [] as string[] };
  const fail = (e: Error) => Promise.reject(e);
  const deps: { share?: (p: typeof PAYLOAD) => Promise<void>; writeText?: (s: string) => Promise<void> } = {};
  if (opts.share) deps.share = (p) => { calls.share.push(p); return opts.share === "ok" ? Promise.resolve() : fail(opts.share as Error); };
  if (opts.copy) deps.writeText = (u) => { calls.copy.push(u); return opts.copy === "ok" ? Promise.resolve() : fail(opts.copy as Error); };
  return { deps, calls };
}
const named = (name: string) => Object.assign(new Error(name), { name });

test("runShare: share works, nothing is copied", async () => {
  const { deps, calls } = fakes({ share: "ok", copy: "ok" });
  assert.equal(await runShare(deps, PAYLOAD), "done");
  assert.deepEqual(calls.share, [PAYLOAD]);
  assert.deepEqual(calls.copy, []);
});

test("runShare: a cancelled share sheet is silent and copies nothing", async () => {
  const { deps, calls } = fakes({ share: named("AbortError"), copy: "ok" });
  assert.equal(await runShare(deps, PAYLOAD), "silent");
  assert.deepEqual(calls.copy, []);
});

test("runShare: any other share error falls back to copying the link once", async () => {
  const { deps, calls } = fakes({ share: named("NotAllowedError"), copy: "ok" });
  assert.equal(await runShare(deps, PAYLOAD), "copied");
  assert.deepEqual(calls.copy, [PAYLOAD.url]);
});

test("runShare: a share error with no clipboard goes to the manual field", async () => {
  const { deps } = fakes({ share: named("NotAllowedError") });
  assert.equal(await runShare(deps, PAYLOAD), "manual");
});

test("runShare: without Web Share it copies and never calls share", async () => {
  const { deps, calls } = fakes({ copy: "ok" });
  assert.equal(await runShare(deps, PAYLOAD), "copied");
  assert.deepEqual(calls.copy, [PAYLOAD.url]);
  assert.deepEqual(calls.share, []);
});

test("runShare: a rejected copy goes to the manual field", async () => {
  const { deps } = fakes({ copy: named("NotAllowedError") });
  assert.equal(await runShare(deps, PAYLOAD), "manual");
});

test("runShare: nothing available goes to the manual field", async () => {
  assert.equal(await runShare({}, PAYLOAD), "manual");
});

// --- shareDeps: which browser APIs runShare gets (RED re-audit 2, gap C) ---------------------------

test("shareDeps: missing or non-function APIs are undefined, never assumed", () => {
  for (const nav of [{}, { clipboard: {} }, { share: "not a function" }, { clipboard: { writeText: 7 } }]) {
    const deps = shareDeps(nav);
    assert.equal(deps.share, undefined, JSON.stringify(nav));
    assert.equal(deps.writeText, undefined, JSON.stringify(nav));
  }
});

test("shareDeps: each API is bound to its owner (no Illegal invocation)", async () => {
  const seen: unknown[] = [];
  const clipboard = { writeText(this: unknown) { seen.push(this); return Promise.resolve(); } };
  const nav = { share(this: unknown) { seen.push(this); return Promise.resolve(); }, clipboard };
  const deps = shareDeps(nav);
  await deps.share!(PAYLOAD);
  await deps.writeText!(PAYLOAD.url);
  assert.equal(seen[0], nav);
  assert.equal(seen[1], clipboard);
});

test("shareDeps: Web Share and clipboard are both passed when present", () => {
  const deps = shareDeps({ share: () => Promise.resolve(), clipboard: { writeText: () => Promise.resolve() } });
  assert.equal(typeof deps.share, "function");
  assert.equal(typeof deps.writeText, "function");
});

test("shareDeps + runShare: no Web Share copies the link once", async () => {
  const written: string[] = [];
  const nav = { clipboard: { writeText: (s: string) => { written.push(s); return Promise.resolve(); } } };
  assert.equal(await runShare(shareDeps(nav), PAYLOAD), "copied");
  assert.deepEqual(written, [PAYLOAD.url]);
});

// --- T23-W6 party and names (ux.md section 4; the same rules as TG-15's partySummary) ----------------

const member = (type: string, name: string | null = null) => ({ type, name });

test("party summary: Party of n, fixed type order, TG-15 labels", () => {
  assert.equal(partySummary([member("adult"), member("adult"), member("senior")]), "Party of 3: 2 adults, 1 senior.");
  assert.equal(partySummary([member("senior"), member("adult"), member("adult")]), "Party of 3: 2 adults, 1 senior.");
  assert.equal(partySummary([member("adult")]), "Party of 1: 1 adult.");
  assert.equal(
    partySummary([member("pwd"), member("senior"), member("student"), member("student"), member("adult")]),
    "Party of 5: 1 adult, 2 students, 1 senior, 1 PWD.",
  );
  assert.equal(partySummary([member("pwd"), member("pwd")]), "Party of 2: 2 PWD.");
});

test("party summary: child, then unknown types as other(s), last", () => {
  assert.equal(partySummary([member("child"), member("child"), member("adult")]), "Party of 3: 1 adult, 2 children.");
  assert.equal(partySummary([member("infant"), member("child")]), "Party of 2: 1 child, 1 other.");
  assert.equal(partySummary([member("infant"), member("pet"), member("adult")]), "Party of 3: 1 adult, 2 others.");
});

test("party summary never shows names, and an empty party never reads broken", () => {
  assert.equal(partySummary([member("adult", "Testname-Marker-23 (made up)")]), "Party of 1: 1 adult.");
  const empty = partySummary([]); // the exact text is TG-15's open Q3
  assert.ok(empty.trim().length > 0);
  assert.doesNotMatch(empty, /undefined|null|NaN|Party of 0/);
});

test("party summary matches TG-15's, except the picker-only 'Party is full' sentence (ux.md section 4)", () => {
  const parties = [
    [],
    [member("adult")],
    [member("student"), member("adult"), member("adult")],
    [member("pwd"), member("pwd"), member("senior"), member("child")],
    [member("infant"), member("child"), member("constructor")],
  ];
  for (const p of parties) assert.equal(partySummary(p), pickerPartySummary(p), JSON.stringify(p));
  const ten = Array.from({ length: 10 }, () => member("adult"));
  assert.equal(partySummary(ten), "Party of 10: 10 adults.");
  assert.match(pickerPartySummary(ten), /^Party of 10: 10 adults\. Party is full/);
});

test("names join without an Oxford comma, blanks skipped", () => {
  assert.equal(joinNames([member("adult", "Ana")]), "Ana");
  assert.equal(joinNames([member("adult", "Ana"), member("student", "Ben")]), "Ana and Ben");
  assert.equal(joinNames([member("adult", "Ana"), member("adult", "Ben"), member("senior", "Cora")]), "Ana, Ben and Cora");
  assert.equal(joinNames([member("adult"), member("adult", "Ana"), member("adult", "  "), member("adult", "")]), "Ana");
  assert.equal(joinNames([member("adult"), member("student")]), "");
  assert.equal(joinNames([]), "");
});

// --- dates and the share text (ux.md 2.1, 2.2) -----------------------------------------------------

test("date range: en dash, open-ended, single day; any device time zone", () => {
  for (const tz of TZS) {
    process.env.TZ = tz;
    assert.equal(dateRange("2026-11-06", "2026-11-08"), "Fri, Nov 6 – Sun, Nov 8", tz);
    assert.equal(dateRange("2026-11-06", null), "From Fri, Nov 6", tz);
    assert.equal(dateRange("2026-11-06", "2026-11-06"), "Fri, Nov 6", tz);
  }
  assert.equal(dateRange("2026-11-06", "2026-11-08"), `${formatTravelDate("2026-11-06")} – ${formatTravelDate("2026-11-08")}`);
});

test("share text has the dates only: never names, budget or vibe", () => {
  assert.equal(shareText("2026-11-06", "2026-11-08"), "Our Baguio trip, Fri, Nov 6 – Sun, Nov 8");
  assert.equal(shareText("2026-11-06", null), "Our Baguio trip, From Fri, Nov 6");
});

// --- per-card notices (ux.md 3.2) ------------------------------------------------------------------

test("issue notices: one plain sentence per code, never the validator's message", () => {
  const cases: [string, string][] = [
    ["trip_inactive", "This bus is no longer on our schedule. Check with the operator before you go."],
    ["trip_not_running", "Our schedule doesn't show this bus on this date anymore. Check with the operator."],
    ["wrong_date", "Our schedule doesn't show this bus on this date anymore. Check with the operator."],
    ["unknown_trip", "This bus is no longer in our list."],
    ["unknown_spot", "No longer in our list"],
    ["unknown_leg", "Directions to this stop are no longer in our list."],
    ["leg_wrong_start", "This ride may not match the stop anymore. Check the route before you go."],
    ["leg_wrong_end", "This ride may not match the stop anymore. Check the route before you go."],
    ["closed", "This place may be closed on this day. Check before you go."],
  ];
  for (const [code, text] of cases) assert.equal(issueNotice(code), text, code);
  for (const code of ["overlap", "not_enough_travel_time", "before_bus_arrival", "after_return", "stop_times", "made_up_code"]) {
    assert.equal(issueNotice(code), "This part of the plan may be out of date.", code);
  }
});

// --- T23-W8 issues per card ------------------------------------------------------------------------

test("issuesFor matches a path and its children only", () => {
  const issues: PlanIssue[] = [
    { code: "trip_inactive", path: "outbound.trip_id", message: "x" },
    { code: "unknown_leg", path: "days[0].stops[1].leg.last_mile_route_id", message: "x" },
    { code: "overlap", path: "days[0].stops[1].arrive", message: "x" },
    { code: "closed", path: "days[0].stops[1]", message: "x" },
    { code: "unknown_spot", path: "days[0].stops[10].spot_id", message: "x" },
    { code: "trip_not_running", path: "return.trip_id", message: "x" },
  ];
  assert.deepEqual(issuesFor("days[0].stops[1]", issues).map((i) => i.code), ["unknown_leg", "overlap", "closed"]);
  assert.deepEqual(issuesFor("outbound", issues).map((i) => i.code), ["trip_inactive"]);
  assert.deepEqual(issuesFor("return", issues).map((i) => i.code), ["trip_not_running"]);
  assert.deepEqual(issuesFor("days[0].stops[1]", []), []);
});

// --- T23-W9 / W10 formatting -------------------------------------------------------------------------

test("day heading uses the stored Manila date in every device time zone", () => {
  for (const tz of TZS) {
    process.env.TZ = tz;
    assert.equal(dayHeading({ day: 1, date: "2026-11-06", stops: [] }), "Day 1 · Fri, Nov 6", tz);
    assert.equal(dayHeading({ day: 2, date: "2026-11-07", stops: [] }), "Day 2 · Sat, Nov 7", tz);
    assert.equal(dayHeading({ day: 3, date: null, stops: [] }), "Day 3", tz);
  }
});

test("TZ changes in-process really change the device time zone (guards the loop above)", () => {
  process.env.TZ = "America/Los_Angeles";
  const la = new Date("2026-11-06T00:00:00Z").getDate();
  process.env.TZ = "Asia/Manila";
  assert.notEqual(la, new Date("2026-11-06T00:00:00Z").getDate());
});

test("pesos: whole, centavos, zero, unknown", () => {
  assert.equal(formatPeso(6000), "₱6,000");
  assert.equal(formatPeso(12.5), "₱12.50");
  assert.equal(formatPeso(6000.5), "₱6,000.50");
  assert.equal(formatPeso(0), "₱0");
  assert.equal(formatPeso(null), null);
});

// --- T23-W7 fetchItinerary ---------------------------------------------------------------------------

function stubFetch(respond: () => Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond();
  }) as typeof fetch;
  return calls;
}

test("fetchItinerary: exact URL, no-store, 200 parsed", async () => {
  const body = { share_slug: "a1b2c3d4e5f6", issues: [] };
  const calls = stubFetch(async () => new Response(JSON.stringify(body), { status: 200 }));
  assert.deepEqual(await fetchItinerary("a1b2c3d4e5f6"), body);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${API_URL}/itineraries/a1b2c3d4e5f6`);
  assert.equal(calls[0].init?.cache, "no-store");
});

test("fetchItinerary: 404 is null, other errors throw, network errors propagate", async () => {
  stubFetch(async () => new Response('{"detail":"Itinerary not found"}', { status: 404 }));
  assert.equal(await fetchItinerary("0123456789ab"), null);
  stubFetch(async () => new Response("{}", { status: 500 }));
  await assert.rejects(fetchItinerary("a1b2c3d4e5f6"), /API error 500/);
  stubFetch(async () => { throw new TypeError("Failed to fetch"); });
  await assert.rejects(fetchItinerary("a1b2c3d4e5f6"), TypeError); // the error state, not the 404
});

test("fetchItinerary encodes the slug", async () => {
  const calls = stubFetch(async () => new Response("{}", { status: 404 }));
  await fetchItinerary("a b");
  assert.equal(calls[0].url, `${API_URL}/itineraries/a%20b`);
});

// --- T23-W11 guards, review nit 3 ---------------------------------------------------------------------

test("itinerary.ts is a plain module: type-only imports from api or lastMile (ux.md's date helper is re-done, not imported)", () => {
  const src = readFileSync(new URL("./itinerary.ts", import.meta.url), "utf8");
  const imports = src.match(/^\s*import\b.*$/gm) ?? [];
  for (const line of imports) {
    assert.match(line, /^import type \{[^}]*\} from "(\.\/|@\/lib\/)(api|lastMile)(\.ts)?";$/, line);
  }
  assert.doesNotMatch(src, /\bimport\s*\(/);
  assert.doesNotMatch(src, /"use client"/);
  assert.doesNotMatch(src, /^\s*(export\s+)?(const\s+)?enum\b/m);
  assert.doesNotMatch(src, /<\/[A-Za-z]|\/>/); // no JSX
});

test("api.ts keeps type-only imports, so node --test can load it", () => {
  const src = readFileSync(new URL("./api.ts", import.meta.url), "utf8");
  for (const line of src.match(/^\s*import\b.*$/gm) ?? []) assert.match(line, /^import type /, line);
});

test("no component renders raw HTML (party names are user text)", () => {
  const dirs = [new URL("src/components/", WEB), new URL("src/app/i/[slug]/", WEB)];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".tsx"))) {
      assert.doesNotMatch(readFileSync(new URL(f, dir), "utf8"), /dangerouslySetInnerHTML/, f);
    }
  }
});

test("share page is noindex and sends no referrer (review nit 3)", () => {
  const page = readFileSync(new URL("src/app/i/[slug]/page.tsx", WEB), "utf8");
  assert.match(page, /robots:\s*\{\s*index:\s*false,\s*follow:\s*false\s*\}/);
  assert.match(page, /referrer:\s*"no-referrer"/);
});

test("ShareButton hands the tap to runShare with shareDeps(navigator) (RED re-audits B and C)", () => {
  const src = readFileSync(new URL("src/components/ShareButton.tsx", WEB), "utf8");
  assert.match(src, /runShare\(\s*shareDeps\(navigator\)\s*,/);
  assert.match(src, /shareText\(/); // the payload text has dates only
  // the component never builds or calls the browser APIs itself, so the fallbacks can't be bypassed
  assert.doesNotMatch(src, /navigator\.share|navigator\.clipboard/);
  assert.doesNotMatch(src, /\.writeText\(/);
});

// CI's shallow checkout has no origin/main; there T27-17 (pwa.test.ts) still pins the exact dependency set
test("no new web dependency (T23-G1)", (t) => {
  let base: string;
  try {
    base = execFileSync("git", ["show", "origin/main:web/package.json"], {
      cwd: new URL(".", WEB),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    t.skip("origin/main not fetched; T27-17 covers the dependency set");
    return;
  }
  const now = readFileSync(new URL("package.json", WEB), "utf8");
  const deps = (s: string) => {
    const j = JSON.parse(s);
    return { dependencies: j.dependencies, devDependencies: j.devDependencies };
  };
  assert.deepEqual(deps(now), deps(base));
});

// ---------------------------------------------------------------- TG-43 PR B: the share page on the pixel primitives
// ux.md §2.2 and §2.4; plan §3.2 and §3.5. Static source guards (no component runner yet), as in TG-15/TG-21/TG-22.

const VIEW_SRC = () => readFileSync(new URL("src/components/ItineraryView.tsx", WEB), "utf8");
const LIST_SRC = () => readFileSync(new URL("src/components/ItineraryList.tsx", WEB), "utf8");

test("T43-P5b the share page files are on @/components/pixel and no longer use planUi", () => {
  for (const [name, src] of [["ItineraryView", VIEW_SRC()], ["ItineraryList", LIST_SRC()]] as const) {
    assert.doesNotMatch(src, /planUi|\bUI\./, `${name}: planUi`);
    assert.match(src, /from "@\/components\/pixel"/, `${name}: imports the primitives`);
    // no hand-written skins, v1 shapes or raw pixel font (ux §0 rule 1)
    assert.doesNotMatch(src, /pixel-btn|pixel-box|border-3|font-pixel|rounded-|\bring-|#[0-9a-f]{3,6}\b/i, name);
  }
});

test("T43-B1 ItineraryView: the 404 and error boxes, Search buses and Try again use the primitives (ux §2.2)", () => {
  const src = VIEW_SRC();
  // TG-47 ux §2: both take the red lining (tone="alert"); layout unchanged
  assert.equal(src.match(/<PixelBox tone="alert" className="p-4 flex flex-col items-start gap-3">/g)?.length, 2, "the 404 and error boxes");
  assert.match(src, /<PixelLink variant="secondary" href="\/">\s*Search buses\s*<\/PixelLink>/);
  assert.match(src, /<PixelButton\s+variant="secondary"\s+aria-disabled=\{state\.retrying \|\| undefined\}\s+onClick=\{retry\}\s*>/);
  assert.doesNotMatch(src, /<button\b|<Link\b/, "no raw button or link left");
  assert.match(src, /<p role="status" className="sr-only">/, "the announced status is unchanged");
  assert.match(src, /map=\{flags\.overworldMap\}/, "the overworld kill switch is kept");
});

test("T43-B2 ItineraryList: summary, notice, sections and stops use the primitives and PX keys (ux §2.4)", () => {
  const src = LIST_SRC();
  assert.match(src, /<PixelBox as="section" aria-label="Trip summary" className="p-4 flex flex-col gap-3">/);
  assert.match(src, /<p className=\{PX\.dataHeading\}>\{dateRange\(/, "the date range is body font");
  assert.match(src, /className=\{`\$\{PX\.chip\} min-w-0 break-words`\}>\{it\.vibe\}/, "the vibe chip");
  assert.match(src, /<span className=\{PX\.chip\}>Pre-made plan<\/span>/);
  assert.match(src, /className=\{`\$\{PX\.meta\} tabular-nums`\}>Budget /);
  // TG-47 ux §2: the plan-changed and bus-gone boxes take the red lining (tone="alert"); layout unchanged
  assert.match(src, /<PixelBox as="section" aria-label="Plan changes" tone="alert" className="p-4 flex flex-col gap-1">/);
  assert.match(src, /<PixelBox tone="alert" className="p-4 flex flex-col items-start gap-3">[\s\S]*?<PixelLink variant="secondary" href="\/">\s*Search buses/, "the bus-gone box");
  assert.match(src, /<PixelBox as="p" className="p-4 text-sm">Free time\. No stops planned for this day\.<\/PixelBox>/);
  assert.match(src, /<PixelBox as="p" className="p-4 text-sm">\{issueNotice\("unknown_leg"\)\}<\/PixelBox>/);
  assert.match(src, /<PixelBox className="p-4 flex flex-col gap-1">/, "the stop box");
  assert.match(src, /<h3 className=\{`\$\{PX\.dataHeading\} min-w-0 break-words`\}>/, "the stop name is body font");
  assert.match(src, /<p className=\{PX\.meta\}>Entrance \{fee\}<\/p>/);
  // ux-review-b S1: TG-22 ux §2.5 keeps the map's instruction text-sm (only the confirm note under it is meta)
  assert.match(src, /<p className="text-sm">Tap a stop or a ride for details\.<\/p>/, "the map intro line stays text-sm");
  // RED audit nit: the trust lines keep their muted meta style (ux §2.4)
  assert.match(src, /<p className=\{PX\.meta\}>\{leg\.trip\.confirm_note\}<\/p>/, "bus confirm note");
  assert.match(src, /\{legNote && <p className=\{PX\.meta\}>\{legNote\}<\/p>\}/, "last-mile note");
  assert.doesNotMatch(src, /<Link\b|<h2\b/, "no raw link or h2 left");
});

test("T43-P3 the share page's pixel-font titles hold only the two dated headings", () => {
  const titles = [...LIST_SRC().matchAll(/<SectionTitle\b[^>]*>([\s\S]*?)<\/SectionTitle>/g)].map((m) => m[1].replace(/\s+/g, " ").trim());
  assert.deepEqual(titles.sort(), ["{dayHeading(day)}", "{title} · {formatTravelDate(leg.date)}"].sort());
  assert.doesNotMatch(LIST_SRC(), /<(PageTitle|SectionTitle)\b[^>]*\bchildren=/);
  // The helpers that fill them never produce a glyph Pixelify Sans lacks (ux-guide 2.2)
  for (const date of ["2026-11-06", "2026-11-08", "2026-12-31", "2027-01-01"]) {
    for (const text of [formatTravelDate(date), dayHeading({ day: 1, date, stops: [] }), dayHeading({ day: 12, date: null, stops: [] })]) {
      assert.doesNotMatch(text, /[₱→]/, text);
    }
  }
  for (const title of ["Bus to Baguio", "Bus to Metro Manila"]) {
    assert.match(LIST_SRC(), new RegExp(`title="${title}"`), `${title} stays the static phrase`);
  }
});

test("T43-P6 the stop sprite draws at a true 24px on a PX.plate wrapper; the step numeral is PX.numeral", () => {
  const src = LIST_SRC();
  const plate = src.match(/<span className=\{PX\.plate\}>\s*(?:\{\/\*[\s\S]*?\*\/\}\s*)?<img\b([\s\S]*?)\/>\s*<\/span>/);
  assert.ok(plate, "the <img> sits inside <span className={PX.plate}> (TG-23 review S1)");
  assert.match(plate[1], /width=\{24\}/);
  assert.match(plate[1], /height=\{24\}/);
  assert.match(plate[1], /className="pixelated block"/, "the plate is on the wrapper, not the image");
  assert.match(plate[1], /src=\{spriteSrc\(placeSprite\(spot\.category\)\)\}/);
  assert.match(plate[1], /alt=""/);
  assert.match(src, /<span aria-hidden="true" className=\{`\$\{PX\.numeral\} w-6 shrink-0 text-center`\}>\s*\{n\}\s*<\/span>/);
});
