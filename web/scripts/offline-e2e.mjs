// TG-27 Part B: a saved itinerary opens offline, end to end (README section 6, "Offline and install").
// Drives headless Chrome over the DevTools protocol with Node's built-in WebSocket: no dependencies.
//
//   node scripts/offline-e2e.mjs --origin http://localhost:3040 [--slug premade-chill] [--port 9040] [--out dir]
//
// It follows the four "before the trip" steps online in a fresh profile, then takes both the page and the
// service worker offline and reloads the saved itinerary and /plan. Exits 1 on the first run with any FAIL.
// Read-only against the app: it loads pages and opens a sheet, and it submits /plan only in ready-made mode, so it
// never sends POST /plan (it stops with a FAIL if the site has the live planner on). Chrome: $CHROME_BIN, or
// Playwright's cached chrome-headless-shell under ~/.cache/ms-playwright.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    origin: { type: "string", default: "http://localhost:3040" },
    slug: { type: "string", default: "premade-chill" },
    port: { type: "string", default: "9040" },
    out: { type: "string" },
    dates: { type: "string", default: "2026-11-06,2026-11-08" },
  },
});
const W = args.origin.replace(/\/$/, "");
const [FROM, TO] = args.dates.split(",");
const WIDTH = 380;
const PREMADE_SUBMIT = "Tara, show trip ideas"; // PLAN_COPY.premade.submit (src/lib/planForm.ts); live mode would POST /plan

function chromeBin() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const root = join(homedir(), ".cache", "ms-playwright");
  const dirs = existsSync(root) ? readdirSync(root).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse() : [];
  for (const d of dirs) {
    const bin = join(root, d, "chrome-headless-shell-linux64", "chrome-headless-shell");
    if (existsSync(bin)) return bin;
  }
  throw new Error("no Chrome: set CHROME_BIN");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (cond, label) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) fails.push(label);
  return cond;
};

// A port someone else's browser already holds would have us drive that browser: refuse instead
await new Promise((resolve) => {
  const probe = createServer();
  probe.once("error", () => {
    console.log(`FAIL CDP port ${args.port} is already in use: pick a free one with --port`);
    process.exit(1);
  });
  probe.listen(Number(args.port), "127.0.0.1", () => probe.close(resolve));
});

const profile = mkdtempSync(join(tmpdir(), "tg-offline-e2e-"));
const chrome = spawn(chromeBin(), [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profile}`, "--no-sandbox", "--disable-gpu", "about:blank"], { stdio: "ignore" });
console.log(`chrome pid ${chrome.pid}, CDP port ${args.port}, fresh profile`);

/** Stop our own Chrome (by its handle, never by name), wait for it to exit, then remove its profile. */
async function stopChrome() {
  if (chrome.exitCode === null && chrome.signalCode === null) {
    const exited = new Promise((resolve) => chrome.once("exit", resolve));
    chrome.kill();
    await Promise.race([exited, sleep(5000)]);
  }
  rmSync(profile, { recursive: true, force: true });
  console.log(`stopped chrome pid ${chrome.pid}`);
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await stopChrome();
    process.exit(130);
  });
}

/** One browser-level connection; page and service worker each get a flattened session on it. */
async function connect() {
  let url;
  for (let i = 0; i < 50 && !url; i++) {
    try {
      url = (await (await fetch(`http://127.0.0.1:${args.port}/json/version`)).json()).webSocketDebuggerUrl;
    } catch {
      await sleep(200);
    }
  }
  if (!url) throw new Error("Chrome's DevTools endpoint didn't come up");
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else listeners.forEach((fn) => fn(msg));
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      const i = ++id;
      pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
    }).then((msg) => {
      if (msg.error) throw new Error(`${method}: ${msg.error.message}`);
      return msg.result;
    });
  return { ws, send, onEvent: (fn) => listeners.push(fn) };
}

async function main() {
  const { ws, send, onEvent } = await connect();
  const consoleLines = [];
  onEvent((msg) => {
    if (msg.method === "Runtime.exceptionThrown") consoleLines.push(`exception: ${msg.params.exceptionDetails.text}`);
    if (msg.method === "Log.entryAdded") consoleLines.push(`${msg.params.entry.level}: ${msg.params.entry.text}`);
  });

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: page } = await send("Target.attachToTarget", { targetId, flatten: true });
  const p = (method, params) => send(method, params, page);
  await p("Page.enable");
  await p("Runtime.enable");
  await p("Log.enable");
  await p("Network.enable");
  await p("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: 1400, deviceScaleFactor: 2, mobile: true });

  const evaluate = async (expression) => {
    const r = await p("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const waitFor = async (expression, ms = 20000) => {
    for (let t = 0; t < ms; t += 250) {
      if (await evaluate(expression).catch(() => false)) return true;
      await sleep(250);
    }
    return false;
  };
  const go = async (path) => {
    await p("Page.navigate", { url: `${W}${path}` });
    await waitFor("document.readyState === 'complete'");
    await sleep(1500);
  };
  const shot = async (name) => {
    if (!args.out) return;
    const { data } = await p("Page.captureScreenshot", { format: "png" });
    const file = join(args.out, `offline-e2e-${name}.png`);
    writeFileSync(file, Buffer.from(data, "base64"));
    console.log(`     screenshot ${file}`);
  };
  const setDates = (from, to) =>
    evaluate(`(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      const [d, r] = document.querySelectorAll("input[type=date]");
      for (const [el, v] of [[d, ${JSON.stringify(from)}], [r, ${JSON.stringify(to)}]]) {
        set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    })()`);
  const loadTripIdeas = async () => {
    // Never submit the live planner: that POST /plan spends on the LLM and saves an itinerary
    const label = String(await evaluate(`(document.querySelector("form button[type=submit]") || {}).innerText || ""`)).trim();
    if (label !== PREMADE_SUBMIT) {
      throw new Error(`/plan is in live-planner mode (submit "${label}", not "${PREMADE_SUBMIT}"): stopped before submitting, no POST /plan`);
    }
    await setDates(FROM, TO);
    await sleep(300);
    await evaluate(`document.querySelector("form button[type=submit]").click()`);
    await waitFor(`/\\d+ trip ideas?/.test(document.body.innerText)`, 20000);
    return evaluate(`[...document.querySelectorAll('a[href^="/i/premade-"]')].map((a) => a.getAttribute("href"))`);
  };
  const SIGNS = `[...document.querySelectorAll('li button > span[style*="width"], li > div > span[style*="width"]')]`;

  // --- Online: README section 6, steps 1 to 4 -------------------------------------------------------
  console.log(`online: ${W}`);
  await go("/"); // 1. open the app online
  check(await waitFor("navigator.serviceWorker.ready.then((r) => !!r.active)", 20000), "1. service worker installed and active");
  await go("/"); // 2. reopen, so the page is controlled by the current worker
  check(await waitFor("!!navigator.serviceWorker.controller", 10000), "2. page is controlled by the service worker after a reload");
  const swUrl = await evaluate("navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL");
  check(/\/sw\.js\?api=https?%3A/.test(swUrl ?? ""), "2. worker registered with the API origin (?api=)");

  // Installability: manifest plus a controlling worker with a fetch handler
  const manifest = await p("Page.getAppManifest").catch(() => null);
  const parsed = manifest?.data ? JSON.parse(manifest.data) : null;
  check(!!parsed && (manifest.errors ?? []).length === 0, "install: manifest loads with no errors");
  check(parsed?.display === "standalone" && !!parsed?.start_url, "install: display standalone with a start_url");
  const sizes = (parsed?.icons ?? []).map((i) => i.sizes);
  check(sizes.includes("192x192") && sizes.includes("512x512"), "install: 192 and 512 icons");
  const installErrors = await p("Page.getInstallabilityErrors").then((r) => r.installabilityErrors, () => null);
  if (installErrors === null) console.log("     (Page.getInstallabilityErrors not supported by this Chrome; manifest and worker checked above)");
  else check(installErrors.length === 0, `install: Chrome reports no installability errors ${JSON.stringify(installErrors.map((e) => e.errorId))}`);

  await go("/plan"); // 3. load the ready-made trip list once
  const links = await loadTripIdeas();
  check(links.length > 0 && links.includes(`/i/${args.slug}`), `3. /plan lists ready-made trips (${links.length}) including /i/${args.slug}`);
  for (const href of links) {
    // 4. open every ready-made trip once
    await go(href);
    const ok = await waitFor(`${SIGNS}.length > 3 && [...document.images].every((i) => i.complete)`, 20000);
    check(ok, `4. opened ${href} online (map drawn, images loaded)`);
  }
  await sleep(1500); // let the worker finish its cache writes

  const saved = await evaluate(`(async () => {
    const urls = [];
    for (const name of await caches.keys()) for (const req of await (await caches.open(name)).keys()) urls.push(req.url);
    return urls;
  })()`);
  check(saved.some((u) => u.endsWith(`/i/${args.slug}`)), `saved: page /i/${args.slug}`);
  check(saved.some((u) => u.endsWith(`/itineraries/${args.slug}`)), `saved: API /itineraries/${args.slug}`);
  check(saved.some((u) => /\/premade-itineraries$/.test(u)), "saved: API /premade-itineraries");
  check(saved.some((u) => u.endsWith("/plan")), "saved: page /plan");
  check(saved.some((u) => u.includes("/sprites/")), "saved: sprites");

  // --- Offline: the page and the service worker both lose the network --------------------------------
  const offline = { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
  await p("Network.emulateNetworkConditions", offline);
  const workers = (await send("Target.getTargets")).targetInfos.filter((t) => t.type === "service_worker" && t.url.startsWith(W));
  check(workers.length > 0, "offline: found the service worker target");
  for (const w of workers) {
    const { sessionId } = await send("Target.attachToTarget", { targetId: w.targetId, flatten: true });
    await send("Network.enable", {}, sessionId);
    await send("Network.emulateNetworkConditions", offline, sessionId);
  }
  const reachable = await evaluate(`fetch(${JSON.stringify(`${W}/sw.js?probe=${Date.now()}`)}, { cache: "no-store" }).then(() => true, () => false)`);
  check(!reachable, "offline: the network really is down (a bypassed request fails)");
  console.log("offline: reloading the saved trip and /plan");

  const BANNER = `((document.querySelector("[role=status]") || {}).innerText || "")`;
  const offlineBanner = async (where) => {
    // Loaded with no network, the screen shows saved data: a "saved <time>" banner whose wording follows
    // navigator.onLine. CDP's offline emulation doesn't carry navigator.onLine into a new document (it reads true
    // there; a phone in airplane mode reads false), so that first banner is "Can't reach the server" here.
    const shown = await waitFor(`/ · saved /.test(${BANNER})`, 8000);
    const onLine = await evaluate("navigator.onLine");
    const text = await evaluate(BANNER);
    const want = onLine ? /^Can't reach the server · saved / : /^Offline · saved /;
    check(shown && want.test(text), `${where}: saved-data banner on load ("${text.split(" · ").slice(0, 2).join(" · ")}", navigator.onLine=${onLine})`);
    // Then the browser reports offline, as a phone losing signal does: the banner must say "Offline · saved"
    await p("Network.emulateNetworkConditions", { ...offline, offline: false });
    await p("Network.emulateNetworkConditions", offline);
    check(await waitFor(`/^Offline · saved /.test(${BANNER})`, 5000), `${where}: "Offline · saved" banner once the browser reports offline`);
  };

  await go(`/i/${args.slug}`);
  check(await waitFor(`${SIGNS}.length > 3`, 15000), `/i/${args.slug}: overworld map renders offline`);
  const signs = await evaluate(`${SIGNS}.map((s) => { const r = s.getBoundingClientRect(); return r.left + r.width / 2; })`);
  check(signs.some((x) => x < WIDTH / 2) && signs.some((x) => x >= WIDTH / 2), `/i/${args.slug}: signs on both sides (${signs.length})`);
  const imgs = await evaluate(`[...document.images].filter((i) => i.src.includes("/sprites/")).map((i) => i.complete && i.naturalWidth > 0)`);
  check(imgs.length > 0 && imgs.every(Boolean), `/i/${args.slug}: every sprite image loads offline (${imgs.length})`);
  const tiles = await evaluate(`(async () => {
    const urls = new Set();
    for (const el of document.querySelectorAll("*")) {
      const m = getComputedStyle(el).backgroundImage.match(/url\\("?([^")]+\\/sprites\\/[^")]+)"?\\)/);
      if (m) urls.add(m[1]);
    }
    const ok = await Promise.all([...urls].map((u) => fetch(u).then((r) => r.ok, () => false)));
    return { n: urls.size, ok: ok.every(Boolean) };
  })()`);
  check(tiles.n > 0 && tiles.ok, `/i/${args.slug}: map tiles (background sprites) load offline (${tiles.n})`);
  await offlineBanner(`/i/${args.slug}`);
  check((await evaluate("document.documentElement.scrollWidth")) === WIDTH, `/i/${args.slug}: no horizontal scroll at ${WIDTH}`);
  await shot("map");
  const opened = await evaluate(`(() => {
    const b = [...document.querySelectorAll("li button")].find((b) => /→/.test(b.innerText) && /Checked/.test(b.innerText));
    if (!b) return false;
    b.scrollIntoView({ block: "center" });
    b.click();
    return true;
  })()`);
  check(opened && (await waitFor("!!document.querySelector('dialog[open]')", 5000)), `/i/${args.slug}: bus sheet opens offline`);
  const sheet = opened ? await evaluate("(document.querySelector('dialog[open]') || {}).innerText || ''") : "";
  check(/Checked \w+ \d+/.test(sheet), `/i/${args.slug}: bus sheet shows "Checked <date>"`);
  check(/Confirm with the operator/i.test(sheet), `/i/${args.slug}: bus sheet shows the confirm note`);
  await sleep(1000); // the sheet's terminal links ask for /terminals, which the README steps never save
  check(/^Offline · saved /.test(await evaluate(BANNER)), `/i/${args.slug}: still "Offline · saved" with the bus sheet open`);
  await shot("bus-sheet");

  await go("/plan");
  check(await waitFor("!!document.querySelector('form button[type=submit]')", 10000), "/plan: form renders offline");
  const offlineLinks = await loadTripIdeas();
  check(offlineLinks.includes(`/i/${args.slug}`), `/plan: the saved ready-made list loads offline (${offlineLinks.length})`);
  await offlineBanner("/plan");
  check((await evaluate("document.documentElement.scrollWidth")) === WIDTH, `/plan: no horizontal scroll at ${WIDTH}`);
  await shot("plan");

  const bad = consoleLines.filter((l) => /CORS|blocked by|exception/i.test(l));
  check(bad.length === 0, `no CORS errors or uncaught exceptions (${bad.length})`);
  bad.slice(0, 5).forEach((l) => console.log(`     console: ${l.slice(0, 200)}`));
  ws.close();
}

main()
  .catch((e) => check(false, e.message))
  .finally(async () => {
    await stopChrome();
    console.log(fails.length ? `offline e2e: FAIL (${fails.length})` : "offline e2e: PASS");
    process.exit(fails.length ? 1 : 0);
  });
