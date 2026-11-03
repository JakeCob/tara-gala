// TG-58 PR 1 attendees, arrival check and profile photos, web side. Run with `npm test` (node --test, Node 22.18+ type
// stripping). Ids are T58-W1 to W30 from tickets/TG-58/test-plan.md. Web has no component runner, so TripPeople's states
// are checked end to end in people-e2e.mjs; here are the pure helpers, the API client and the source checks. Names here
// are made up.
// `import *`, not named imports: before the feature exists, a named import of a missing export would stop the whole file.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as people from "./people.ts";
import * as shrink from "./shrink.ts";
import * as tripLib from "./trip.ts";
import type { Guide } from "./guide.ts";
import type { Attendee } from "./people.ts";
import type { Trip } from "./trip.ts";

const WEB = new URL("../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, WEB), "utf8").replaceAll("&apos;", "'");
const box = () => read("src/components/TripPeople.tsx");
const view = () => read("src/components/TripView.tsx");

const SLUG = "a".repeat(32);
const ID = "11111111-1111-4111-8111-111111111111";
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const person = (name: string, over: Partial<Attendee> = {}): Attendee => ({ id: `p-${name}`, name, rsvp: "pending", rsvp_at: null, arrived_at: null, ...over });
const yes = (name: string, over: Partial<Attendee> = {}) => person(name, { rsvp: "yes", rsvp_at: "2026-11-02T01:00:00Z", ...over });
const no = (name: string, over: Partial<Attendee> = {}) => person(name, { rsvp: "no", rsvp_at: "2026-11-02T01:00:00Z", ...over });
const here = (name: string) => yes(name, { arrived_at: "2026-11-06T01:12:00Z" });
const trip = (over: Partial<Trip> = {}) => ({ share_slug: SLUG, name: "Baguio", start_date: "2026-11-06", return_date: "2026-11-08", attendees: [person("Ana")], ...over }) as Trip;
const realGuide = () => JSON.parse(readFileSync(new URL("../data/itineraries/baguio-barkada-2026-11-06.json", WEB), "utf8")).guide as Guide;
const row = (key: string, time: string, plan: string, over = {}) => ({ key, time, plan, note: "", place: null, bus: null, show_if: null, hide_if: null, ...over });
const oneDay = (rows: unknown[], day = 1) => ({ days: [{ day, title: "", intro: "", pick: null, rows, tips: [] }] }) as unknown as Guide;

/** Runs one tripApi call with fetch stubbed, and gives back what it sent. */
async function sent(run: () => Promise<unknown>, status = 200, body: unknown = trip()) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  const result = await run();
  return { ...calls[0], result };
}

// ---------------------------------------------------------------- pure helpers

test("T58-W1 peopleOf: a saved copy from before this deploy has no attendees", () => {
  assert.deepEqual(people.peopleOf(trip({ attendees: undefined })), []);
  const list = [person("Ana")];
  assert.equal(people.peopleOf(trip({ attendees: list })), list);
});

test("T58-W2 counts", () => {
  assert.deepEqual(people.counts([yes("Ana"), yes("Ben"), no("Ed"), person("Fe"), person("Gil"), person("Hal")]), { yes: 2, no: 1, pending: 3 });
  assert.deepEqual(people.counts([]), { yes: 0, no: 0, pending: 0 });
});

test("T58-W3 comingLines: three lines in list order, and an empty one drops out", () => {
  assert.deepEqual(people.comingLines([yes("Ana"), no("Ed"), person("Fe"), yes("Ben")]), ["Coming: Ana, Ben", "Can't make it: Ed", "No answer yet: Fe"]);
  assert.deepEqual(people.comingLines([yes("Ana")]), ["Coming: Ana"]);
  assert.deepEqual(people.comingLines([no("Ed"), person("Fe")]), ["Can't make it: Ed", "No answer yet: Fe"]);
  assert.deepEqual(people.comingLines([]), []);
});

test("T58-W4 comingSummary: the sentence above the lines, with F8's singular, and zero parts drop out", () => {
  const list = [yes("A"), yes("B"), yes("C"), yes("D"), yes("E"), no("F"), person("G"), person("H")];
  assert.equal(people.comingSummary(list), "5 coming, 1 can't make it, 2 haven't answered.");
  assert.equal(people.comingSummary([person("G")]), "1 hasn't answered.");
  assert.equal(people.comingSummary([yes("A"), person("G")]), "1 coming, 1 hasn't answered.");
  assert.equal(people.comingSummary([no("A"), no("B")]), "2 can't make it.");
  assert.equal(people.comingSummary([]), "");
});

test("T58-W5 expected: everyone except a no, in list order, and an arrival doesn't move anyone", () => {
  const names = (list: Attendee[]) => people.expected(list).map((p) => p.name);
  assert.deepEqual(names([person("Fe"), no("Ed"), yes("Ana")]), ["Fe", "Ana"]);
  assert.deepEqual(names([person("Fe"), here("Ana"), yes("Ben")]), ["Fe", "Ana", "Ben"]);
  assert.deepEqual(names([]), []);
});

test("T58-W6 waitingLine", () => {
  const waiting = (n: number) => Array.from({ length: n }, (_, i) => person(`P${i + 1}`));
  assert.equal(people.waitingLine([here("Ana"), here("Ben"), here("Cara"), yes("Dina"), person("Fe"), person("Gil"), yes("Jacob")]), "3 of 7 here. Waiting for Dina, Fe, Gil and Jacob.");
  assert.equal(people.waitingLine([here("Ana"), yes("Dina")]), "1 of 2 here. Waiting for Dina.");
  assert.equal(people.waitingLine([here("Ana"), yes("Dina"), person("Fe")]), "1 of 3 here. Waiting for Dina and Fe.");
  assert.equal(people.waitingLine(waiting(6)), "0 of 6 here. Waiting for P1, P2, P3, P4, P5 and P6.");
  assert.equal(people.waitingLine(waiting(7)), "0 of 7 here. Waiting for 7 people.");
  assert.equal(people.waitingLine([here("A"), here("B"), here("C"), here("D"), here("E"), here("F"), here("G")]), "Everyone's here: 7 of 7.");
});

test("T58-W7 waitingLine edges: a no-sayer's time isn't counted, and nobody expected never reads 0 of 0 (F3)", () => {
  const late = no("Ed", { arrived_at: "2026-11-06T01:12:00Z" });
  assert.equal(people.waitingLine([late, here("Ana"), yes("Ben")]), "1 of 2 here. Waiting for Ben.");
  assert.equal(people.waitingLine([no("Ed")]), "Nobody's expected yet.");
  assert.equal(people.waitingLine([]), "Nobody's expected yet.");
});

test("T58-W8 openFace: here on start_date with someone listed, else coming (F3)", () => {
  assert.equal(people.openFace("2026-11-06", trip()), "here");
  assert.equal(people.openFace("2026-11-05", trip()), "coming");
  assert.equal(people.openFace("2026-11-07", trip()), "coming");
  assert.equal(people.openFace("2026-11-08", trip()), "coming");
  assert.equal(people.openFace("2026-11-06", trip({ attendees: [] })), "coming");
  assert.equal(people.openFace("2026-11-06", trip({ attendees: undefined })), "coming");
});

test("T58-W9 meetLine: the first row showing on day 1, else First meet-up", () => {
  assert.equal(people.meetLine(realGuide(), []), "9:30 AM · Meet at Cubao terminal");
  assert.equal(people.meetLine(null, []), "First meet-up");
  assert.equal(people.meetLine(oneDay([]), []), "First meet-up");
  assert.equal(people.meetLine(oneDay([row("d2-01", "08:00", "Sunrise")], 2), []), "First meet-up");
  const rows = [row("d1-01", "07:00", "Hidden", { hide_if: { pick: "p", is: "A" } }), row("d1-02", "09:00", "Meet at Pasay")];
  assert.equal(people.meetLine(oneDay(rows), []), "7:00 AM · Hidden");
  assert.equal(people.meetLine(oneDay(rows), [{ key: "pick:p", value: "A", updated_at: "2026-11-01T00:00:00Z" }]), "9:00 AM · Meet at Pasay");
});

test("T58-W10 arrivalTime reads Manila time, on a machine in UTC or anywhere else", () => {
  assert.equal(people.arrivalTime("2026-11-06T01:12:00Z"), "9:12 AM");
  assert.equal(people.arrivalTime("2026-11-06T01:12:00+00:00"), "9:12 AM");
  assert.equal(people.arrivalTime("2026-11-05T16:30:00Z"), "12:30 AM");
  assert.equal(people.arrivalTime("2026-11-06T05:05:30.123456Z"), "1:05 PM");
});

test("T58-W11 arrivalInput is an HH:MM in Manila", () => {
  assert.equal(people.arrivalInput("2026-11-06T01:12:00Z"), "09:12");
  assert.equal(people.arrivalInput("2026-11-05T16:30:00Z"), "00:30");
});

test("T58-W12 correctedAt keeps the Manila day, with no offset", () => {
  assert.equal(people.correctedAt("2026-11-06T01:12:00Z", "09:40"), "2026-11-06T09:40:00");
  assert.equal(people.correctedAt("2026-11-05T16:30:00Z", "09:40"), "2026-11-06T09:40:00", "slicing the ISO date gives the day before");
});

test("T58-W13 correctedAt refuses anything but HH:MM (F4)", () => {
  for (const bad of ["", "9", "25:00", "09:60", "9:40"]) assert.equal(people.correctedAt("2026-11-06T01:12:00Z", bad), null, bad);
});

// ---------------------------------------------------------------- the API client

test("T58-W14 tripApi: the six calls, and addFile's attendee_id", async () => {
  const api = tripLib.tripApi;
  const base = `/sessions/${SLUG}`;
  const check = async (run: () => Promise<unknown>, method: string, path: string, body?: unknown) => {
    const s = await sent(run);
    assert.equal(s.init.method, method, path);
    assert.ok(s.url.endsWith(path), `${s.url} ends with ${path}`);
    assert.deepEqual(s.init.body === undefined ? undefined : JSON.parse(String(s.init.body)), body, path);
  };
  await check(() => api.addAttendee(SLUG, "Ana"), "POST", `${base}/attendees`, { name: "Ana" });
  await check(() => api.copyWalletNames(SLUG), "POST", `${base}/attendees/from-wallet`);
  await check(() => api.setAnswer(SLUG, ID, "yes"), "PATCH", `${base}/attendees/${ID}`, { rsvp: "yes" });
  await check(() => api.removeAttendee(SLUG, ID), "DELETE", `${base}/attendees/${ID}`);
  await check(() => api.arrive(SLUG, ID), "PUT", `${base}/attendees/${ID}/arrival`, {});
  await check(() => api.arrive(SLUG, ID, "2026-11-06T09:40:00"), "PUT", `${base}/attendees/${ID}/arrival`, { at: "2026-11-06T09:40:00" });
  await check(() => api.clearArrival(SLUG, ID), "DELETE", `${base}/attendees/${ID}/arrival`);
  const file = await sent(() => api.addFile(SLUG, "avatar", new Blob(["x"], { type: "image/jpeg" }), { attendee_id: ID }));
  const url = new URL(file.url, "http://x");
  assert.equal(url.searchParams.get("kind"), "avatar");
  assert.equal(url.searchParams.get("attendee_id"), ID);
});

test("T58-W15 failure copy: plan §2.11's trip-page strings, through call", async () => {
  const say = async (status: number, detail: string) => {
    const { result } = await sent(() => tripLib.tripApi.addAttendee(SLUG, "Ana"), status, { detail });
    const failed = result as { ok: false; why: tripLib.TripFailure; detail?: string };
    assert.equal(failed.ok, false);
    assert.equal(failed.detail, detail);
    return tripLib.tripFailureMessage(failed);
  };
  assert.equal(await say(409, "name_taken"), "Someone on the list already has that name.");
  assert.equal(await say(409, "party_full"), "The list is full: it holds up to 30 people.");
  assert.equal(await say(422, "unknown_attendee"), "That person isn't on the list any more. Refresh and try again.");
  assert.equal(await say(422, "no_wallet"), "This trip has no wallet to copy names from.");
});

test("T58-W16 call: a 422 unknown_attendee is rejected, never not_found", async () => {
  const { result } = await sent(() => tripLib.tripApi.arrive(SLUG, ID), 422, { detail: "unknown_attendee" });
  assert.deepEqual(result, { ok: false, why: "rejected", detail: "unknown_attendee" });
});

test("T58-W17 types: avatar is a kind, and attendees and invite_slug are optional", () => {
  const src = read("src/lib/trip.ts");
  assert.match(src, /export type FileKind = [^;]*"avatar"/);
  assert.match(src, /attendee_id: string \| null;/);
  assert.match(src, /attendees\?: Attendee\[\];/);
  assert.match(src, /invite_slug\?: string \| null;/);
});

test("T58-W18 peopleOf is the only door: outside people.ts, no source reads .attendees", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  const src = new URL("src/", WEB).pathname;
  const readers = walk(src).filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".test.ts") && !f.endsWith("/lib/people.ts") && /\.attendees\b/.test(readFileSync(f, "utf8")));
  assert.deepEqual(readers, []);
});

// ---------------------------------------------------------------- photos

test("T58-W19 squareCrop: centred across, a third of the way down a tall picture", () => {
  assert.deepEqual(shrink.squareCrop(1000, 1000), { sx: 0, sy: 0, side: 1000 });
  assert.deepEqual(shrink.squareCrop(2000, 1000), { sx: 500, sy: 0, side: 1000 });
  assert.deepEqual(shrink.squareCrop(1000, 2500), { sx: 0, sy: 500, side: 1000 });
  assert.deepEqual(shrink.squareCrop(1, 1), { sx: 0, sy: 0, side: 1 });
});

test("T58-W20 fitAvatar: 256px at most, always redrawn as a JPEG, and null if the browser can't draw", () => {
  assert.equal(shrink.AVATAR_SIDE, 256);
  const src = read("src/lib/shrink.ts");
  const start = src.indexOf("export async function fitAvatar");
  assert.ok(start > 0);
  const fn = src.slice(start, src.indexOf("\n}\n", start));
  assert.match(fn, /Math\.min\(AVATAR_SIDE, side\)/, "never enlarges");
  assert.match(fn, /squareCrop\(bitmap\.width, bitmap\.height\)/);
  assert.match(fn, /toBlob\(done, "image\/jpeg", 0\.8\)/);
  assert.match(fn, /if \(!context\) \{/);
  assert.match(fn, /return null;/);
  assert.doesNotMatch(fn, /picture\.size/, "no shortcut: every avatar is redrawn, so its location data goes");
});

// ---------------------------------------------------------------- the trip page

test("T58-W21 placement: TripPeople directly follows TripHeader in a two-column wrapper, with apply and not write", () => {
  const src = view();
  assert.match(src, /<div className="[^"]*md:grid md:grid-cols-2[^"]*">\s*<TripHeader [^>]*\/>\s*<TripPeople [^>]*\/>\s*<\/div>/);
  const use = src.match(/<TripPeople [^>]*\/>/)?.[0] ?? "";
  assert.match(use, /apply=\{apply\}/);
  assert.doesNotMatch(use, /write=/);
});

test("T58-W22 apply logs, never sets a notice, and write goes through it", () => {
  const src = view();
  const start = src.indexOf("async function apply(");
  assert.ok(start > 0);
  const fn = src.slice(start, src.indexOf("\n  }\n", start));
  assert.match(fn, /console\.info\("\[tg-trip\] %s ok=%s"/);
  assert.match(fn, /void tripApi\.get\(slug\);/);
  assert.doesNotMatch(fn, /setNotice/);
  const write = src.slice(src.indexOf("async function write("), src.indexOf("const onFail ="));
  assert.match(write, /await apply\(action, op\)/);
});

test("T58-W23 TripPeople: results stay next to the control", () => {
  const src = box();
  assert.doesNotMatch(src, /setNotice|onFail/);
  assert.match(src, /role="alert"/);
  assert.match(src, /role="status"/);
  assert.match(src, /aria-expanded=/);
  assert.match(src, /is here, \$\{/, "the row's status line, read out on success");
});

test("T58-W24 DeleteTrip names the people and their photos", () => {
  assert.match(view().replace(/\s+/g, " "), /This deletes the trip, its hotel, its list of people and their photos, and its shared tickets and QRs for everyone\./);
});

test("T58-W25 avatars stay out of the albums and tickets", () => {
  assert.match(read("src/components/TripFiles.tsx"), /export function useFile\(/);
  assert.match(view(), /f\.kind !== "photo" && !kept\.has\(f\.id\)/, "keepFilesOffline fetches avatars too, unchanged");
  const map = read("src/components/LevelMap.tsx");
  assert.ok((map.match(/kind === "photo"/g) ?? []).length >= 2);
});

test("T58-W26 Avatar markup", () => {
  const src = box();
  assert.match(src, /width=\{40\} height=\{40\}/);
  assert.match(src, /border-2 border-frame/);
  assert.match(src, /object-cover/);
  assert.match(src, /alt=""/);
  assert.match(src, /aria-hidden="true"/);
  assert.match(src, /`\$\{[^}]*\? "Change" : "Add"\} \$\{[^}]*\}'s photo`|Add \$\{[^}]*\}'s photo/);
  assert.match(src, /Change \$\{[^}]*\}'s photo|"Change"/);
  assert.match(src, /Everyone with the trip's link sees these photos\. They stay until the trip is deleted\./);
});

test("T58-W27 plain words, and no colour on a time", () => {
  for (const file of ["src/components/TripPeople.tsx", "src/lib/people.ts"]) {
    const src = read(file).replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    assert.doesNotMatch(src, /verified|confirmed|checked in|\blate\b|on time/i, file);
  }
  assert.doesNotMatch(box(), /text-danger|text-success|text-warning|bg-danger/);
});

test("T58-W28 no invite in PR 1 (F2): PR 2 replaces this with T58-J9", () => {
  assert.doesNotMatch(box(), /invite/i);
  assert.match(box(), /No names yet\. Add the people you're asking\./);
});

test("T58-W29 fences: these files don't change, and TripPeople writes nothing to a wallet", () => {
  const changed = execFileSync("git", ["diff", "--name-only", "origin/main", "--", "web/src/components/LevelMap.tsx", "web/public/sw.js", "web/package.json", "web/package-lock.json", "package.json", "package-lock.json"], { cwd: new URL("../", WEB), encoding: "utf8" });
  assert.equal(changed.trim(), "");
  const src = box();
  assert.match(src, /walletApi\.get\(/, "the count comes from the wallet's GET");
  assert.equal(src.match(/walletApi\.\w+/g)?.filter((c) => c !== "walletApi.get").length ?? 0, 0);
});

test("T58-W30 confirms: the remove sentence, the photo's, and none on Undo", () => {
  const src = box();
  assert.match(src, /`Remove \$\{[^}]*\} from this list\? Their answer, arrival time and photo go too\. The wallet doesn't change\.`/);
  assert.match(src, /window\.confirm\(`Remove \$\{[^}]*\}'s photo\?`\)/);
  const undo = src.slice(src.indexOf("function onUndo"), src.indexOf("\n  }\n", src.indexOf("function onUndo")));
  assert.ok(undo.length > 0);
  assert.doesNotMatch(undo, /confirm/);
});
