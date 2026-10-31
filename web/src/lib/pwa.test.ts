// Installability tests (TG-27): manifest, icons, /sw.js headers and static guards on sw.js.
// Run with `npm test` (node --test, Node 22.18+ type stripping).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import manifest from "../app/manifest.ts";
import nextConfig from "../../next.config.ts";

const WEB = new URL("../../", import.meta.url);
const layout = readFileSync(new URL("src/app/layout.tsx", WEB), "utf8");

// T27-1 (B1)
test("T27-1 manifest has what Chrome and iOS need to install", () => {
  const m = manifest();
  assert.equal(m.display, "standalone");
  assert.equal(m.start_url, "/");
  assert.equal(m.scope, "/");
  assert.equal(m.id, "/", "a stable id so a later start_url change doesn't make a second app");
  assert.equal(m.name, "Tara Gala");
  assert.equal(m.short_name, "Tara Gala");
  assert.equal(m.background_color, "#fff8e7", "the install splash matches the Paper page (TG-49)");
  assert.equal(m.theme_color, "#fff8e7", "TG-49: the status bar is the Paper page");
  const themeColor = layout.match(/themeColor:\s*"([^"]+)"/)?.[1];
  assert.equal(m.theme_color, themeColor, "manifest and viewport theme colours must match");
  const sizes = (m.icons ?? []).map((i) => i.sizes);
  assert.ok(sizes.includes("192x192"));
  assert.ok(sizes.includes("512x512"));
  for (const icon of m.icons ?? []) {
    assert.ok(icon.purpose === undefined || icon.purpose === "any", `${icon.src}: no maskable art yet (TG-33)`);
  }
});

// T27-2 (B1, B2)
test("T27-2 every manifest icon exists at its stated size; iOS stays as it is", () => {
  for (const icon of manifest().icons ?? []) {
    const file = new URL(`public${icon.src}`, WEB);
    assert.ok(existsSync(file), icon.src);
    const png = readFileSync(file);
    assert.equal(png.subarray(1, 4).toString("latin1"), "PNG", icon.src);
    const size = `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`;
    assert.equal(size, icon.sizes, icon.src);
  }
  assert.ok(existsSync(new URL("public/apple-touch-icon.png", WEB)));
  assert.match(layout, /appleWebApp:\s*\{\s*capable:\s*true,\s*title:\s*"Tara Gala",\s*statusBarStyle:\s*"default"\s*\}/);
  assert.match(layout, /icons:\s*\{\s*apple:\s*"\/apple-touch-icon\.png"\s*\}/);
});

// T27-3 (B3)
test("T27-3 /sw.js is served uncached, as JavaScript, with no CSP", async () => {
  assert.equal(typeof nextConfig.headers, "function", "next.config.ts needs headers()");
  const rules = await nextConfig.headers!();
  const sw = rules.find((r) => r.source === "/sw.js");
  assert.ok(sw, "a headers() entry for /sw.js");
  const get = (key: string) => sw.headers.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;
  assert.equal(get("Cache-Control"), "no-cache, no-store, must-revalidate");
  assert.equal(get("Content-Type"), "application/javascript; charset=utf-8");
  // A CSP on the worker script would block its calls to the API on another origin
  assert.equal(get("Content-Security-Policy"), undefined);
});

test("T27-3 the existing next.config keys are unchanged", () => {
  const { cacheComponents, partialPrefetching, turbopack } = nextConfig as Record<string, unknown>;
  assert.deepEqual(
    { cacheComponents, partialPrefetching, turbopack },
    {
      cacheComponents: true,
      partialPrefetching: true,
      turbopack: { rules: { "*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" } } },
    },
  );
});

// T27-17 (B3, B15)
test("T27-17 sw.js static guards", () => {
  const source = readFileSync(new URL("public/sw.js", WEB), "utf8");
  for (const type of ["install", "activate", "message", "fetch"]) {
    assert.match(source, new RegExp(`addEventListener\\(\\s*["']${type}["']`), `${type} listener`);
  }
  assert.match(source, /caches\.delete\(/);
  assert.match(source, /cachesToDelete\(/);
  assert.match(source, /clients\.claim\(\)/);
  assert.match(source, /skipWaiting\(\)/);
  assert.match(source, /SKIP_WAITING/);
  assert.doesNotMatch(source, /importScripts/);
  assert.doesNotMatch(source, /workbox|serwist/i);
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
  assert.match(source, /single source of truth/i, "header comment: tests load this file in node:vm");
  assert.match(source, /bump SW_VERSION/i);
});

test("T27-17 no new dependency", () => {
  const pkg = JSON.parse(readFileSync(new URL("package.json", WEB), "utf8"));
  assert.deepEqual(pkg.dependencies, { next: "16.4.3", react: "19.3.0", "react-dom": "19.3.0" });
  assert.deepEqual(pkg.devDependencies, {
    "@tailwindcss/turbopack": "^4",
    "@types/node": "^20",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    eslint: "^9",
    "eslint-config-next": "16.4.3",
    tailwindcss: "^4",
    typescript: "^5",
  });
});

// B5
test("offline.html is a self-contained fallback page", () => {
  const html = readFileSync(new URL("public/offline.html", WEB), "utf8");
  assert.match(html, /<meta name="viewport" content="width=device-width,\s*initial-scale=1"/);
  assert.match(html, /You're offline/);
  assert.match(html, /This page wasn't saved on this phone yet\. Open it once while you have signal and it'll work offline next time\./);
  assert.match(html, /<a [^>]*href="\/"[^>]*>Back to bus search<\/a>/);
  assert.doesNotMatch(html, /<script/i, "no scripts");
  assert.doesNotMatch(html, /<link[^>]+stylesheet|src="\/_next/, "no external assets: it must render from one cached file");
});

// RED audit S1: the page side of the update path has no unit test of its own, so guard its source
const manager = readFileSync(new URL("src/components/ServiceWorkerManager.tsx", WEB), "utf8");
const banner = readFileSync(new URL("src/components/OfflineBanner.tsx", WEB), "utf8");

test("S1 ServiceWorkerManager registers with the API origin and bypasses the HTTP cache", () => {
  assert.match(manager, /register\("\/sw\.js\?api=" \+ encodeURIComponent\(/);
  assert.match(manager, /\{ scope: "\/", updateViaCache: "none" \}/);
  assert.match(manager, /process\.env\.NODE_ENV !== "production"/);
  assert.match(manager, /flags\.serviceWorker/);
  assert.match(manager, /import \{ API_URL \} from "@\/lib\/api"/);
});

test("S1 ServiceWorkerManager uses the shared SKIP_WAITING contract and reloads once", () => {
  assert.match(manager, /import \{ MSG_SKIP_WAITING \} from "@\/lib\/offline"/);
  assert.match(manager, /postMessage\(\{ type: MSG_SKIP_WAITING \}\)/);
  assert.doesNotMatch(manager, /"SKIP_WAITING"/, "use the constant, not a literal");
  assert.match(manager, /addEventListener\("controllerchange"/);
  assert.match(manager, /reloadStarted\.current\) return;/, "a guard so the tab reloads once");
  assert.match(manager, /addEventListener\("updatefound"/);
  assert.match(manager, /visibilitychange/);
});

test("S1 the kill switch unregisters and deletes only tg- caches", () => {
  assert.match(manager, /\.unregister\(\)/);
  assert.match(manager, /startsWith\("tg-"\)/);
  assert.doesNotMatch(manager, /beforeinstallprompt/, "Chrome's own install UI stays (ux.md section 3)");
});

test("S1 the update prompt matches ux.md", () => {
  assert.match(manager, /A new version of Tara Gala is ready\./);
  assert.match(manager, />\s*Later\s*</);
  assert.match(manager, /"Reloading\.\.\." : "Reload"/);
  assert.equal(manager.match(/min-h-11/g)?.length, 2, "both buttons at least 44px");
  assert.equal(manager.match(/type="button"/g)?.length, 2);
  assert.match(manager, /<div role="status">\s*\{show &&/, "an always-rendered status wrapper");
  assert.doesNotMatch(manager, /drop-shadow-/, "TG-49: the box carries its own hard shadow");
  assert.match(manager, /pixel-box bg-card/);
});

test("S1 OfflineBanner is an always-rendered status driven by the worker's messages", () => {
  assert.match(banner, /return \(\s*<div role="status" className="sticky top-0 z-10 w-full">\s*\{text &&/);
  assert.match(banner, /parseSwMessage\(/);
  assert.match(banner, /useReducer\(bannerReducer/);
  assert.match(banner, /bg-accent text-accent-ink/);
  assert.doesNotMatch(banner, /<button/, "a stale warning can't be dismissed");
});

test("S1 layout mounts the banner first and the manager last; api.ts only exports API_URL", () => {
  assert.match(layout, /<body[^>]*>\s*<OfflineBanner \/>\s*\{children\}\s*<ServiceWorkerManager \/>\s*<\/body>/);
  const api = readFileSync(new URL("src/lib/api.ts", WEB), "utf8");
  assert.match(api, /^export const API_URL = process\.env\.NEXT_PUBLIC_API_URL \?\? "http:\/\/localhost:8000";$/m);
});
