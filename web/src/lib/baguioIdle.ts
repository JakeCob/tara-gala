// The /baguio empty state (TG-49 PR 2, ux.md section 3): the box under the terminal picker before a pick. Plain data
// with no runtime imports; BaguioIdle.tsx renders it. Same shape as homeDecor.ts, so Tailwind finds the class strings.
import type { DecorShow } from "./homeDecor";

// Left to right (ux.md 3.2): the walk from the terminal out to the spots. md-only sprites don't fit a phone.
export const BAGUIO_IDLE_ROW = [
  { name: "place-terminal", show: "all" },
  { name: "mode-jeep", show: "all" },
  { name: "place-market", show: "md" },
  { name: "mode-taxi", show: "all" },
  { name: "place-cafe", show: "md" },
  { name: "mode-walk", show: "all" },
  { name: "place-viewpoint", show: "md" },
  { name: "place-park", show: "all" },
] as const satisfies readonly { name: string; show: DecorShow }[];

// The fixed light screen (guide 1.3). The heights are fixed, so the box can't move as the sprites load.
export const BAGUIO_IDLE_SCENE_CLASS =
  "pointer-events-none h-24 border-b-3 border-frame bg-screen pixelated flex items-end justify-center gap-2 pb-2 md:h-32 md:gap-4 lg:gap-6";

export const BAGUIO_IDLE_COPY = {
  lead: "Tara, pick your terminal above.",
  line: "We'll show the jeeps, taxis and walks from there to the top spots.",
};
