// TG-75 the game-style Ask Kaloy chat behind NEXT_PUBLIC_CHAT_GAME_UI (owner 2026-11-23: "looks like a plain form"):
// the flag's wiring, the words, the poses and every state of today's chat, read from the source in the style of
// planChat.test.ts and kaloy.test.ts. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { PRIVACY_LINE } from "./chat.ts";
import { KALOY_CHAT, alertPose } from "./kaloy.ts";

const WEB = new URL("../../", import.meta.url);
const read = (path: string) => {
  assert.ok(existsSync(new URL(path, WEB)), `${path} exists`);
  return readFileSync(new URL(path, WEB), "utf8");
};
const between = (src: string, from: string, to: string) => {
  const i = src.indexOf(from);
  assert.ok(i >= 0, `found ${from}`);
  const j = src.indexOf(to, i + from.length);
  return src.slice(i, j < 0 ? undefined : j);
};
const game = () => read("src/components/KaloyChat.tsx");
const plan = () => read("src/components/PlanChat.tsx");

test("T75-G2 PlanChat keeps the state and hands it to KaloyChat only with Kaloy and the flag on; off, the form is today's", () => {
  const src = plan();
  assert.match(src, /const gameUi = kaloy && flags\.chatGameUi;/, "needs Kaloy: the game chat is his");
  const branch = between(src, "if (gameUi) {", "\n  return (\n    <dialog");
  assert.match(branch, /<KaloyChat dialogRef=\{dialog\} endRef=\{end\} fieldId=\{fieldId\}/, "the same dialog ref, so showModal and focus moves work");
  for (const prop of ["log={log}", "onDraft={setDraft}", "holding={!!proposal}", "off={off}", "waiting={waiting}", "status={editor.status}", "cheer={cheer}",
    "lastAsked={lastAsked}", "lastApplied={lastApplied}", "newestBot={newestBot}", "onClose={onClose}", "onSend={(text, again) => void send(text, again)}",
    "onApply={onApply}", "onNotThis={onNotThis}", "onClear={onClear}", "onNeedLink={onNeedLink}"]) {
    assert.ok(branch.includes(prop), prop);
  }
  // the branch comes after every hook, so both looks run the same hooks in the same order
  assert.ok(src.indexOf("if (gameUi) {") > src.lastIndexOf("useEffect("), "after the last hook");
  assert.ok(src.indexOf("if (gameUi) {") > src.lastIndexOf("useRef("), "after the last ref");
  // today's form is still drawn, word for word, when the flag is off
  const form = src.slice(src.indexOf("\n  return (\n    <dialog"));
  assert.match(form, /<label htmlFor=\{fieldId\} className="text-sm font-semibold">Message<\/label>/);
  assert.match(form, /<p className=\{PX\.meta\}>\{PRIVACY_LINE\}<\/p>/);
  assert.match(form, /\{kaloy \? KALOY_WORDS\.ask : <>Ask the chatbot<\/>\}/);
});

test("T75-G3 the game chat is still the chat's native dialog: a polite log, the same size, a labelled field, Close", () => {
  const src = game();
  assert.match(src, /^"use client";/);
  assert.match(src, /<dialog ref=\{dialogRef\} aria-label=\{KALOY_WORDS\.ask\}/);
  assert.match(src, /onClose=\{\(e\) => e\.target === e\.currentTarget && p\.onClose\(\)\}/, "Esc closes it through the dialog's own close");
  assert.match(src, /w-\[min\(28rem,calc\(100%-2rem\)\)\]/);
  assert.match(src, /h-\[calc\(100dvh-2rem\)\]/);
  assert.match(src, /role="log" aria-live="polite"/);
  assert.match(src, /<SectionTitle>\{KALOY_WORDS\.ask\}<\/SectionTitle>/, "a heading, not a bare line");
  assert.match(src, />Close</);
  assert.match(src, /<label htmlFor=\{p\.fieldId\} className="sr-only">Message<\/label>/, "the field keeps its name for screen readers");
  assert.match(src, /<textarea id=\{p\.fieldId\}/);
  assert.match(src, /maxLength=\{MAX_TEXT\}/);
  assert.match(src, /e\.key === "Enter" && !e\.shiftKey && !e\.nativeEvent\.isComposing/, "Enter sends, Shift+Enter and composing don't");
  assert.match(src, /<div ref=\{endRef\} \/>/, "the log still scrolls to its end");
});

test("T75-G4 who said it is in words: Kaloy's name in each bubble, You: before yours for screen readers; tails are paint", () => {
  const src = game();
  assert.match(src, /<p className=\{cx\(PX\.meta, "font-bold"\)\}>\{KALOY_WORDS\.name\}<\/p>/);
  assert.match(src, /<span className="sr-only">\{KALOY_CHAT\.you\} <\/span>/);
  assert.match(src, /e\.kind === "user" \? \(\s*<p key=\{i\} className="pixel-frame relative mr-6 max-w-\[85%\] self-end bg-accent [^"]*text-accent-ink/);
  assert.match(between(src, "function Tail(", "\n}\n"), /<svg aria-hidden="true"/);
  assert.match(between(src, "function KaloySays(", "\n}\n"), /<KaloySprite pose=\{pose\} \/>/, "his sprite, decorative (Kaloy.tsx)");
});

test("T75-G5 every state of today's chat: greeting, thinking, proposal, applied, declined, pin ask, limits, no fit, offline, clash", () => {
  const src = game();
  const empty = between(src, "{log.length === 0 && (", "{log.map(");
  assert.match(empty, /<KaloyGreeting \/>/);
  assert.match(empty, /\{KALOY_WORDS\.howTo\}/);
  assert.equal(src.match(/<KaloyGreeting\b/g)?.length, 1);
  assert.doesNotMatch(src, /KALOY_WORDS\.greeting|kaloyGreeting/, "the greeting's words live in Kaloy.tsx only");
  assert.match(src, /\{sending && \(\s*<KaloySays pose="think">\s*<p className="text-sm">\{KALOY_WORDS\.thinking\}<\/p>/);
  assert.match(src, /Proposed change/);
  assert.match(src, /<ChangeList lines=\{e\.changes\} \/>/);
  assert.match(src, /\{e\.proposal === "open" && p\.holding \? \(/);
  assert.match(src, /aria-disabled=\{p\.off \|\| undefined\} onClick=\{p\.onApply\}/);
  assert.match(src, /\{applying \? "Applying\.\.\." : "Apply"\}/);
  assert.match(src, />\s*Not this\s*</);
  assert.match(src, /<p tabIndex=\{-1\} className=\{PX\.meta\} data-chat-focus=\{i === p\.lastApplied \? "applied" : undefined\}>\{APPLIED\}<\/p>/);
  assert.match(src, /\{NOT_APPLIED\}/);
  assert.match(src, /needLinkLine\(e\.needLink\.name\)/);
  assert.match(src, />\s*Paste a Google Maps link\s*</);
  assert.match(src, /p\.onNeedLink\(e\.needLink!\)/);
  assert.match(src, /<ChatAlert lines=\{\[e\.text \|\| NO_FIT\]\}/, "no_fit is said once, as the state it is");
  assert.match(src, /\{!online && <ChatAlert lines=\{chatFailureLines\(\{ why: "offline" \}\) \?\? \[\]\} pose="sad" \/>\}/);
  assert.match(src, /data-chat-focus="again" onClick=\{\(\) => p\.onSend\(p\.lastAsked!, true\)\}/);
  assert.match(src, />\s*Ask again\s*</);
  assert.match(src, /\{log\.length > 0 && \(/);
  assert.match(src, />Clear this chat</);
  assert.match(src, /role="status"[^>]*>\{p\.waiting \? <SaidText said=\{p\.status\} \/> : ""\}/, "a chat Apply's waiting line (ux.md §3.3)");
  assert.equal(src.match(/tone="alertText"/g)?.length, 1, "one alert box for every chat state (palette W1 registers it)");
});

test("T75-G6 one Red button, aria-disabled never disabled, Send waits offline and while a message is out", () => {
  const src = game();
  assert.match(src, /variant=\{p\.holding \? "secondary" : "primary"\}/, "Send gives way while Apply shows (UX review S3)");
  assert.equal(src.match(/variant="primary"/g)?.length, 1, "Apply is the only fixed Red button");
  assert.match(src, /aria-disabled=\{!online \|\| sending \|\| undefined\}>[\s\S]{0,200}?\{!sending && <MenuCursor [^>]*\/>\}\s*\{sending \? "Sending\.\.\." : "Send"\}/);
  assert.doesNotMatch(src, /(?<![-\w])disabled=\{/, "aria-disabled keeps focus (guide §10)");
});

test("T75-G7 the game chat only draws: no fetch, no storage, no save, no motion", () => {
  const src = game();
  assert.doesNotMatch(src, /\bfetch\(|localStorage|chatStorage|saveLog|savePlan|tripApi|setLog|addEntry/);
  assert.doesNotMatch(src, /animate-|transition|@keyframes|setInterval|setTimeout|duration-/, "no typing out (guide §6), nothing that moves");
});

test("T75-G8 logs: a fixed tag and codes only, never the chat's words", () => {
  const logs = [...game().matchAll(/console\.(?:info|warn|error)\(([^;]*)\);/g)].map((m) => m[1]);
  assert.deepEqual(logs, ['"[tg-kaloy] chat ui=game"', '"[tg-trip] chat pin-ask open at=%s", at ? Object.keys(at)[0] : "none"']);
  assert.match(game(), /useEffect\(\(\) => \{\s*console\.info\("\[tg-kaloy\] chat ui=game"\);[^}]*\}, \[\]\);/, "once per open, not per render");
});

test("T75-G9 the short privacy line still says the chat stays on this phone and messages go to an AI service", () => {
  assert.deepEqual(KALOY_CHAT, {
    you: "You:",
    placeholder: "Message Kaloy",
    privacy: "This chat stays on this phone. To answer, your messages and the plan go to an AI service.",
  });
  assert.match(KALOY_CHAT.privacy, /on this phone/);
  assert.match(KALOY_CHAT.privacy, /AI service/);
  assert.ok(KALOY_CHAT.privacy.length < PRIVACY_LINE.length, "shorter than today's line");
  assert.match(game(), /<p className=\{PX\.meta\}>\{KALOY_CHAT\.privacy\}<\/p>/);
  assert.match(game(), /placeholder=\{KALOY_CHAT\.placeholder\}/);
  assert.doesNotMatch(JSON.stringify(KALOY_CHAT), /…/, "three ASCII dots, never an ellipsis character");
});

test("T75-G10 alertPose: sad while the box is the newest line, idle once it isn't or while a message is out", () => {
  assert.equal(alertPose({ newest: true, sending: false }), "sad");
  assert.equal(alertPose({ newest: false, sending: false }), "idle");
  assert.equal(alertPose({ newest: true, sending: true }), "idle", "the thinking line thinks");
  const src = game();
  assert.equal(src.match(/pose=\{alertPose\(\{ newest: i === log\.length - 1, sending \}\)\}/g)?.length, 2, "an alert and a no-fit reply");
  assert.match(src, /pose=\{replyPose\(\{ index: i, newest: p\.newestBot, sending, cheer: p\.cheer \}\)\}/, "replies keep TG-75's poses");
});
