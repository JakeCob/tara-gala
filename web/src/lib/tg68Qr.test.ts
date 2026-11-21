// TG-68 part 1 (ux.md §1, audit #3): "Show my QR" with no QR saved says why inside Settle up, with a way to My payout QR.
// Web has no component runner, so these are source checks; the 380 px screenshots show it on screen. Names are made up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const WEB = new URL("../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, WEB), "utf8").replaceAll("&apos;", "'");
const view = () => read("src/components/WalletView.tsx");
const fn = (src: string, start: string) => {
  const i = src.indexOf(start);
  assert.ok(i >= 0, `${start} is in the source`);
  const end = src.indexOf("\n  }\n", i);
  return src.slice(i, end > i ? end : undefined);
};
const MESSAGE = "You haven't added your payout QR on this phone yet. It's in My payout QR, near the end of this page.";

test("TG68-Q1 no QR: Show my QR puts ux §1's message in Settle up's notice (setSettleNotice), as an error, and logs it", () => {
  const show = fn(view(), "async function showMyQr(");
  assert.doesNotMatch(show, /setNotice\(/, "not the page-top notice: it's out of view");
  assert.match(show, /setSettleNotice\(/);
  assert.ok(show.includes(MESSAGE), "ux §1's text");
  assert.match(show, /error: true/);
  assert.match(show, /console\.info\("\[tg-wallet\] show-my-qr none=yes"\)/, "the log, with no names");
  assert.ok(!view().includes("Add your payout QR below first, then show it here."), "the old text is gone");
});

test("TG68-Q2 with a QR saved, Show my QR opens it as today", () => {
  assert.match(fn(view(), "async function showMyQr("), /setQr\(\{ blob: mine\.blob, label: "My payout QR" \}\)/);
});

test("TG68-Q3 the notice carries Go to My payout QR: a secondary button with the usual classes, under the text, in Settle up's area", () => {
  const src = view();
  const at = src.indexOf("Go to My payout QR");
  assert.ok(at > 0, "the button's label");
  assert.equal(src.split("Go to My payout QR").length - 1, 1, "one button");
  const button = src.slice(src.lastIndexOf("<PixelButton", at), at);
  assert.match(button, /variant="secondary"/);
  assert.match(button, /className="inline-flex items-center self-start px-4 text-sm"/);
  // It's drawn by the notice area, and only the settle box's notice asks for it
  const area = fn(src, "function NoticeArea(");
  assert.ok(area.includes("Go to My payout QR"), "NoticeArea draws it");
  assert.ok(area.indexOf("{notice.text}") < area.indexOf("Go to My payout QR"), "under the text");
});

test("TG68-Q4 Go to My payout QR scrolls the section's title to the top and focuses it; it never opens the file picker", () => {
  const src = view();
  const go = fn(src, "function toPayoutQr(");
  assert.match(go, /getElementById\("payout-title"\)/);
  assert.match(go, /scrollIntoView\(\{ block: "start" \}\)/);
  assert.match(go, /\.focus\(\{ preventScroll: true \}\)/);
  assert.doesNotMatch(go, /\.click\(\)|picker/, "no file picker");
  const title = read("src/components/PayoutQr.tsx").match(/<SectionTitle id="payout-title"[^>]*>/)?.[0] ?? "";
  assert.match(title, /tabIndex=\{-1\}/, "focusable from script only");
  assert.match(title, /className="focus-pixel"/, "with the focus ring");
});

test("TG68-Q5 it clears like the other settle notices, and when a QR is added (only the QR message)", () => {
  const src = view();
  assert.match(fn(src, "async function write("), /setSettleNotice\(null\)/, "any write clears it, as today");
  assert.match(src, /<PayoutQr onSaved=\{[^}]*setSettleNotice\(\(n\) => \(n\?\.toPayout \? null : n\)\)/, "adding a QR clears the QR message only");
  const qr = read("src/components/PayoutQr.tsx");
  assert.match(qr, /export default function PayoutQr\(\{ onSaved \}: \{ onSaved\?: \(\) => void \}\)/);
  const save = qr.slice(qr.indexOf("await savePayoutQr("), qr.indexOf("} catch (err)", qr.indexOf("await savePayoutQr(")));
  assert.match(save, /onSaved\?\.\(\);/, "after the save lands");
});
