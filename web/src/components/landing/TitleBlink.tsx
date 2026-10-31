"use client";

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

export const BLINK_MS = 500;
const STILL_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeStill(onChange: () => void) {
  const media = window.matchMedia(STILL_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/**
 * The title screen's blinking part (TG-49): PRESS START and the start menu's ▶ cursor flash together once a second,
 * like a game's (owner: "make the menu cursor blink", "make press start blink too"). data-blink flips on a timer and
 * globals.css fades every [data-blinks] inside on "off". Steady under reduced motion, on the server render, and while
 * the tab is hidden.
 */
export default function TitleBlink({ children }: { children: ReactNode }) {
  const still = useSyncExternalStore(subscribeStill, () => window.matchMedia(STILL_QUERY).matches, () => true);
  const [lit, setLit] = useState(true);

  useEffect(() => {
    if (still) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) setLit((on) => !on);
    }, BLINK_MS);
    return () => window.clearInterval(timer);
  }, [still]);

  return (
    <div className="flex flex-col items-center gap-3" data-blink={still || lit ? "on" : "off"}>
      {children}
    </div>
  );
}
