"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CAST, castSprite } from "@/lib/landingCast";
import { CHIBI_FRAMES, spriteSrc } from "@/lib/sprites";
import { WALK_MS, homeX, startWalkers, stepWalker, walkerFrame, type Walker } from "@/lib/titleWalk";

const STILL_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeStill(onChange: () => void) {
  const media = window.matchMedia(STILL_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/**
 * The title screen's trio (TG-49): they walk about the bottom of the scene, rest, and wave (titleWalk.ts). Each chibi
 * stacks its three frames and shows one, so every frame loads with the page and a swap never flickers. They stand
 * still, side by side, when the phone asks for reduced motion, on the server, and while the tab is hidden.
 */
export default function TitleCast() {
  const still = useSyncExternalStore(subscribeStill, () => window.matchMedia(STILL_QUERY).matches, () => true);
  const strip = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [walkers, setWalkers] = useState<Walker[] | null>(null);

  // The strip's width bounds the walk; it changes with the window
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (still || width === 0) return;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      setWalkers((now) => (now ?? startWalkers(CAST.heroTrio.length, Math.random)).map((w) => stepWalker(w, width, Math.random)));
    }, WALK_MS);
    return () => window.clearInterval(timer);
  }, [still, width]);

  const moving = !still && walkers !== null;
  return (
    <div ref={strip} aria-hidden="true" className="absolute inset-x-3 bottom-1 h-16 lg:inset-x-6 lg:bottom-3">
      {CAST.heroTrio.map((slot, i) => {
        const shown = moving ? walkerFrame(walkers[i]) : slot.frame;
        const x = moving ? walkers[i].x : homeX(i);
        return (
          <span key={slot.type} className="absolute bottom-0 left-0 grid" style={{ transform: `translateX(${x}px)` }}>
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
