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
  const api = read("../api/app/wallets.py");
  for (const code of ["shares_mismatch", "unknown_member", "name_taken", "party_full", "wallet_full"]) {
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
  for (const path of ["src/lib/wallet.ts", "src/components/WalletView.tsx", "src/components/WalletHome.tsx", "src/components/PayoutQr.tsx"]) {
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
  assert.match(sw, /const SAVED_PAGE = \/\^\\\/\(i\|w\)\\\/\[\^\/\]\+\\\/\?\$\/;/, "/w/<slug> pages are kept like /i/ ones");
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
  assert.equal(src.match(/window\.confirm\(/g)?.length, 3, "delete expense, mark paid and undo each confirm");
  assert.match(src, /visibilitychange/, "refreshes when the phone comes back to the app");
});

test("V11 home: the fourth quick action is the trip wallet, which links on to tickets", () => {
  const src = read("src/components/landing/QuickActions.tsx");
  const hrefs = [...src.matchAll(/<PixelCardLink\b[^>]*\bhref="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, ["#travel-date", "/plan", "/baguio", "/wallet"]);
  assert.match(read("src/components/WalletHome.tsx"), /href="\/tickets"/);
});
