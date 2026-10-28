"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createSpawner, type SpawnState, type SpawnStep } from "@/lib/spawn";

const REST: SpawnState = { active: [], step: { at: 0, frame: "idle-1", stars: false } };

/**
 * The chibi spawn as React state (TG-15; TG-22 reuses it for the map party). A thin wrapper around createSpawner:
 * real timers, and prefers-reduced-motion read on every start. start and skip are stable across renders.
 */
export function useSpawn(): { active: ReadonlySet<number>; step: SpawnStep; start(indices: number[]): void; skip(): void } {
  const [state, setState] = useState<SpawnState>(REST);
  const spawner = useRef<ReturnType<typeof createSpawner> | null>(null);

  useEffect(() => {
    const s = createSpawner({
      schedule: (fn, ms) => window.setTimeout(fn, ms),
      cancel: (handle) => window.clearTimeout(handle as number),
      reducedMotion: () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      onChange: setState,
    });
    spawner.current = s;
    return () => s.dispose();
  }, []);

  const actions = useMemo(
    () => ({
      start: (indices: number[]) => spawner.current?.start(indices),
      skip: () => spawner.current?.skip(),
    }),
    [],
  );
  const active = useMemo(() => new Set(state.active), [state.active]);

  return { active, step: state.step, ...actions };
}
