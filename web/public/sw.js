// Tara Gala service worker (TG-27), hand-written with no build step.
// This file is the single source of truth: src/lib/swStrategy.test.ts loads it in node:vm and tests
// self.TG_SW and the event handlers. Bump SW_VERSION on every change so old static and page caches rotate.
// Nothing at the top level may touch caches or fetch.

const SW_VERSION = "2026-10-28.1"; // bump on every edit of this file
const DATA_VERSION = "1"; // bump only if the stored data format changes
const NETWORK_TIMEOUT_MS = 4000;
const SAVED_AT_HEADER = "X-TG-Saved-At";
const MSG_DATA = "tg-sw:data"; // SW -> page, after every API GET handled
const MSG_SKIP_WAITING = "SKIP_WAITING"; // page -> waiting SW
const API_PATHS = [/^\/(trips|last-mile|terminals|spots)$/, /^\/itineraries\/[^/]+$/];
const SAVED_PAGE = /^\/i\/[^/]+\/?$/;
const STATIC_FILES = ["/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png", "/offline.html"];
const PRECACHE_PAGES = ["/", "/baguio"];
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T/;

const log = (...args) => console.info("[tg-sw]", ...args);
const warn = (...args) => console.warn("[tg-sw]", ...args);
const errorName = (err) => (err && err.name) || String(err);
// Our own "status 404", else only the error's name (a fetch error message can carry the URL)
const reasonOf = (err) => (err && /^status \d+$/.test(err.message) ? err.message.replace(" ", "=") : `error=${errorName(err)}`);

function cacheNames(version) {
  if (typeof version !== "string" || !version.trim()) throw new Error("cacheNames needs a version");
  // data has no SW_VERSION, so saved trips and itineraries survive an update
  return { static: `tg-static-${version}`, pages: `tg-pages-${version}`, data: `tg-data-${DATA_VERSION}` };
}

/** Our caches that aren't current. Never touches a cache another library made. */
function cachesToDelete(allNames, version) {
  const current = Object.values(cacheNames(version));
  return allNames.filter((name) => /^tg-(static|pages|data)-/.test(name) && !current.includes(name));
}

/** The API origin passed as `?api=` on the registration URL, or null (then no API request is cached). */
function apiOriginFrom(scriptUrl) {
  try {
    const raw = new URL(scriptUrl).searchParams.get("api");
    if (!raw) return null;
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** A header from a Headers object or a plain object with lower-case keys. */
function headerOf(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  return headers[name] ?? null;
}

const bypass = () => ({ strategy: "bypass" });

/** What the fetch handler does with a request: { method, url, mode?, headers? } and origins { app, api }. */
function strategyFor(req, origins) {
  if (req.method !== "GET" || headerOf(req.headers, "authorization") !== null) return bypass();
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return bypass();
  }
  if (url.origin === origins.app) {
    if (url.pathname === "/sw.js") return bypass();
    // RSC payloads vary by router-state headers; offline, Next falls back to a full navigation instead
    const rsc = headerOf(req.headers, "rsc") !== null || headerOf(req.headers, "next-router-prefetch") !== null;
    if (rsc || url.searchParams.has("_rsc")) return bypass();
    if (url.pathname.startsWith("/_next/static/")) return { strategy: "cache-first", cache: "static" };
    if (req.mode === "navigate") {
      return { strategy: "network-first", cache: SAVED_PAGE.test(url.pathname) ? "data" : "pages", kind: "page" };
    }
    if (STATIC_FILES.includes(url.pathname)) return { strategy: "stale-while-revalidate", cache: "static" };
    return bypass();
  }
  if (origins.api && url.origin === origins.api && API_PATHS.some((re) => re.test(url.pathname))) {
    return { strategy: "network-first", cache: "data", kind: "api" };
  }
  return bypass();
}

/** Only full 200s are stored. Cache-Control is ignored on purpose: this is an offline store, not an HTTP cache. */
function shouldStore(res) {
  return res.status === 200 && res.type !== "opaque";
}

function isServerFailure(res) {
  return res.status >= 500;
}

/** A copy of `res` carrying the moment it was stored. Pass it a clone. */
function stampSavedAt(res, iso) {
  const headers = new Headers(res.headers);
  headers.set(SAVED_AT_HEADER, iso);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function readSavedAt(res) {
  const value = res.headers.get(SAVED_AT_HEADER);
  return value && ISO_INSTANT.test(value) && !Number.isNaN(Date.parse(value)) ? value : null;
}

/**
 * Network-first with a cache fallback. All I/O is injected.
 * `result` resolves { response, source: "network" | "cache" | "none", savedAt } as soon as there's an answer
 * (the cached copy after `timeoutMs` if the network is slow). `done` resolves once the network answer has been
 * written, or has failed, and never rejects: the fetch handler passes it to waitUntil straight away.
 */
function networkFirst({ network, readCache, writeCache, timeoutMs, nowIso }) {
  let pending;
  try {
    pending = Promise.resolve(network());
  } catch (err) {
    pending = Promise.reject(err);
  }
  // Clone before anyone reads the body, so the stored copy keeps its own
  const answer = pending.then((res) => ({ res, copy: shouldStore(res) ? res.clone() : null }));

  const done = answer
    .then(({ copy }) => copy && writeCache(stampSavedAt(copy, nowIso())), () => undefined)
    .then(
      () => undefined,
      (err) => warn(`cache write failed error=${errorName(err)}`),
    );

  const fromCache = async () => {
    const hit = await readCache();
    return hit ? { response: hit, source: "cache", savedAt: readSavedAt(hit) } : null;
  };

  const fromNetwork = answer.then(
    async ({ res }) => {
      if (isServerFailure(res)) return (await fromCache()) ?? { response: res, source: "none", savedAt: null };
      return { response: res, source: "network", savedAt: null };
    },
    async () => (await fromCache()) ?? { response: null, source: "none", savedAt: null },
  );

  const result = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    // Slow network: serve the cached copy if there is one, else keep waiting
    const timer = setTimeout(() => {
      fromCache().then((hit) => hit && finish(hit), () => undefined);
    }, timeoutMs);
    fromNetwork.then(finish, (err) => {
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });

  return { result, done };
}

/** De-duplicated /_next/static URLs in HTML, including escaped ones in inline RSC payloads. */
function extractStaticUrls(html) {
  return [...new Set(html.match(/\/_next\/static\/[^"'\s\\)<>]+/g) ?? [])];
}

function dataMessage(source, savedAt, url) {
  return { type: MSG_DATA, source, savedAt, url };
}

self.TG_SW = {
  SW_VERSION,
  DATA_VERSION,
  NETWORK_TIMEOUT_MS,
  MSG_DATA,
  MSG_SKIP_WAITING,
  PRECACHE_PAGES,
  STATIC_FILES,
  cacheNames,
  cachesToDelete,
  apiOriginFrom,
  strategyFor,
  shouldStore,
  isServerFailure,
  stampSavedAt,
  readSavedAt,
  networkFirst,
  extractStaticUrls,
  dataMessage,
};

// ---------------------------------------------------------------- event glue (thin; logic lives above)

const absolute = (path) => new URL(path, self.location.origin).href;
const nowIso = () => new Date().toISOString();

async function precache() {
  const names = cacheNames(SW_VERSION);
  const pages = await caches.open(names.pages);
  const statics = await caches.open(names.static);
  const assets = new Set(STATIC_FILES);
  let pageCount = 0;
  for (const path of PRECACHE_PAGES) {
    try {
      const res = await fetch(absolute(path), { cache: "reload" });
      if (!shouldStore(res)) throw new Error(`status ${res.status}`);
      for (const url of extractStaticUrls(await res.clone().text())) assets.add(url);
      await pages.put(absolute(path), stampSavedAt(res, nowIso()));
      pageCount++;
    } catch (err) {
      warn(`precache miss url=${path} ${reasonOf(err)}`);
      if (path === "/") throw err; // fails the install; the browser retries later
    }
  }
  const assetList = [...assets];
  const results = await Promise.allSettled(
    assetList.map(async (path) => {
      const res = await fetch(absolute(path), { cache: "reload" });
      if (!shouldStore(res)) throw new Error(`status ${res.status}`);
      await statics.put(absolute(path), res);
    }),
  );
  results.forEach((r, i) => {
    if (r.status === "rejected") warn(`precache miss url=${assetList[i]} ${reasonOf(r.reason)}`);
  });
  const staticCount = results.filter((r) => r.status === "fulfilled").length;
  log(`install v=${SW_VERSION} precached pages=${pageCount} static=${staticCount}`);
}

/** Saved /i/* pages reference hashed chunks; copy them into the new static cache before the old one goes. */
async function carryOverSavedPageAssets(names) {
  if (!(await caches.has(names.data))) return 0;
  const data = await caches.open(names.data);
  const statics = await caches.open(names.static);
  let carried = 0;
  for (const key of await data.keys()) {
    const url = new URL(key.url);
    if (url.origin !== self.location.origin || !SAVED_PAGE.test(url.pathname)) continue;
    const page = await data.match(key);
    if (!page) continue;
    for (const path of extractStaticUrls(await page.text())) {
      if (await statics.match(absolute(path))) continue;
      const hit = await caches.match(absolute(path));
      if (hit) {
        await statics.put(absolute(path), hit);
        carried++;
      }
    }
  }
  return carried;
}

async function activate() {
  const names = cacheNames(SW_VERSION);
  const carried = await carryOverSavedPageAssets(names);
  const deleted = cachesToDelete(await caches.keys(), SW_VERSION);
  await Promise.all(deleted.map((name) => caches.delete(name)));
  await self.clients.claim();
  log(`activate v=${SW_VERSION} deleted=${JSON.stringify(deleted)} carried=${carried}`);
}

// API queries hold only cities, dates and slugs, so they're logged; other URLs log the path alone
const pathOf = (url, kind) => {
  const u = new URL(url);
  return kind === "api" ? u.pathname + u.search : u.pathname;
};

async function postToClient(clientId, message) {
  if (!clientId) return;
  const client = await self.clients.get(clientId);
  if (client) client.postMessage(message);
}

// Every waitUntil below is called synchronously in the handler (review fix 1): once respondWith's promise
// settles with nothing else pending, a later waitUntil throws InvalidStateError.

function handleNetworkFirst(event, cacheName, kind) {
  const req = event.request;
  const matchOptions = kind === "page" ? { ignoreVary: true } : undefined; // Next's HTML varies on RSC headers
  const run = networkFirst({
    network: () =>
      fetch(req).catch((err) => {
        warn(`network failure kind=${kind} path=${pathOf(req.url, kind)} error=${errorName(err)}`);
        throw err;
      }),
    readCache: () => caches.open(cacheName).then((c) => c.match(req, matchOptions)),
    writeCache: (res) => caches.open(cacheName).then((c) => c.put(req, res)),
    timeoutMs: NETWORK_TIMEOUT_MS,
    nowIso,
  });
  const response = run.result.then(async (r) => {
    const path = pathOf(req.url, kind);
    if (r.source === "cache") log(`fallback served kind=${kind} source=cache path=${path} savedAt=${r.savedAt}`);
    if (r.source === "none" && r.response) warn(`server failure kind=${kind} path=${path} status=${r.response.status}`);
    if (kind === "api" || r.source !== "none") return r.response ?? Response.error();
    // A page with no copy of its own: the same page under another query, else the offline page
    const near = await caches.match(req, { ignoreSearch: true, ignoreVary: true });
    if (near) {
      log(`fallback served kind=page source=other-query path=${path} savedAt=${readSavedAt(near)}`);
      return near;
    }
    if (r.response) return r.response; // a 5xx from the server, passed through
    const offline = await caches.match(absolute("/offline.html"));
    log(`fallback served kind=page source=${offline ? "offline-page" : "none"} path=${path}`);
    return offline ?? Response.error();
  });
  event.respondWith(response);
  const message =
    kind === "api" ? run.result.then((r) => postToClient(event.clientId, dataMessage(r.source, r.savedAt, req.url))) : null;
  event.waitUntil(Promise.all([run.done, message]).catch(() => undefined));
}

function handleCacheFirst(event, cacheName) {
  const req = event.request;
  const answer = caches.match(req).then(async (hit) => {
    if (hit) return { res: hit, copy: null };
    const res = await fetch(req);
    return { res, copy: shouldStore(res) ? res.clone() : null };
  });
  event.respondWith(answer.then(({ res }) => res));
  event.waitUntil(
    answer
      .then(({ copy }) => copy && caches.open(cacheName).then((c) => c.put(req, copy)))
      .catch((err) => warn(`network failure kind=static path=${pathOf(req.url)} error=${errorName(err)}`)),
  );
}

function handleStaleWhileRevalidate(event, cacheName) {
  const req = event.request;
  const fresh = fetch(req).then((res) => ({ res, copy: shouldStore(res) ? res.clone() : null }));
  event.respondWith(caches.match(req).then((hit) => hit ?? fresh.then(({ res }) => res)));
  event.waitUntil(
    fresh
      .then(({ copy }) => copy && caches.open(cacheName).then((c) => c.put(req, copy)))
      .catch((err) => warn(`network failure kind=static path=${pathOf(req.url)} error=${errorName(err)}`)),
  );
}

self.addEventListener("install", (event) => {
  // No skipWaiting here: the new worker waits until the page's Reload prompt sends SKIP_WAITING
  event.waitUntil(
    precache().catch((err) => {
      warn(`install failed v=${SW_VERSION} ${reasonOf(err)}`);
      throw err;
    }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    activate().catch((err) => {
      warn(`activate failed v=${SW_VERSION} error=${errorName(err)}`);
      throw err;
    }),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === MSG_SKIP_WAITING) {
    log(`skip-waiting v=${SW_VERSION}`);
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const origins = { app: self.location.origin, api: apiOriginFrom(self.location.href) };
  const plan = strategyFor(event.request, origins);
  if (plan.strategy === "bypass") return;
  const names = cacheNames(SW_VERSION);
  if (plan.strategy === "cache-first") return handleCacheFirst(event, names.static);
  if (plan.strategy === "stale-while-revalidate") return handleStaleWhileRevalidate(event, names.static);
  handleNetworkFirst(event, names[plan.cache], plan.kind);
});
