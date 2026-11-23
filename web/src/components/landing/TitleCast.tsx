"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { flags } from "@/lib/flags";
import { CAST, castSprite } from "@/lib/landingCast";
import { CHIBI_FRAMES, spriteSrc } from "@/lib/sprites";
import {
  WALK_MS, followerFrame, followerHomeX, homeX, startFollower, startWalkers, stepFollower, stepWalker, walkerFrame,
  type Follower, type FollowerFrame, type Walker,
} from "@/lib/titleWalk";

const STILL_QUERY = "(prefers-reduced-motion: reduce)";
const KALOY_FRAMES: FollowerFrame[] = ["idle", "walk-1", "walk-2"];

function subscribeStill(onChange: () => void) {
  const media = window.matchMedia(STILL_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/**
 * The title screen's trio (TG-49): they walk about the bottom of the scene, rest, and wave (titleWalk.ts). Each chibi
 * stacks its three frames and shows one, so every frame loads with the page and a swap never flickers. They stand
 * still, side by side, when the phone asks for reduced motion, on the server, and while the tab is hidden.
 * TG-75: with flags.kaloy, Kaloy trails the last of them, behind the trio, and stands next to them when they're still.
 */
export default function TitleCast() {
  const still = useSyncExternalStore(subscribeStill, () => window.matchMedia(STILL_QUERY).matches, () => true);
  const strip = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [scene, setScene] = useState<{ walkers: Walker[]; kaloy: Follower | null } | null>(null);
  const walkers = scene?.walkers ?? null;

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
      setScene((now) => {
        const next = (now?.walkers ?? startWalkers(CAST.heroTrio.length, Math.random)).map((w) => stepWalker(w, width, Math.random));
        const kaloy = flags.kaloy ? stepFollower(now?.kaloy ?? startFollower(CAST.heroTrio.length), next[next.length - 1], width) : null;
        return { walkers: next, kaloy };
      });
    }, WALK_MS);
    return () => window.clearInterval(timer);
  }, [still, width]);

  const moving = !still && walkers !== null;
  const kaloy = moving ? scene?.kaloy ?? null : null;
  const kaloyShown = kaloy ? followerFrame(kaloy) : "idle";
  return (
    <div ref={strip} aria-hidden="true" className="absolute inset-x-3 bottom-1 h-16 lg:inset-x-6 lg:bottom-3">
      {flags.kaloy && (
        // First in the strip, so the trio walks in front of him; mirrored when he walks left
        <span className="absolute bottom-0 left-0 grid"
          style={{ transform: `translateX(${kaloy ? kaloy.x : followerHomeX(CAST.heroTrio.length)}px)${kaloy?.dir === -1 ? " scaleX(-1)" : ""}` }}>
          {KALOY_FRAMES.map((frame) => (
            // eslint-disable-next-line @next/next/no-img-element -- pixel art: next/image would resample it
            <img key={frame} src={spriteSrc(`kaloy-${frame}`)} alt="" width={64} height={64} draggable={false} hidden={frame !== kaloyShown}
              className="pixelated [grid-area:1/1]" />
          ))}
        </span>
      )}
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
