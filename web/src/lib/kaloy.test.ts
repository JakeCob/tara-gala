// TG-75 Kaloy, the chatbot carabao: his words, the greeting's language, his poses, the title screen walk, and the
// wiring behind NEXT_PUBLIC_KALOY (read from the source, in the style of planChat.test.ts). Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { FIRST_MESSAGE, chatRequest, loadLog, saveLog, type Entry } from "./chat.ts";
import { FLAG_DEFAULTS, readFlags } from "./flags.ts";
import { KALOY_POSES, KALOY_WALK, KALOY_WORDS, greetingLang, kaloyGreeting, kaloySprite, replyPose } from "./kaloy.ts";
import { parseGrid } from "./pixelSvg.ts";
import { SPRITES, spriteSrc } from "./sprites.ts";
import { CHIBI_PX, STEP_PX, followerFrame, followerHomeX, homeX, startFollower, startWalkers, stepFollower, stepWalker, type Follower, type Walker } from "./titleWalk.ts";

const WEB = new URL("../../", import.meta.url);
const ROOT = new URL("../../../", import.meta.url);
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
const FIL = "Uy! Ako si Kaloy. Ano'ng gusto mong baguhin sa plan?";
const EN = "Hi, I'm Kaloy! What should we change in your plan?";

// ---- the words and the greeting's language ------------------------------------------------------------------------

test("TK1 greetingLang: Filipino or Tagalog phones get Filipino, everything else English", () => {
  const cases: [string | null | undefined, "fil" | "en"][] = [
    ["fil-PH", "fil"], ["fil", "fil"], ["FIL-ph", "fil"], ["tl", "fil"], ["tl-PH", "fil"], [" tl_PH ", "fil"],
    ["en-US", "en"], ["en-PH", "en"], ["en", "en"], ["es-ES", "en"], ["filler", "en"], ["tlh", "en"],
    ["", "en"], [undefined, "en"], [null, "en"],
  ];
  for (const [lang, want] of cases) assert.equal(greetingLang(lang), want, JSON.stringify(lang));
});

test("TK2 the owner's words, exactly", () => {
  assert.deepEqual(KALOY_WORDS, {
    name: "Kaloy",
    ask: "Ask Kaloy",
    thinking: "Kaloy is thinking...",
    howTo: `For example, "add merienda after Burnham Park" or "mas chill ang Day 2". I only use places on Tara Gala and ones your group added. Nothing changes until someone taps Apply.`,
    greeting: { fil: FIL, en: EN },
  });
  // Under his greeting: FIRST_MESSAGE's examples and Apply line, without its own "Kumusta! Tell me what to change"
  const rest = FIRST_MESSAGE.slice(FIRST_MESSAGE.indexOf('"add merienda'));
  assert.ok(KALOY_WORDS.howTo.endsWith(rest), "the same examples and the same Apply line");
  assert.doesNotMatch(KALOY_WORDS.howTo, /Kumusta|Hi\b|Uy\b/, "one hello per bubble");
  assert.equal(kaloyGreeting("fil-PH"), FIL);
  assert.equal(kaloyGreeting("tl"), FIL);
  assert.equal(kaloyGreeting("en-US"), EN);
  assert.equal(kaloyGreeting(""), EN);
  assert.equal(kaloyGreeting(undefined), EN);
  assert.doesNotMatch(JSON.stringify(KALOY_WORDS), /…/, "three ASCII dots, never an ellipsis character");
});

test("TK3 the greeting is display only: never in the chat log on the phone, never in the messages sent", () => {
  const base = { itinerary_slug: "x", seq: 1 };
  const greetings = Object.values(KALOY_WORDS.greeting);
  // An empty chat sends only the question
  assert.deepEqual(chatRequest(base, [], "hi", null).messages, [{ role: "user", text: "hi" }]);
  const log: Entry[] = [{ kind: "user", text: "hi" }, { kind: "bot", text: "Sure." }];
  const sent = JSON.stringify(chatRequest(base, log, "more", null));
  for (const g of greetings) assert.ok(!sent.includes(g), "the greeting is not a turn");
  // What's kept is only what the log holds
  const store = new Map<string, string>();
  const kept = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  assert.ok(saveLog(kept, "s", log));
  assert.deepEqual(loadLog(kept, "s"), log);
  for (const g of greetings) assert.ok(![...store.values()].some((v) => v.includes(g)));
  // The chat draws the greeting only while the log is empty, and never hands it to the log
  const chat = read("src/components/PlanChat.tsx");
  const empty = between(chat, "{log.length === 0 && (", "{log.map(");
  assert.match(empty, /\{kaloy && <KaloyGreeting \/>\}/);
  assert.equal(chat.match(/<KaloyGreeting\b/g)?.length, 1);
  assert.doesNotMatch(chat, /KALOY_WORDS\.greeting|kaloyGreeting/, "the words live in Kaloy.tsx only");
  const kaloy = read("src/components/Kaloy.tsx");
  assert.doesNotMatch(kaloy, /addEntry|setLog|saveLog|chatStorage|localStorage|tg-chat|fetch\(/, "Kaloy.tsx only draws");
});

test("TK4 the greeting reads the phone's language on the client only, and logs once per chat open", () => {
  const kaloy = read("src/components/Kaloy.tsx");
  assert.match(kaloy, /^"use client";/);
  assert.match(kaloy, /useSyncExternalStore\(subscribeLang, \(\) => navigator\.language, \(\) => ""\)/, "the server snapshot is stable");
  assert.match(kaloy, /addEventListener\("languagechange", onChange\)/);
  assert.match(kaloy, /const tag = lang \?\? phone;/, "TG-74's picker can pass the picked language");
  const logs = [...kaloy.matchAll(/console\.(?:info|warn|error)\(([^;]*)\);/g)].map((m) => m[1]);
  assert.deepEqual(logs, ['"[tg-kaloy] greeting lang=%s", said'], "one log line: the language only, never the words");
  assert.match(kaloy, /useEffect\(\(\) => \{\s*console\.info\("\[tg-kaloy\] greeting lang=%s", said\);[^}]*\}, \[said\]\);/, "in an effect, not per render");
});

// ---- the poses --------------------------------------------------------------------------------------------------------

test("TK5 replyPose: the newest reply talks, cheers right after an Apply, every other reply idles, all idle while sending", () => {
  assert.equal(replyPose({ index: 3, newest: 3, sending: false, cheer: false }), "talk");
  assert.equal(replyPose({ index: 3, newest: 3, sending: false, cheer: true }), "happy");
  assert.equal(replyPose({ index: 1, newest: 3, sending: false, cheer: true }), "idle");
  assert.equal(replyPose({ index: 1, newest: 3, sending: false, cheer: false }), "idle");
  assert.equal(replyPose({ index: 3, newest: 3, sending: true, cheer: false }), "idle", "the thinking line thinks");
  const chat = read("src/components/PlanChat.tsx");
  assert.match(chat, /pose=\{replyPose\(\{ index: i, newest: newestBot, sending, cheer \}\)\}/);
  assert.match(chat, /\{sending && \(\s*<KaloyBeside pose="think"/);
  assert.match(between(chat, "async function onApply()", "function onNotThis()"), /if \(out\.ok\) \{[^}]*setCheer\(true\);/);
  assert.match(between(chat, "async function send(", "const r = await chat.send("), /setCheer\(false\);/, "the next turn ends the cheer");
  assert.match(between(chat, "function onClear()", "function onSubmit("), /setCheer\(false\);/);
});

test("TK6 every pose and both walk frames are 32x32 SVG sprites; the walk frames differ from each other and from idle", () => {
  const names = [...KALOY_POSES.map(kaloySprite), ...KALOY_WALK];
  assert.deepEqual(names, ["kaloy-idle", "kaloy-talk", "kaloy-think", "kaloy-happy", "kaloy-sad", "kaloy-walk-1", "kaloy-walk-2"]);
  const rows = new Map<string, string>();
  for (const name of names) {
    assert.deepEqual(SPRITES[name], { w: 32, h: 32 }, name);
    assert.equal(spriteSrc(name), `/sprites/${name}.svg`);
    const grid = parseGrid(read(`sprites-src/${name}.txt`), name);
    rows.set(name, grid.rows.join("\n"));
  }
  // The art is the lead's: the poses may share a drawing, but the walk needs two different steps that aren't standing
  const [idle, one, two] = ["kaloy-idle", "kaloy-walk-1", "kaloy-walk-2"].map((n) => rows.get(n));
  assert.notEqual(one, two, "two different steps");
  assert.notEqual(one, idle, "walk-1 isn't standing");
  assert.notEqual(two, idle, "walk-2 isn't standing");
  for (const name of names) assert.match(rows.get(name)!, /S/, `${name}: the Sun salakot`);
});

// ---- the flag ---------------------------------------------------------------------------------------------------------

test("TK7 NEXT_PUBLIC_KALOY: default off, a literal read, documented in README section 7 and web/.env.example", () => {
  assert.equal(FLAG_DEFAULTS.kaloy, false);
  const before = process.env.NEXT_PUBLIC_KALOY;
  try {
    delete process.env.NEXT_PUBLIC_KALOY;
    assert.equal(readFlags().kaloy, false);
    process.env.NEXT_PUBLIC_KALOY = "true";
    assert.equal(readFlags().kaloy, true);
  } finally {
    if (before === undefined) delete process.env.NEXT_PUBLIC_KALOY;
    else process.env.NEXT_PUBLIC_KALOY = before;
  }
  assert.match(read("src/lib/flags.ts"), /kaloy: parseFlag\(process\.env\.NEXT_PUBLIC_KALOY, FLAG_DEFAULTS\.kaloy\)/);
  const readme = readFileSync(new URL("README.md", ROOT), "utf8");
  const row = readme.slice(readme.indexOf("## 7.")).split("\n").find((line) => line.includes("`NEXT_PUBLIC_KALOY`"));
  assert.ok(row, "README section 7 has a row for NEXT_PUBLIC_KALOY");
  assert.ok(row.includes("`false`"), "default false");
  assert.match(read(".env.example"), /^NEXT_PUBLIC_KALOY=false$/m);
});

test("TK8 flag off, every page is today's: Kaloy's helper is only its children, and every label keeps today's words", () => {
  const kaloy = read("src/components/Kaloy.tsx");
  assert.match(kaloy, /if \(!flags\.kaloy\) return children;/);
  const chat = read("src/components/PlanChat.tsx");
  assert.match(chat, /aria-label=\{kaloy \? KALOY_WORDS\.ask : "Ask the chatbot"\}/);
  assert.match(chat, /\{kaloy \? KALOY_WORDS\.ask : <>Ask the chatbot<\/>\}/);
  assert.equal(chat.match(/\{kaloy \? KALOY_WORDS\.name : <>Chatbot<\/>\}/g)?.length, 2, "the first message and every reply");
  assert.match(chat, /const kaloy = flags\.kaloy;/);
  for (const file of ["src/components/LevelMap.tsx", "src/components/PlaceInput.tsx"]) {
    assert.match(read(file), /\{flags\.kaloy \? <><KaloySprite pose="idle" className="-my-1 mr-2" \/>\{KALOY_WORDS\.ask\}<\/> : <>Ask the chatbot<\/>\}/, file);
  }
  assert.match(read("src/components/landing/TitleCast.tsx"), /\{flags\.kaloy && \(/);
  assert.match(read("src/components/landing/TitleCast.tsx"), /const kaloy = flags\.kaloy \? stepFollower\(/);
});

test("TK9 where Kaloy shows: sad by the no-trips box and the trip and wallet load errors, idle by the empty lists", () => {
  const sad: [string, string][] = [
    ["src/components/TripSearch.tsx", "{emptyMessage(searched.direction, searched.date, searched.city)}"],
    ["src/components/TripView.tsx", "this trip isn't saved on this phone yet"],
    ["src/components/WalletView.tsx", "this wallet isn't saved on this phone yet"],
  ];
  const idle: [string, string][] = [
    ["src/components/landing/PremadeTrips.tsx", "No ready-made trips on file yet."],
    ["src/components/PlanResults.tsx", "<SearchBusesBox message={props.emptyMessage ?? LIST.empty} />"],
    ["src/components/WalletHome.tsx", "AMBAGAN_WORDS.listEmpty"],
  ];
  for (const [file, text, pose] of [...sad.map(([f, t]) => [f, t, "sad"]), ...idle.map(([f, t]) => [f, t, "idle"])]) {
    const src = read(file);
    const i = src.indexOf(text);
    assert.ok(i >= 0, `${file}: ${text}`);
    const open = src.lastIndexOf("<KaloyBeside", i);
    assert.ok(open >= 0 && src.indexOf("</KaloyBeside>", open) > i, `${file}: wrapped in KaloyBeside`);
    assert.match(src.slice(open, i), new RegExp(`^<KaloyBeside pose="${pose}"`), `${file}: ${pose}`);
  }
});

test("TK10 Kaloy is decorative everywhere: alt=\"\" and aria-hidden, pixel-sharp at a whole multiple of the art", () => {
  const kaloy = read("src/components/Kaloy.tsx");
  const img = between(kaloy, "<img src={spriteSrc(kaloySprite(pose))}", "/>");
  assert.match(img, /alt=""/);
  assert.match(img, /aria-hidden="true"/);
  assert.match(img, /pixelated/);
  assert.match(kaloy, /size\?: 32 \| 64/);
  const cast = read("src/components/landing/TitleCast.tsx");
  assert.match(cast, /<img key=\{frame\} src=\{spriteSrc\(`kaloy-\$\{frame\}`\)\} alt=""/);
  assert.match(cast, /<div ref=\{strip\} aria-hidden="true"/, "inside the trio's hidden strip");
  assert.ok(cast.indexOf("{flags.kaloy && (") < cast.indexOf("{CAST.heroTrio.map("), "drawn first, so he walks behind the trio");
  assert.doesNotMatch(read("public/offline.html"), /kaloy/i, "the static offline page can't read the flag, so it stays as it is");
});

// ---- the title screen walk ------------------------------------------------------------------------------------------

function seeded(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("TK11 Kaloy trails the last of the trio, one step at a time, always inside the strip, and idles once he's there", () => {
  for (const width of [296, 356, 610, 930]) { // 296: a 320px phone's strip (inset-x-3)
    for (const seed of [1, 2, 3]) {
      const rng = seeded(seed);
      let walkers: Walker[] = startWalkers(3, rng);
      let k: Follower = startFollower(3);
      const path: Follower[] = [k];
      for (let i = 0; i < 600; i++) {
        walkers = walkers.map((w) => stepWalker(w, width, rng));
        k = stepFollower(k, walkers[2], width);
        path.push(k);
      }
      for (let i = 1; i < path.length; i++) {
        assert.ok(path[i].x >= 0 && path[i].x <= width - CHIBI_PX, `w${width} s${seed}: inside the strip`);
        assert.ok(Math.abs(path[i].x - path[i - 1].x) <= STEP_PX, `w${width} s${seed}: never jumps`);
      }
      assert.ok(path.some((f) => f.moving) && path.some((f) => !f.moving), `w${width} s${seed}: walks and stands`);
    }
  }
  assert.equal(followerHomeX(3), homeX(3), "still: next to the trio");
  assert.ok(followerHomeX(3) + CHIBI_PX <= 296, "still, he fits a 320px phone's strip");
});

test("TK12 his feet swap every step while he walks; standing, he's idle; he faces the way he walks", () => {
  const f = (moving: boolean, age: number): Follower => ({ x: 0, dir: 1, moving, age });
  assert.deepEqual([0, 1, 2, 3].map((a) => followerFrame(f(true, a))), ["walk-1", "walk-2", "walk-1", "walk-2"]);
  assert.equal(followerFrame(f(false, 3)), "idle");
  const leader: Walker = { x: 200, dir: 1, mode: "walk", left: 5, age: 0 };
  const left = stepFollower({ x: 300, dir: 1, moving: false, age: 0 }, leader, 930);
  assert.deepEqual([left.dir, left.moving, left.x], [-1, true, 300 - STEP_PX], "walks left toward the spot behind the leader");
  const there = stepFollower({ x: 160, dir: 1, moving: true, age: 4 }, leader, 930);
  assert.equal(there.moving, false, "caught up: idle");
  assert.match(read("src/components/landing/TitleCast.tsx"), /kaloy\?\.dir === -1 \? " scaleX\(-1\)" : ""/);
});
