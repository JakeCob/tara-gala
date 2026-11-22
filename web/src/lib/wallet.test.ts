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
  assert.match(home, /<PageTitle className="text-balance">\{flags\.ambaganTab \? AMBAGAN_WORDS\.title : "Trip wallet"\}<\/PageTitle>/); // TG-72
  const sw = read("public/sw.js");
  assert.match(sw, /\/\^\\\/wallets\\\/\[0-9a-f\]\{32\}\$\//, "GET /wallets/<slug> is cached for offline viewing");
  assert.match(sw, /const SAVED_PAGE = \/\^\\\/\(i\|w\|t\)\\\/\[\^\/\]\+\\\/\?\$\/;/, "/w/<slug> and TG-52's /t/<slug> pages are kept like /i/ ones");
  assert.match(sw, /const PRECACHE_PAGES = \[[^\]]*"\/wallet"[^\]]*\];/);
  assert.doesNotMatch(sw, /SW_VERSION = "2026-10-31\.2"/, "SW_VERSION bumped");
});

test("V10 the wallet screen: one primary (Add expense), Show my QR on the payments I receive, and confirms before deleting", () => {
  const src = read("src/components/WalletView.tsx");
  assert.match(src, /^"use client";/);
  // TG-66 W3: the add form is W1's ExpenseForm, which holds the screen's one primary (one of two, by flag)
  assert.equal(src.match(/variant="primary"/g)?.length ?? 0, 0, "no primary of its own");
  const form = read("src/components/wallet/ExpenseForm.tsx");
  assert.match(form, /const submitButton = v2 \? \(\s*<PixelButton type="submit" variant="primary"[\s\S]*?\) : \(\s*<PixelButton type="submit" variant="primary"/, "one primary, whichever form shows");
  assert.equal(form.match(/variant="primary"/g)?.length, 2);
  assert.match(form, /Add expense/);
  assert.match(src, /t\.to_member === me/, "Show my QR only on payments to me");
  assert.match(src, /<PayoutQr\b/);
  assert.equal(src.match(/window\.confirm\(/g)?.length, 2, "delete expense and undo confirm; Mark paid opens ProofDialog (TG-53)");
  assert.match(src, /visibilitychange/, "refreshes when the phone comes back to the app");
});

test("V11 home: the fourth quick action is the trip wallet, which links on to tickets", () => {
  // TG-49: the quick actions became the title screen's start menu
  const src = read("src/components/landing/TitleScreen.tsx");
  const hrefs = [...src.matchAll(/href: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, ["/buses", "/plan", "/around", "/baguio", "/trip", "/wallet"]); // TG-71/72: Around in place of Baguio, Ambagan last, each by its flag; the whole block is pinned in tg72.test.ts
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
  // TG-66 W3: every wallet a write brings back lands through landWallet, which marks the screen new before its state
  const land = view.slice(view.indexOf("function landWallet("), view.indexOf("function openProof("));
  assert.ok(land.includes("shownAt.current = Date.now();"), "landWallet marks the screen as new");
  assert.ok(land.indexOf("shownAt.current = Date.now();") < land.indexOf("setLoad("), "before its state, so no answer can slip between");
  const write = view.slice(view.indexOf("async function write("), view.indexOf("function landWallet("));
  assert.ok(write.indexOf("landWallet(") > write.indexOf("if (!r.ok)"), "only a write that landed");
  assert.match(view.slice(view.indexOf("function proofSaved("), view.indexOf("/** Settle up")), /landWallet\(next\)/);
  assert.equal(view.match(/setLoad\(/g)?.length, 2, "afterGet and landWallet: nothing else sets the wallet");
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

// ---------------------------------------------------------------- TG-66 P0: the shared contracts (plan §2)
// Dynamic imports, as above: before P0's GREEN the new exports don't exist, and a named import would stop the file.

const revWallet = (rev: number | undefined, notes: string[] = []) => ({ ...walletWith(notes), ...(rev === undefined ? {} : { rev }) });

test("TG66-1 afterGet: an answer with a lower rev never replaces the wallet on screen; equal or higher does", async () => {
  const { afterGet } = await import("./wallet.ts");
  const prev = { state: "ready" as const, wallet: revWallet(8, []) }; // a comment was deleted: rev 8
  const older = { ok: true as const, wallet: revWallet(7, ["Taxi"]) };
  assert.equal(afterGet(prev, older, W, false, false), prev, "rev 7 under rev 8: the screen stays, whatever the clock says");
  assert.deepEqual(afterGet(prev, { ok: true, wallet: revWallet(8, ["Taxi"]) }, W, false, false), { state: "ready", wallet: revWallet(8, ["Taxi"]) });
  assert.deepEqual(afterGet(prev, { ok: true, wallet: revWallet(9) }, W, false, false), { state: "ready", wallet: revWallet(9) });
  // audit S1: the rule needs a rev on both sides. A live answer with none comes from an API reverted to before TG-66
  // (plan §6): it shows, or an open wallet would ignore every refresh until it reloads. The worker's old copy is held by
  // the saved-copy rule, not this one.
  assert.deepEqual(afterGet(prev, { ok: true, wallet: revWallet(undefined, ["Taxi"]) }, W, false, false), { state: "ready", wallet: revWallet(undefined, ["Taxi"]) });
  assert.equal(afterGet(prev, { ok: true, wallet: revWallet(undefined), saved: true }, W, false, false), prev);
  assert.deepEqual(afterGet({ state: "ready", wallet: revWallet(undefined) }, { ok: true, wallet: revWallet(0) }, W, false, false), { state: "ready", wallet: revWallet(0) });
  // another wallet's screen, or nothing on screen, isn't this wallet's
  assert.deepEqual(afterGet({ state: "ready", wallet: { ...revWallet(9), share_slug: "d".repeat(32) } }, older, W, false, false), { state: "ready", wallet: older.wallet });
  assert.deepEqual(afterGet({ state: "loading" }, older, W, false, false), { state: "ready", wallet: older.wallet });
  // TG-65's rules still hold beside it
  assert.equal(afterGet(prev, { ok: true, wallet: revWallet(9) }, W, true, false), prev, "overtaken");
  assert.equal(afterGet(prev, { ok: true, wallet: revWallet(9), saved: true }, W, false, false), prev, "a saved copy");
});

type Sent = { url: string; method: string; body: string | undefined };
async function withFetch<T>(answers: Response[], run: (sent: Sent[]) => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  const sent: Sent[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
    const next = answers.shift();
    if (!next) throw new TypeError("offline");
    return next;
  }) as typeof fetch;
  try {
    return await run(sent);
  } finally {
    globalThis.fetch = real;
  }
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const E = "e".repeat(8);

test("TG66-2 walletApi: an old-shape add goes out byte for byte; delete takes an optional version; edit is a PATCH", async () => {
  const { walletApi } = await import("./wallet.ts");
  const old = { paid_by: "a", amount_centavos: 1000, note: "Taxi", split_among: ["a", "b"] };
  await withFetch([json(201, revWallet(1)), json(200, revWallet(2)), json(200, revWallet(3)), json(200, revWallet(4))], async (sent) => {
    assert.ok((await walletApi.addExpense(W, old)).ok);
    await walletApi.deleteExpense(W, E);
    await walletApi.deleteExpense(W, E, 3);
    const v2 = { mode: "shares" as const, paid_by: "a", amount_centavos: 1000, note: "Taxi", inputs: [{ member_id: "a", value: 2 }], version: 2 };
    const r = await walletApi.editExpense(W, E, v2);
    assert.ok(r.ok && r.wallet.rev === 4);
    assert.equal(sent[0].body, JSON.stringify(old), "today's body, untouched");
    assert.deepEqual(sent.map((s) => [s.method, s.url.slice(s.url.indexOf("/wallets"))]), [
      ["POST", `/wallets/${W}/expenses`],
      ["DELETE", `/wallets/${W}/expenses/${E}`],
      ["DELETE", `/wallets/${W}/expenses/${E}?version=3`],
      ["PATCH", `/wallets/${W}/expenses/${E}`],
    ]);
    assert.equal(sent[3].body, JSON.stringify(v2));
  });
});

test("TG66-3 refusals: a string detail stays a code; an object detail gives its code, the current wallet and an item's seq", async () => {
  const { walletApi } = await import("./wallet.ts");
  const current = revWallet(9, ["Taxi"]);
  const answers = [
    json(409, { detail: { code: "expense_changed", wallet: current } }),
    json(404, { detail: { code: "expense_gone", wallet: current } }),
    json(404, { detail: "feature_off" }),
    json(422, { detail: { code: "item_no_one", seq: 3 } }),
    json(422, { detail: "percent_total" }),
    json(422, { detail: [{ loc: ["body"], msg: "x" }] }), // pydantic's own 422: no code, as today
    json(404, { detail: "Wallet not found" }),
  ];
  await withFetch(answers, async () => {
    const got = [];
    for (let i = 0; i < 7; i++) got.push(await walletApi.deleteExpense(W, E, 1));
    assert.deepEqual(got, [
      { ok: false, why: "rejected", detail: "expense_changed", wallet: current },
      { ok: false, why: "not_found", detail: "expense_gone", wallet: current },
      { ok: false, why: "not_found", detail: "feature_off" },
      { ok: false, why: "rejected", detail: "item_no_one", seq: 3 },
      { ok: false, why: "rejected", detail: "percent_total" },
      { ok: false, why: "rejected", detail: undefined },
      { ok: false, why: "not_found", detail: "Wallet not found" },
    ]);
  });
});

test("TG66-4 comments and activity: GETs answer {rev, …}; comment writes answer the wallet and the list; offline is offline", async () => {
  const { walletApi } = await import("./wallet.ts");
  const comment = { id: "k1", expense_id: E, author: null, body: "Nice", created_at: "2026-11-16T01:00:00.000000Z" };
  const row = { id: 12, at: "2026-11-16T01:00:00.000000Z", actor: null, action: "comment_add", expense_id: E, settlement_id: null, member_id: null, before: null, after: null };
  const answers = [
    json(200, { rev: 7, comments: [comment] }),
    json(201, { wallet: revWallet(8), comments: [comment, { ...comment, id: "k2" }] }),
    json(200, { wallet: revWallet(9), comments: [] }),
    json(200, { rev: 9, rows: [row] }),
    json(200, { rev: 9, rows: [] }),
    json(404, { detail: "feature_off" }),
  ];
  await withFetch(answers, async (sent) => {
    assert.deepEqual(await walletApi.comments(W, E), { ok: true, rev: 7, comments: [comment] });
    const added = await walletApi.addComment(W, E, { body: "Nice", by: "a" });
    assert.ok(added.ok && added.wallet.rev === 8 && added.comments.length === 2);
    const gone = await walletApi.deleteComment(W, E, "k1");
    assert.ok(gone.ok && gone.wallet.rev === 9 && gone.comments.length === 0);
    assert.deepEqual(await walletApi.activity(W), { ok: true, rev: 9, rows: [row] });
    await walletApi.activity(W, 12);
    assert.deepEqual(await walletApi.comments(W, E), { ok: false, why: "not_found", detail: "feature_off" });
    assert.deepEqual(await walletApi.activity(W), { ok: false, why: "offline" });
    assert.deepEqual(sent.map((s) => [s.method, s.url.slice(s.url.indexOf("/wallets"))]), [
      ["GET", `/wallets/${W}/expenses/${E}/comments`],
      ["POST", `/wallets/${W}/expenses/${E}/comments`],
      ["DELETE", `/wallets/${W}/expenses/${E}/comments/k1`],
      ["GET", `/wallets/${W}/activity?limit=15`],
      ["GET", `/wallets/${W}/activity?before=12&limit=15`],
      ["GET", `/wallets/${W}/expenses/${E}/comments`],
      ["GET", `/wallets/${W}/activity?limit=15`],
    ]);
    assert.equal(sent[1].body, JSON.stringify({ body: "Nice", by: "a" }));
  });
});

test("TG66-5 the new expense fields are optional, so a wallet saved before TG-66 still type-checks and reads", async () => {
  const src = read("src/lib/wallet.ts");
  for (const field of ["category", "mode", "inputs", "items", "charges", "payers", "version", "updated_at", "comment_count"]) {
    assert.match(src, new RegExp(`\\b${field}\\?:`), `Expense.${field} is optional`);
  }
  assert.match(src, /\brev\?: number;/, "Wallet.rev is optional");
  assert.match(src, /export type SplitMode = "equal" \| "exact" \| "percent" \| "shares" \| "adjust" \| "itemized";/);
  assert.match(src, /export type Category = "transport" \| "hotel" \| "food" \| "activities" \| "other";/);
});

// ---------------------------------------------------------------- TG-66 W3: `by` on every write, and the rev rule for write answers

test("TG66-W3-1 B28c walletApi sends `by` (A3/A2: ?by= on settle, undo, delete, proofs and member add; never in those bodies), and leaves today's request alone without it", async () => {
  const { walletApi } = await import("./wallet.ts");
  const M = "00000000-0000-4000-8000-000000000002";
  const S = "11111111-1111-4111-8111-111111111111";
  const t = { from_member: "a", to_member: "b", amount_centavos: 500 };
  const pic = new Blob(["made up"], { type: "image/jpeg" });
  await withFetch(Array.from({ length: 13 }, (_, i) => json(200, revWallet(i + 1))), async (sent) => {
    await walletApi.deleteExpense(W, E, 3, M);
    await walletApi.deleteExpense(W, E, undefined, M);
    await walletApi.settle(W, t, M);
    await walletApi.undoSettlement(W, S, M);
    await walletApi.addProof(W, S, pic, M);
    await walletApi.removeProof(W, S, M);
    // without a by: today's requests, byte for byte
    await walletApi.deleteExpense(W, E);
    await walletApi.settle(W, t);
    await walletApi.settle(W, t, null);
    await walletApi.undoSettlement(W, S);
    await walletApi.addMember(W, "Eli", M);
    await walletApi.addMember(W, "Eli");
    await walletApi.deleteExpense(W, E, 4, null);
    const at = (i: number) => sent[i].url.slice(sent[i].url.indexOf("/wallets"));
    assert.equal(at(0), `/wallets/${W}/expenses/${E}?version=3&by=${M}`);
    assert.equal(at(1), `/wallets/${W}/expenses/${E}?by=${M}`);
    assert.equal(at(2), `/wallets/${W}/settlements?by=${M}`);
    assert.equal(sent[2].body, JSON.stringify(t), "SettlementIn forbids extra keys: by is a query, the body is today's");
    assert.equal(at(3), `/wallets/${W}/settlements/${S}?by=${M}`);
    assert.equal(at(4), `/wallets/${W}/settlements/${S}/proof?by=${M}`);
    assert.equal(sent[4].method, "POST");
    assert.equal(at(5), `/wallets/${W}/settlements/${S}/proof?by=${M}`);
    assert.equal(sent[5].method, "DELETE");
    assert.equal(at(6), `/wallets/${W}/expenses/${E}`);
    assert.equal(sent[7].body, JSON.stringify(t), "today's settle body");
    assert.equal(sent[8].body, JSON.stringify(t), "a null by is no by");
    assert.equal(at(8), `/wallets/${W}/settlements`, "tg-test3 S1: never ?by=null (the API would 422 it)");
    assert.equal(at(12), `/wallets/${W}/expenses/${E}?version=4`, "a null by on a DELETE: no by at all");
    assert.equal(at(9), `/wallets/${W}/settlements/${S}`);
    assert.equal(at(10), `/wallets/${W}/members?by=${M}`);
    assert.equal(sent[10].body, JSON.stringify({ name: "Eli" }));
    assert.equal(at(11), `/wallets/${W}/members`);
    assert.equal(at(7), `/wallets/${W}/settlements`);
  });
});

test("TG66-W3-2 B28c markPaid passes `by` to the settle and the upload", async () => {
  const { markPaid } = await import("./wallet.ts");
  const calls: unknown[][] = [];
  const w = { ...revWallet(2), settlements: [{ id: "s1", from_member: "a", to_member: "b", amount_centavos: 500, created_at: "2026-11-06T05:00:00Z" }] } as unknown as import("./wallet.ts").Wallet;
  const api = {
    settle: async (...args: unknown[]) => (calls.push(["settle", ...args]), { ok: true as const, wallet: w }),
    addProof: async (...args: unknown[]) => (calls.push(["addProof", ...args]), { ok: true as const, wallet: w }),
  };
  const t = { from_member: "a", to_member: "b", amount_centavos: 500 };
  const pic = new Blob(["x"]);
  await markPaid(api, W, t, pic, undefined, "m-b");
  assert.deepEqual(calls, [["settle", W, t, "m-b"], ["addProof", W, "s1", pic, "m-b"]]);
});

test("TG66-W3-3 B27 afterWrite: a write's wallet with a lower rev than the screen never replaces it; otherwise it shows", async () => {
  const { afterWrite } = await import("./wallet.ts");
  const screen = { state: "ready" as const, wallet: revWallet(8, ["Taxi", "Jeep"]) };
  assert.equal(afterWrite(screen, revWallet(7, ["Taxi"])), screen, "an older answer (another tab's slower write) keeps the newer screen");
  assert.deepEqual(afterWrite(screen, revWallet(9, ["Taxi"])), { state: "ready", wallet: revWallet(9, ["Taxi"]) });
  assert.deepEqual(afterWrite(screen, revWallet(8, ["Bus"])), { state: "ready", wallet: revWallet(8, ["Bus"]) }, "equal rev: the write's own answer");
  const noRev = { ...revWallet(1), rev: undefined };
  assert.deepEqual(afterWrite(screen, noRev), { state: "ready", wallet: noRev }, "an API without rev (reverted): it shows, as afterGet's S1");
  assert.deepEqual(afterWrite({ state: "loading" }, revWallet(1)), { state: "ready", wallet: revWallet(1) });
  const other = { state: "ready" as const, wallet: { ...revWallet(50), share_slug: "d".repeat(32) } };
  assert.deepEqual(afterWrite(other, revWallet(1)), { state: "ready", wallet: revWallet(1) }, "another wallet's screen isn't this one's");
});

// ---------------------------------------------------------------- TG-70 O2: the add's timeout and Retry-After (test-plan L12)

type Init70 = RequestInit & { signal?: AbortSignal };
/** A fake fetch that keeps every init. `hang`: never answers, only rejects when its signal aborts (as a real fetch does). */
async function withFetch70<T>(answer: Response | "hang", run: (inits: Init70[]) => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  const inits: Init70[] = [];
  globalThis.fetch = ((_url: string, init?: Init70) => {
    inits.push(init ?? {});
    if (answer !== "hang") return Promise.resolve(answer);
    return new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
      setTimeout(() => reject(new Error("test guard: the request was never aborted")), 3000); // fail fast, not at the 60 s cap
    });
  }) as typeof fetch;
  try {
    return await run(inits);
  } finally {
    globalThis.fetch = real;
  }
}
const V2_ADD = { mode: "equal", paid_by: "a", amount_centavos: 45000, note: "Taxi (made up)", category: null, by: "a", inputs: [{ member_id: "a", value: 1 }] } as const;

test("T70-L12 addExpense with timeoutMs: an answer that never comes is offline with timedOut, after the abort", async () => {
  const { walletApi } = await import("./wallet.ts");
  await withFetch70("hang", async (inits) => {
    const started = Date.now();
    const r = await walletApi.addExpense(W, { ...V2_ADD, id: "e1" } as never, { timeoutMs: 30 });
    assert.deepEqual(r, { ok: false, why: "offline", timedOut: true });
    assert.ok(Date.now() - started >= 25, "it waited for the timeout");
    assert.ok(inits[0].signal instanceof AbortSignal, "the fetch got a signal");
    assert.equal(inits[0].signal?.aborted, true);
  });
});

test("T70-L12 S2 the timeout doesn't need AbortSignal.timeout (iOS before 16 lacks it)", async () => {
  const { walletApi } = await import("./wallet.ts");
  const real = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
  delete (AbortSignal as { timeout?: unknown }).timeout;
  try {
    assert.equal("timeout" in AbortSignal, false);
    await withFetch70(json(201, revWallet(2)), async () => {
      const r = await walletApi.addExpense(W, { ...V2_ADD, id: "e1" } as never, { timeoutMs: 1000 });
      assert.equal(r.ok, true, "it still sends");
    });
    await withFetch70("hang", async () => {
      assert.deepEqual(await walletApi.addExpense(W, { ...V2_ADD, id: "e1" } as never, { timeoutMs: 20 }), { ok: false, why: "offline", timedOut: true }, "and still times out");
    });
  } finally {
    if (real) Object.defineProperty(AbortSignal, "timeout", real);
  }
  const source = readFileSync(new URL("./wallet.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /AbortSignal\.timeout/);
  assert.match(source, /clearTimeout/);
});

test("T70-L12 B24 addExpense without the option: no signal in the init, and the request is today's byte for byte", async () => {
  const { walletApi } = await import("./wallet.ts");
  const old = { paid_by: "a", amount_centavos: 1000, note: "Taxi", split_among: ["a", "b"] };
  await withFetch70(json(201, revWallet(1)), async (inits) => {
    assert.ok((await walletApi.addExpense(W, old)).ok);
    assert.deepEqual(Object.keys(inits[0]).sort(), ["body", "cache", "headers", "method"]);
    assert.equal("signal" in inits[0], false);
    assert.equal(inits[0].body, JSON.stringify(old));
    assert.deepEqual(inits[0].headers, { "content-type": "application/json" });
  });
  await withFetch70(json(201, revWallet(1)), async (inits) => {
    assert.ok((await walletApi.addExpense(W, old, {})).ok);
    assert.equal("signal" in inits[0], false, "an empty option is no option");
  });
});

test("T70-L12 a fast answer clears the timer: nothing aborts later", async () => {
  const { walletApi } = await import("./wallet.ts");
  await withFetch70(json(201, revWallet(3)), async (inits) => {
    assert.ok((await walletApi.addExpense(W, { ...V2_ADD, id: "e1" } as never, { timeoutMs: 20 })).ok);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(inits[0].signal?.aborted, false);
  });
});

test("T70-L12 a 429's Retry-After is carried in seconds; without the header there's no retryAfter", async () => {
  const { walletApi } = await import("./wallet.ts");
  const with429 = new Response(JSON.stringify({ detail: "rate_limited" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "120" } });
  await withFetch70(with429, async () => {
    assert.deepEqual(await walletApi.addExpense(W, { ...V2_ADD, id: "e1" } as never, { timeoutMs: 1000 }), { ok: false, why: "rate_limited", retryAfter: 120 });
  });
  await withFetch70(json(429, { detail: "rate_limited" }), async () => {
    assert.deepEqual(await walletApi.addExpense(W, { ...V2_ADD, id: "e1" } as never), { ok: false, why: "rate_limited" });
  });
  const junk = new Response("{}", { status: 429, headers: { "retry-after": "soon" } });
  await withFetch70(junk, async () => {
    assert.deepEqual(await walletApi.addExpense(W, { ...V2_ADD, id: "e1" } as never), { ok: false, why: "rate_limited" }, "an unreadable header is no header");
  });
});

test("T70-L12 a thrown fetch without a timeout stays plain offline (no timedOut)", async () => {
  const { walletApi } = await import("./wallet.ts");
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;
  try {
    assert.deepEqual(await walletApi.addExpense(W, { ...V2_ADD, id: "e1" } as never, { timeoutMs: 1000 }), { ok: false, why: "offline" });
  } finally {
    globalThis.fetch = real;
  }
});

test("T70-L12 DETAIL is exported, and failureMessage still reads it", async () => {
  const { DETAIL, failureMessage } = (await import("./wallet.ts")) as typeof import("./wallet.ts") & { DETAIL?: Record<string, string> };
  assert.ok(DETAIL, "DETAIL is exported");
  for (const [code, line] of Object.entries(DETAIL)) assert.equal(failureMessage({ why: "rejected", detail: code }), line);
});

// ---------------------------------------------------------------- TG-70 O2 review S1: the timeout covers the body read too

/** A 2xx whose JSON never finishes (`stall`) or whose stream drops mid-way (`drop`). */
function brokenBody(kind: "stall" | "drop", status = 201): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('{"share_slug":"'));
      if (kind === "drop") c.error(new TypeError("network error"));
    },
  });
  return new Response(stream, { status, headers: { "content-type": "application/json" } });
}
/** Fails fast instead of at the 60 s test cap when the call never settles. */
const within = <T>(p: Promise<T>, ms = 3000) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`test guard: no answer in ${ms} ms`)), ms))]);

test("T70-L12b review S1: a 201 whose body never ends is offline with timedOut after the timeout (it may have landed)", async () => {
  const { walletApi } = await import("./wallet.ts");
  await withFetch70(brokenBody("stall"), async () => {
    const started = Date.now();
    assert.deepEqual(await within(walletApi.addExpense(W, { ...V2_ADD, id: "e1" } as never, { timeoutMs: 40 })), { ok: false, why: "offline", timedOut: true });
    assert.ok(Date.now() - started >= 35, "it waited for the timeout, not less");
  });
});

test("T70-L12b review S1: a 2xx whose body drops mid-way is a result, not a throw, and counts as may-have-landed", async () => {
  const { walletApi } = await import("./wallet.ts");
  const { mayHaveLanded } = await import("./outbox.ts");
  await withFetch70(brokenBody("drop"), async () => {
    const r = await within(walletApi.addExpense(W, { ...V2_ADD, id: "e1" } as never, { timeoutMs: 1000 }));
    assert.deepEqual(r, { ok: false, why: "offline", timedOut: true });
    assert.equal(mayHaveLanded(r, { start: false, end: false }), true, "even if the phone says offline at both ends");
  });
});

test("T70-L12b review S1: without the option a broken body still throws, as today (flag off = main)", async () => {
  const { walletApi } = await import("./wallet.ts");
  await withFetch70(brokenBody("drop"), async () => {
    await assert.rejects(within(walletApi.addExpense(W, { paid_by: "a", amount_centavos: 1000, note: "Taxi", split_among: ["a"] })), TypeError);
  });
});

test("T70-L12b review S1: a refusal whose body stalls still ends at the timeout, as a refusal with no code", async () => {
  const { walletApi } = await import("./wallet.ts");
  await withFetch70(brokenBody("stall", 409), async () => {
    assert.deepEqual(await within(walletApi.addExpense(W, { ...V2_ADD, id: "e1" } as never, { timeoutMs: 40 })), { ok: false, why: "rejected", detail: undefined });
  });
});
