// TG-50 story 5, ticket wallet tests. Run with `npm test` (node --test, Node 22.18+ type stripping).
// The helpers are pure; the IndexedDB store and the page are checked by source, and end to end in a browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MAX_TICKET_BYTES, MAX_TICKETS, addedLine, checkTicketFile, sortTickets, ticketLabel } from "./ticketWallet.ts";

const WEB = new URL("../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, WEB), "utf8");
const png = (size: number) => ({ type: "image/png", size });

test("W1 photos up to 10 MB pass; other types, empty files and big files get a plain reason", () => {
  for (const type of ["image/png", "image/jpeg", "image/webp", "image/gif"]) assert.deepEqual(checkTicketFile({ type, size: 1000 }, 0), { ok: true }, type);
  assert.deepEqual(checkTicketFile(png(MAX_TICKET_BYTES), 0), { ok: true }, "exactly 10 MB is fine");
  assert.equal(MAX_TICKET_BYTES, 10 * 1024 * 1024);
  const pdf = checkTicketFile({ type: "application/pdf", size: 1000 }, 0);
  assert.ok(!pdf.ok && /screenshot/i.test(pdf.message), "a PDF: take a screenshot");
  const heic = checkTicketFile({ type: "image/heic", size: 1000 }, 0);
  assert.ok(!heic.ok && /PNG, JPG or WebP/.test(heic.message), "HEIC only shows in Safari, so it's refused everywhere");
  const empty = checkTicketFile(png(0), 0);
  assert.ok(!empty.ok && /empty/i.test(empty.message));
  const big = checkTicketFile(png(MAX_TICKET_BYTES + 1), 0);
  assert.ok(!big.ok && /10 MB/.test(big.message));
});

test("W2 the wallet holds up to 20 tickets", () => {
  assert.equal(MAX_TICKETS, 20);
  assert.deepEqual(checkTicketFile(png(1000), MAX_TICKETS - 1), { ok: true });
  const full = checkTicketFile(png(1000), MAX_TICKETS);
  assert.ok(!full.ok && /up to 20/.test(full.message) && /Delete/.test(full.message));
});

test("W3 a ticket's label is its file name, tidied, never blank", () => {
  assert.equal(ticketLabel("ticket-VLIX00078671.png"), "ticket VLIX00078671");
  assert.equal(ticketLabel("IMG_2034.JPG"), "IMG 2034");
  assert.equal(ticketLabel("my.return.ticket.jpeg"), "my.return.ticket");
  assert.equal(ticketLabel(".png"), "Ticket");
  assert.equal(ticketLabel("   "), "Ticket");
  assert.equal(ticketLabel("x".repeat(100) + ".png").length, 60);
});

test("W4 newest first; the added line is the Manila date", () => {
  const list = [{ addedAt: "2026-10-30T01:00:00.000Z" }, { addedAt: "2026-10-31T01:00:00.000Z" }, { addedAt: "2026-10-29T01:00:00.000Z" }];
  assert.deepEqual(sortTickets(list).map((t) => t.addedAt.slice(8, 10)), ["31", "30", "29"]);
  assert.equal(list[0].addedAt.slice(8, 10), "30", "the input isn't sorted in place");
  assert.equal(addedLine("2026-10-31T17:30:00.000Z"), "Added Nov 1", "01:30 on Nov 1 in Manila");
  assert.equal(addedLine("2026-10-31T01:00:00.000Z"), "Added Oct 31");
});

test("W5 tickets never leave the phone: no network call in the wallet code, and its logs carry no label", () => {
  for (const path of ["src/lib/ticketWallet.ts", "src/lib/ticketStore.ts", "src/components/TicketWallet.tsx"]) {
    const src = read(path);
    assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest|sendBeacon|API_URL/, `${path}: no network`);
    for (const [, args] of src.matchAll(/console\.\w+\(([^;]*)\);/g)) {
      assert.doesNotMatch(args, /label|file\.name|fileName/, `${path}: a log names a ticket: ${args}`);
    }
  }
  const store = read("src/lib/ticketStore.ts");
  assert.match(store, /indexedDB\.open\("tara-gala-wallet", 1\)/);
  assert.match(store, /createObjectStore\("tickets", \{ keyPath: "id" \}\)/);
});

test("W6 /tickets: one shell, says where the photos live, and the service worker precaches it", () => {
  const page = read("src/app/tickets/page.tsx");
  assert.equal(page.match(/<PageShell>/g)?.length, 1);
  assert.match(page, /<PageTitle className="text-balance">My tickets<\/PageTitle>/);
  assert.match(page, /title: "My tickets · Tara Gala"/);
  assert.match(page, /only on this phone/i, "the privacy promise is on the page");
  assert.match(page, /<TicketWallet \/>/);
  const sw = read("public/sw.js");
  assert.match(sw, /const PRECACHE_PAGES = \["\/", "\/baguio", "\/plan", "\/tickets"\];/);
  assert.doesNotMatch(sw, /SW_VERSION = "2026-10-31\.1"/, "SW_VERSION bumped");
});

test("W7 the wallet: one primary button that opens a hidden picker of photos; full-screen view in a modal dialog", () => {
  const src = read("src/components/TicketWallet.tsx");
  assert.match(src, /^"use client";/);
  assert.equal(src.match(/variant="primary"/g)?.length, 1, "one primary per screen");
  const input = src.match(/<input\b[^>]*\/>/)?.[0] ?? "";
  assert.match(input, /type="file"/);
  assert.match(input, /accept="image\/png,image\/jpeg,image\/webp,image\/gif"/);
  assert.match(input, /\bmultiple\b/);
  assert.match(input, /\bhidden\b/, "the button is the control; the input stays out of the tab order");
  assert.match(src, /<dialog\b/);
  assert.match(src, /\.showModal\(\)/);
  assert.match(src, /wakeLock/, "the screen stays on while a ticket is shown at the gate");
  assert.match(src, /URL\.revokeObjectURL/, "object URLs are freed");
  assert.doesNotMatch(src, /focus:outline/, "T14");
  assert.match(src, /navigator\.storage\?\.persist/, "asks the browser not to evict the tickets");
});

test("W8 home: a My tickets quick action; four tiles make a 2 by 2 grid from lg", () => {
  const src = read("src/components/landing/QuickActions.tsx");
  const hrefs = [...src.matchAll(/<PixelCardLink\b[^>]*\bhref="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, ["#travel-date", "/plan", "/baguio", "/tickets"]);
  assert.match(src, /const cols = formMode\(flags\) !== "none" \? "lg:grid-cols-2" : "lg:grid-cols-3";/);
});
