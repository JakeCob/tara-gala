// TG-58 PR 2, the invite link, web side. Run with `npm test` (node --test, Node 22.18+ type stripping). Ids are T58-J1 to
// J14 from tickets/TG-58/test-plan.md (J11 is in swStrategy.test.ts). Web has no component runner, so JoinView's states
// are checked end to end in people-e2e.mjs; here are the pure helpers, the API client and the source checks. Names here
// are made up.
// `import *`, not named imports: before the feature exists, a named import of a missing export would stop the whole file.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import * as invite from "./invite.ts";
import * as tripLib from "./trip.ts";

const WEB = new URL("../../", import.meta.url);
const read = (p: string) => (existsSync(new URL(p, WEB)) ? readFileSync(new URL(p, WEB), "utf8").replaceAll("&apos;", "'") : "");
const box = () => read("src/components/TripPeople.tsx");
const join = () => read("src/components/JoinView.tsx");
const page = () => read("src/app/join/[slug]/page.tsx");
const code = (src: string) => src.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

const SLUG = "b".repeat(32);
const OTHER = "c".repeat(32);
const ID = "11111111-1111-4111-8111-111111111111";
const INVITE = { name: "Baguio Barkada", start_date: "2026-11-06", return_date: "2026-11-08", coming: 2, closed: false, people: [{ id: ID, name: "Fe" }] };
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Runs one call with fetch stubbed, and gives back what it sent and what it returned. */
async function sent(run: () => Promise<unknown>, status = 200, body: unknown = INVITE) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  }) as typeof fetch;
  const result = await run();
  return { ...calls[0], calls, result };
}

/** A Storage stand-in. `broken` throws on every call, as some private modes do. */
function memory(broken = false) {
  const data = new Map<string, string>();
  const fail = () => {
    throw new Error("blocked");
  };
  return {
    data,
    getItem: (k: string) => (broken ? fail() : (data.get(k) ?? null)),
    setItem: (k: string, v: string) => (broken ? fail() : void data.set(k, v)),
    removeItem: (k: string) => (broken ? fail() : void data.delete(k)),
  };
}

// ---------------------------------------------------------------- the API client

test("T58-J1 inviteApi.get: ready, closed, a dead link, and no signal isn't a dead link", async () => {
  const ready = await sent(() => invite.inviteApi.get(SLUG));
  assert.match(ready.url, new RegExp(`/invites/${SLUG}$`));
  assert.equal(ready.init.method ?? "GET", "GET");
  assert.deepEqual(ready.result, { ok: true, value: INVITE });
  const closed = await sent(() => invite.inviteApi.get(SLUG), 200, { ...INVITE, closed: true, people: [] });
  assert.deepEqual(closed.result, { ok: true, value: { ...INVITE, closed: true, people: [] } });
  assert.deepEqual((await sent(() => invite.inviteApi.get(SLUG), 404, { detail: "Invite not found" })).result, { ok: false, why: "dead" });
  assert.deepEqual((await sent(() => invite.inviteApi.get(SLUG), 500, {})).result, { ok: false, why: "server" });
  globalThis.fetch = (async () => {
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;
  assert.deepEqual(await invite.inviteApi.get(SLUG), { ok: false, why: "offline" });
});

test("T58-J2 inviteApi.answer: a POST with exactly {attendee_id, answer} or {name, answer}", async () => {
  const out = { attendee_id: ID, name: "Fe", answer: "yes" };
  const byId = await sent(() => invite.inviteApi.answer(SLUG, { attendee_id: ID }, "yes"), 200, out);
  assert.match(byId.url, new RegExp(`/invites/${SLUG}/answers$`));
  assert.equal(byId.init.method, "POST");
  assert.deepEqual(JSON.parse(String(byId.init.body)), { attendee_id: ID, answer: "yes" });
  assert.deepEqual(byId.result, { ok: true, value: out });
  const byName = await sent(() => invite.inviteApi.answer(SLUG, { name: "Fe" }, "no"), 200, { ...out, answer: "no" });
  assert.deepEqual(JSON.parse(String(byName.init.body)), { name: "Fe", answer: "no" });
  const taken = await sent(() => invite.inviteApi.answer(SLUG, { name: "Fe" }, "yes"), 409, { detail: "name_taken" });
  assert.deepEqual(taken.result, { ok: false, why: "rejected", detail: "name_taken" });
  const limited = await sent(() => invite.inviteApi.answer(SLUG, { name: "Fe" }, "yes"), 429, { detail: "rate_limited" });
  assert.deepEqual(limited.result, { ok: false, why: "rate_limited" });
});

test("T58-J3 inviteApi.addPhoto: the raw picture with its type, and 204 is a success", async () => {
  const picture = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" });
  const r = await sent(() => invite.inviteApi.addPhoto(SLUG, ID, picture), 204);
  assert.match(r.url, new RegExp(`/invites/${SLUG}/attendees/${ID}/photo$`));
  assert.equal(r.init.method, "POST");
  assert.equal(r.init.body, picture);
  assert.equal(new Headers(r.init.headers).get("content-type"), "image/jpeg");
  assert.deepEqual(r.result, { ok: true, value: null });
  const taken = await sent(() => invite.inviteApi.addPhoto(SLUG, ID, picture), 409, { detail: "photo_taken" });
  assert.deepEqual(taken.result, { ok: false, why: "rejected", detail: "photo_taken" });
});

test("T58-J4 inviteMessage: the invite's own words, not the trip page's", () => {
  const msg = (detail: string) => invite.inviteMessage({ why: "rejected", detail });
  assert.equal(msg("name_taken"), "That name is on the list already. Pick it above.");
  assert.equal(msg("party_full"), "This trip's list is full. Ask the group.");
  assert.equal(msg("unknown_attendee"), "That person isn't on the list any more. Refresh and try again.");
  assert.equal(msg("photo_taken"), "This name already has a photo. Ask the group to change it.");
  assert.equal(msg("invite_closed"), "This trip has ended, so answers are closed.");
  assert.notEqual(msg("name_taken"), tripLib.tripFailureMessage({ why: "rejected", detail: "name_taken" }));
  assert.notEqual(msg("party_full"), tripLib.tripFailureMessage({ why: "rejected", detail: "party_full" }));
  assert.equal(invite.inviteMessage({ why: "dead" }), "This invitation doesn't work any more. Ask the group for a new link.");
  assert.equal(invite.inviteMessage({ why: "offline" }), tripLib.tripFailureMessage({ why: "offline" }));
  assert.equal(invite.inviteMessage({ why: "server" }), tripLib.tripFailureMessage({ why: "server" }));
  assert.equal(invite.inviteMessage({ why: "rate_limited" }), tripLib.tripFailureMessage({ why: "rate_limited" }));
  assert.equal(msg("not_an_image"), tripLib.tripFailureMessage({ why: "rejected", detail: "not_an_image" }), "the photo's own failures read as on the trip page");
});

// ---------------------------------------------------------------- what this phone remembers

test("T58-J5 rememberAnswer and readAnswer: one key per invite, and a broken store gives null", () => {
  const store = memory();
  const fe = { attendee_id: ID, name: "Fe", answer: "yes" as const };
  invite.rememberAnswer(SLUG, fe, store);
  assert.deepEqual([...store.data.keys()], [`tg-invite-${SLUG}`]);
  assert.deepEqual(invite.readAnswer(SLUG, store), fe);
  assert.equal(invite.readAnswer(OTHER, store), null, "one invite doesn't read another's");
  invite.rememberAnswer(SLUG, { ...fe, photo: true }, store);
  assert.deepEqual(invite.readAnswer(SLUG, store), { ...fe, photo: true });
  for (const bad of ["{", "null", "[]", '{"attendee_id":1}', JSON.stringify({ ...fe, answer: "maybe" })]) {
    store.data.set(`tg-invite-${SLUG}`, bad);
    assert.equal(invite.readAnswer(SLUG, store), null, bad);
  }
  const broken = memory(true);
  assert.doesNotThrow(() => invite.rememberAnswer(SLUG, fe, broken));
  assert.equal(invite.readAnswer(SLUG, broken), null);
  assert.doesNotThrow(() => invite.forgetAnswer(SLUG, broken));
  assert.equal(invite.readAnswer(SLUG, null), null, "no storage at all");
});

test("T58-J6 forgetAnswer clears only this invite's key", () => {
  const store = memory();
  const fe = { attendee_id: ID, name: "Fe", answer: "no" as const };
  invite.rememberAnswer(SLUG, fe, store);
  invite.rememberAnswer(OTHER, fe, store);
  store.data.set("tg-trips", "[]");
  invite.forgetAnswer(SLUG, store);
  assert.deepEqual([...store.data.keys()].sort(), [`tg-invite-${OTHER}`, "tg-trips"]);
});

// ---------------------------------------------------------------- the page

test("T58-J7 page metadata: never names the trip, not indexed, no referrer", () => {
  const src = page();
  assert.ok(src, "src/app/join/[slug]/page.tsx exists");
  assert.match(src, /title: "You're invited · Tara Gala"/);
  assert.match(src, /robots: \{ index: false, follow: false \}/);
  assert.match(src, /referrer: "no-referrer"/);
  assert.match(src, /export const instant = false/);
  assert.doesNotMatch(src, /generateMetadata/);
  assert.match(src, /<JoinView\b/);
});

test("T58-J8 JoinView markup: names as PixelChoice radios in a fieldset, and a focusable heading", () => {
  const src = join();
  assert.ok(src, "src/components/JoinView.tsx exists");
  assert.match(src, /<fieldset\b/);
  assert.match(src, /<SectionTitle as="legend"[^>]*>Which one are you\?<\/SectionTitle>/);
  assert.match(src, /<PixelChoice\b/);
  assert.match(src, /<PageTitle id="[^"]+" tabIndex=\{-1\}>/);
  assert.match(src, /\.focus\(\)/);
  for (const words of ["Tara, sama ka?", "You're in", "Maybe next time", "I'm not on the list", "Your name", "I'm coming", "Can't make it",
    "Everyone with this link can see these names.", "See you on the trip.", "The group will send you the trip's link.", "Change my answer",
    "Thanks for telling the group, ", "Add your photo", "Photo added.", "Pick your name first.", "Type your name first."]) {
    assert.ok(src.includes(words), words);
  }
  assert.match(src, /Optional\. Everyone on the trip will see it\. To remove it later, ask the group\. That deletes it from the server, not from phones that already saved the trip\./);
  assert.match(src, /maxLength=\{30\}/);
  assert.match(src, /fitAvatar/);
  assert.match(src, /md:max-w-\[448px\]/, "desktop: the same box, 448px wide");
  assert.match(src, /md:mx-auto|md:self-center/, "and centred");
});

test("T58-J9 trip page: the invite button, its share text, the line under it, and turning it off", () => {
  const src = box();
  assert.match(src, /No names yet\. Add the people you're asking, or send the invite and they can add themselves\./, "F2: ux's sentence is back");
  assert.match(src, /<PixelButton variant="secondary"[^>]*onClick=\{onInvite\}[^>]*>\s*Invite the group\s*<\/PixelButton>/);
  assert.match(src, /title: "Tara Gala invite"/);
  assert.match(src, /text: `Are you coming to "\$\{trip\.name\}"\? Tap to answer\.`/);
  assert.match(src, /runShare\(shareDeps\(navigator\)/);
  assert.match(src, /\/join\/\$\{/);
  assert.match(src, /Link copied\. Send it to the group\./);
  assert.match(src, /The invite only lets people say if they're coming\. It doesn't open the trip\./);
  assert.match(src, /Turn off the invite/);
  assert.match(src, /window\.confirm\("Turn off this invite\? The link stops working\. Invite the group makes a new one\."\)/);
  assert.match(src, /tripApi\.startInvite\(/);
  assert.match(src, /tripApi\.stopInvite\(/);
  assert.match(src, /trip\.invite_slug/);
  assert.doesNotMatch(src, /variant="primary"/, "Share the trip keeps the page's one red button");
});

test("T58-J10 tripApi: startInvite is a PUT, stopInvite a DELETE", async () => {
  const trip = { share_slug: SLUG, invite_slug: OTHER };
  const on = await sent(() => tripLib.tripApi.startInvite(SLUG), 200, trip);
  assert.match(on.url, new RegExp(`/sessions/${SLUG}/invite$`));
  assert.equal(on.init.method, "PUT");
  assert.deepEqual(on.result, { ok: true, trip });
  const off = await sent(() => tripLib.tripApi.stopInvite(SLUG), 200, { ...trip, invite_slug: null });
  assert.match(off.url, new RegExp(`/sessions/${SLUG}/invite$`));
  assert.equal(off.init.method, "DELETE");
});

test("T58-J12 plain words: no 'verified', 'confirmed' or 'checked in', and no Maybe as an answer", () => {
  for (const file of ["src/components/JoinView.tsx", "src/lib/invite.ts"]) {
    const src = code(read(file));
    assert.ok(src, file);
    assert.doesNotMatch(src, /verified|confirmed|checked in/i, file);
    assert.doesNotMatch(src.replaceAll("Maybe next time", ""), /\bmaybe\b/i, file);
  }
});

test("T58-J13 no link leaks: the invite page never touches the trip's link or its files", () => {
  for (const file of ["src/components/JoinView.tsx", "src/lib/invite.ts", "src/app/join/[slug]/page.tsx"]) {
    const src = code(read(file));
    assert.ok(src, file);
    for (const banned of ["/t/", "share_slug", "useFile", "fetchFile", "rememberTrip", "/sessions", "/wallets", "tripApi", "walletApi"]) {
      assert.ok(!src.includes(banned), `${file}: ${banned}`);
    }
  }
});

test("T58-J14 countLine: plural, singular and F8's zero", () => {
  assert.equal(invite.countLine(5), "5 people are coming so far.");
  assert.equal(invite.countLine(1), "1 person is coming so far.");
  assert.equal(invite.countLine(0), "Nobody's said yes yet.");
});

test("T58-J15 the log lines (plan section 9), with no name", () => {
  const src = join();
  for (const what of ["load", "answer", "photo"]) {
    assert.match(src, new RegExp(`console\\.info\\("\\[tg-invite\\] ${what} ok=%s"`), what);
  }
  assert.doesNotMatch(src, /console\.\w+\([^)]*\bname\b/);
});
