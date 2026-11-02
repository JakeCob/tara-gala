// TG-57 timing gate. Usage: node scripts/map-timing.mjs <origin> <api> [plan slug] [visits] [maxMapMs]
// Makes its own throwaway trip, opens it <visits> times in one browser profile (visit 1 is cold, then the worker has a
// copy), prints when the trip, the frame and the levels first appear, and deletes the trip. Never the owner's trip.
// With maxMapMs it exits 1 if a repeat visit's levels are later. Run it on a local stack with the API behind
// scripts/slow-proxy.mjs at prod's times (session=830, itinerary=1370), built with NEXT_PUBLIC_API_URL at the proxy:
//   node scripts/map-timing.mjs http://localhost:3030 http://127.0.0.1:8030 baguio-barkada-nov6 3 500
// SLOW=6000 adds bad signal after visit 1, in the proxies only. Visit 2 has no saved page yet, so the gate reads visit 3.
// CDP_PORT picks the browser's debugging port, default 9030.
import { spawn } from "node:child_process";
import { readdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
const [origin, API, PLAN = "baguio-barkada-nov6", VISITS = "3", MAX = ""] = process.argv.slice(2);
const CDP = process.env.CDP_PORT ?? "9030";
const firstGated = process.env.SLOW ? 3 : 2;
const root = join(homedir(), ".cache/ms-playwright");
const dir = readdirSync(root).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const chrome = spawn(join(root, dir, "chrome-headless-shell-linux64", "chrome-headless-shell"), [`--remote-debugging-port=${CDP}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "pg-"))}`, "--no-sandbox", "--disable-gpu", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${CDP}/json/version`); break; } catch { await sleep(200); } }
const tab = await (await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.result?.value;
const api = (path, method = "GET", body) => fetch(API + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined }).then(async (r) => (r.status === 204 ? null : r.json()));
const NAME = "E2E TG-57";
const trip = await api("/sessions", "POST", { name: NAME, start_date: "2026-11-06", return_date: "2026-11-08" });
let failed = false;
try {
  await api(`/sessions/${trip.share_slug}/itinerary`, "PUT", { share_slug: PLAN });
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 380, height: 900, deviceScaleFactor: 1, mobile: true });
  // Stamps the first moment each thing is in the page, from navigation start
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    const t = (window.__tg = {});
    const seen = { trip: "h2", frame: "[data-map-loading]", title: "#progress-title", level: "li[data-level]" };
    const look = () => { for (const k in seen) if (!(k in t) && document.querySelector(seen[k])) t[k] = Math.round(performance.now()); };
    new MutationObserver(look).observe(document, { childList: true, subtree: true });
  })();` });
  for (let v = 1; v <= Number(VISITS); v++) {
    await send("Page.navigate", { url: `${origin}/t/${trip.share_slug}` });
    let got = false;
    for (let t = 0; t < 30000 && !got; t += 100) { await sleep(100); got = await ev(`!!window.__tg?.level`); }
    await sleep(process.env.SLOW ? 600 : 2600); // let the page's own API reads finish before reading their timing
    const r = await ev(`(() => {
      const nav = performance.getEntriesByType("navigation")[0];
      const res = performance.getEntriesByType("resource").filter((e) => /\\/(sessions|itineraries)\\//.test(e.name) && !/files/.test(e.name));
      return JSON.stringify({ ...window.__tg, html: Math.round(nav.responseEnd), sw: !!navigator.serviceWorker?.controller,
        api: res.map((e) => [e.name.includes("/sessions/") ? "session" : "itinerary", Math.round(e.startTime), Math.round(e.responseEnd)]) });
    })()`);
    console.log(`visit ${v}`, r);
    const o = JSON.parse(r);
    if (MAX && v >= firstGated && !(o.level <= Number(MAX))) { failed = true; console.log(`FAIL visit ${v}: levels at ${o.level} ms, over ${MAX} ms`); }
    await sleep(v === 1 ? 2500 : 200); // the worker's install and first copies
    if (v === 1 && process.env.SLOW) { // bad signal from here on: the page and both API reads, in the proxies only
      await fetch(`${API}/__set?session=${process.env.SLOW}&itinerary=${process.env.SLOW}`);
      await fetch(`${origin}/__set?other=${process.env.SLOW}`);
    }
  }
} finally {
  await api(`/sessions/${trip.share_slug}`, "DELETE", { name: NAME });
  chrome.kill();
}
process.exit(failed ? 1 : 0);
