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
 * The title screen's start menu (TG-49). Its ▶ cursor blinks like a game's, once a second (owner: "make the menu
 * cursor blink"): data-blink flips on a timer and globals.css's title-menu fades the cursor on "off". Steady under
 * reduced motion, on the server render, and while the tab is hidden.
 */
export default function StartMenu({ children }: { children: ReactNode }) {
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
    <nav aria-label="Start menu" className="title-menu mt-1" data-blink={still || lit ? "on" : "off"}>
      {children}
    </nav>
  );
}
