"use client";

import { useEffect, useMemo, useRef } from "react";

/**
 * One planner request at a time (TG-21). begin() hands out a fresh id and abort signal, or null while a request is
 * still running, so a fast double submit can't abort and replace the first. Unmounting aborts the one in flight.
 * Kept out of PlanForm so TG-15's "no effect in PlanForm" guard (no spawn on first paint) still holds.
 */
export function usePlanRequests(): { begin(): { id: number; signal: AbortSignal } | null; end(): void } {
  const ctrl = useRef<AbortController | null>(null);
  const seq = useRef(0);
  const busy = useRef(false);

  useEffect(() => () => ctrl.current?.abort(), []);

  return useMemo(
    () => ({
      begin() {
        if (busy.current) return null;
        busy.current = true;
        ctrl.current = new AbortController();
        seq.current += 1;
        return { id: seq.current, signal: ctrl.current.signal };
      },
      end() {
        busy.current = false;
      },
    }),
    [],
  );
}
