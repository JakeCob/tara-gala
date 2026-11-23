"use client";

import { useEffect } from "react";
import { fetchLastMile } from "@/lib/api";
import type { AroundCity } from "@/lib/around";

/**
 * Pre-trip check 2026-11-23: with signal, fetch every start's legs once, so the service worker saves each answer
 * (/last-mile is in its API_PATHS). Then a start nobody tapped online still opens offline. Without this, Around →
 * Sagada offline showed "Could not reach the server" for the start you hadn't tapped. Same params as LastMile's own
 * request, so the saved URL is the one it asks for later. Renders nothing; the answers aren't used here.
 */
export default function WarmLegs({ city }: { city: AroundCity }) {
  useEffect(() => {
    if (!navigator.onLine) return;
    const starts = city.starts;
    void Promise.allSettled(starts.map((s) => fetchLastMile(s.kind === "spot" ? { spot: s.slug } : { terminal: s.slug }))).then((r) =>
      console.info("[tg-around] warm city=%s ok=%d of=%d", city.slug, r.filter((x) => x.status === "fulfilled").length, starts.length),
    );
  }, [city]);
  return null;
}
