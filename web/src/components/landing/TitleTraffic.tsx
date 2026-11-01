"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { cx } from "@/components/pixel";
import { spriteSrc } from "@/lib/sprites";
import { ROAD_SPRITES, PLANE, TRAFFIC_MS, flipped, moverSize, moverY, startTraffic, stepMover, type Mover } from "@/lib/titleTraffic";

const STILL_QUERY = "(prefers-reduced-motion: reduce)";
const SKY_SHARE = 0.45; // the top of the scene, behind the sign and the menu

function subscribeStill(onChange: () => void) {
  const media = window.matchMedia(STILL_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/**
 * The title screen's traffic (TG-49, titleTraffic.ts): vehicles drive along the bottom of the scene behind the trio,
 * and planes cross the sky behind the sign and the menu. Each road mover stacks every vehicle and shows one, so
 * a new vehicle never flickers in. It's drawn once the scene's size is known, and stands still for reduced motion and
 * while the tab is hidden.
 */
export default function TitleTraffic() {
  const still = useSyncExternalStore(subscribeStill, () => window.matchMedia(STILL_QUERY).matches, () => true);
  const layer = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, sky: 0 });
  const [movers, setMovers] = useState<Mover[] | null>(null);

  // The scene's size bounds the drive and the drift; it changes with the window
  useEffect(() => {
    const el = layer.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({ width: Math.floor(entry.contentRect.width), sky: Math.floor(entry.contentRect.height * SKY_SHARE) }),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (still || size.width === 0) return;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      setMovers((now) => (now ?? startTraffic(size.width, size.sky, Math.random)).map((m) => stepMover(m, size.width, size.sky, Math.random)));
    }, TRAFFIC_MS);
    return () => window.clearInterval(timer);
  }, [still, size]);

  const shown = size.width === 0 ? [] : !still && movers !== null ? movers : startTraffic(size.width, size.sky, () => 0);
  return (
    <div ref={layer} aria-hidden="true" className="absolute inset-0">
      {shown.map((m, i) => {
        const road = m.lane === "road";
        const move = `translate(${m.x}px, ${road ? -m.y : moverY(m)}px)${flipped(m) ? " scaleX(-1)" : ""}`;
        return (
          <span
            key={i}
            hidden={m.wait > 0}
            className={cx("absolute left-0 grid", road ? "bottom-1 lg:bottom-3" : "top-0")}
            style={{ transform: move }}
          >
            {(road ? ROAD_SPRITES : [PLANE]).map((name) => (
              // eslint-disable-next-line @next/next/no-img-element -- pixel art: next/image would resample it
              <img
                key={name}
                src={spriteSrc(name)}
                alt=""
                width={moverSize(name).w}
                height={moverSize(name).h}
                draggable={false}
                hidden={name !== m.sprite}
                className="pixelated [grid-area:1/1]"
              />
            ))}
          </span>
        );
      })}
    </div>
  );
}
