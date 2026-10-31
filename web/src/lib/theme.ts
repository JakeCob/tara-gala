// TG-51: the light and dark switch. With no choice saved, the app follows the phone's setting (prefers-color-scheme).
// A choice is kept on this device only, and set as <html data-theme> before first paint so the page never flashes.

export type Theme = "light" | "dark";

export const THEME_KEY = "tg-theme";
/** Fired on window after the switch changes the theme, so every mounted switch re-reads it */
export const THEME_EVENT = "tg-theme-change";

export function parseTheme(raw: unknown): Theme | null {
  return raw === "light" || raw === "dark" ? raw : null;
}

export function nextTheme(current: Theme): Theme {
  return current === "dark" ? "light" : "dark";
}

/** The theme on screen: the saved choice, else the phone's setting */
export function effectiveTheme(saved: Theme | null, systemDark: boolean): Theme {
  return saved ?? (systemDark ? "dark" : "light");
}

/** Runs inline in <head> before first paint. Self-contained on purpose: it ships as a string. */
export const THEME_BOOT = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;
