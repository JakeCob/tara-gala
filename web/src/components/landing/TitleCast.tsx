"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { CAST, TICK_MS, castFrame, castSprite } from "@/lib/landingCast";
import { CHIBI_FRAMES, spriteSrc } from "@/lib/sprites";

const STILL_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeStill(onChange: () => void) {
  const media = window.matchMedia(STILL_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/**
 * The title screen's trio (TG-49, owner: "make the title screen chibis animate"). Each chibi stacks its three frames
 * and shows one, so every frame loads with the page and a swap never flickers. They stay still when the phone asks
 * for reduced motion, on the server, and while the tab is hidden.
 */
export default function TitleCast() {
  const still = useSyncExternalStore(subscribeStill, () => window.matchMedia(STILL_QUERY).matches, () => true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (still) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) setTick((t) => t + 1);
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [still]);

  return (
    <div aria-hidden="true" className="absolute bottom-1 left-3 flex gap-1 lg:bottom-3 lg:left-6">
      {CAST.heroTrio.map((slot, i) => {
        const shown = still ? slot.frame : castFrame(i, tick);
        return (
          <span key={slot.type} className="grid">
            {CHIBI_FRAMES.map((frame) => (
              // eslint-disable-next-line @next/next/no-img-element -- pixel art: next/image would resample it
              <img
                key={frame}
                src={spriteSrc(castSprite({ ...slot, frame }))}
                alt=""
                width={64}
                height={64}
                draggable={false}
                hidden={frame !== shown}
                className="pixelated [grid-area:1/1]"
              />
            ))}
          </span>
        );
      })}
    </div>
  );
}
