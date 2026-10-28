// Service worker tests (TG-27). Run with `npm test` (node --test, Node 22.18+ type stripping).
// public/sw.js is the single source of truth: these tests load the real file into a node:vm context
// that stands in for the worker's global scope, then run its pure helpers (self.TG_SW) and its event
// handlers against in-memory fakes of caches, fetch and clients.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SW_PATH = new URL("../../public/sw.js", import.meta.url);
const APP = "http://localhost:3110";
const API = "http://localhost:8110";
const SCRIPT_URL = `${APP}/sw.js?api=${encodeURIComponent(API)}`;
// Made-up production-shaped origins, to prove nothing is tied to localhost
const PROD = { app: "https://tara-gala.vercel.app", api: "https://tara-gala-api.up.railway.app" };
const LOCAL = { app: APP, api: API };
const OLD_ISO = "2026-10-30T13:12:00.000Z";

// Objects built inside the vm have another realm's prototypes, which deepStrictEqual rejects
const plain = (x: unknown) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

/** Timers the tests move by hand, so the 4 s network timeout runs instantly. */
function fakeClock() {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout: (fn: () => void, ms = 0) => {
      timers.set(++next, { at: now + ms, fn });
      return next;
    },
    clearTimeout: (id: number) => void timers.delete(id),
    async advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
      await flush();
    },
  };
}

const urlOf = (req: string | Request | { url: string }, base = APP) =>
  typeof req === "string" ? new URL(req, base).href : req.url;
const keyOf = (url: string, ignoreSearch?: boolean) => {
  const u = new URL(url);
  if (ignoreSearch) u.search = "";
  u.hash = "";
  return u.href;
};

class FakeCache {
  entries = new Map<string, Response>();
  async match(req: string | Request, opts: { ignoreSearch?: boolean } = {}) {
    const want = keyOf(urlOf(req), opts.ignoreSearch);
    for (const [url, res] of this.entries) if (keyOf(url, opts.ignoreSearch) === want) return res.clone();
    return undefined;
  }
  async put(req: string | Request, res: Response) {
    if (typeof req !== "string" && req.method !== "GET") throw new TypeError("Cache.put only accepts GET");
    this.entries.set(keyOf(urlOf(req)), res);
  }
  async add(req: string | Request) {
    const res = await fakeGlobalFetch!(req);
    if (!res.ok) throw new TypeError(`add failed ${res.status}`);
    await this.put(req, res);
  }
  async addAll(reqs: (string | Request)[]) {
    for (const r of reqs) await this.add(r);
  }
  async keys() {
    return [...this.entries.keys()].map((u) => new Request(u));
  }
  async delete(req: string | Request) {
    return this.entries.delete(keyOf(urlOf(req)));
  }
}

class FakeCacheStorage {
  stores = new Map<string, FakeCache>();
  async open(name: string) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache());
    return this.stores.get(name)!;
  }
  async has(name: string) {
    return this.stores.has(name);
  }
  async delete(name: string) {
    return this.stores.delete(name);
  }
  async keys() {
    return [...this.stores.keys()];
  }
  async match(req: string | Request, opts: { ignoreSearch?: boolean; cacheName?: string } = {}) {
    for (const [name, cache] of this.stores) {
      if (opts.cacheName && opts.cacheName !== name) continue;
      const hit = await cache.match(req, opts);
      if (hit) return hit;
    }
    return undefined;
  }
}

// FakeCache.add needs the current test's fetch
let fakeGlobalFetch: ((req: string | Request, init?: RequestInit) => Promise<Response>) | null = null;

type Handler = (event: unknown) => void;
type Loaded = {
  sw: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  handlers: Record<string, Handler[]>;
  scope: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  logs: { level: string; args: unknown[] }[];
};

/** Loads public/sw.js into a fresh vm context. `globals` adds or overrides worker globals. */
function loadSw(globals: Record<string, unknown> = {}): Loaded {
  const source = readFileSync(SW_PATH, "utf8");
  const handlers: Record<string, Handler[]> = {};
  const logs: Loaded["logs"] = [];
  const record = (level: string) => (...args: unknown[]) => void logs.push({ level, args });
  const scope: Record<string, any> = { // eslint-disable-line @typescript-eslint/no-explicit-any
    location: new URL(SCRIPT_URL),
    registration: { scope: `${APP}/` },
    clients: {},
    skipWaitingCalls: 0,
    addEventListener: (type: string, fn: Handler) => void (handlers[type] ??= []).push(fn),
    URL,
    URLSearchParams,
    Response,
    Request,
    Headers,
    setTimeout,
    clearTimeout,
    console: { log: record("log"), info: record("info"), warn: record("warn"), error: record("error"), debug: record("debug") },
  };
  // Copy descriptors, not values, so a getter in `globals` isn't run here
  Object.defineProperties(scope, Object.getOwnPropertyDescriptors(globals));
  scope.skipWaiting = () => {
    scope.skipWaitingCalls++;
    return Promise.resolve();
  };
  scope.self = scope;
  vm.createContext(scope);
  vm.runInContext(source, scope, { filename: "sw.js" });
  return { sw: scope.TG_SW, handlers, scope, logs };
}

let cached: Loaded | null = null;
/** The pure helpers, from one shared load (handlers aren't used through this). */
function tg() {
  cached ??= loadSw();
  return cached.sw;
}

const req = (url: string, init: { method?: string; mode?: string; headers?: Record<string, string> | Headers } = {}) => ({
  method: init.method ?? "GET",
  url,
  mode: init.mode,
  headers: init.headers ?? {},
});
const strategy = (r: ReturnType<typeof req>, origins = LOCAL) => plain(tg().strategyFor(r, origins));
const BYPASS = { strategy: "bypass" };
const API_FIRST = { strategy: "network-first", cache: "data", kind: "api" };
const PAGE_FIRST = { strategy: "network-first", cache: "pages", kind: "page" };
const SAVED_PAGE_FIRST = { strategy: "network-first", cache: "data", kind: "page" };
const CACHE_FIRST = { strategy: "cache-first", cache: "static" };
const SWR = { strategy: "stale-while-revalidate", cache: "static" };

const TRIPS = "/trips?origin_city=Metro%20Manila&destination_city=Baguio&date=2026-11-06";
const API_GETS = [TRIPS, "/last-mile?terminal=vl-baguio", "/spots", "/terminals", "/itineraries/abc123", "/premade-itineraries"];

const originalTZ = process.env.TZ;
afterEach(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

// ---------------------------------------------------------------- loading and constants

test("sw.js loads in a bare worker scope without touching caches or fetch", () => {
  const touched: string[] = [];
  const trap = (name: string) => ({
    get() {
      touched.push(name);
      return undefined;
    },
    configurable: true,
  });
  const globals = {};
  Object.defineProperty(globals, "caches", trap("caches"));
  Object.defineProperty(globals, "fetch", trap("fetch"));
  const { sw, handlers } = loadSw(globals);
  assert.deepEqual(touched, []);
  assert.equal(typeof sw, "object", "sw.js must expose self.TG_SW");
  for (const type of ["install", "activate", "message", "fetch"]) {
    assert.equal(handlers[type]?.length, 1, `one ${type} listener`);
  }
});

test("constants the page and the plan rely on", () => {
  const sw = tg();
  assert.match(sw.SW_VERSION, /\S/);
  assert.match(sw.DATA_VERSION, /\S/);
  assert.equal(sw.NETWORK_TIMEOUT_MS, 4000);
  assert.equal(sw.MSG_DATA, "tg-sw:data");
  assert.equal(sw.MSG_SKIP_WAITING, "SKIP_WAITING");
  assert.ok(sw.PRECACHE_PAGES.includes("/"));
  assert.ok(sw.PRECACHE_PAGES.includes("/baguio"));
  for (const f of ["/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png", "/offline.html"]) {
    assert.ok(sw.STATIC_FILES.includes(f), f);
  }
  assert.ok(![...sw.PRECACHE_PAGES, ...sw.STATIC_FILES].some((p: string) => p.startsWith("/sw.js")), "never precache /sw.js");
});

// T27-14: the page's copies of the message contract match the worker's
test("T27-14 message contract matches offline.ts", async () => {
  const offline = await import("./offline.ts");
  const sw = tg();
  assert.equal(sw.MSG_DATA, offline.MSG_DATA);
  assert.equal(sw.MSG_SKIP_WAITING, offline.MSG_SKIP_WAITING);
  const msg = sw.dataMessage("cache", OLD_ISO, `${API}${TRIPS}`);
  assert.deepEqual(plain(msg), { type: "tg-sw:data", source: "cache", savedAt: OLD_ISO, url: `${API}${TRIPS}` });
  assert.deepEqual(plain(offline.parseSwMessage(msg)), plain(msg));
  assert.deepEqual(plain(offline.parseSwMessage(sw.dataMessage("none", null, `${API}${TRIPS}`))), {
    type: "tg-sw:data",
    source: "none",
    savedAt: null,
    url: `${API}${TRIPS}`,
  });
});

// ---------------------------------------------------------------- API origin

test("apiOriginFrom reads the http(s) origin from the registration URL", () => {
  const sw = tg();
  assert.equal(sw.apiOriginFrom(SCRIPT_URL), API);
  assert.equal(sw.apiOriginFrom(`${APP}/sw.js?api=${encodeURIComponent(`${PROD.api}/`)}`), PROD.api);
  assert.equal(sw.apiOriginFrom(`${APP}/sw.js?api=${encodeURIComponent(`${PROD.api}/some/path?x=1`)}`), PROD.api);
  assert.equal(sw.apiOriginFrom(`${APP}/sw.js`), null);
  assert.equal(sw.apiOriginFrom(`${APP}/sw.js?api=`), null);
  assert.equal(sw.apiOriginFrom(`${APP}/sw.js?api=not%20a%20url`), null);
  assert.equal(sw.apiOriginFrom(`${APP}/sw.js?api=${encodeURIComponent("javascript:alert(1)")}`), null);
  assert.equal(sw.apiOriginFrom(`${APP}/sw.js?api=${encodeURIComponent("ftp://files.example.com")}`), null);
});

// ---------------------------------------------------------------- route -> strategy

test("T27-4 /sw.js is never cached", () => {
  for (const origins of [LOCAL, PROD]) {
    for (const path of ["/sw.js", "/sw.js?v=2", `/sw.js?api=${encodeURIComponent(origins.api)}`]) {
      assert.deepEqual(strategy(req(`${origins.app}${path}`), origins), BYPASS, path);
      assert.deepEqual(strategy(req(`${origins.app}${path}`, { mode: "navigate" }), origins), BYPASS, `navigate ${path}`);
    }
  }
});

test("T27-5 API GETs on the configured origin are network-first into the data cache", () => {
  for (const origins of [LOCAL, PROD]) {
    for (const path of API_GETS) {
      assert.deepEqual(strategy(req(`${origins.api}${path}`), origins), API_FIRST, `${origins.api}${path}`);
    }
  }
});

test("T27-6 static files: /_next/static is cache-first, the public files are stale-while-revalidate", () => {
  for (const origins of [LOCAL, PROD]) {
    for (const path of ["/_next/static/chunks/x.js", "/_next/static/css/app.css", "/_next/static/media/font.woff2"]) {
      assert.deepEqual(strategy(req(`${origins.app}${path}`), origins), CACHE_FIRST, path);
    }
    for (const path of ["/icon-192.png", "/icon-512.png", "/apple-touch-icon.png", "/manifest.webmanifest", "/offline.html"]) {
      assert.deepEqual(strategy(req(`${origins.app}${path}`), origins), SWR, path);
    }
  }
});

test("T27-6 RSC and prefetch requests and other /_next paths are bypassed", () => {
  const cases = [
    req(`${APP}/?_rsc=1`, { headers: { rsc: "1" } }),
    req(`${APP}/?_rsc=abc`),
    req(`${APP}/baguio`, { headers: { rsc: "1" } }),
    req(`${APP}/baguio`, { headers: { "next-router-prefetch": "1" } }),
    req(`${APP}/baguio`, { headers: new Headers({ RSC: "1" }) }),
    req(`${APP}/`, { mode: "navigate", headers: { rsc: "1" } }),
    req(`${APP}/baguio?_rsc=abc`, { mode: "navigate" }), // the _rsc param alone (RED audit N1)
    req(`${APP}/_next/image?url=%2Ficon-192.png&w=64&q=75`),
    req(`${APP}/_next/data/build/index.json`),
  ];
  for (const r of cases) assert.deepEqual(strategy(r), BYPASS, `${r.url} ${JSON.stringify(r.headers)}`);
});

test("T27-7 navigations are network-first; saved /i/* pages go to the data cache", () => {
  for (const origins of [LOCAL, PROD]) {
    for (const path of ["/", "/baguio", "/baguio?terminal=vl-baguio", "/some-page-not-built-yet", "/i/abc/extra"]) {
      assert.deepEqual(strategy(req(`${origins.app}${path}`, { mode: "navigate" }), origins), PAGE_FIRST, path);
    }
    for (const path of ["/i/abc123", "/i/abc123/"]) {
      assert.deepEqual(strategy(req(`${origins.app}${path}`, { mode: "navigate" }), origins), SAVED_PAGE_FIRST, path);
    }
  }
});

test("T27-8 only GET is ever handled", () => {
  const cases = [
    req(`${API}/plan`, { method: "POST" }),
    req(`${APP}/`, { method: "POST" }),
    req(`${API}/trips`, { method: "PUT" }),
    req(`${API}/trips`, { method: "DELETE" }),
    req(`${API}${TRIPS}`, { method: "HEAD" }),
    req(`${APP}/`, { method: "POST", mode: "navigate" }),
    req(`${APP}/_next/static/chunks/x.js`, { method: "HEAD" }),
  ];
  for (const r of cases) assert.deepEqual(strategy(r), BYPASS, `${r.method} ${r.url}`);
});

test("T27-9 look-alikes, other origins and authorised requests are bypassed", () => {
  const cases = [
    req("https://www.google.com/maps/dir/?api=1&destination=Baguio"),
    req("https://sakay.ph/"),
    req(`${APP}/trips`), // the app origin is not the API
    req(`${APP}${TRIPS}`),
    req(`http://localhost:8111/trips`), // same host, other port
    req(`https://localhost:8110/trips`), // same host and port, other scheme
    req(`http://127.0.0.1:8110/trips`), // same server, other host name
    req(`${API}/tripsx`),
    req(`${API}/trips/extra`),
    req(`${API}/itineraries`),
    req(`${API}/itineraries/`),
    req(`${API}/itineraries/abc/extra`),
    req(`${API}/health`),
    req(`${API}/flags`),
    req(`${API}/`),
    req(`${API}${TRIPS}`, { headers: { authorization: "Bearer x" } }),
    req(`${API}${TRIPS}`, { headers: new Headers({ Authorization: "Bearer x" }) }),
    req(`${APP}/icon-192.png`, { headers: { authorization: "Bearer x" } }),
  ];
  for (const r of cases) assert.deepEqual(strategy(r), BYPASS, `${r.url} ${JSON.stringify(r.headers)}`);
  for (const r of [req(`${PROD.app}/trips`), req(`https://other.up.railway.app/trips`), req(`${API}/trips`)]) {
    assert.deepEqual(strategy(r, PROD), BYPASS, `prod ${r.url}`);
  }
});

test("with no API origin configured, no API request is cached", () => {
  for (const path of API_GETS) {
    assert.deepEqual(strategy(req(`${API}${path}`), { app: APP, api: null } as never), BYPASS, path);
  }
});

// ---------------------------------------------------------------- what gets stored

test("T27-10 shouldStore: only full 200s, whatever Cache-Control says", () => {
  const sw = tg();
  assert.equal(sw.shouldStore(new Response("[]", { status: 200 })), true);
  assert.equal(sw.shouldStore(new Response("[]", { status: 200, headers: { "Cache-Control": "no-store" } })), true);
  assert.equal(sw.shouldStore(new Response("[]", { status: 200, headers: { "Cache-Control": "private, max-age=0" } })), true);
  for (const status of [201, 204, 206, 301, 404, 422, 500, 503]) {
    const body = [204].includes(status) ? null : "x";
    assert.equal(sw.shouldStore(new Response(body, { status })), false, String(status));
  }
  assert.equal(sw.shouldStore({ status: 0, type: "opaque" }), false);
  assert.equal(sw.shouldStore({ status: 200, type: "opaque" }), false);
  assert.equal(sw.shouldStore(Response.error()), false);
});

test("isServerFailure is 5xx only", () => {
  const sw = tg();
  for (const status of [500, 502, 503, 504]) assert.equal(sw.isServerFailure(new Response("x", { status })), true);
  for (const status of [200, 304, 404, 422]) {
    assert.equal(sw.isServerFailure(new Response(status === 304 ? null : "x", { status })), false);
  }
});

// T27-12 (moved here from offline.test.ts: stamping lives in sw.js)
test("T27-12 saved-at stamp round trip, in any device time zone", async () => {
  const sw = tg();
  for (const tz of ["America/Los_Angeles", "Pacific/Kiritimati", "Asia/Manila"]) {
    process.env.TZ = tz;
    const original = new Response('[{"id":1}]', {
      status: 200,
      statusText: "OK",
      headers: { "Content-Type": "application/json" },
    });
    const stamped = sw.stampSavedAt(original.clone(), OLD_ISO);
    assert.equal(stamped.headers.get("X-TG-Saved-At"), OLD_ISO, tz);
    assert.equal(stamped.status, 200);
    assert.equal(stamped.statusText, "OK");
    assert.equal(stamped.headers.get("Content-Type"), "application/json");
    assert.equal(sw.readSavedAt(stamped), OLD_ISO);
    // The stamp is on the stored response itself, so reading it later gives the same instant
    assert.equal(Date.parse(sw.readSavedAt(stamped.clone())), Date.parse("2026-10-30T13:12:00Z"));
    assert.deepEqual(await stamped.json(), [{ id: 1 }]);
    assert.equal(original.headers.get("X-TG-Saved-At"), null, "stamping must not change the response it was given");
  }
});

test("T27-12 readSavedAt gives null for a missing or garbage stamp", () => {
  const sw = tg();
  assert.equal(sw.readSavedAt(new Response("x")), null);
  for (const bad of ["", "yesterday", "NaN", "2026-13-45T99:99:99Z"]) {
    assert.equal(sw.readSavedAt(new Response("x", { headers: { "X-TG-Saved-At": bad } })), null, bad);
  }
});

// ---------------------------------------------------------------- networkFirst (T27-10, T27-11, review fix 1)

const json = (body: unknown, status = 200, savedAt?: string) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...(savedAt ? { "X-TG-Saved-At": savedAt } : {}) },
  });

/** networkFirst with recorded I/O. `cachedCopy` is what readCache returns. */
function runNetworkFirst(network: () => Promise<Response>, cachedCopy?: Response, timeoutMs = 20) {
  const writes: Response[] = [];
  let reads = 0;
  const run = tg().networkFirst({
    network,
    readCache: async () => {
      reads++;
      return cachedCopy?.clone();
    },
    writeCache: async (res: Response) => void writes.push(res),
    timeoutMs,
    nowIso: () => "2026-11-06T01:00:00.000Z",
  });
  return { run, writes, reads: () => reads };
}

test("networkFirst returns a result and a done promise", async () => {
  const { run } = runNetworkFirst(async () => json([]));
  assert.equal(typeof run.result?.then, "function", "result must be a promise");
  assert.equal(typeof run.done?.then, "function", "done must be a promise");
  await run.result;
  await run.done;
});

test("T27-10 a 200 is served and stored with the saved-at stamp", async () => {
  const { run, writes } = runNetworkFirst(async () => json([{ id: "fresh" }]));
  const r = await run.result;
  assert.equal(r.source, "network");
  assert.deepEqual(await r.response.json(), [{ id: "fresh" }]);
  await run.done;
  assert.equal(writes.length, 1);
  assert.equal(writes[0].headers.get("X-TG-Saved-At"), "2026-11-06T01:00:00.000Z");
  assert.deepEqual(await writes[0].json(), [{ id: "fresh" }], "the stored copy keeps its own body");
});

test("T27-10 a 200 marked no-store is still stored", async () => {
  const { run, writes } = runNetworkFirst(
    async () => new Response("[]", { status: 200, headers: { "Cache-Control": "no-store" } }),
  );
  await run.result;
  await run.done;
  assert.equal(writes.length, 1);
});

test("T27-10 a 500 never overwrites the good copy, and the good copy is served", async () => {
  const { run, writes } = runNetworkFirst(async () => json({ detail: "boom" }, 500), json([{ id: "good" }], 200, OLD_ISO));
  const r = await run.result;
  assert.equal(r.source, "cache");
  assert.equal(r.savedAt, OLD_ISO);
  assert.deepEqual(await r.response.json(), [{ id: "good" }]);
  await run.done;
  assert.equal(writes.length, 0);
});

test("a 500 with nothing cached is passed through", async () => {
  const { run, writes } = runNetworkFirst(async () => json({ detail: "boom" }, 503));
  const r = await run.result;
  assert.equal(r.source, "none");
  assert.equal(r.response.status, 503);
  await run.done;
  assert.equal(writes.length, 0);
});

test("a network error falls back to the cached copy", async () => {
  const { run, writes } = runNetworkFirst(async () => Promise.reject(new TypeError("Failed to fetch")), json([1], 200, OLD_ISO));
  const r = await run.result;
  assert.equal(r.source, "cache");
  assert.equal(r.savedAt, OLD_ISO);
  assert.deepEqual(await r.response.json(), [1]);
  await run.done;
  assert.equal(writes.length, 0);
});

test("a network error with nothing cached gives no response and source none", async () => {
  const { run } = runNetworkFirst(async () => Promise.reject(new TypeError("Failed to fetch")));
  const r = await run.result;
  assert.equal(r.source, "none");
  assert.equal(r.response, null);
  assert.equal(r.savedAt, null);
  await run.done;
});

test("a cached copy without a stamp reports savedAt null", async () => {
  const { run } = runNetworkFirst(async () => Promise.reject(new TypeError("offline")), json([1]));
  const r = await run.result;
  assert.equal(r.source, "cache");
  assert.equal(r.savedAt, null);
});

test("T27-10 a 4xx is passed through and not stored", async () => {
  for (const status of [404, 422]) {
    const { run, writes } = runNetworkFirst(async () => json({ detail: "x" }, status), json([1], 200, OLD_ISO));
    const r = await run.result;
    assert.equal(r.source, "network", String(status));
    assert.equal(r.response.status, status);
    await run.done;
    assert.equal(writes.length, 0, String(status));
  }
});

test("T27-11 after the timeout the cached copy is served, and done waits for the late write", async () => {
  const net = deferred<Response>();
  const { run, writes } = runNetworkFirst(() => net.promise, json([{ id: "old" }], 200, OLD_ISO), 20);
  let doneSettled = false;
  run.done.then(() => (doneSettled = true));
  const r = await run.result; // resolves after ~20 ms although the network is still pending
  assert.equal(r.source, "cache");
  assert.equal(r.savedAt, OLD_ISO);
  assert.deepEqual(await r.response.json(), [{ id: "old" }]);
  await flush();
  assert.equal(doneSettled, false, "done must stay pending while the network is still out");
  assert.equal(writes.length, 0);
  net.resolve(json([{ id: "new" }]));
  await run.done;
  assert.equal(writes.length, 1, "the late network answer still refreshes the cache");
  assert.deepEqual(await writes[0].json(), [{ id: "new" }]);
});

test("T27-11 with nothing cached it keeps waiting for the network past the timeout", async () => {
  const net = deferred<Response>();
  const { run, writes } = runNetworkFirst(() => net.promise, undefined, 10);
  let settled = false;
  run.result.then(() => (settled = true));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(settled, false, "must not give up early when there's nothing to fall back to");
  net.resolve(json([{ id: "slow" }]));
  const r = await run.result;
  assert.equal(r.source, "network");
  assert.deepEqual(await r.response.json(), [{ id: "slow" }]);
  await run.done;
  assert.equal(writes.length, 1);
});

test("a fast answer doesn't wait for the timeout", async () => {
  const { run } = runNetworkFirst(async () => json([]), json([1], 200, OLD_ISO), 10_000);
  const started = Date.now();
  const r = await run.result;
  assert.equal(r.source, "network");
  assert.ok(Date.now() - started < 1000);
});

test("done resolves even when the cache write fails", async () => {
  const run = tg().networkFirst({
    network: async () => json([]),
    readCache: async () => undefined,
    writeCache: async () => Promise.reject(new Error("QuotaExceededError")),
    timeoutMs: 20,
    nowIso: () => OLD_ISO,
  });
  assert.equal((await run.result).source, "network");
  await run.done;
});

// ---------------------------------------------------------------- caches across versions

test("T27-15 cache names are versioned; data survives SW versions", () => {
  const sw = tg();
  const v1 = plain(sw.cacheNames("v1"));
  const v2 = plain(sw.cacheNames("v2"));
  assert.deepEqual(v1, { static: "tg-static-v1", pages: "tg-pages-v1", data: `tg-data-${sw.DATA_VERSION}` });
  assert.notEqual(v1.static, v2.static);
  assert.notEqual(v1.pages, v2.pages);
  assert.equal(v1.data, v2.data, "saved data is kept when the SW updates");
  for (const name of Object.values(sw.cacheNames(sw.SW_VERSION)) as string[]) assert.match(name, /^tg-/);
  for (const bad of ["", "   ", undefined, null]) assert.throws(() => sw.cacheNames(bad), String(bad));
});

test("T27-16 cachesToDelete rotates static and pages, keeps current data and other libraries' caches", () => {
  const sw = tg();
  const current = `tg-data-${sw.DATA_VERSION}`;
  const stale = `tg-data-${sw.DATA_VERSION}-old`;
  const all = ["tg-static-v1", "tg-pages-v1", current, stale, "tg-static-v2", "tg-pages-v2", "other-lib-cache"];
  assert.deepEqual(plain(sw.cachesToDelete(all, "v2")).sort(), ["tg-pages-v1", "tg-static-v1", stale].sort());
  assert.deepEqual(plain(sw.cachesToDelete([], "v2")), []);
  assert.deepEqual(plain(sw.cachesToDelete(["other-lib-cache", "workbox-precache"], "v2")), []);
  assert.deepEqual(plain(sw.cachesToDelete(["tg-static-v2", "tg-pages-v2", current], "v2")), []);
});

test("T27-16 the review's fixture: tg-data-1 kept, tg-data-0 deleted", (t) => {
  const sw = tg();
  if (sw.DATA_VERSION !== "1") return t.skip("the fixture is written for the first data format");
  const all = ["tg-static-v1", "tg-pages-v1", "tg-data-1", "tg-data-0", "tg-static-v2", "tg-pages-v2", "other-lib-cache"];
  assert.deepEqual(plain(sw.cachesToDelete(all, "v2")).sort(), ["tg-data-0", "tg-pages-v1", "tg-static-v1"]);
});

// ---------------------------------------------------------------- precache helper

test("extractStaticUrls finds /_next/static URLs in HTML and inline RSC payloads", () => {
  const html = [
    '<link rel="stylesheet" href="/_next/static/css/app-123.css" data-precedence="next"/>',
    '<script src="/_next/static/chunks/main-abc.js" async=""></script>',
    '<script src="/_next/static/chunks/main-abc.js" async=""></script>',
    '<script>self.__next_f.push([1,"1:I[\\"/_next/static/chunks/x.js\\",[]]"])</script>',
    "<style>@font-face{src:url(/_next/static/media/font.woff2)}</style>",
    '<img src="/icon-192.png"/>',
  ].join("\n");
  assert.deepEqual(plain(tg().extractStaticUrls(html)), [
    "/_next/static/css/app-123.css",
    "/_next/static/chunks/main-abc.js",
    "/_next/static/chunks/x.js",
    "/_next/static/media/font.woff2",
  ]);
  assert.deepEqual(plain(tg().extractStaticUrls("<p>nothing</p>")), []);
});

// ---------------------------------------------------------------- event glue

/**
 * An ExtendableEvent / FetchEvent that enforces the lifetime rules a browser does: respondWith only
 * while dispatching, and waitUntil after dispatch only while another lifetime promise is pending.
 */
function fakeEvent(fields: Record<string, unknown> = {}) {
  let dispatching = true;
  let pending = 0;
  const log = {
    responses: [] as Promise<Response>[],
    waits: [] as { promise: Promise<unknown>; duringDispatch: boolean; settled: boolean }[],
    errors: [] as string[],
  };
  const track = (p: Promise<unknown>) => {
    pending++;
    p.then(
      () => pending--,
      () => pending--,
    );
  };
  const event = {
    ...fields,
    respondWith(p: Response | Promise<Response>) {
      if (!dispatching) {
        log.errors.push("respondWith after dispatch");
        throw new Error("InvalidStateError");
      }
      const promise = Promise.resolve(p);
      promise.catch(() => {});
      log.responses.push(promise);
      track(promise);
    },
    waitUntil(p: unknown) {
      if (!dispatching && pending === 0) {
        log.errors.push("waitUntil after the event finished");
        throw new Error("InvalidStateError");
      }
      const promise = Promise.resolve(p);
      const entry = { promise, duringDispatch: dispatching, settled: false };
      promise.then(
        () => (entry.settled = true),
        () => (entry.settled = true),
      );
      log.waits.push(entry);
      track(promise);
    },
  };
  const dispatch = (handlers: Handler[]) => {
    try {
      for (const h of handlers) h(event);
    } finally {
      dispatching = false;
    }
  };
  const allWaits = async () => {
    for (let i = 0; i < log.waits.length; i++) await log.waits[i].promise.catch(() => {});
  };
  return { event, log, dispatch, allWaits };
}

/** A FetchEvent's request: a real Request whose mode can be "navigate" (the constructor forbids it). */
class NavRequest extends Request {
  get mode() {
    return "navigate" as RequestMode;
  }
}

function swEnv(fetchImpl: (req: string | Request, init?: RequestInit) => Promise<Response>) {
  const clock = fakeClock();
  const caches = new FakeCacheStorage();
  const fetchCalls: { url: string; init?: RequestInit; cache?: string }[] = [];
  const fetch = (r: string | Request, init?: RequestInit) => {
    fetchCalls.push({ url: urlOf(r), init, cache: init?.cache ?? (typeof r === "string" ? undefined : r.cache) });
    return fetchImpl(r, init);
  };
  fakeGlobalFetch = fetch;
  const messages: { clientId: string; data: unknown }[] = [];
  let claims = 0;
  const clients = {
    get: async (id: string) => (id ? { id, postMessage: (data: unknown) => void messages.push({ clientId: id, data: plain(data) }) } : undefined),
    matchAll: async () => [],
    claim: async () => void claims++,
  };
  const loaded = loadSw({ caches, fetch, clients, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  const names = plain(loaded.sw.cacheNames(loaded.sw.SW_VERSION));
  const seed = async (cacheName: string, url: string, res: Response) => (await caches.open(cacheName)).put(url, res);
  return { ...loaded, clock, caches, fetchCalls, messages, names, seed, claims: () => claims };
}

type EventLog = ReturnType<typeof fakeEvent>["log"];
/** The one response the handler gave, failing clearly when it didn't call respondWith. */
function responded(log: EventLog) {
  assert.equal(log.responses.length, 1, "the fetch handler must call respondWith once");
  return log.responses[0];
}
/** The first lifetime promise, failing clearly when the handler didn't call waitUntil. */
function waited(log: EventLog) {
  assert.ok(log.waits.length >= 1, "the handler must call event.waitUntil");
  return log.waits[0].promise;
}

const fetchEvent = (request: Request, clientId = "client-1") => fakeEvent({ request, clientId, resultingClientId: "" });

test("fetch: bypassed requests get no respondWith and no fetch", () => {
  const env = swEnv(async () => json([]));
  for (const r of [
    new Request(`${API}/plan`, { method: "POST", body: "{}" }),
    // POSTs to allow-listed API paths and a same-origin form post (RED audit S2)
    new Request(`${API}/trips`, { method: "POST", body: "{}" }),
    new Request(`${API}/itineraries/abc`, { method: "POST", body: "{}" }),
    new NavRequest(`${APP}/`, { method: "POST", body: "x=1" }),
    new Request(`${APP}/sw.js`),
    new Request(`${API}/health`),
    new Request("https://sakay.ph/"),
  ]) {
    const { log, dispatch } = fetchEvent(r);
    dispatch(env.handlers.fetch);
    assert.equal(log.responses.length, 0, `${r.method} ${r.url}`);
  }
  assert.equal(env.fetchCalls.length, 0);
});

test("fetch API: a 200 is served, stored with its stamp and reported as network", async () => {
  const env = swEnv(async () => json([{ id: "fresh" }]));
  const url = `${API}${TRIPS}`;
  const { log, dispatch, allWaits } = fetchEvent(new Request(url));
  dispatch(env.handlers.fetch);
  assert.equal(log.responses.length, 1);
  assert.deepEqual(await (await responded(log)).json(), [{ id: "fresh" }]);
  await allWaits();
  assert.deepEqual(log.errors, []);
  const stored = await (await env.caches.open(env.names.data)).match(url);
  assert.ok(stored, "stored in the data cache");
  assert.ok(env.sw.readSavedAt(stored), "stored copy carries X-TG-Saved-At");
  assert.equal(env.messages.length, 1);
  assert.equal((env.messages[0].data as { source: string }).source, "network");
  assert.equal((env.messages[0].data as { type: string }).type, "tg-sw:data");
  assert.equal(env.messages[0].clientId, "client-1");
});

test("fetch API: a 500 serves the good copy, keeps it and reports cache", async () => {
  const env = swEnv(async () => json({ detail: "boom" }, 500));
  const url = `${API}${TRIPS}`;
  await env.seed(env.names.data, url, json([{ id: "good" }], 200, OLD_ISO));
  const { log, dispatch, allWaits } = fetchEvent(new Request(url));
  dispatch(env.handlers.fetch);
  assert.deepEqual(await (await responded(log)).json(), [{ id: "good" }]);
  await allWaits();
  assert.deepEqual(log.errors, []);
  const stored = await (await env.caches.open(env.names.data)).match(url);
  assert.equal(stored!.headers.get("X-TG-Saved-At"), OLD_ISO, "the good copy is untouched");
  assert.deepEqual(env.messages.map((m) => m.data), [{ type: "tg-sw:data", source: "cache", savedAt: OLD_ISO, url }]);
});

test("fetch API: offline with nothing cached gives a network error and reports none", async () => {
  const env = swEnv(async () => Promise.reject(new TypeError("Failed to fetch")));
  const url = `${API}/trips?origin_city=Metro%20Manila&destination_city=Baguio&date=2026-11-20`;
  const { log, dispatch, allWaits } = fetchEvent(new Request(url));
  dispatch(env.handlers.fetch);
  const res = await responded(log);
  assert.equal(res.type, "error", "the page's own error path must run");
  await allWaits();
  assert.deepEqual(log.errors, []);
  assert.deepEqual(env.messages.map((m) => m.data), [{ type: "tg-sw:data", source: "none", savedAt: null, url }]);
});

// Review should-fix 1: the lifetime promise is registered in the handler, not after the response settles
test("fetch API: waitUntil is registered during dispatch and outlives a timeout fallback", async () => {
  const net = deferred<Response>();
  const env = swEnv(() => net.promise);
  const url = `${API}${TRIPS}`;
  await env.seed(env.names.data, url, json([{ id: "old" }], 200, OLD_ISO));
  const { log, dispatch, allWaits } = fetchEvent(new Request(url));
  dispatch(env.handlers.fetch);
  assert.equal(log.responses.length, 1);
  assert.ok(log.waits.length >= 1, "the fetch handler must call event.waitUntil itself");
  assert.ok(
    log.waits.every((w) => w.duringDispatch),
    "every waitUntil must be called synchronously in the fetch handler",
  );

  await flush();
  assert.equal(log.waits.some((w) => w.settled), false);
  await env.clock.advance(env.sw.NETWORK_TIMEOUT_MS);
  const res = await responded(log);
  assert.deepEqual(await res.json(), [{ id: "old" }], "the cached copy is served after the timeout");
  await flush();
  assert.ok(
    log.waits.some((w) => !w.settled),
    "the event must stay alive while the network is still out",
  );

  net.resolve(json([{ id: "new" }]));
  await allWaits();
  assert.deepEqual(log.errors, [], "no waitUntil after the event finished");
  assert.ok(log.waits.every((w) => w.duringDispatch));
  const stored = await (await env.caches.open(env.names.data)).match(url);
  assert.deepEqual(await stored!.json(), [{ id: "new" }], "the late answer refreshes the saved copy");
  assert.notEqual(stored!.headers.get("X-TG-Saved-At"), OLD_ISO);
  assert.deepEqual(env.messages.map((m) => m.data), [{ type: "tg-sw:data", source: "cache", savedAt: OLD_ISO, url }]);
});

test("fetch API: the message path also registers its waitUntil during dispatch", async () => {
  const env = swEnv(async () => json([{ id: "fresh" }]));
  const { log, dispatch, allWaits } = fetchEvent(new Request(`${API}/spots`));
  dispatch(env.handlers.fetch);
  assert.ok(log.waits.length >= 1 && log.waits.every((w) => w.duringDispatch));
  await allWaits();
  assert.deepEqual(log.errors, []);
  assert.equal(env.messages.length, 1);
});

test("fetch API: a 404 is passed through, not stored, reported as network", async () => {
  const env = swEnv(async () => json({ detail: "Itinerary not found" }, 404));
  const url = `${API}/itineraries/nope`;
  const { log, dispatch, allWaits } = fetchEvent(new Request(url));
  dispatch(env.handlers.fetch);
  assert.equal((await responded(log)).status, 404);
  await allWaits();
  assert.equal(await (await env.caches.open(env.names.data)).match(url), undefined);
  assert.equal((env.messages[0].data as { source: string }).source, "network");
});

test("fetch page: offline, a cached page is served even with a different query", async () => {
  const env = swEnv(async () => Promise.reject(new TypeError("offline")));
  await env.seed(env.names.pages, `${APP}/baguio`, new Response("<p>baguio</p>", { headers: { "Content-Type": "text/html" } }));
  await env.seed(env.names.static, `${APP}/offline.html`, new Response("<p>offline</p>"));
  for (const path of ["/baguio", "/baguio?terminal=vl-baguio"]) {
    const { log, dispatch, allWaits } = fetchEvent(new NavRequest(`${APP}${path}`), "");
    dispatch(env.handlers.fetch);
    assert.equal(await (await responded(log)).text(), "<p>baguio</p>", path);
    await allWaits();
    assert.deepEqual(log.errors, []);
  }
});

test("fetch page: offline and never cached shows /offline.html, not the browser's error page", async () => {
  const env = swEnv(async () => Promise.reject(new TypeError("offline")));
  await env.seed(env.names.static, `${APP}/offline.html`, new Response("<p>offline</p>"));
  for (const path of ["/i/unknown-slug", "/never-built"]) {
    const { log, dispatch, allWaits } = fetchEvent(new NavRequest(`${APP}${path}`), "");
    dispatch(env.handlers.fetch);
    assert.equal(await (await responded(log)).text(), "<p>offline</p>", path);
    await allWaits();
    assert.deepEqual(log.errors, []);
  }
});

test("fetch page: online, the page is stored in the pages cache; /i/* in the data cache", async () => {
  const env = swEnv(async (r) => new Response(`<p>${new URL(urlOf(r)).pathname}</p>`, { headers: { "Content-Type": "text/html" } }));
  for (const [path, cacheName] of [
    ["/baguio", env.names.pages],
    ["/i/abc123", env.names.data],
  ]) {
    const { log, dispatch, allWaits } = fetchEvent(new NavRequest(`${APP}${path}`), "");
    dispatch(env.handlers.fetch);
    assert.equal(await (await responded(log)).text(), `<p>${path}</p>`);
    assert.ok(log.waits.every((w) => w.duringDispatch));
    await allWaits();
    assert.deepEqual(log.errors, []);
    const stored = await (await env.caches.open(cacheName)).match(`${APP}${path}`);
    assert.ok(stored, `${path} stored in ${cacheName}`);
    assert.ok(env.sw.readSavedAt(stored));
  }
  assert.equal(env.messages.length, 0, "page navigations post no data message in Part A");
});

test("fetch static: cache-first finds a chunk in any cache, else fetches and stores it", async () => {
  const env = swEnv(async () => new Response("fetched();"));
  await env.seed("tg-static-older", `${APP}/_next/static/chunks/old.js`, new Response("old();"));
  let ev = fetchEvent(new Request(`${APP}/_next/static/chunks/old.js`));
  ev.dispatch(env.handlers.fetch);
  assert.equal(await (await responded(ev.log)).text(), "old();");
  assert.equal(env.fetchCalls.length, 0);

  ev = fetchEvent(new Request(`${APP}/_next/static/chunks/new.js`));
  ev.dispatch(env.handlers.fetch);
  // The store on a miss is registered in the handler too (RED audit S3)
  assert.ok(ev.log.waits.length >= 1 && ev.log.waits.every((w) => w.duringDispatch));
  assert.equal(await (await responded(ev.log)).text(), "fetched();");
  await ev.allWaits();
  await flush();
  assert.deepEqual(ev.log.errors, []);
  assert.ok(await (await env.caches.open(env.names.static)).match(`${APP}/_next/static/chunks/new.js`));
});

// RED audit S4: a missing hashed chunk cached under cache-first would be served until the next SW_VERSION
test("fetch static: cache-first passes a 404 or 500 through and doesn't store it", async () => {
  for (const status of [404, 500]) {
    const env = swEnv(async () => new Response("missing", { status }));
    const url = `${APP}/_next/static/chunks/gone-${status}.js`;
    const { log, dispatch, allWaits } = fetchEvent(new Request(url));
    dispatch(env.handlers.fetch);
    assert.equal((await responded(log)).status, status);
    await allWaits();
    assert.deepEqual(log.errors, []);
    assert.equal(await env.caches.match(url), undefined, `${status} stored`);
  }
});

test("fetch static: stale-while-revalidate serves the cached file and refreshes it within the event", async () => {
  const env = swEnv(async () => new Response("new-bytes"));
  const url = `${APP}/icon-192.png`;
  await env.seed(env.names.static, url, new Response("old-bytes"));
  const { log, dispatch, allWaits } = fetchEvent(new Request(url));
  dispatch(env.handlers.fetch);
  assert.equal(await (await responded(log)).text(), "old-bytes");
  assert.ok(log.waits.length >= 1 && log.waits.every((w) => w.duringDispatch), "revalidation is registered in the handler");
  await allWaits();
  assert.deepEqual(log.errors, []);
  assert.equal(await (await (await env.caches.open(env.names.static)).match(url))!.text(), "new-bytes");
});

test("install: precaches pages with a stamp and their static files, and waits (no skipWaiting)", async () => {
  const pages: Record<string, string> = {
    "/": '<script src="/_next/static/chunks/main.js"></script><link href="/_next/static/css/app.css" rel="stylesheet">',
    "/baguio": '<script src="/_next/static/chunks/baguio.js"></script>',
  };
  const env = swEnv(async (r) => {
    const path = new URL(urlOf(r)).pathname;
    return new Response(pages[path] ?? `file ${path}`, { status: 200 });
  });
  const { log, dispatch, allWaits } = fakeEvent();
  dispatch(env.handlers.install);
  assert.ok(log.waits.length >= 1 && log.waits[0].duringDispatch);
  await allWaits();
  assert.deepEqual(log.errors, []);
  for (const path of ["/", "/baguio"]) {
    const page = await (await env.caches.open(env.names.pages)).match(`${APP}${path}`);
    assert.ok(page, `${path} precached`);
    assert.ok(env.sw.readSavedAt(page), `${path} stamped`);
    const call = env.fetchCalls.find((c) => new URL(c.url).pathname === path);
    assert.equal(call?.cache, "reload", `${path} fetched past the HTTP cache`);
  }
  const statics = await env.caches.open(env.names.static);
  for (const path of ["/_next/static/chunks/main.js", "/_next/static/css/app.css", "/_next/static/chunks/baguio.js", ...env.sw.STATIC_FILES]) {
    assert.ok(await statics.match(`${APP}${path}`), `${path} precached`);
  }
  assert.ok(await env.caches.match(`${APP}/offline.html`), "offline.html precached");
  assert.equal(env.scope.skipWaitingCalls, 0, "prompt model: the new worker waits");
  for (const name of await env.caches.keys()) {
    for (const key of await (await env.caches.open(name)).keys()) {
      assert.notEqual(new URL(key.url).pathname, "/sw.js", `sw.js cached in ${name}`);
    }
  }
});

test("install: fails when / can't be fetched, so the browser retries later", async () => {
  const env = swEnv(async (r) => (new URL(urlOf(r)).pathname === "/" ? new Response("down", { status: 503 }) : new Response("ok")));
  const { log, dispatch } = fakeEvent();
  dispatch(env.handlers.install);
  await assert.rejects(waited(log));
});

test("install: a missing static file is only logged", async () => {
  const env = swEnv(async (r) => {
    const path = new URL(urlOf(r)).pathname;
    if (path === "/icon-512.png") return new Response("nope", { status: 404 });
    return new Response(path === "/" ? '<script src="/_next/static/chunks/main.js"></script>' : "ok");
  });
  const { log, dispatch } = fakeEvent();
  dispatch(env.handlers.install);
  await waited(log);
  assert.ok(env.logs.some((l) => l.level === "warn"), "precache miss is logged as a warning");
});

test("activate: deletes old caches, keeps data and other caches, carries /i/* assets, claims clients", async () => {
  const env = swEnv(async () => new Response("unused"));
  const dataName = env.names.data;
  await env.seed("tg-static-older", `${APP}/_next/static/chunks/itin.js`, new Response("itin();"));
  await env.seed("tg-pages-older", `${APP}/`, new Response("<p>old home</p>"));
  await env.seed(dataName, `${APP}/i/abc123`, new Response('<script src="/_next/static/chunks/itin.js"></script>'));
  await env.seed(dataName, `${API}${TRIPS}`, json([1], 200, OLD_ISO));
  await env.seed(`${dataName}-old`, `${API}/spots`, json([]));
  await env.seed("other-lib-cache", "https://example.com/x", new Response("x"));
  const { log, dispatch, allWaits } = fakeEvent();
  dispatch(env.handlers.activate);
  assert.ok(log.waits.length >= 1 && log.waits.every((w) => w.duringDispatch));
  await allWaits();
  assert.deepEqual(log.errors, []);
  const names = await env.caches.keys();
  for (const gone of ["tg-static-older", "tg-pages-older", `${dataName}-old`]) assert.ok(!names.includes(gone), `${gone} deleted`);
  for (const kept of [dataName, "other-lib-cache"]) assert.ok(names.includes(kept), `${kept} kept`);
  assert.ok(await (await env.caches.open(dataName)).match(`${API}${TRIPS}`), "saved trips survive the update");
  const carried = await (await env.caches.open(env.names.static)).match(`${APP}/_next/static/chunks/itin.js`);
  assert.equal(await carried?.text(), "itin();", "a saved itinerary's chunks move into the new static cache");
  assert.equal(env.claims(), 1);
});

test("message: SKIP_WAITING activates the waiting worker; anything else is ignored", () => {
  const env = swEnv(async () => new Response(""));
  for (const data of [null, undefined, "SKIP_WAITING", { type: "other" }, { type: "tg-sw:data" }]) {
    fakeEvent({ data }).dispatch(env.handlers.message);
  }
  assert.equal(env.scope.skipWaitingCalls, 0);
  fakeEvent({ data: { type: "SKIP_WAITING" } }).dispatch(env.handlers.message);
  assert.equal(env.scope.skipWaitingCalls, 1);
});

// ---------------------------------------------------------------- TG-43 A1: the ready-made list offline

const PREMADE = `${API}/premade-itineraries`;

// T43-O1 is the API_GETS entry above (T27-5, and the no-origin test)

test("T43-O2 look-alikes of /premade-itineraries are bypassed", () => {
  const cases = [
    req(`${API}/premade-itineraries/`),
    req(`${API}/premade-itineraries/abc`),
    req(`${API}/premade-itinerariesx`),
    req(`${API}/xpremade-itineraries`),
    req(`${APP}/premade-itineraries`), // the app origin is not the API
    req(PREMADE, { method: "POST" }),
    req(PREMADE, { method: "HEAD" }),
    req(PREMADE, { headers: { authorization: "Bearer x" } }),
  ];
  for (const r of cases) assert.deepEqual(strategy(r), BYPASS, `${r.method} ${r.url} ${JSON.stringify(r.headers)}`);
});

test("T43-O3 offline, the saved ready-made list is served with TG-27's saved-at message", async () => {
  const env = swEnv(async () => Promise.reject(new TypeError("Failed to fetch")));
  await env.seed(env.names.data, PREMADE, json([{ share_slug: "premade-x" }], 200, OLD_ISO));
  const { log, dispatch, allWaits } = fetchEvent(new Request(PREMADE));
  dispatch(env.handlers.fetch);
  assert.deepEqual(await (await responded(log)).json(), [{ share_slug: "premade-x" }]);
  await allWaits();
  assert.deepEqual(log.errors, []);
  assert.ok(log.waits.every((w) => w.duringDispatch), "waitUntil only during dispatch");
  assert.deepEqual(env.messages.map((m) => m.data), [{ type: "tg-sw:data", source: "cache", savedAt: OLD_ISO, url: PREMADE }]);
});

// Strict on purpose: it needs the worker to handle the request, so it fails at RED (the test plan expected a
// vacuous pass there). After GREEN it pins "a 404 (the API flag off) never replaces the saved list".
test("T43-O3b a 404 from the list is passed through and never replaces the saved copy", async () => {
  const env = swEnv(async () => json({ detail: "Not Found" }, 404));
  await env.seed(env.names.data, PREMADE, json([{ share_slug: "premade-x" }], 200, OLD_ISO));
  const { log, dispatch, allWaits } = fetchEvent(new Request(PREMADE));
  dispatch(env.handlers.fetch);
  assert.equal((await responded(log)).status, 404);
  await allWaits();
  const stored = await (await env.caches.open(env.names.data)).match(PREMADE);
  assert.equal(stored?.headers.get("X-TG-Saved-At"), OLD_ISO, "the saved list is untouched");
  assert.equal((env.messages[0]?.data as { source: string } | undefined)?.source, "network");
});

test("T43-O3c online, the list is served and stored with its stamp", async () => {
  const env = swEnv(async () => json([{ share_slug: "premade-y" }]));
  const { log, dispatch, allWaits } = fetchEvent(new Request(PREMADE));
  dispatch(env.handlers.fetch);
  assert.deepEqual(await (await responded(log)).json(), [{ share_slug: "premade-y" }]);
  await allWaits();
  const stored = await (await env.caches.open(env.names.data)).match(PREMADE);
  assert.ok(stored, "stored in the data cache, which survives SW versions");
  assert.ok(env.sw.readSavedAt(stored), "stored copy carries X-TG-Saved-At");
  assert.equal((env.messages[0]?.data as { source: string } | undefined)?.source, "network");
});

test("T43-O4 /plan is precached with / and /baguio", () => {
  const sw = tg();
  for (const p of ["/", "/baguio", "/plan"]) assert.ok(sw.PRECACHE_PAGES.includes(p), p);
  assert.ok(!sw.PRECACHE_PAGES.some((p: string) => p.startsWith("/sw.js")));
});

// Strict like O3b: it fails at RED because /plan isn't precached yet; after GREEN it pins "a /plan miss can't break
// an install" (only a miss on / does)
test("T43-O4b install survives a /plan miss and logs it", async () => {
  const env = swEnv(async (r) => {
    const path = new URL(urlOf(r)).pathname;
    if (path === "/plan") return new Response("down", { status: 503 });
    return new Response(path === "/" ? '<script src="/_next/static/chunks/main.js"></script>' : "ok");
  });
  const { log, dispatch } = fakeEvent();
  dispatch(env.handlers.install);
  await waited(log); // resolves: the install isn't failed
  const pages = await env.caches.open(env.names.pages);
  for (const path of ["/", "/baguio"]) assert.ok(await pages.match(`${APP}${path}`), `${path} precached`);
  const warns = env.logs.filter((l) => l.level === "warn").map((l) => l.args.join(" "));
  assert.equal(warns.filter((w) => /precache miss url=\/plan\b/.test(w)).length, 1, warns.join("\n"));
});

test("T43-O5 SW_VERSION changes whenever sw.js does", (t) => {
  let base: string;
  try {
    base = execFileSync("git", ["show", "origin/main:web/public/sw.js"], {
      cwd: new URL(".", SW_PATH),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    t.skip("skipped: origin/main not fetched; run locally before merging");
    return;
  }
  const now = readFileSync(SW_PATH, "utf8");
  const version = (src: string) => src.match(/const SW_VERSION = "([^"]+)"/)?.[1];
  assert.ok(version(base) && version(now), "SW_VERSION found in both");
  if (now !== base) assert.notEqual(version(now), version(base), "sw.js changed: bump SW_VERSION (again after a rebase)");
});

test("T43-O6 SW_VERSION is a Manila date plus a counter", () => {
  assert.match(tg().SW_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/);
});

// ---------------------------------------------------------------- TG-43 A1: README section 6

const README = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
const readmeSection = (heading: RegExp) => {
  const start = README.search(heading);
  assert.ok(start >= 0, `README heading ${heading}`);
  const rest = README.slice(start + 1);
  const end = rest.search(/\n##? /);
  return end < 0 ? rest : rest.slice(0, end);
};

// Manager addition (2026-10-28 21:40): --test-force-exit let node --test exit before every test registered
test("T43-T1 npm test uses a per-test timeout, never --test-force-exit", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const script: string = pkg.scripts.test;
  assert.doesNotMatch(script, /--test-force-exit/, "it dropped tests silently");
  assert.match(script, /--test-timeout=60000\b/);
});

test("T43-R1 README says npm test has a 60 s per-test timeout, why not force-exit, and how to check timers", () => {
  const web = readmeSection(/\n## 6\. Web/);
  assert.match(web, /--test-timeout=60000/);
  assert.match(web, /--test-force-exit/, "say why it isn't used");
  assert.match(web, /mock\.timers/);
  assert.doesNotMatch(web, /runs with `--test-force-exit`/, "the old note is gone");
});

test("T43-R2 README offline section: the list and /plan are saved, and the device-readiness steps", () => {
  const offline = readmeSection(/\n### Offline and install/);
  assert.match(offline, /ready-made trip list/i);
  assert.match(offline, /`\/plan`/);
  // Review S2: a trip's own page is saved only once it has been opened online
  assert.match(offline, /saved only (after|once) (you've|you have) opened it/i);
  // Review S1: numbered steps for each phone after the last deploy, and the kill switch warning
  const steps = [...offline.matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1]);
  assert.ok(steps.length >= 4, `numbered readiness steps: ${steps.join(" | ")}`);
  assert.ok(steps.some((s) => /Reload/.test(s)), "a step takes the update (Reload)");
  assert.ok(steps.some((s) => /\/plan/.test(s) && /ready-made/i.test(s)), "a step loads the ready-made list on /plan");
  assert.ok(steps.some((s) => /every ready-made trip/i.test(s)), "a step opens every ready-made trip");
  assert.match(offline, /NEXT_PUBLIC_SERVICE_WORKER=false/);
});
