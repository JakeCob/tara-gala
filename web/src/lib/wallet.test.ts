// TG-50 shared trip wallet, web side. Run with `npm test` (node --test, Node 22.18+ type stripping).
// Pure helpers here; the screens are checked by source below and end to end in a browser against a local API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MAX_CENTAVOS,
  WALLET_SLUG,
  failureMessage,
  formatPeso,
  knownWallets,
  leftToAssign,
  netLine,
  parseKnownWallets,
  whenLine,
  parsePeso,
  rememberWallet,
  splitEqual,
  whoAmI,
} from "./wallet.ts";

const WEB = new URL("../../", import.meta.url);
const ROOT = new URL("../", WEB);
const read = (p: string) => readFileSync(new URL(p, WEB), "utf8");

function memoryStore() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
}

const SLUG_A = "a".repeat(32);
const SLUG_B = "0123456789abcdef".repeat(2);

test("V1 pesos parse to centavos, with or without ₱, commas and centavos", () => {
  assert.equal(parsePeso("450"), 45000);
  assert.equal(parsePeso("1,151.50"), 115150);
  assert.equal(parsePeso("₱ 1,151.5"), 115150);
  assert.equal(parsePeso("PHP 20"), 2000);
  assert.equal(parsePeso("0.01"), 1);
  assert.equal(parsePeso("100000"), MAX_CENTAVOS);
  for (const bad of ["", "0", "0.00", "-5", "1.234", "abc", "100000.01", "1e3", "12.3.4"]) assert.equal(parsePeso(bad), null, bad);
  assert.equal(parsePeso("0", { allowZero: true }), 0, "a custom share can be zero");
});

test("V2 pesos format with commas, and centavos only when there are some", () => {
  assert.equal(formatPeso(45000), "₱450");
  assert.equal(formatPeso(115150), "₱1,151.50");
  assert.equal(formatPeso(1), "₱0.01");
  assert.equal(formatPeso(-30000), "−₱300");
  assert.equal(formatPeso(0), "₱0");
});

test("V3 the equal-split preview matches the API's rule (api/tests/test_wallets.py)", () => {
  const [a, b, c] = ["a", "b", "c"];
  assert.deepEqual(splitEqual(90000, [a, b, c], a), { a: 30000, b: 30000, c: 30000 });
  assert.deepEqual(splitEqual(1000, [a, b, c], b), { b: 334, a: 333, c: 333 });
  assert.deepEqual(splitEqual(1001, [a, b, c], a), { a: 334, b: 334, c: 333 });
  assert.deepEqual(splitEqual(1001, [b, c], a), { b: 501, c: 500 });
  assert.deepEqual(splitEqual(100, [], a), {});
  // The API test pins the same cases, so the two rules can't drift apart unnoticed
  const api = readFileSync(new URL("api/tests/test_wallets.py", ROOT), "utf8");
  for (const line of ["{b: 334, a: 333, c: 333}", "{a: 334, b: 334, c: 333}", "{b: 501, c: 500}"]) assert.ok(api.includes(line), line);
});

test("V4 a custom split shows what's left, and nets read as plain words", () => {
  assert.equal(leftToAssign(90000, [70000, 10000]), 10000);
  assert.equal(leftToAssign(90000, [70000, 30000]), -10000);
  assert.equal(netLine(30000), "gets back ₱300");
  assert.equal(netLine(-30000), "owes ₱300");
  assert.equal(netLine(0), "all square");
});

test("V5 every failure gets one plain sentence; API codes map to their own", () => {
  assert.match(failureMessage({ why: "offline" }), /No signal/);
  assert.match(failureMessage({ why: "not_found" }), /link doesn't work/);
  assert.match(failureMessage({ why: "rate_limited" }), /Wait a minute/);
  assert.match(failureMessage({ why: "server" }), /server had a problem/);
  assert.match(failureMessage({ why: "rejected", detail: "shares_mismatch" }), /don't add up/);
  assert.match(failureMessage({ why: "rejected", detail: "name_taken" }), /already has that name/);
  assert.match(failureMessage({ why: "rejected", detail: "whatever" }), /didn't save/);
  const api = read("../api/app/wallets.py") + read("../api/app/wallet_proofs.py");
  for (const code of ["shares_mismatch", "unknown_member", "name_taken", "party_full", "wallet_full", "too_many_proofs"]) {
    assert.ok(api.includes(`"${code}"`), `the API sends ${code}`);
    assert.ok(read("src/lib/wallet.ts").includes(`${code}:`), `the web explains ${code}`);
  }
});

test("V6 this phone remembers wallets, newest first, and who it is in each", () => {
  const store = memoryStore();
  assert.deepEqual(knownWallets(store), []);
  rememberWallet({ slug: SLUG_A, name: "Baguio", me: "m1" }, store);
  rememberWallet({ slug: SLUG_B, name: "Other" }, store);
  assert.deepEqual(knownWallets(store).map((w) => w.slug), [SLUG_B, SLUG_A]);
  rememberWallet({ slug: SLUG_A, name: "Baguio Nov 6" }, store);
  assert.deepEqual(knownWallets(store)[0], { slug: SLUG_A, name: "Baguio Nov 6", me: "m1" }, "a rename keeps who I am");
  assert.equal(whoAmI(SLUG_A, store), "m1");
  assert.equal(whoAmI(SLUG_B, store), null);
  rememberWallet({ slug: SLUG_A, name: "Baguio Nov 6", me: null }, store);
  assert.equal(whoAmI(SLUG_A, store), null, "Not you? forgets");
  store.setItem("tg-wallets", "{broken");
  assert.deepEqual(knownWallets(store), [], "a broken entry reads as none");
  store.setItem("tg-wallets", JSON.stringify([{ slug: "../x", name: "x", me: null }, { slug: SLUG_A, name: "ok", me: null }]));
  assert.deepEqual(knownWallets(store).map((w) => w.slug), [SLUG_A], "bad slugs are dropped");
  assert.equal(knownWallets(null).length, 0, "no storage at all");
  assert.deepEqual(parseKnownWallets(JSON.stringify([{ slug: SLUG_B, name: "B", me: "x" }])), [{ slug: SLUG_B, name: "B", me: "x" }]);
  assert.deepEqual(parseKnownWallets(null), []);
  assert.equal(whenLine("2026-11-06T05:30:00Z"), "Nov 6, 1:30 PM", "Manila time");
});

test("V7 the slug pattern is the API's", () => {
  assert.match(SLUG_A, WALLET_SLUG);
  assert.doesNotMatch("A".repeat(32), WALLET_SLUG);
  assert.doesNotMatch("a".repeat(31), WALLET_SLUG);
  assert.ok(read("../api/app/wallets.py").includes('SLUG = re.compile(r"^[0-9a-f]{32}$")'));
});

test("V8 payout QRs never leave the phone, and wallet logs carry no names, notes or slugs", () => {
  for (const path of ["src/lib/payoutStore.ts", "src/components/PayoutQr.tsx"]) {
    assert.doesNotMatch(read(path), /\bfetch\(|XMLHttpRequest|sendBeacon|API_URL|walletApi/, `${path}: no network`);
  }
  for (const path of ["src/lib/wallet.ts", "src/components/WalletView.tsx", "src/components/WalletHome.tsx", "src/components/PayoutQr.tsx", "src/components/ProofDialog.tsx"]) {
    for (const [, args] of read(path).matchAll(/console\.\w+\(([^;]*)\);/g)) {
      assert.doesNotMatch(args, /(?<!err\.)\bname\b|\bnote\b|\bslug\b|\blabel\b/, `${path}: a log carries personal data: ${args}`);
    }
  }
});

test("V9 the wallet pages: noindex capability link, one shell, and the service worker keeps them offline", () => {
  const view = read("src/app/w/[slug]/page.tsx");
  assert.match(view, /robots: \{ index: false, follow: false \}/);
  assert.match(view, /referrer: "no-referrer"/);
  assert.equal(view.match(/<PageShell>/g)?.length, 1);
  const home = read("src/app/wallet/page.tsx");
  assert.equal(home.match(/<PageShell>/g)?.length, 1);
  assert.match(home, /<PageTitle className="text-balance">Trip wallet<\/PageTitle>/);
  const sw = read("public/sw.js");
  assert.match(sw, /\/\^\\\/wallets\\\/\[0-9a-f\]\{32\}\$\//, "GET /wallets/<slug> is cached for offline viewing");
  assert.match(sw, /const SAVED_PAGE = \/\^\\\/\(i\|w\|t\)\\\/\[\^\/\]\+\\\/\?\$\/;/, "/w/<slug> and TG-52's /t/<slug> pages are kept like /i/ ones");
  assert.match(sw, /const PRECACHE_PAGES = \[[^\]]*"\/wallet"[^\]]*\];/);
  assert.doesNotMatch(sw, /SW_VERSION = "2026-10-31\.2"/, "SW_VERSION bumped");
});

test("V10 the wallet screen: one primary (Add expense), Show my QR on the payments I receive, and confirms before deleting", () => {
  const src = read("src/components/WalletView.tsx");
  assert.match(src, /^"use client";/);
  assert.equal(src.match(/variant="primary"/g)?.length, 1, "one primary per screen");
  assert.match(src, /Add expense/);
  assert.match(src, /t\.to_member === me/, "Show my QR only on payments to me");
  assert.match(src, /<PayoutQr\b/);
  assert.equal(src.match(/window\.confirm\(/g)?.length, 2, "delete expense and undo confirm; Mark paid opens ProofDialog (TG-53)");
  assert.match(src, /visibilitychange/, "refreshes when the phone comes back to the app");
});

test("V11 home: the fourth quick action is the trip wallet, which links on to tickets", () => {
  // TG-49: the quick actions became the title screen's start menu
  const src = read("src/components/landing/TitleScreen.tsx");
  const hrefs = [...src.matchAll(/href: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, ["/buses", "/plan", "/baguio", "/trip"]); // TG-52: My trip links on to the wallets and tickets
  assert.match(read("src/components/TripHome.tsx"), /href="\/wallet"/);
  assert.match(read("src/components/TripHome.tsx"), /href="\/tickets"/);
  assert.match(read("src/components/WalletHome.tsx"), /href="\/tickets"/);
});

// ---------------------------------------------------------------- TG-65: an older GET never replaces a newer wallet
// WalletView reloads when the phone comes back to the app. A write that lands while that GET is on the wire must stay:
// the GET read the wallet before the write, so its answer would bring a deleted expense back or drop a new one.
// Dynamic imports: before the fix, afterGet doesn't exist, and a named import would stop the whole file.

const W = "c".repeat(32);
const walletWith = (notes: string[], slug = W) =>
  ({ share_slug: slug, name: "E2E", members: [], expenses: notes.map((note, i) => ({ id: `e${i}`, note })), settlements: [] }) as unknown as import("./wallet.ts").Wallet;
const ready = (notes: string[], slug = W) => ({ state: "ready" as const, wallet: walletWith(notes, slug) });

test("TG65-1 afterGet: an answer a write overtook keeps the wallet on screen; one that wasn't overtaken shows", async () => {
  const { afterGet } = await import("./wallet.ts");
  const prev = ready([]); // the expense was just deleted on this phone
  const older = { ok: true as const, wallet: walletWith(["Taxi"]) };
  assert.equal(afterGet(prev, older, W, true, false), prev, "the deleted expense doesn't come back");
  assert.deepEqual(afterGet(prev, older, W, false, false), { state: "ready", wallet: older.wallet }, "not overtaken: another phone's expense comes through");
  assert.deepEqual(afterGet({ state: "loading" }, older, W, true, false), { state: "ready", wallet: older.wallet }, "nothing on screen to keep");
  const other = ready([], "d".repeat(32));
  assert.deepEqual(afterGet(other, older, W, true, false), { state: "ready", wallet: older.wallet }, "another wallet's screen isn't this wallet");
});

test("TG65-2 afterGet keeps TG-53's rule: a saved copy never replaces the wallet on screen, and still opens one offline", async () => {
  const { afterGet } = await import("./wallet.ts");
  const prev = ready(["Taxi"]);
  const saved = { ok: true as const, wallet: walletWith([]), saved: true };
  assert.equal(afterGet(prev, saved, W, false, false), prev);
  assert.equal(afterGet(prev, saved, W, false, true), prev, "with a dialog open too");
  assert.deepEqual(afterGet({ state: "loading" }, saved, W, false, false), { state: "ready", wallet: saved.wallet });
  assert.deepEqual(afterGet({ state: "error", why: "offline" }, saved, W, false, false), { state: "ready", wallet: saved.wallet });
});

test("TG65-3 afterGet: a failure keeps the wallet when offline, a dialog is open, or a write overtook it; shows otherwise", async () => {
  const { afterGet } = await import("./wallet.ts");
  const prev = ready(["Taxi"]);
  assert.equal(afterGet(prev, { ok: false, why: "offline" }, W, false, false), prev, "offline with a copy on screen");
  assert.equal(afterGet(prev, { ok: false, why: "server" }, W, false, true), prev, "an open proof dialog keeps its page");
  assert.equal(afterGet(prev, { ok: false, why: "server" }, W, true, false), prev, "a write landed after this GET left: it just worked");
  assert.deepEqual(afterGet(prev, { ok: false, why: "server" }, W, false, false), { state: "error", why: "server" });
  assert.deepEqual(afterGet(prev, { ok: false, why: "not_found" }, W, false, false), { state: "error", why: "not_found" });
  assert.deepEqual(afterGet({ state: "loading" }, { ok: false, why: "server" }, W, true, false), { state: "error", why: "server" });
});

test("TG65-4 WalletView: every GET goes through afterGet, aged against the last write that landed", () => {
  const view = read("src/components/WalletView.tsx");
  assert.match(view, /const left = Date\.now\(\);\s+walletApi\.get\(slug\)\.then\(\(r\) => \{\s+if \(!live\) return;\s+const overtaken = left < shownAt\.current;/, "timed before the GET leaves");
  assert.match(view, /setLoad\(\(prev\) => afterGet\(prev, r, slug, overtaken, proofOpen\.current\)\);/);
  assert.match(view, /console\.info\("\[tg-wallet\] load ok=%s", r\.ok \? \(overtaken \? "overtaken" : r\.saved \? "saved" : "yes"\) : r\.why\);/);
  assert.match(view, /if \(r\.ok && !overtaken\) \{\s+if \(!r\.saved\) shownAt\.current = left;\s+rememberWallet\(/, "an overtaken answer leaves everything alone");
  for (const [from, to] of [["async function write(", "function openProof("], ["function proofSaved(", "/** Settle up"]]) {
    const body = view.slice(view.indexOf(from), view.indexOf(to));
    assert.ok(body.includes("shownAt.current = Date.now();"), `${from} marks the screen as new`);
    assert.ok(body.indexOf("shownAt.current = Date.now();") < body.indexOf("setLoad("), `${from}: before its state, so no answer can slip between`);
    if (from.startsWith("async")) assert.ok(body.indexOf("shownAt.current = Date.now();") > body.indexOf("if (!r.ok)"), "only a write that landed");
  }
  assert.equal(view.match(/setLoad\(/g)?.length, 3, "afterGet, a write and a saved proof: nothing else sets the wallet");
});

test("TG65-5 the repro, in order: a return-to-app GET, then a delete and an add, then the old answers land", async () => {
  const { afterGet } = await import("./wallet.ts");
  // WalletView's load path and its writes, as in TG65-4
  let shownAt = 0;
  let screen: import("./wallet.ts").WalletLoad = { state: "loading" };
  const land = (r: import("./wallet.ts").WalletResult, left: number) => {
    const overtaken = left < shownAt;
    if (r.ok && !overtaken && !r.saved) shownAt = left;
    screen = afterGet(screen, r, W, overtaken, false);
  };
  const write = (notes: string[], at: number) => {
    shownAt = at;
    screen = ready(notes);
  };
  const notes = () => (screen.state === "ready" ? screen.wallet.expenses.map((e) => e.note) : null);
  land({ ok: true, wallet: walletWith(["Taxi"]) }, 1000); // opened
  write([], 2500); // Delete Taxi lands while the return-to-app GET (left at 2000) is on the wire
  land({ ok: true, wallet: walletWith(["Taxi"]) }, 2000);
  assert.deepEqual(notes(), [], "the deleted expense stays deleted");
  write(["Jeep"], 4500); // Add Jeep lands while another (left at 4000) is on the wire
  land({ ok: true, wallet: walletWith([]) }, 4000);
  assert.deepEqual(notes(), ["Jeep"], "the new expense stays");
  land({ ok: true, wallet: walletWith(["Jeep", "Lunch"]) }, 6000); // the next return to the app
  assert.deepEqual(notes(), ["Jeep", "Lunch"], "a later GET brings another phone's expense");
});
