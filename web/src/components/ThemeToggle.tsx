"use client";

import { useSyncExternalStore } from "react";
import { PixelButton } from "@/components/pixel";
import { THEME_EVENT, THEME_KEY, effectiveTheme, nextTheme, parseTheme, type Theme } from "@/lib/theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function current(): Theme {
  return effectiveTheme(parseTheme(document.documentElement.dataset.theme), window.matchMedia(DARK_QUERY).matches);
}

function subscribe(onChange: () => void) {
  const media = window.matchMedia(DARK_QUERY);
  // Another tab flipped the switch: follow it here too
  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_KEY) return;
    const saved = parseTheme(event.newValue);
    if (saved) document.documentElement.dataset.theme = saved;
    else delete document.documentElement.dataset.theme;
    onChange();
  };
  media.addEventListener("change", onChange);
  window.addEventListener(THEME_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    media.removeEventListener("change", onChange);
    window.removeEventListener(THEME_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** The Dark mode switch (TG-51), at the right of every page's header (TG-49). */
export default function ThemeToggle() {
  // null on the server: the saved choice lives in this browser only
  const theme = useSyncExternalStore(subscribe, current, () => null);
  const dark = theme === "dark";

  const flip = () => {
    const next = nextTheme(current());
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch (err) {
      // Private mode or blocked storage: the theme still changes for this visit
      console.warn("theme: choice not saved", err instanceof Error ? err.name : "unknown");
    }
    window.dispatchEvent(new Event(THEME_EVENT));
  };

  return (
    <PixelButton variant="secondary" role="switch" aria-checked={dark} onClick={flip} className="inline-flex items-center gap-2 px-3 text-sm">
      Dark mode
      <span aria-hidden="true" className="text-muted">{theme === null ? "" : dark ? "On" : "Off"}</span>
    </PixelButton>
  );
}
