// TG-70 O3 (plan Rev 3 §3 O3; test-plan §5 U1 to U15; ux.md): the queue on Save, the Waiting for signal box, the
// sender on any open page. The web has no component runner, so these are source checks (each reads only its own
// function: a top-level one ends at "\n}\n", a nested one at "\n  }\n"), with the CDP E2E behind them. Made-up names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const WEB = new URL("../../", import.meta.url);
const read = (p: string) => {
  const url = new URL(p, WEB);
  assert.ok(existsSync(url), `${p} exists`);
  return readFileSync(url, "utf8").replaceAll("&apos;", "'");
};
const slice = (src: string, start: string, end: string) => {
  const i = src.indexOf(start);
  assert.ok(i >= 0, `${start} is in the source`);
  const j = src.indexOf(end, i);
  assert.ok(j > i, `${start} ends`);
  return src.slice(i, j);
};
const inner = (src: string, start: string) => slice(src, start, "\n  }\n");

const view = () => read("src/components/WalletView.tsx");
const list = () => read("src/components/wallet/WaitingList.tsx");
const runnerTsx = () => read("src/components/OutboxRunner.tsx");
const form = () => read("src/components/wallet/ExpenseForm.tsx");

// ---------------------------------------------------------------- L14 (O3's, the manager): the flag gate

test("T70-L14 screenParts: outbox is NEXT_PUBLIC_OFFLINE_EXPENSES and WALLET_SPLITS, all four ways", async () => {
  const { screenParts } = (await import("./walletView.ts")) as unknown as { screenParts: (f: Record<string, boolean>) => Record<string, boolean> };
  const base = { walletSplits: false, walletMultiPayer: false, walletActivity: false };
  for (const [offlineExpenses, walletSplits, want] of [[false, false, false], [true, false, false], [false, true, false], [true, true, true]]) {
    assert.equal(screenParts({ ...base, walletSplits, offlineExpenses }).outbox, want, `offline=${offlineExpenses} splits=${walletSplits}`);
  }
  assert.equal(screenParts(base).outbox, false, "a flag left out is off");
});

// ---------------------------------------------------------------- U1: the runner, on every page

test("T70-U1 OutboxRunner is mounted next to ServiceWorkerManager, renders nothing, and only wires events and the timer", () => {
  const layout = read("src/app/layout.tsx");
  assert.match(layout, /import OutboxRunner from "@\/components\/OutboxRunner";/);
  assert.match(layout, /<OutboxRunner \/>\n\s+<ServiceWorkerManager \/>/, "next to it; the manager stays last (S1)");
  const src = runnerTsx();
  assert.match(src, /^"use client";/);
  assert.match(src, /return null;\n\}\n/, "renders nothing");
  assert.match(src, /outboxRunner\(\{\s*store: outbox,\s*send: walletApi\.addExpense,\s*onLine: \(\) => navigator\.onLine,\s*now: Date\.now,/);
  assert.match(src, /new CustomEvent\(OUTBOX_EVENT, \{ detail: e \}\)/);
  assert.match(src, /addEventListener\("online", onOnline\)/);
  assert.match(src, /document\.visibilityState === "visible"/);
  assert.match(src, /addEventListener\(OUTBOX_KICK, onKick\)/, "a Save that queued arms the timer");
  assert.match(src, /window\.addEventListener\(OUTBOX_KICK, onKick\);\n\s+void go\(true\);/, "the mount itself is a trigger (S1), not only online");
  assert.match(src, /clearTimeout\(timer\)/);
  assert.match(src, /setTimeout\(\(\) => void go\(false\), next\)/, "the timer is the only non-trigger run");
});

test("T70-U1b B24: the runner never reads the flag, sends one at a time, and uses O2's afterSend and due", () => {
  const lib = read("src/lib/outboxRunner.ts");
  for (const src of [runnerTsx(), lib]) {
    assert.doesNotMatch(src, /offlineExpenses|from "@\/lib\/flags"|from "\.\/flags/, "the runner drains even with the flag off");
    assert.doesNotMatch(src, /Promise\.all|Promise\.allSettled/, "one at a time");
  }
  assert.match(lib, /import \{[^}]*\bafterSend\b[^}]*\bdue\b[^}]*\} from "\.\/outbox\.ts";/);
  assert.doesNotMatch(lib, /export type (Queued|QueuedBody|SendOutcome|Try)\b/, "O2's types are imported, never redefined");
});

// ---------------------------------------------------------------- U2, U3, U13: the queue on Save

const submit = () => inner(view(), "async function submitExpense(");

test("T70-U2 an add with the flag effective gets an id and 15 s; an edit never does", () => {
  const fn = submit();
  const edit = fn.indexOf("if (ctx.edit) return editing ? saveEdit(editing, body as ExpensePatch) : false;");
  const id = fn.indexOf('const id = parts.outbox && "mode" in body ? newExpenseId() : null;');
  assert.ok(edit > 0 && id > edit, "the edit returns before any id is made");
  assert.match(fn, /const sent = id \? \(\{ \.\.\.\(body as ExpenseBodyV2\), id \} as QueuedBody\) : null;/, "the id goes on the body that's sent and kept");
  assert.match(fn, /const startOnline = navigator\.onLine;\n\s+const r = sent \? await walletApi\.addExpense\(slug, sent, \{ timeoutMs: SEND_TIMEOUT_MS \}\) : await walletApi\.addExpense\(slug, body\);/);
  assert.doesNotMatch(inner(view(), "async function saveEdit("), /newExpenseId|timeoutMs/);
});

test("T70-U13 B24: with the flag off the add is today's call, byte for byte: no id, no option, no queue", () => {
  const fn = submit();
  assert.match(fn, /: await walletApi\.addExpense\(slug, body\);/);
  assert.match(fn, /if \(sent && !r\.ok && shouldQueue\(r\) && \(await queueAdd\(sent, r, startOnline\)\)\) return true;/, "queued only with an id");
  assert.equal(view().split("queueAdd(").length - 1, 2, "one definition, one call");
});

test("T70-U2b shouldQueue's answer is kept: queuedRow with D1's online at the start and end, then the box says QUEUED", () => {
  const fn = inner(view(), "async function queueAdd(");
  assert.match(fn, /queuedRow\(slug, sent, r, \{ now: Date\.now\(\), online: \{ start: startOnline, end: navigator\.onLine \} \}\)/);
  assert.match(fn, /try \{\n\s+await outbox\.queue\(row\);\n\s+\} catch \{/);
  assert.match(fn, /box\.say\(QUEUED\);/, "in the box's own live region");
  assert.match(fn, /getElementById\("waiting-title"\)\?\.focus\(\)/);
  assert.match(fn, /window\.dispatchEvent\(new Event\(OUTBOX_KICK\)\)/, "the runner arms its timer");
  assert.ok(fn.indexOf("await outbox.queue(row)") < fn.indexOf("box.say(QUEUED)"), "QUEUED only once it's kept");
});

test("T70-U3 B23: a put that throws isn't queued: today's path runs on, with the form kept", () => {
  const fn = inner(view(), "async function queueAdd(");
  assert.match(fn, /\} catch \{\n\s+console\.info\("\[tg-outbox\] save queued=no"\);\n\s+return false;\n\s+\}/);
  const s = submit();
  assert.ok(s.indexOf("await queueAdd(") < s.indexOf("const lineAlert = r.ok ? null : await lineRefusal(r, body);"), "then today's handling");
  assert.ok(s.indexOf("const out = addOutcome(before, body, r);") > 0, "addOutcome unchanged (U4)");
});

test("T70-U2c ux rule: no outbox line ever goes through the page-top notice or Settle up's notice", () => {
  const src = view() + list();
  assert.doesNotMatch(src, /set(Settle)?Notice\(\{ text: (QUEUED|REMOVED|FORM_BUSY|OFFLINE_CUE)/);
  assert.doesNotMatch(src, /set(Settle)?Notice\([^)]*sentLines/);
});

// ---------------------------------------------------------------- U5, U6: the Waiting box

test("T70-U5 the box: its title (count), intro, where-note, its own live region, this wallet's rows", () => {
  const src = list();
  assert.match(src, /<SectionTitle id="waiting-title" tabIndex=\{-1\} className="focus-pixel">\s*\{boxTitle\(box\.rows\.length\)\}\s*<\/SectionTitle>/);
  assert.match(src, /<p className=\{PX\.meta\}>\{BOX_INTRO\}<\/p>\s*<p className=\{PX\.meta\}>\{WHERE_NOTE\}<\/p>/, "B10b: the where-note, always");
  assert.match(src, /<div aria-live="polite"[^>]*>\s*\{box\.lines\.map\(/);
  assert.match(src, /outbox\.list\(\)\.then\(\n\s+\(all\) => \{\n\s+setRows\(forWallet\(all, slug\)\);/, "waiting and failed rows, oldest first");
  assert.match(src, /paidBy\(q\.body, members\)/);
  assert.match(src, /savedAt\(q\.savedAt, box\.now\)/, "the time they were read, never Date.now() in render");
  assert.match(src, /\{q\.body\.note\.trim\(\) \|\| NO_NOTE\}/, "trimmed, as sentLines does");
  assert.match(src, /formatPeso\(q\.body\.amount_centavos\)/);
});

test("T70-U5b the chip: a label in the banner's accent, 2px frame, text-xs semibold; Sending... while in flight", () => {
  const src = list();
  assert.match(src, /<span className="border-2 border-frame bg-accent px-2 py-0\.5 text-xs font-semibold text-accent-ink">\s*\{box\.sending === q\.id \? CHIP_SENDING : CHIP_WAITING\}\s*<\/span>/);
});

test("T70-U5c a failed row: alertText with failedLine, MAYBE_LANDED when it may have landed, and Put it in the form", () => {
  const src = list();
  assert.match(src, /<PixelBox tone="alertText" className="flex flex-col gap-1 p-3 text-sm">\s*<p>\{failedLine\(q\)\}<\/p>\s*\{q\.mayHaveLanded && <p className=\{PX\.meta\}>\{MAYBE_LANDED\}<\/p>\}/);
  assert.match(src, /\{q\.state === "failed" && \(\s*<PixelButton variant="secondary" onClick=\{\(\) => onToForm\(q\)\}>\s*\{TO_FORM\}/, "only a failed row (secondary's skin is 44 px)");
  assert.match(src, /\{formBusy === q\.id && <p className="text-sm">\{FORM_BUSY\}<\/p>\}/, "on that card");
  assert.match(src, /<div className="flex flex-wrap gap-2">/, "the buttons wrap only when they must (320)");
});

test("T70-U6 Remove: aria-disabled while sending; the confirm asks removeAsk(q), Remove and Keep it; held while open", () => {
  const src = list();
  assert.match(src, /aria-disabled=\{box\.sending === q\.id \|\| undefined\}/);
  assert.match(src, /onClick=\{\(\) => box\.sending !== q\.id && ask\(q\.id\)\}/, "a tap while sending does nothing");
  const open = inner(src, "function ask(");
  assert.match(open, /outbox\.held\.add\(id\);/, "B20a: the runner skips it");
  const close = inner(src, "function keep(");
  assert.match(close, /outbox\.held\.delete\(id\);/);
  assert.match(src, /<p className="text-sm">\{removeAsk\(q\)\}<\/p>/);
  assert.match(src, /<PixelButton variant="primary" className="px-4 text-sm" onClick=\{\(\) => void remove\(q\.id\)\}>\s*\{REMOVE\}/);
  const rm = inner(src, "async function remove(");
  assert.match(rm, /await outbox\.remove\(id\);/);
  assert.match(rm, /outbox\.held\.delete\(id\);/);
  assert.match(rm, /box\.say\(REMOVED\);/);
});

test("T70-U5f no rows and no line: no box at all (ux §2: it shows only for this wallet's queued rows)", () => {
  const fn = slice(list(), "export default function WaitingList(", "\n}\n");
  const early = fn.indexOf("if (!box.rows.length && !box.lines.length) return null;");
  assert.ok(early > 0 && early < fn.indexOf("return ("), "before the box is drawn");
});

test("T70-U6b the confirm starts on Keep it, and Esc is Keep it (ux §2:75): a stray Enter never removes", () => {
  const src = list();
  assert.match(src, /<div className="flex flex-col gap-2" onKeyDown=\{\(e\) => \{\n\s+if \(e\.key === "Escape"\) keep\(q\.id\);\n\s+\}\}>/);
  assert.match(src, /<PixelButton variant="secondary" autoFocus onClick=\{\(\) => keep\(q\.id\)\}>\s*\{REMOVE_KEEP\}/);
  assert.doesNotMatch(src, /<PixelButton variant="primary"[^>]*autoFocus/, "never on Remove");
  const close = inner(src, "function keep(");
  assert.match(close, /getElementById\(`remove-\$\{id\}`\)\?\.focus\(\)/, "focus back on that row's Remove");
});

test("T70-U5d the box listens to the runner: Sending..., the wallet landed by the rev rule, the run's sent lines at its end", () => {
  const src = list();
  assert.match(src, /window\.addEventListener\(OUTBOX_EVENT, on\)/);
  assert.match(src, /if \(e\.outcome === "end"\) \{/);
  assert.match(src, /setLines\(sentLines\(run\.current, formatPeso\)\)/);
  assert.match(src, /if \(e\.slug !== slug\) return;/, "another wallet's sends say nothing here");
  assert.match(src, /if \(e\.outcome === "sending"\) return setSending\(e\.id\);/);
  assert.match(src, /if \(e\.wallet\) wallet\.current\(e\.wallet\);/, "landWallet: a lower rev never replaces the screen");
});

test("T70-U5e where it sits: the top of Expenses, above the first card, with the flag effective only", () => {
  const src = view();
  const exp = src.indexOf('<SectionTitle id="expenses-title"');
  const box = src.indexOf("{parts.outbox && <WaitingList");
  assert.ok(exp > 0 && box > exp && box < src.indexOf("{wallet.expenses.length === 0 ? (", exp), "between the title and the cards");
  assert.match(src, /const box = useOutbox\(slug, landWallet, parts\.outbox\);/);
});

// ---------------------------------------------------------------- U7: Put it in the form

test("T70-U7 Put it in the form: FORM_BUSY on a dirty form; else formFromBody, the line, a remount, then the amount", () => {
  const fn = inner(view(), "function toForm(");
  assert.match(fn, /if \(formDirty\) \{\n\s+console\.info\("\[tg-outbox\] to-form busy=yes"\);\n\s+return setFormBusy\(q\.id\);\n\s+\}/);
  assert.match(fn, /setFormStart\(\{ form: formFromBody\(q\.body, wallet\.members\), line: sentLine\(q\.body\) \}\);/);
  assert.match(fn, /setRefill\(q\.id\);/);
  assert.match(fn, /setFormKey\(\(k\) => k \+ 1\);/);
  assert.match(fn, /getElementById\("expense-amount"\)/);
  assert.doesNotMatch(fn, /outbox\.remove/, "the row stays until the new Save is sent or queued");
});

test("T70-U7b the refilled row leaves only after the new Save: ok, or queued again", () => {
  const s = submit();
  assert.ok(s.indexOf("void dropRefill();") > s.indexOf("landWallet(out.wallet);"), "after an ok add");
  assert.match(inner(view(), "async function queueAdd("), /void dropRefill\(\);/);
  const drop = inner(view(), "async function dropRefill(");
  assert.match(drop, /await outbox\.remove\(refill\)/);
  assert.equal(view().split("outbox.remove(").length - 1, 1, "nowhere else in WalletView");
});

test("T70-U7c ExpenseForm takes an optional start and onDirty; with neither it's today's form", () => {
  const src = form();
  assert.match(src, /start\?: \{ form: FormState; line: string \| null \};/);
  assert.match(src, /onDirty\?: \(dirty: boolean\) => void;/);
  assert.match(src, /useState<FormState>\(\(\) => \(editing \? formFromExpense\(editing\.expense, members\) : start\?\.form \?\? emptyForm\(me\)\)\)/);
  assert.match(src, /editing \? initialLine\(budget, editing\.expense\.budget_key, editing\.expense\.category \?\? null\) : start\?\.line \?\? null/);
  assert.match(src, /const typed = s\.amount\.trim\(\) !== "" \|\| s\.note\.trim\(\) !== "";\n\s+useEffect\(\(\) => \{\n\s+onDirty\?\.\(typed\);\n\s+\}, \[typed, onDirty\]\);/);
  const v = view();
  assert.match(v, /start=\{formStart \?\? undefined\}/);
  assert.match(v, /onDirty=\{parts\.outbox \? setFormDirty : undefined\}/);
});

// ---------------------------------------------------------------- U8, U9: the cue and Settle up

test("T70-U8 B10a: the cue sits right above Add only with the flag effective, offline, on an add; the label stays", () => {
  const src = view();
  assert.match(src, /\{parts\.outbox && !online && !editing && <p className=\{PX\.meta\}>\{OFFLINE_CUE\}<\/p>\}\n\s+<\/div>\n\s+\);/, "the last thing in the form's notice, which sits above the buttons");
  assert.equal(src.split("OFFLINE_CUE").length - 1, 2, "imported once, shown once");
  assert.match(form(), /\{busy \? "Saving\.\.\." : edit \? "Save changes" : "Add expense"\}/);
});

test("T70-U9 B22: Settle up's line right under its title, from this wallet's rows, failed ones counted", () => {
  const src = view();
  assert.match(src, /<SectionTitle id="settle-title" tabIndex=\{-1\} className="focus-pixel">Settle up<\/SectionTitle>\n\s+<NoticeArea notice=\{settleNotice\} className="flex flex-col empty:-mt-3" \/>\n\s+\{parts\.outbox && box\.rows\.length > 0 && <p className=\{PX\.meta\}>\{settleLine\(box\.rows\.length\)\}<\/p>\}/, "under the title and its notice area (T53-W19), above the transfers");
  assert.doesNotMatch(src, /box\.rows\.filter/, "waiting and failed both count");
});

test("T70-U10 the next write clears the box's lines (they stay until a reload or the next write)", () => {
  assert.match(submit(), /box\.clear\(\);/);
  assert.match(inner(view(), "async function write("), /box\.clear\(\);/);
});

// ---------------------------------------------------------------- U14: logs

test("T70-U14 the outbox's own logs carry counts, outcomes and why only: never a note, name, member or expense id", () => {
  for (const src of [list(), runnerTsx(), read("src/lib/outboxRunner.ts"), view()]) {
    for (const call of src.match(/console\.(info|warn|error|log)\([^;]*\);/g) ?? []) {
      if (!call.includes("tg-outbox")) continue;
      assert.doesNotMatch(call, /\.note|\.name|member|\.id\b|body\b|\bq\b|row\b/, call);
    }
  }
  assert.match(view(), /console\.info\("\[tg-outbox\] save queued=no"\)/);
});

// ---------------------------------------------------------------- found in REFACTOR (pJ): three small leaks

test("T70-U6c a confirm that's open when the box goes away doesn't keep its row held (the runner would skip it)", () => {
  const fn = slice(list(), "export default function WaitingList(", "\n}\n");
  const hold = fn.indexOf("useEffect(() => () => {");
  assert.ok(hold > 0 && hold < fn.indexOf("if (!box.rows.length && !box.lines.length) return null;"), "a hook, before the early return");
  assert.match(fn, /useEffect\(\(\) => \(\) => \{\n\s+if \(asking\) outbox\.held\.delete\(asking\);\n\s+\}, \[asking\]\);/);
});

test("T70-U1c one timer at a time: a run that ends clears any timer another run armed meanwhile", () => {
  assert.match(runnerTsx(), /if \(!stopped && next !== null\) \{\n\s+clearTimeout\(timer\);\n\s+timer = setTimeout\(\(\) => void go\(false\), next\);\n\s+\}/);
});

test("T70-U7d Put it in the form's expense isn't loaded again when the form closes after an edit", () => {
  const fn = inner(view(), "function closeForm(");
  assert.match(fn, /setFormStart\(null\);/);
  assert.match(fn, /setRefill\(null\);/, "the row stays a failed card, to put in the form again");
});

// ---------------------------------------------------------------- tg-ux2's O3 review (ux-review-O3.md)

test("T70-U16 M1: with the flag on, Activity's offline or 5xx read says ACTIVITY_OFFLINE, never the write's 'wasn't saved'", () => {
  const src = read("src/components/wallet/ActivityList.tsx");
  assert.match(src, /export const ACTIVITY_OFFLINE = "No signal, so Activity may be missing the newest changes\.";/);
  assert.match(src, /waitHere\?: boolean;/, "an optional prop: flag off, today's list (B24)");
  assert.match(src, /const readFailure = \(r: WalletFailed\) => \(waitHere && \(r\.why === "offline" \|\| r\.why === "server"\) \? ACTIVITY_OFFLINE : failureMessage\(r\)\);/);
  assert.equal(src.split("setFailed(readFailure(r))").length - 1, 2, "the first page and Older");
  assert.doesNotMatch(src, /setFailed\(failureMessage\(/);
  assert.match(view(), /<ActivityList slug=\{slug\} wallet=\{lineWallet\} online=\{online\} waitHere=\{parts\.outbox\} /);
});
