// TG-74 the language picker (flag langPicker). The language lives on this phone only, in localStorage like the theme:
// no /tl/ URLs and no cookies, so pages stay prerendered and the service worker keeps one copy per URL. A boot script
// sets <html lang data-lang> before first paint; the words of both languages are in the page and CSS shows the one
// that matches data-lang (globals.css), so there's no flash of English. The first visit follows the phone.
// Pure TS so `node --test` runs it.
import { EN, type Words } from "./words/en.ts";
import { TL } from "./words/tl.ts";

export type Lang = "en" | "tl";

/** The picker's choices, each in its own name. Ilokano and Bisaya stay hidden until a native speaker checks them. */
export const LANGS: readonly { code: Lang; name: string }[] = [
  { code: "en", name: "English" },
  { code: "tl", name: "Tagalog" },
];

export const WORDS: Record<Lang, Words> = { en: EN, tl: TL };

export const LANG_KEY = "tg-lang";
/** Fired on window after the picker changes the language, so every mounted reader re-reads it */
export const LANG_EVENT = "tg-lang-change";

export function parseLang(raw: unknown): Lang | null {
  return raw === "en" || raw === "tl" ? raw : null;
}

/** The phone's language: Filipino ("fil") or Tagalog ("tl") as the first tag's primary subtag gives Tagalog, anything
 * else (or nothing) English. Same rule as Kaloy's greeting (kaloy.ts greetingLang). */
export function phoneLang(tags: readonly string[] | null | undefined): Lang {
  const primary = (tags?.[0] ?? "").trim().toLowerCase().split(/[-_]/)[0];
  return primary === "fil" || primary === "tl" ? "tl" : "en";
}

/**
 * Runs inline in <head> before first paint, only with the flag on. Self-contained on purpose: it ships as a string.
 * A saved choice wins; with none, it follows the phone once and saves that, so the first visit decides. Blocked
 * storage still gets the phone's language for this page.
 */
export const LANG_BOOT = `(function(){var d=document.documentElement,l=null;try{l=localStorage.getItem("${LANG_KEY}")}catch(e){}if(l!=="en"&&l!=="tl"){var n=navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language||""],p=String(n[0]||"").trim().toLowerCase().split(/[-_]/)[0];l=p==="fil"||p==="tl"?"tl":"en";try{localStorage.setItem("${LANG_KEY}",l)}catch(e){}console.info("[tg-lang] pick from=%s to=%s source=%s","none",l,"phone")}d.lang=l;d.dataset.lang=l})()`;
