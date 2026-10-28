// Planner network tests (TG-21): postPlan and fetchPremade with a fake fetch. No real requests: a global guard
// fails any test that reaches globalThis.fetch without passing its own fetchImpl.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { API_URL, fetchPremade, postPlan, type PlanRequestBody } from "./api.ts";

const BODY: PlanRequestBody = {
  date: "2026-11-06",
  return_date: "2026-11-08",
  party: [{ type: "adult" }, { type: "senior" }],
  budget_php: 6000,
  vibe: "Food trip, Nature",
};

type Call = { url: string; init: RequestInit | undefined };

// Reaching the real fetch is a test bug: record it, reject, and fail in afterEach
let realFetch: typeof fetch;
let leaked: string[] = [];
beforeEach(() => {
  realFetch = globalThis.fetch;
  leaked = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    leaked.push(String(input));
    throw new TypeError("global fetch is blocked in tests");
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  assert.deepEqual(leaked, [], "a test reached the global fetch");
});

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { impl, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// A fetch that only settles when its signal aborts, like a planner that never answers
const hang = (call: Call) =>
  new Promise<Response>((_, reject) => {
    const signal = call.init?.signal;
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

// Records every timer postPlan creates, so a leak shows up as a timer neither fired nor cleared
function trackTimers() {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const open = new Set<unknown>();
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    const id = realSet(() => {
      open.delete(id);
      fn();
    }, ms);
    open.add(id);
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    open.delete(id);
    realClear(id);
  }) as typeof clearTimeout;
  return {
    open: () => open.size,
    restore() {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    },
  };
}

test("T21-N1 postPlan POSTs the exact JSON body to /plan, without credentials", async () => {
  const f = fakeFetch(() => json(201, { share_slug: "abc123def456" }));
  await postPlan(BODY, { fetchImpl: f.impl });
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(url, `${API_URL}/plan`);
  assert.equal(init?.method, "POST");
  assert.equal(new Headers(init?.headers).get("Content-Type"), "application/json");
  assert.equal(init?.body, JSON.stringify(BODY));
  assert.notEqual(init?.credentials, "include");
});

test("T21-N2 a 201 with a slug is ok", async () => {
  const f = fakeFetch(() => json(201, { share_slug: "abc123def456", model: "m", attempts: 1, plan: {} }));
  assert.deepEqual(await postPlan(BODY, { fetchImpl: f.impl }), { kind: "ok", slug: "abc123def456" });
});

test("T21-N3 a 201 without a string slug is a response, never ok", async () => {
  for (const body of [{ model: "m" }, { share_slug: 12 }, null]) {
    const f = fakeFetch(() => json(201, body));
    assert.deepEqual(await postPlan(BODY, { fetchImpl: f.impl }), { kind: "response", status: 201, body });
  }
});

test("T21-N4 error statuses come back with their parsed body", async () => {
  for (const status of [502, 503, 504, 429, 422, 404]) {
    const body = { detail: { code: "x", message: "y" } };
    const f = fakeFetch(() => json(status, body));
    assert.deepEqual(await postPlan(BODY, { fetchImpl: f.impl }), { kind: "response", status, body });
  }
});

test("T21-N5 an HTML error page gives body null and doesn't throw", async () => {
  const f = fakeFetch(() => new Response("<html><body>502 Bad Gateway</body></html>", { status: 502, headers: { "Content-Type": "text/html" } }));
  assert.deepEqual(await postPlan(BODY, { fetchImpl: f.impl }), { kind: "response", status: 502, body: null });
});

test("T21-N6 a rejected fetch is a network error", async () => {
  const f = fakeFetch(() => {
    throw new TypeError("Failed to fetch");
  });
  assert.deepEqual(await postPlan(BODY, { fetchImpl: f.impl }), { kind: "network" });
});

test("T21-N7 our own timeout is a timeout; the default is 120 s, longer than TG-20's deadline", async () => {
  const f = fakeFetch(hang);
  assert.deepEqual(await postPlan(BODY, { fetchImpl: f.impl, timeoutMs: 20 }), { kind: "timeout" });
  assert.match(readFileSync(new URL("./api.ts", import.meta.url), "utf8"), /timeoutMs = 120_000/);
});

test("T21-N8 the caller's abort is aborted, not timeout", async () => {
  const f = fakeFetch(hang);
  const ctrl = new AbortController();
  const p = postPlan(BODY, { fetchImpl: f.impl, signal: ctrl.signal, timeoutMs: 5_000 });
  ctrl.abort();
  assert.deepEqual(await p, { kind: "aborted" });
  const pre = new AbortController();
  pre.abort();
  assert.deepEqual(await postPlan(BODY, { fetchImpl: fakeFetch(hang).impl, signal: pre.signal }), { kind: "aborted" });
});

test("T21-N9 no timer is left behind, and postPlan never throws", async () => {
  const t = trackTimers();
  try {
    const cases: [string, (c: Call) => Response | Promise<Response>, number?][] = [
      ["ok", () => json(201, { share_slug: "s" })],
      ["error", () => json(503, { detail: { code: "x", message: "y" } })],
      ["network", () => Promise.reject(new TypeError("down"))],
      ["timeout", hang, 10],
    ];
    for (const [name, respond, timeoutMs] of cases) {
      const r = await postPlan(BODY, { fetchImpl: fakeFetch(respond).impl, timeoutMs });
      assert.ok(r && typeof r.kind === "string", name);
      assert.equal(t.open(), 0, `${name}: timer cleared`);
    }
    const ctrl = new AbortController();
    const p = postPlan(BODY, { fetchImpl: fakeFetch(hang).impl, signal: ctrl.signal });
    ctrl.abort();
    await p;
    assert.equal(t.open(), 0, "aborted: timer cleared");
  } finally {
    t.restore();
  }
});

test("T21-N10 fetchPremade: GET with no body; ok, unavailable or failed", async () => {
  const list = [{ share_slug: "a", vibe: null, trip_date: "2026-11-06", return_date: null, budget_php: null, day_count: 1, stop_count: 2, spot_names: [] }];
  const ok = fakeFetch(() => json(200, list));
  assert.deepEqual(await fetchPremade({ fetchImpl: ok.impl }), { kind: "ok", list });
  assert.equal(ok.calls[0].url, `${API_URL}/premade-itineraries`);
  assert.ok(!ok.calls[0].init?.method || ok.calls[0].init.method === "GET");
  assert.equal(ok.calls[0].init?.body, undefined);
  assert.notEqual(ok.calls[0].init?.cache, "no-store", "cacheable, so TG-27's service worker can keep it");
  for (const [respond, kind] of [
    [() => json(200, { items: [] }), "failed"],
    [() => json(200, null), "failed"],
    [() => json(404, { detail: "Not Found" }), "unavailable"],
    [() => json(500, { detail: "x" }), "failed"],
    [() => Promise.reject(new TypeError("down")), "failed"],
  ] as const) {
    assert.deepEqual(await fetchPremade({ fetchImpl: fakeFetch(respond).impl }), { kind });
  }
});

test("T21-N11 the default fetch is read at call time, so the test guard can catch it", async () => {
  // No fetchImpl: this must hit the blocked global, which records the URL and rejects
  assert.deepEqual(await postPlan(BODY, { timeoutMs: 1_000 }), { kind: "network" });
  assert.deepEqual(await fetchPremade(), { kind: "failed" });
  assert.deepEqual(leaked, [`${API_URL}/plan`, `${API_URL}/premade-itineraries`]);
  leaked = [];
});
