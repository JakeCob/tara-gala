// TG-71/72: the Around tab (Baguio and Sagada pages, site words) and the Ambagan tab, each behind its own flag.
// Owner decisions 2026-11-22 (_team/tickets/TG-72/ticket.md). Source guards where the repo's tests can't render JSX.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { currentTab, visibleTabs } from "./tabs.ts";
import { ICON_SIZE, TAB_ICONS } from "./pixelIcons.ts";
import { AROUND_CITIES, AROUND_WORDS, aroundCity, legsFrom } from "./around.ts";
import { AMBAGAN_WORDS } from "./ambagan.ts";
import { BAGUIO_TERMINALS } from "./lastMile.ts";
import { BAGUIO_IDLE_COPY, BAGUIO_IDLE_ROW } from "./baguioIdle.ts";
import { SPRITES } from "./sprites.ts";
import { FLAG_DEFAULTS } from "./flags.ts";
import { EN } from "./words/en.ts";

const WEB = new URL("../../", import.meta.url);
const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, WEB), "utf8");
const readRoot = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const hrefs = (tabs: readonly { href: string }[]) => tabs.map((t) => t.href);

// ---------------------------------------------------------------- tabs

test("T72-T1 both flags off is today's bar, tab for tab; both default off", () => {
  assert.equal(FLAG_DEFAULTS.aroundTab, false);
  assert.equal(FLAG_DEFAULTS.ambaganTab, false);
  assert.deepEqual(visibleTabs(true, {}), visibleTabs(true));
  assert.deepEqual(visibleTabs(true).map((t) => [t.href, t.label]), [["/buses", "Buses"], ["/plan", "Plan"], ["/baguio", "Baguio"], ["/trip", "Trip"]]);
  assert.deepEqual(hrefs(visibleTabs(false, { around: false, ambagan: false })), ["/buses", "/baguio", "/trip"]);
});

test("T72-T2 owner order: Buses · Plan · Around · Trip · Ambagan; each flag on its own", () => {
  assert.deepEqual(visibleTabs(true, { around: true, ambagan: true }).map((t) => [t.href, t.label]), [
    ["/buses", "Buses"], ["/plan", "Plan"], ["/around", "Around"], ["/trip", "Trip"], ["/wallet", "Ambagan"],
  ]);
  assert.deepEqual(hrefs(visibleTabs(false, { around: true, ambagan: true })), ["/buses", "/around", "/trip", "/wallet"]);
  assert.deepEqual(hrefs(visibleTabs(true, { around: true })), ["/buses", "/plan", "/around", "/trip"]);
  assert.deepEqual(hrefs(visibleTabs(true, { ambagan: true })), ["/buses", "/plan", "/baguio", "/trip", "/wallet"]);
});

test("T72-T3 each page marks its tab, by flag", () => {
  const both = { around: true, ambagan: true };
  const slug = "0123456789abcdef0123456789abcdef";
  const cases: [string, string | null, string | null][] = [
    // path, both off, both on
    ["/baguio", "/baguio", "/around"],
    ["/around", null, "/around"],
    ["/around/sagada", null, "/around"],
    ["/wallet", "/trip", "/wallet"],
    [`/w/${slug}`, "/trip", "/wallet"],
    ["/tickets", "/trip", "/trip"], // owner: My tickets stays under Trip
    [`/t/${slug}`, "/trip", "/trip"],
    ["/trip", "/trip", "/trip"],
    ["/buses", "/buses", "/buses"],
    ["/aroundx", null, null],
    ["/", null, null],
  ];
  for (const [path, off, on] of cases) {
    assert.equal(currentTab(path), off, `off ${path}`);
    assert.equal(currentTab(path, both), on, `on ${path}`);
  }
});

test("T72-T4 the new icons: Around keeps the pine, Ambagan is a pouch, both 16 by 16", () => {
  assert.deepEqual(TAB_ICONS["/around"], TAB_ICONS["/baguio"], "TG-71 ux §7.1: its icon stays");
  const pouch = TAB_ICONS["/wallet"];
  assert.equal(pouch.length, ICON_SIZE);
  for (const row of pouch) assert.match(row, /^[#.]{16}$/);
  assert.notDeepEqual(pouch, TAB_ICONS["/trip"]);
});

test("T72-T5 the bar and the header read both flags; five tabs get five columns", () => {
  for (const f of ["src/components/TabBar.tsx", "src/components/SiteHeader.tsx"]) {
    const src = read(f);
    assert.match(src, /const switches = \{ around: flags\.aroundTab, ambagan: flags\.ambaganTab \};/, f);
    assert.match(src, /currentTab\(usePathname\(\), switches\)/, f);
    assert.match(src, /visibleTabs\(formMode\(flags\) !== "none", switches\)/, f);
  }
  assert.match(read("src/components/TabBar.tsx"), /const GRID_COLS: Record<number, string> = \{ 3: "grid-cols-3", 4: "grid-cols-4", 5: "grid-cols-5 \[&_a\]:px-0 \[&_a\]:text-xs" \};/, "five labels fit 64px at 320");
});

// ---------------------------------------------------------------- Around

test("T72-A1 Baguio's city is today's /baguio, word for word", () => {
  const baguio = AROUND_CITIES[0];
  assert.equal(baguio.slug, "baguio");
  assert.equal(baguio.blurb, "Jeeps, taxis and walks from the bus terminal to the top spots.");
  assert.ok(read("src/app/baguio/page.tsx").includes(baguio.blurb), "the old page's intro");
  assert.equal(baguio.legend, "Which terminal does your bus arrive at?");
  assert.deepEqual(baguio.starts, BAGUIO_TERMINALS.map((t) => ({ kind: "terminal", slug: t.slug, label: t.label })));
  assert.equal(baguio.idle, BAGUIO_IDLE_COPY);
  assert.equal(baguio.empty, "No routes on file yet for this terminal.");
  assert.equal(AROUND_WORDS.pageTitle("Baguio"), "Getting around Baguio");
});

test("T72-A2 Sagada starts where its data starts: the Coda Lines stop and the town centre", () => {
  const sagada = aroundCity("sagada");
  assert.ok(sagada);
  assert.deepEqual(sagada.starts.map((s) => [s.kind, s.slug]), [["terminal", "coda-sagada"], ["spot", "sagada-town-centre"]]);
  const coda = readRoot("data/sagada-coda/last_mile_routes.csv");
  assert.match(coda, /^coda-sagada,,,/m, "legs start at coda-sagada");
  const legs = readRoot("data/last_mile_routes.csv");
  assert.match(legs, /^,sagada-town-centre,,[a-z0-9-]+,/m, "legs start at the town centre spot");
  assert.equal(aroundCity("la-union"), undefined);
});

test("T72-A3 Sagada's line names only the modes its data has (never invent)", () => {
  const rows = [...readRoot("data/last_mile_routes.csv").split("\n"), ...readRoot("data/sagada-coda/last_mile_routes.csv").split("\n")]
    .filter((l) => l.trim().endsWith(",Sagada"));
  assert.ok(rows.length > 20, `${rows.length} Sagada legs`);
  const modes = new Set(rows.map((l) => l.split(",")[4]));
  assert.deepEqual([...modes].sort(), ["van", "walk"], "if this changes, change Sagada's blurb and idle line too");
  const s = aroundCity("sagada")!;
  assert.equal(s.blurb, "Walks and vans from the town centre to the caves, falls and viewpoints.");
  assert.doesNotMatch(`${s.blurb} ${s.idle.line}`, /jeep|taxi|tricycle/i);
});

test("T72-A9 each city's idle box draws its own rides: Baguio's as today, Sagada's walks and vans only", () => {
  assert.equal(AROUND_CITIES[0].idleRow, BAGUIO_IDLE_ROW);
  const sagada = aroundCity("sagada")!.idleRow;
  const names = sagada.map((d) => d.name);
  assert.equal(new Set(names).size, names.length, "unique: they're the React keys");
  for (const n of names) assert.ok(SPRITES[n], n);
  assert.deepEqual(names.filter((n) => n.startsWith("mode-")).sort(), ["mode-van", "mode-walk"]);
  assert.match(read("src/components/LastMile.tsx"), /<BaguioIdle copy=\{city\.idle\} row=\{city\.idleRow\} \/>/);
});

test("T72-A4 a spot start keeps only the legs that leave it; a terminal's come as they are", () => {
  const leg = (kind: string, slug: string, id: string) => ({ id, origin: { kind, slug } });
  const legs = [leg("spot", "sagada-town-centre", "out"), leg("spot", "kiltepan-viewpoint", "back"), leg("terminal", "coda-sagada", "t")];
  assert.deepEqual(legsFrom(legs, { kind: "spot", slug: "sagada-town-centre", label: "" }).map((l) => l.id), ["out"]);
  assert.deepEqual(legsFrom(legs, { kind: "terminal", slug: "coda-sagada", label: "" }).map((l) => l.id), ["out", "back", "t"]);
});

test("T72-A5 the site words name no city: the app is for every province (owner, 2026-11-22)", () => {
  assert.equal(AROUND_WORDS.tagline, "Provincial buses, straight from the operators.");
  assert.equal(AROUND_WORDS.heroLine, "Bus trips on file, with fares and where to book.");
  assert.equal(AROUND_WORDS.siteDescription, "Provincial bus times, how to get around once you're there, and an ambagan for the barkada's costs.");
  const cities = ["Manila", ...AROUND_CITIES.map((c) => c.name)];
  for (const w of [AROUND_WORDS.tagline, AROUND_WORDS.heroLine, AROUND_WORDS.siteDescription, AROUND_WORDS.intro, AROUND_WORDS.title, AROUND_WORDS.menu, AROUND_WORDS.tab]) {
    for (const city of cities) assert.ok(!w.includes(city), `${city} in "${w}"`);
    assert.doesNotMatch(w, /anywhere|own plan|add your own|every/i, w); // no promise the data can't keep
  }
});

test("T72-A6 the pages: /around and /around/<city> only with the flag; /baguio goes to /around/baguio with it", () => {
  assert.match(read("src/app/around/layout.tsx"), /if \(!flags\.aroundTab\) notFound\(\);\s*return children;/, "a real 404 for every /around page while off");
  const list = read("src/app/around/page.tsx");
  assert.match(list, /if \(!flags\.aroundTab\) notFound\(\);/);
  assert.match(list, /AROUND_CITIES\.map\(/);
  assert.match(list, /href=\{`\/around\/\$\{c\.slug\}`\}/);
  const city = read("src/app/around/[city]/page.tsx");
  assert.match(city, /export const generateStaticParams = \(\) => AROUND_CITIES\.map\(\(c\) => \(\{ city: c\.slug \}\)\);/);
  assert.match(city, /if \(!flags\.aroundTab \|\| !city\) notFound\(\);/);
  assert.match(city, /<LastMile key=\{city\.slug\} city=\{city\} \/>/);
  const old = read("src/app/baguio/page.tsx");
  assert.match(old, /if \(flags\.aroundTab\) redirect\("\/around\/baguio"\);/);
  assert.match(old, /<LastMile \/>/, "flag off: today's page");
  assert.match(read("src/components/LastMile.tsx"), /export default function LastMile\(\{ city = AROUND_CITIES\[0\] \}/);
});

test("T72-A7 the title screen, the hero and the site description switch on the flag; off is today's", () => {
  const title = read("src/components/landing/TitleScreen.tsx");
  assert.match(title, /\{flags\.aroundTab \? <Say w=\{\(d\) => d\.title\.tagline\} \/> : "Manila to Baguio buses, straight from the operators\."\}/); // TG-74: EN.title.tagline is AROUND_WORDS.tagline
  // the start menu's whole block, so its order and the flags-off items (Find buses, Plan a trip, In Baguio, My trip) stay
  // TG-74: the words are in words/en.ts and each item reads its key (EN pinned below)
  assert.ok(title.includes(`  const menu = [
    { href: "/buses", label: <Say w={(d) => d.title.findBuses} /> },
    ...(formMode(flags) !== "none" ? [{ href: "/plan", label: <Say w={(d) => d.title.planTrip} /> }] : []),
    flags.aroundTab ? { href: "/around", label: <Say w={(d) => d.title.gettingAround} /> } : { href: "/baguio", label: "In Baguio" }, // TG-71/72
    { href: "/trip", label: <Say w={(d) => d.title.myTrip} /> },
    ...(flags.ambaganTab ? [{ href: "/wallet", label: <Say w={(d) => d.title.ambagan} /> }] : []), // TG-72: the shared wallets' own way in
  ];`), "the start menu block");
  assert.deepEqual([EN.title.findBuses, EN.title.planTrip, EN.title.gettingAround, EN.title.myTrip, EN.title.ambagan], ["Find buses", "Plan a trip", AROUND_WORDS.menu, "My trip", "Ambagan"]);
  assert.equal(EN.title.tagline, AROUND_WORDS.tagline);
  // the /buses hero names no city with the flag on; off is today's line
  assert.match(read("src/components/landing/Hero.tsx"), /\{flags\.aroundTab \? AROUND_WORDS\.heroLine : "Every Manila to Baguio trip on file, with fares and where to book\."\}/);
  for (const f of ["src/app/layout.tsx", "src/app/manifest.ts"]) {
    assert.match(read(f), /description: flags\.aroundTab \? AROUND_WORDS\.siteDescription : "Every Manila to Baguio bus, plus how to get around once you're there\.",/, f);
  }
  assert.equal(AROUND_WORDS.menu, "Getting around");
});

test("T72-A8 the service worker precaches the Around pages and its version moved", () => {
  const sw = read("public/sw.js");
  assert.match(sw, /const PRECACHE_PAGES = \[[^\]]*"\/around", "\/around\/baguio", "\/around\/sagada"[^\]]*\];/);
  assert.doesNotMatch(sw, /const SW_VERSION = "2026-11-20\.1"/);
});

// ---------------------------------------------------------------- Ambagan

test("T72-W1 the owner's Ambagan words", () => {
  assert.equal(AMBAGAN_WORDS.tab, "Ambagan");
  assert.equal(AMBAGAN_WORDS.title, "Ambagan");
  assert.equal(AMBAGAN_WORDS.intro, "Split costs with your barkada: who paid what, and who pays whom at the end.");
  assert.equal(AMBAGAN_WORDS.startTitle, "Start an ambagan");
  assert.equal(AMBAGAN_WORDS.nameLabel, "What's it for?");
  assert.equal(AMBAGAN_WORDS.namePlaceholder, "Like Sagada trip, Friday dinner, rent");
  assert.equal(visibleTabs(false, { ambagan: true }).at(-1)?.label, AMBAGAN_WORDS.tab);
});

test("T72-W2 the hub: with Ambagan on, My tickets leaves it (it stays under Trip); off is today's", () => {
  const src = read("src/components/WalletHome.tsx");
  assert.match(src, /const amb = flags\.ambaganTab;/);
  assert.match(src, /\{!amb && \(\s*<PixelCardLink href="\/tickets"/);
  assert.match(src, /\{amb \? AMBAGAN_WORDS\.startTitle : "Start a trip wallet"\}/);
  assert.match(src, /\{busy \? "Starting\.\.\." : amb \? AMBAGAN_WORDS\.start : "Start the wallet"\}/);
  assert.match(read("src/components/TripHome.tsx"), /<PixelCardLink href="\/tickets"/, "Trip keeps My tickets");
  assert.match(read("src/components/TripHome.tsx"), /\{flags\.ambaganTab \? AMBAGAN_WORDS\.title : "Trip wallets"\}/);
});

test("T72-W3 a shared wallet's page and share say Ambagan with the flag", () => {
  const page = read("src/app/w/[slug]/page.tsx");
  assert.match(page, /<PageTitle>\{flags\.ambaganTab \? AMBAGAN_WORDS\.title : "Trip wallet"\}<\/PageTitle>/);
  assert.match(page, /robots: \{ index: false, follow: false \}/, "still a capability link");
  const view = read("src/components/WalletView.tsx");
  assert.match(view, /title: flags\.ambaganTab \? AMBAGAN_WORDS\.shareTitle : "Tara Gala trip wallet"/);
  assert.match(view, /\{flags\.ambaganTab \? AMBAGAN_WORDS\.all : "All wallets"\}/);
});

test("T72-L1 a non-Baguio city's picks are logged, with no user data", () => {
  const src = read("src/components/LastMile.tsx");
  const calls = src.match(/console\.info\([^\n]*/g) ?? [];
  assert.equal(calls.length, 2);
  for (const c of calls) assert.match(c, /^console\.info\("\[tg-around\] legs city=%s start=%s/, c);
});

// ---------------------------------------------------------------- plan page and ready-made trips (owner, 2026-11-22)

test("T72-P1 the plan page's length hint names no city with the Around flag; off is today's", async () => {
  const { lengthHint } = await import("./planForm.ts");
  assert.equal(lengthHint("2026-11-06", "2026-11-08"), "3 days in Baguio", "flag off: today's");
  assert.equal(lengthHint("2026-11-06", "2026-11-08", null), "3 days");
  assert.equal(lengthHint("2026-11-06", "2026-11-06", null), "Day trip");
  // TG-71: `city` is null unless NEXT_PUBLIC_GOING_TO is on (goingTo.test.ts T71-P3), so this is still the hint's flag-off rule
  assert.match(read("src/components/PlanForm.tsx"), /hint=\{lengthHint\(values\.date, values\.returnDate, city \?\? \(flags\.aroundTab \? null : "Baguio"\)\)\}/);
});

test("T72-P2 each ready-made card names its place with the Around flag; off, or an older API with no city, is today's", async () => {
  const { landingCard, premadeCard, landingPremadeView } = await import("./premadeView.ts");
  const s = { share_slug: "premade-x", vibe: "Chill", trip_date: "2026-11-06", return_date: "2026-11-08", budget_php: null, day_count: 3, stop_count: 12, spot_names: ["Burnham Park (made up)"], city: "Baguio" };
  assert.equal(landingCard(s).dates, "3 days · 12 stops");
  assert.equal(landingCard(s, true).dates, "Baguio · 3 days · 12 stops");
  assert.equal(landingCard({ ...s, city: undefined }, true).dates, "3 days · 12 stops");
  assert.match(premadeCard(s, "", "", true).dates, / · Baguio · 3 days · 12 stops$/);
  assert.doesNotMatch(premadeCard(s, "", "").dates, /Baguio/);
  const view = landingPremadeView({ kind: "ok", list: [s] }, true, true);
  assert.equal(view.cards?.[0].dates, "Baguio · 3 days · 12 stops");
  for (const f of ["src/components/landing/PremadeTrips.tsx"]) assert.equal(read(f).match(/flags\.aroundTab\)/g)?.length, 2, f);
  assert.match(read("src/components/PlanResults.tsx"), /premadeCard\(trip, date, returnDate, siteFlags\.aroundTab\)/);
});
