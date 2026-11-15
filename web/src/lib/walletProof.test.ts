// TG-53 payment proofs, web side. Run with `npm test` (node --test, Node 22.18+ type stripping). Ids are T53-W1 to W27
// from tickets/TG-53/test-plan.md. Web has no component runner, so ProofDialog's stages are checked end to end in
// proof-e2e.mjs; here are the pure helpers, the API client and the source checks. Names here are made up.
// `import *`, not named imports: before the feature exists, a named import of a missing export would stop the whole file.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as wallet from "./wallet.ts";
import type { Settlement, Transfer, Wallet, WalletResult } from "./wallet.ts";

const WEB = new URL("../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, WEB), "utf8").replaceAll("&apos;", "'");
const view = () => read("src/components/WalletView.tsx");
const dialog = () => read("src/components/ProofDialog.tsx");

const SLUG = "a".repeat(32);
const ID = "11111111-1111-4111-8111-111111111111";
const JACOB = "m-jacob";
const ANA = "m-ana";
const BEN = "m-ben";
const CARA = "m-cara";
const PICTURE = new Blob(["made up"], { type: "image/jpeg" });
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const transfer = (from_member = JACOB, to_member = ANA, amount_centavos = 50000): Transfer => ({ from_member, to_member, amount_centavos });
const settlement = (over: Partial<Settlement> = {}): Settlement => ({
  id: ID,
  from_member: JACOB,
  to_member: ANA,
  amount_centavos: 50000,
  created_at: "2026-11-07T04:00:00Z",
  ...over,
});
const made = (over: Partial<Wallet> = {}): Wallet => ({
  share_slug: SLUG,
  name: "Baguio Nov 6",
  created_at: "2026-11-06T00:00:00Z",
  members: [],
  expenses: [],
  settlements: [],
  balances: [],
  transfers: [],
  total_centavos: 0,
  ...over,
});
const ok = (w: Wallet): WalletResult => ({ ok: true, wallet: w });
const failed = (why: "offline" | "not_found" | "server" | "rejected", detail?: string): WalletResult => ({ ok: false, why, detail });

/** Records calls and returns queued results, like walletApi's settle and addProof. */
function fakeApi(settles: WalletResult[], uploads: WalletResult[]) {
  const calls = { settle: [] as unknown[][], addProof: [] as unknown[][] };
  return {
    calls,
    settle: async (slug: string, t: Transfer) => {
      calls.settle.push([slug, t]);
      return settles.shift()!;
    },
    addProof: async (slug: string, id: string, picture: Blob) => {
      calls.addProof.push([slug, id, picture]);
      return uploads.shift()!;
    },
  };
}

const AFTER_SETTLE = made({ settlements: [settlement()] });
const AFTER_UPLOAD = made({ settlements: [settlement({ has_proof: true, proof_at: "2026-11-07T04:01:00Z" })] });

// ---------------------------------------------------------------- the pure helpers

test("T53-W1 sameTransfer: this exact from, to and amount is still open", () => {
  const w = made({ transfers: [transfer(), transfer(BEN, ANA, 30000)] });
  assert.equal(wallet.sameTransfer(w, transfer()), true);
  assert.equal(wallet.sameTransfer(w, transfer(JACOB, ANA, 50001)), false, "another amount");
  assert.equal(wallet.sameTransfer(w, transfer(ANA, JACOB, 50000)), false, "swapped people");
  assert.equal(wallet.sameTransfer(made(), transfer()), false, "gone");
});

test("T53-W2 newestSettlement: the first match in the newest-first list, and only an exact match", () => {
  const newest = settlement({ id: "newest" });
  const older = settlement({ id: "older" });
  const otherPair = settlement({ id: "pair", from_member: BEN });
  const otherAmount = settlement({ id: "amount", amount_centavos: 100 });
  const w = made({ settlements: [otherAmount, otherPair, newest, older] });
  assert.equal(wallet.newestSettlement(w, transfer()), "newest");
  assert.equal(wallet.newestSettlement(made({ settlements: [otherPair, otherAmount] }), transfer()), null);
  assert.equal(wallet.newestSettlement(made(), transfer()), null);
});

test("T53-W3 proofState: kept, deleted by the sweep, or none, and an old offline copy reads as none", () => {
  assert.equal(wallet.proofState(settlement({ has_proof: true, proof_at: "2026-11-07T04:01:00Z" })), "kept");
  assert.equal(wallet.proofState(settlement({ has_proof: false, proof_at: "2026-11-07T04:01:00Z" })), "deleted");
  assert.equal(wallet.proofState(settlement({ has_proof: false, proof_at: null })), "none");
  assert.equal(wallet.proofState(settlement()), "none", "both fields missing: saved before the deploy");
});

test("T53-W4 proofControls: the ux 4.6 table, for payer, payee and anyone else", () => {
  const states: [string, Partial<Settlement>][] = [
    ["none", { has_proof: false, proof_at: null }],
    ["kept", { has_proof: true, proof_at: "2026-11-07T04:01:00Z" }],
    ["deleted", { has_proof: false, proof_at: "2026-11-07T04:01:00Z" }],
  ];
  const expected: Record<string, Record<string, { show: boolean; add: boolean; change: boolean }>> = {
    payer: {
      none: { show: false, add: true, change: false },
      kept: { show: true, add: false, change: true },
      deleted: { show: false, add: true, change: false },
    },
    payee: {
      none: { show: false, add: true, change: false },
      kept: { show: true, add: false, change: true },
      deleted: { show: false, add: true, change: false },
    },
    third: {
      none: { show: false, add: false, change: false },
      kept: { show: true, add: false, change: false },
      deleted: { show: false, add: false, change: false },
    },
  };
  const phones: [string, string][] = [["payer", JACOB], ["payee", ANA], ["third", CARA]];
  for (const [who, me] of phones) {
    for (const [state, fields] of states) {
      assert.deepEqual(wallet.proofControls(settlement(fields), me), expected[who][state], `${who}, ${state}`);
    }
  }
});

// ---------------------------------------------------------------- markPaid

test("T53-W5 markPaid with no picture: settle once, nothing uploaded", async () => {
  const api = fakeApi([ok(AFTER_SETTLE)], []);
  const r = await wallet.markPaid(api, SLUG, transfer(), null);
  assert.deepEqual(r, { stage: "done", wallet: AFTER_SETTLE });
  assert.equal(api.calls.settle.length, 1);
  assert.deepEqual(api.calls.addProof, []);
});

test("T53-W6 markPaid with a picture: the same Blob goes on the new payment", async () => {
  const api = fakeApi([ok(AFTER_SETTLE)], [ok(AFTER_UPLOAD)]);
  const r = await wallet.markPaid(api, SLUG, transfer(), PICTURE);
  assert.deepEqual(r, { stage: "done", wallet: AFTER_UPLOAD });
  assert.equal(api.calls.addProof.length, 1);
  const [slug, id, picture] = api.calls.addProof[0];
  assert.equal(slug, SLUG);
  assert.equal(id, ID, "newestSettlement's id");
  assert.equal(picture, PICTURE);
});

test("T53-W7 markPaid when the settle fails: nothing saved, nothing uploaded", async () => {
  const api = fakeApi([failed("offline")], []);
  const r = await wallet.markPaid(api, SLUG, transfer(), PICTURE);
  assert.equal(r.stage, "not_saved");
  assert.equal(r.stage === "not_saved" && r.failure.why, "offline");
  assert.deepEqual(api.calls.addProof, []);
});

test("T53-W8 markPaid when the upload fails: the payment stands", async () => {
  const api = fakeApi([ok(AFTER_SETTLE)], [failed("server")]);
  const r = await wallet.markPaid(api, SLUG, transfer(), PICTURE);
  assert.equal(r.stage, "upload_failed");
  if (r.stage !== "upload_failed") return;
  assert.equal(r.wallet, AFTER_SETTLE);
  assert.equal(r.settlementId, ID);
  assert.equal(r.failure.why, "server");
});

test("T53-W9 markPaid with a settlement id only uploads", async () => {
  const api = fakeApi([], [ok(AFTER_UPLOAD)]);
  const r = await wallet.markPaid(api, SLUG, transfer(), PICTURE, ID);
  assert.deepEqual(r, { stage: "done", wallet: AFTER_UPLOAD });
  assert.deepEqual(api.calls.settle, []);
  assert.equal(api.calls.addProof.length, 1);
  assert.equal(api.calls.addProof[0][1], ID);
});

test("T53-W10 a retry that fails again is still upload_failed, on the same payment", async () => {
  const api = fakeApi([], [failed("offline")]);
  const r = await wallet.markPaid(api, SLUG, transfer(), PICTURE, ID);
  assert.equal(r.stage, "upload_failed");
  assert.equal(r.stage === "upload_failed" && r.settlementId, ID);
  assert.equal(r.stage === "upload_failed" && r.wallet, null, "a retry skips settle, so it has no new wallet: the dialog keeps the one it has");
  assert.deepEqual(api.calls.settle, []);
});

test("T53-W11 fail then retry: one settle in total, so a retry can't make a second payment", async () => {
  const api = fakeApi([ok(AFTER_SETTLE)], [failed("offline"), ok(AFTER_UPLOAD)]);
  const first = await wallet.markPaid(api, SLUG, transfer(), PICTURE);
  assert.equal(first.stage, "upload_failed");
  const again = await wallet.markPaid(api, SLUG, transfer(), PICTURE, first.stage === "upload_failed" ? first.settlementId : undefined);
  assert.equal(again.stage, "done");
  assert.equal(api.calls.settle.length, 1);
  assert.equal(api.calls.addProof.length, 2);
});

// ---------------------------------------------------------------- the API client

function stubFetch(respond: () => Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond();
  }) as typeof fetch;
  return calls;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const PROOF_PATH = `/wallets/${SLUG}/settlements/${ID}/proof`;

test("T53-W12 addProof: POSTs the Blob as the body, typed as the picture", async () => {
  const calls = stubFetch(async () => json(201, AFTER_UPLOAD));
  const r = await wallet.walletApi.addProof(SLUG, ID, PICTURE);
  assert.ok(r.ok);
  assert.ok(calls[0].url.endsWith(PROOF_PATH), calls[0].url);
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(calls[0].init?.body, PICTURE, "the Blob, not JSON");
  assert.deepEqual(calls[0].init?.headers, { "content-type": "image/jpeg" });
  await wallet.walletApi.addProof(SLUG, ID, new Blob(["made up"], { type: "image/png" }));
  assert.deepEqual(calls[1].init?.headers, { "content-type": "image/png" }, "the picture's own type, never a fixed one");
});

test("T53-W12 addProof failures: 404 keeps its detail, 409 is a rejection, a throw is offline", async () => {
  stubFetch(async () => json(404, { detail: "Payment not found" }));
  assert.deepEqual(await wallet.walletApi.addProof(SLUG, ID, PICTURE), { ok: false, why: "not_found", detail: "Payment not found" });
  stubFetch(async () => json(404, { detail: "Proof not found" }));
  assert.deepEqual(await wallet.walletApi.addProof(SLUG, ID, PICTURE), { ok: false, why: "not_found", detail: "Proof not found" });
  stubFetch(async () => new Response("<html>not json</html>", { status: 404 }));
  const plain = await wallet.walletApi.addProof(SLUG, ID, PICTURE);
  assert.equal(plain.ok === false && plain.why, "not_found", "a 404 with no JSON body doesn't throw");
  stubFetch(async () => json(409, { detail: "too_many_proofs" }));
  assert.deepEqual(await wallet.walletApi.addProof(SLUG, ID, PICTURE), { ok: false, why: "rejected", detail: "too_many_proofs" });
  stubFetch(async () => {
    throw new TypeError("Failed to fetch");
  });
  const offline = await wallet.walletApi.addProof(SLUG, ID, PICTURE);
  assert.equal(offline.ok === false && offline.why, "offline");
});

test("T53-W13 removeProof: DELETE on that path, with the same 404 detail", async () => {
  const calls = stubFetch(async () => json(200, AFTER_SETTLE));
  assert.ok((await wallet.walletApi.removeProof(SLUG, ID)).ok);
  assert.ok(calls[0].url.endsWith(PROOF_PATH), calls[0].url);
  assert.equal(calls[0].init?.method, "DELETE");
  stubFetch(async () => json(404, { detail: "Proof not found" }));
  assert.deepEqual(await wallet.walletApi.removeProof(SLUG, ID), { ok: false, why: "not_found", detail: "Proof not found" });
  stubFetch(async () => json(404, { detail: "Payment not found" }));
  assert.deepEqual(await wallet.walletApi.removeProof(SLUG, ID), { ok: false, why: "not_found", detail: "Payment not found" });
});

test("T53-W14 fetchProof: a CORS fetch with no HTTP cache; null on anything but a 200", async () => {
  const calls = stubFetch(async () => new Response(PICTURE, { status: 200 }));
  const blob = await wallet.fetchProof(SLUG, ID);
  assert.ok(blob instanceof Blob);
  assert.ok(calls[0].url.endsWith(PROOF_PATH), calls[0].url);
  assert.equal(calls[0].init?.cache, "no-store");
  assert.notEqual(calls[0].init?.mode, "no-cors");
  for (const status of [404, 503]) {
    stubFetch(async () => new Response("{}", { status }));
    assert.equal(await wallet.fetchProof(SLUG, ID), null, String(status));
  }
  stubFetch(async () => {
    throw new TypeError("Failed to fetch");
  });
  assert.equal(await wallet.fetchProof(SLUG, ID), null);
});

test("T53-W28 get says when the answer is the service worker's saved copy", async () => {
  stubFetch(async () => new Response(JSON.stringify(AFTER_SETTLE), { status: 200, headers: { "X-TG-Saved-At": "2026-11-07T01:00:00.000Z" } }));
  const saved = await wallet.walletApi.get(SLUG);
  assert.equal(saved.ok && saved.saved, true);
  stubFetch(async () => json(200, AFTER_SETTLE));
  const live = await wallet.walletApi.get(SLUG);
  assert.ok(live.ok);
  assert.ok(!live.saved, "a live answer isn't marked");
});

test("T53-W15 a full wallet gets its own sentence", () => {
  assert.equal(wallet.failureMessage({ why: "rejected", detail: "too_many_proofs" }), "This wallet is full: it holds up to 50 screenshots.");
});

// ---------------------------------------------------------------- the screens, by source

test("T53-W16 P1: both versions of the payer's hint end with the sentence", () => {
  assert.equal(view().match(/your GCash, Maya or bank app\. Screenshot the receipt for proof\./g)?.length, 2);
});

test("T53-W17 P2: Mark paid has no window.confirm; the dialog's one is the exact remove line", () => {
  assert.equal(view().match(/window\.confirm\(/g)?.length, 2, "delete expense and undo");
  const src = dialog();
  assert.equal(src.match(/window\.confirm\(/g)?.length, 1);
  assert.ok(src.includes('window.confirm("Remove this proof for everyone?")'));
});

test("T53-W18 P9: Payments made sits right under Settle up in the left column, as a move, and hides when empty", () => {
  const src = view();
  const settle = src.indexOf('id="settle-title"');
  const paid = src.indexOf('id="paid-title"');
  const balance = src.indexOf('id="balance-title"');
  assert.ok(settle !== -1 && settle < paid && paid < balance, "settle, then paid, then balances");
  const rightColumn = src.indexOf('<div className="flex flex-col gap-5">', settle);
  assert.ok(paid < rightColumn, "both sit in the left column");
  assert.doesNotMatch(src, /\border-(\d|first|last)/, "a move, not an order- class");
  assert.match(src, /wallet\.settlements\.length > 0 && \([\s\S]{0,120}aria-labelledby="paid-title"/);
});

test("T53-W19 P19: one always-rendered notice area directly under the heading, and every settle result goes there", () => {
  const src = view();
  assert.match(
    src,
    /<SectionTitle id="settle-title"[^>]*tabIndex=\{-1\}[^>]*>\s*Settle up\s*<\/SectionTitle>\s*<NoticeArea notice=\{settleNotice\} className="[^"]*empty:-m/,
    "next element after the heading, outside any condition, cancelling its gap while empty",
  );
  assert.match(src, /setSettleNotice\(/);
  assert.match(src, /write\("settle undo"[\s\S]{0,160}"Payment undone\."[\s\S]{0,40}[sS]ettle/, "Payment undone. goes to the settle area");
  const title = read("src/components/pixel/SectionTitle.tsx");
  assert.match(title, /tabIndex=\{tabIndex\}/, "SectionTitle passes tabIndex on");
});

test("T53-W29 review M1: a saved copy never replaces the wallet on screen, whether or not a dialog is open", async () => {
  // TG-65 moved the rule into wallet.ts's afterGet, with the overtaken check: the screen's answers all go through it
  assert.match(view(), /setLoad\(\(prev\) => afterGet\(prev, r, slug, overtaken, proofOpen\.current\)\);/);
  const { afterGet } = await import("./wallet.ts");
  const onScreen = { state: "ready" as const, wallet: { share_slug: SLUG } as unknown as Wallet };
  const saved = { ok: true as const, wallet: { share_slug: SLUG } as unknown as Wallet, saved: true };
  for (const dialog of [false, true]) assert.equal(afterGet(onScreen, saved, SLUG, false, dialog), onScreen, `dialog open: ${dialog}`);
});

test("T53-W30 ux review: a result from a Payments made row comes to the heading, like a saved one", () => {
  const src = view();
  assert.match(src, /Try again with signal\."[\s\S]{0,120}requestAnimationFrame\(toSettleUp\)/, "after Show proof fails");
  assert.match(src, /"Payment undone\.", setSettleNotice\)\.then\(\(\) => requestAnimationFrame\(toSettleUp\)\)/, "after Undo, worked or not");
  assert.match(src, /<SectionTitle id="settle-title" tabIndex=\{-1\} className="focus-pixel">/, "the square ring, not the browser's thin one");
});

const DIALOG_COPY = [
  "Mark as paid",
  "Marked as paid",
  "Add proof",
  "Change proof",
  "Your screenshot",
  "Add screenshot",
  "Save proof",
  "Saving...",
  "Everyone with this wallet link can see it. Crop out your balance first. Deleted 14 days after the trip or after you add it, whichever is later.",
  "Marked as paid, but the screenshot didn't upload. Check your signal and try again.",
  "The screenshot didn't upload. Check your signal and try again.",
  "The amounts changed while this was open. Close this and check Settle up.",
  // Rev 3, tg-ux's confirmation
  "This payment was undone. Close this and check Settle up.",
  "The screenshot didn't upload. Your old proof is still there. Check your signal and try again.",
  "The proof wasn't removed. Try again in a minute.",
  "Replace it with a new screenshot, or remove it.",
  "Your new screenshot",
  "Removing...",
];
const RESULT_COPY = [
  "Marked as paid.",
  "Marked as paid, with proof.",
  "Proof added.",
  "Proof changed.",
  "Proof removed.",
  "Payment undone.",
  "Proof deleted.",
  "Couldn't open that proof. Try again with signal.",
];

test("T53-W20 the copy is ux.md's, and nothing says verified", () => {
  const box = dialog();
  const screens = view() + box;
  for (const text of DIALOG_COPY) assert.ok(box.includes(text), `ProofDialog.tsx: ${text}`);
  for (const text of RESULT_COPY) assert.ok(screens.includes(text), `WalletView.tsx or its dialog: ${text}`);
  assert.doesNotMatch(screens, /Deleted 14 days after you add it\./, "owner decision 3 replaced this line");
  assert.doesNotMatch(screens, /Open it once with signal to keep it/, "proofs never open offline");
  assert.doesNotMatch(box, /verified|confirmed/i, "the app stores a picture, it doesn't read it");
  for (const line of view().split("\n").filter((l) => /proof/i.test(l))) {
    assert.doesNotMatch(line, /verified|confirmed/i, line);
  }
});

test("T53-W21 Undo says the proof goes too, only when there is one", () => {
  const src = view();
  assert.match(
    src,
    /(has_proof|=== "kept")[\s\S]{0,60}\?\s*"Undo this payment\? It goes back on the settle-up list, and its proof is deleted for everyone\."\s*:\s*"Undo this payment\? It goes back on the settle-up list\."/,
  );
});

test("T53-W22 the dialog follows WorldSheet: native, Close first, no backdrop close, one alert box", () => {
  const src = dialog();
  assert.match(src, /^"use client";/);
  const tag = src.match(/<dialog\b[^]*?>\n/)?.[0] ?? "";
  assert.ok(tag, "a native <dialog>");
  assert.doesNotMatch(tag, /onClick/, "tapping the backdrop would lose a chosen picture");
  assert.match(src, /\.showModal\(\)/);
  assert.match(src, /<DialogBox\b/);
  const close = src.search(/>\s*Close\s*</);
  const title = src.search(/<SectionTitle\b|<h2\b/);
  assert.ok(close !== -1 && title !== -1 && close < title, "Close comes first in the DOM, so showModal() focuses it");
  assert.doesNotMatch(src, /\bcapture\b/, "phones open the gallery, not the camera");
  assert.match(src, /accept=\{ACCEPT\}/);
  assert.match(src, /picked\([^)]*,\s*fitPhoto\)/, "every proof is redrawn, so metadata goes");
  assert.match(src, /if \(holding\.current \|\| fitting\) return;/, "a tap during the redraw would record the payment with no proof");
  const files = read("src/components/TripFiles.tsx");
  assert.match(files, /export const ACCEPT\b/);
  assert.match(files, /export async function picked\([^\n]*\bfit\b[^\n]*=\s*fitForUpload/, "fit defaults to fitForUpload, so tickets don't change");
  assert.equal(src.match(/tone="alertText"/g)?.length, 1, "one alert box");
  assert.match(src, /<PixelBox\b[^>]*tone="alertText"[^>]*>\s*\{problem\}\s*<\/PixelBox>/);
});

test("T53-W24 P11: rows load no proof; only Show proof fetches one", () => {
  const src = view();
  assert.equal(src.match(/fetchProof\(/g)?.length, 1, "one fetch, in the Show proof handler");
  assert.doesNotMatch(src, /BlobImage/, "no thumbnails on rows");
  assert.doesNotMatch(dialog(), /fetchProof\(/, "the dialog doesn't show the current proof");
});

test("T53-W25 each row's buttons say which payment they're for", () => {
  const src = view();
  assert.match(src, /<p className=\{PX\.meta\}>Proof deleted\.<\/p>/, "the swept line is PX.meta");
  for (const name of ["Show proof for", "Add proof for", "Change proof for"]) {
    assert.ok(src.includes(name), name);
  }
  assert.match(src, /aria-label=\{`Undo \$\{/);
});

test("T53-W26 the two 404s: Proof not found is spelled the same on both sides, and neither shows the wallet-link line", () => {
  const src = dialog();
  assert.ok(src.includes('"Proof not found"'), "ProofDialog.tsx");
  assert.ok(read("../api/app/wallet_proofs.py").includes('"Proof not found"'), "wallet_proofs.py");
  for (const m of src.matchAll(/not_found/g)) {
    assert.doesNotMatch(src.slice(m.index, m.index + 200), /failureMessage\(/, "failureMessage would say the wallet link doesn't work");
  }
});

test("T53-W27 change mode: its own copy, and Remove proof only shows behind a condition", () => {
  const src = dialog();
  for (const text of ["Choose new screenshot", "Your new screenshot", "Removing..."]) assert.ok(src.includes(text), text);
  assert.match(src, /(&&|\?|:)\s*\(?\s*<PixelButton\b[^]{0,240}(Remove proof|Removing\.\.\.)/);
});
