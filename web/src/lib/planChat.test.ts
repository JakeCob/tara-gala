// TG-61 PR 2: the chatbot's wiring on the trip page, read from the source in the style of planEditor.test.ts (no
// component runner yet). The pure parts are in chat.test.ts. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { FLAG_DEFAULTS } from "./flags.ts";

const WEB = new URL("../../", import.meta.url);
const read = (path: string) => {
  assert.ok(existsSync(new URL(path, WEB)), `${path} exists`);
  return readFileSync(new URL(path, WEB), "utf8");
};
const view = () => read("src/components/TripView.tsx");
const chat = () => read("src/components/PlanChat.tsx");
const between = (src: string, from: string, to: string) => {
  const i = src.indexOf(from);
  assert.ok(i >= 0, `found ${from}`);
  const j = src.indexOf(to, i + from.length);
  return src.slice(i, j < 0 ? undefined : j);
};

test("T61-P10 the chatbot is behind NEXT_PUBLIC_CHATBOT_LIVE, off by default, and only inside the plan editor", () => {
  assert.equal(FLAG_DEFAULTS.chatbotLive, false);
  assert.match(read("src/lib/flags.ts"), /chatbotLive: parseFlag\(process\.env\.NEXT_PUBLIC_CHATBOT_LIVE, FLAG_DEFAULTS\.chatbotLive\)/);
  const editor = between(view(), "const editor: PlanEditor | undefined = flags.planEditing && theGuide ? {", "} : undefined;");
  assert.match(editor, /chat: flags\.chatbotLive \? \{/, "no chat tools unless the flag is on, and never without the plan editor");
  assert.match(read("src/components/PlanEditor.ts"), /chat: ChatTools \| null;/);
  for (const file of ["src/components/ItineraryList.tsx", "src/components/ItineraryView.tsx"]) {
    assert.doesNotMatch(read(file), /PlanChat|Ask the chatbot/, `${file}: the /i/ page has no chatbot`);
  }
});

test("T61-P11 asking sends the plan on screen's own base, through tripApi.chat, and the answer is read by chatAnswer", () => {
  const editor = between(view(), "chat: flags.chatbotLive ? {", "} : null,");
  assert.match(editor, /tripApi\.chat\(slug, chatRequest\(baseOf\((\w+)\), /, "the base comes from the plan on screen as the question goes (review M1)");
  const trip = read("src/lib/trip.ts");
  assert.match(trip, /chat: \(slug: string, body: ChatIn\) => askChat\(`\$\{at\(slug\)\}\/plan\/chat`, body\)/);
  const ask = between(trip, "async function askChat(", "\n}\n");
  assert.match(ask, /method: "POST"/);
  assert.match(ask, /return \{ ok: false, why: "offline" \};/);
  assert.match(ask, /return chatAnswer\(res\.status, /, "one reader for every answer, tested in chat.ts");
});

test("T61-P12 Apply saves the proposal's own plan with the proposal's own base, as a chat version, through planWrite", () => {
  const editor = between(view(), "chat: flags.chatbotLive ? {", "} : null,");
  assert.match(editor, /planWrite\("plan-chat-apply", \(\) => tripApi\.savePlan\(slug, (\w+)\.base, \1\.stored, "chat"\), \{ kind: "chat" \}, null, "chat"\)/,
    "never the base of a newer plan: a stale proposal must get the server's 409, not be re-based (review M1)");
  assert.doesNotMatch(chat(), /savePlan|tripApi/, "the dialog only asks the page to save");
});

test("T61-P13 the chat dialog: native dialog, a polite log, the composer, the privacy line and the first message", () => {
  const src = chat();
  assert.match(src, /<dialog\b/);
  assert.match(src, /\.showModal\(\)/);
  assert.match(src, /role="log" aria-live="polite"/, "ux.md §12: the log is a polite live region that exists before it changes");
  assert.match(src, /w-\[min\(28rem,calc\(100%-2rem\)\)\]/);
  assert.match(src, /h-\[calc\(100dvh-2rem\)\]/);
  assert.match(src, />Ask the chatbot</);
  assert.match(src, />Close</);
  assert.match(src, /<label[^>]*>[\s\S]*?Message[\s\S]*?<\/label>|htmlFor=\{?["'`]?[\w-]*["'`]?\}?>\s*Message\s*</);
  assert.match(src, /\{PRIVACY_LINE\}/);
  assert.match(src, /\{FIRST_MESSAGE\}/);
  assert.match(src, /Sending\.\.\./);
  assert.match(src, /\{THINKING\}/);
  assert.doesNotMatch(src, /animate-|transition|@keyframes|setInterval/, "no typing animation (guide §6)");
  assert.doesNotMatch(src, /\bfetch\(/, "the dialog never talks to the server itself");
  assert.doesNotMatch(src, /localStorage/, "the log is stored only through chat.ts, which survives a throwing store");
  assert.match(src, /loadLog\(chatStorage\(\), /);
  assert.match(src, /saveLog\(chatStorage\(\), /);
});

test("T61-P14 the user's turns are framed on the right; the chatbot's are plain under a Chatbot label, never colour alone", () => {
  const src = chat();
  assert.match(src, /e\.kind === "user"/);
  assert.match(src, /pixel-frame[^"]*self-end|self-end[^"]*pixel-frame/);
  assert.match(src, />Chatbot</, "a meta label, so who said it doesn't rely on side or colour");
});

test("T61-P15 a proposal: the change lines, Apply and Not this; only the newest keeps its buttons; Apply waits like every save", () => {
  const src = chat();
  assert.match(src, /Proposed change/);
  assert.match(src, /<ChangeList lines=\{/, "the same change lines as the stop proposal (ux.md §4.4)");
  assert.match(src, /proposal === "open"/);
  assert.match(src, /\{NOT_APPLIED\}/);
  assert.match(src, />\s*Not this\s*</);
  assert.match(src, /const off = [^;]*!editor\.can/, "ux.md §3.3: the chat's Apply waits for the newest plan and any plan write");
  assert.match(src, /aria-disabled=\{off \|\| undefined\}/);
  assert.doesNotMatch(src, /(?<![-\w])disabled=\{/, "aria-disabled, never disabled, so focus stays (guide §10)");
  assert.match(src, /Applying\.\.\./);
  assert.match(src, /\{APPLIED\}/);
  assert.match(src, /role="status"[^>]*>\s*\{[^}]*editor\.status/, "a dialog that stays open after a save repeats the bar's line (ux.md §3.3)");
});

test("T61-P16 the states keep the composer: busy, cap, off, no signal, no fit, and a clash on Apply offers Ask again", () => {
  const src = chat();
  assert.match(src, /chatFailureLines\(/);
  assert.match(src, /\{NO_FIT\}|NO_FIT/);
  assert.match(src, /APPLY_CLASH/);
  assert.match(src, />\s*Ask again\s*</);
  assert.match(src, /aria-disabled=\{!online \|\| sending \|\| undefined\}/, "Send waits offline and while a message is out");
  assert.match(src, /role="alert"|alertText|PlanProblem/);
});

test("T61-P17 a place it can't pin: the app's line and Paste a Google Maps link, which closes the chat and opens the find step", () => {
  const src = chat();
  assert.match(src, /needLinkLine\(/);
  assert.match(src, />\s*Paste a Google Maps link\s*</);
  assert.match(src, /onNeedLink\(/);
  const map = read("src/components/LevelMap.tsx");
  assert.match(map, /onNeedLink=\{/);
  assert.match(read("src/components/StopChange.tsx"), /start: "menu" \| "find" \| "fit" \| "replace";/, "Replace's find step can be opened directly");
});

test("T61-P18 Clear this chat asks first, and only once the log has messages", () => {
  const src = chat();
  assert.match(src, />\s*Clear this chat\s*</);
  assert.match(src, /window\.confirm\(CLEAR_CONFIRM\)/);
  assert.match(src, /clearLog\(chatStorage\(\), /);
  assert.match(src, /log\.length > 0 && \(/);
});

test("T61-P19 Ask the chatbot: beside Add a stop to World N in edit mode, and on a stop's proposal with its place in the message", () => {
  const map = read("src/components/LevelMap.tsx");
  const add = between(map, "Add a stop to World {day.day}", "<nav ");
  assert.match(add, /\{editor\.chat && \(/);
  assert.match(add, />\s*Ask the chatbot\s*</);
  assert.match(map, /<PlanChat\b/);
  const input = read("src/components/PlaceInput.tsx");
  assert.match(input, /\{onAsk && \(/);
  assert.match(input, /onAsk\(askLine\(chosen\.name\)\)/, "ux.md §4.4: this stop and place already in the message, then sent");
  assert.match(input, />\s*Ask the chatbot\s*</);
});

test("T61-P20 logs: the action, outcomes and counts, never the chat's words, a name, a note, a place or a link", () => {
  for (const file of ["src/components/PlanChat.tsx", "src/components/TripView.tsx", "src/components/LevelMap.tsx", "src/components/PlaceInput.tsx", "src/lib/chat.ts"]) {
    const logs = [...read(file).matchAll(/console\.(?:info|warn|error)\(([^;]*)\);/g)].map((m) => m[1]);
    for (const args of logs) {
      assert.match(args, /^"\[tg-trip\] /, `${file}: ${args}`);
      const values = args.slice(args.indexOf('"', 1) + 1);
      assert.doesNotMatch(values, /\b(name|names|text|note|plan|typed|link|maps_url|lat|lng|label|item|query|changes|detail|reply|message|messages|said|log|place\.\w+)\b/, `${file}: ${args}`);
    }
  }
  const chatLogs = [...chat().matchAll(/console\.info\("\[tg-trip\] chat (\w+)/g)].map((m) => m[1]);
  for (const action of ["send", "answer", "apply", "clear"]) assert.ok(chatLogs.includes(action), `a [tg-trip] chat ${action} line`);
});
