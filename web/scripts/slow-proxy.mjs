// TG-57 latency by kind of request. node slow-proxy.mjs <listen> <target port>; GET /__set?session=&itinerary=&other= sets
// each delay in ms. Stands in for prod's API times and for a phone on bad signal. Local stack only.
import http from "node:http";
const [listen, target] = process.argv.slice(2).map(Number);
const delay = { session: 0, itinerary: 0, other: 0 };
const kind = (url) => (/^\/sessions\/[0-9a-f]{32}$/.test(url) ? "session" : url.startsWith("/itineraries/") ? "itinerary" : "other");
http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    if (req.url.startsWith("/__set")) {
      for (const [k, v] of new URL(req.url, "http://x").searchParams) delay[k] = Number(v);
      res.writeHead(200, { "access-control-allow-origin": "*" });
      return res.end("ok");
    }
    await new Promise((r) => setTimeout(r, req.method === "GET" ? delay[kind(req.url)] : 0));
    const up = http.request({ host: "127.0.0.1", port: target, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${target}` } }, (ur) => {
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
    });
    up.on("error", () => { res.writeHead(502); res.end(); });
    up.end(Buffer.concat(chunks));
  });
}).listen(listen, "127.0.0.1");
