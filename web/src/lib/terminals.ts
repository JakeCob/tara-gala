import type { TerminalPlace } from "@/lib/mapLinks";

// Same fallback as api.ts, which doesn't export it (TG-17 is editing that file).
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

let cached: Promise<Map<string, TerminalPlace>> | null = null;

/** GET /terminals once per page load, keyed by slug; a failure clears the cache so a later search can retry. */
export function getTerminals(): Promise<Map<string, TerminalPlace>> {
  if (!cached) {
    cached = loadTerminals().catch((err) => {
      cached = null;
      throw err;
    });
  }
  return cached;
}

async function loadTerminals(): Promise<Map<string, TerminalPlace>> {
  const res = await fetch(`${API_URL}/terminals`, { cache: "no-store" });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const rows: TerminalPlace[] = await res.json();
  return new Map(rows.map((t) => [t.slug, t]));
}
