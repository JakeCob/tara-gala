// /terminals fetcher tests (TG-14, RED audit S2). Run with `npm test` (node --test, Node 22.18+ type stripping).
import { afterEach, beforeEach, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

type TerminalsModule = typeof import("./terminals.ts");

const ROWS = [
  { slug: "vl-cubao", name: "Victory Liner Cubao", city: "Quezon City", address: null, lat: null, lng: null },
  { slug: "vl-baguio", name: "Victory Liner Baguio", city: "Baguio", address: null, lat: 16.4, lng: 120.6 },
];

const originalUrl = process.env.NEXT_PUBLIC_API_URL;

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_API_URL;
});

afterEach(() => {
  if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL;
  else process.env.NEXT_PUBLIC_API_URL = originalUrl;
});

// Each case gets a fresh module, so the once-per-page cache starts empty.
let loads = 0;
async function freshModule(): Promise<TerminalsModule> {
  return import(`./terminals.ts?case=${loads++}`);
}

function stubFetch(t: TestContext, ...responses: (() => Promise<Response>)[]) {
  let i = 0;
  return t.mock.method(globalThis, "fetch", () => responses[Math.min(i++, responses.length - 1)]());
}

const ok = () => Promise.resolve(new Response(JSON.stringify(ROWS), { status: 200 }));

test("fetches /terminals once and keys rows by slug", async (t) => {
  const fetchMock = stubFetch(t, ok);
  const { getTerminals } = await freshModule();
  const [a, b] = await Promise.all([getTerminals(), getTerminals()]);
  const c = await getTerminals();
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(a, b);
  assert.equal(a, c);
  assert.deepEqual([...a.keys()], ["vl-cubao", "vl-baguio"]);
  assert.equal(a.get("vl-baguio")?.lat, 16.4);
  const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
  assert.equal(url, "http://localhost:8000/terminals");
  assert.equal(init.cache, "no-store");
});

test("uses NEXT_PUBLIC_API_URL when set", async (t) => {
  process.env.NEXT_PUBLIC_API_URL = "https://api.example.test";
  const fetchMock = stubFetch(t, ok);
  const { getTerminals } = await freshModule();
  await getTerminals();
  assert.equal(fetchMock.mock.calls[0].arguments[0], "https://api.example.test/terminals");
});

test("a non-OK response rejects and the next call retries", async (t) => {
  const fetchMock = stubFetch(t, () => Promise.resolve(new Response("down", { status: 500 })), ok);
  const { getTerminals } = await freshModule();
  await assert.rejects(getTerminals(), /API error 500/);
  const m = await getTerminals();
  assert.equal(fetchMock.mock.callCount(), 2);
  assert.equal(m.size, 2);
});

test("a network error rejects and the next call retries", async (t) => {
  const fetchMock = stubFetch(t, () => Promise.reject(new TypeError("fetch failed")), ok);
  const { getTerminals } = await freshModule();
  await assert.rejects(getTerminals(), /fetch failed/);
  await getTerminals();
  assert.equal(fetchMock.mock.callCount(), 2);
});

test("a non-array body rejects instead of returning a broken map", async (t) => {
  stubFetch(t, () => Promise.resolve(new Response(JSON.stringify({ detail: "x" }), { status: 200 })));
  const { getTerminals } = await freshModule();
  await assert.rejects(getTerminals());
});

test("reads the API URL with a literal process.env access", () => {
  // Next inlines NEXT_PUBLIC_* only for literal member access.
  const source = readFileSync(new URL("./terminals.ts", import.meta.url), "utf8");
  assert.ok(source.includes("process.env.NEXT_PUBLIC_API_URL"));
  assert.doesNotMatch(source, /process\.env\s*\[/);
  assert.doesNotMatch(source, /^\s*import\s+(?!type\b)/m); // type-only imports, erased by type stripping
  assert.doesNotMatch(source, /\bconsole\./);
});
