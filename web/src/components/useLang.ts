"use client";

import { useSyncExternalStore } from "react";
import { LANG_EVENT, LANG_KEY, WORDS, parseLang, type Lang } from "@/lib/lang";
import type { Words } from "@/lib/words/en";

// TG-74: the language on screen, for words CSS can't swap (aria-labels). LANG_BOOT set it on <html> before first paint.

function current(): Lang {
  return parseLang(document.documentElement.dataset.lang) ?? "en";
}

function apply(next: Lang) {
  document.documentElement.dataset.lang = next;
  document.documentElement.lang = next;
}

function subscribe(onChange: () => void) {
  // Another tab picked a language: follow it here too
  const onStorage = (event: StorageEvent) => {
    if (event.key !== LANG_KEY) return;
    const saved = parseLang(event.newValue);
    if (!saved || saved === current()) return;
    console.info("[tg-lang] follow another tab to=%s", saved);
    apply(saved);
    onChange();
  };
  window.addEventListener(LANG_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(LANG_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** "en" on the server and in the first client render (the prerendered page is English), then the phone's choice */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, current, () => "en");
}

export function useWords(): Words {
  return WORDS[useLang()];
}

/** The picker's change: on screen now, saved on this phone, and every reader told */
export function pickLang(next: Lang) {
  const from = current();
  if (from === next) return;
  apply(next);
  try {
    localStorage.setItem(LANG_KEY, next);
  } catch (err) {
    // Private mode or blocked storage: the language still changes for this visit
    console.warn("[tg-lang] choice not saved", err instanceof Error ? err.name : "unknown");
  }
  console.info("[tg-lang] pick from=%s to=%s source=%s", from, next, "picker");
  window.dispatchEvent(new Event(LANG_EVENT));
}
