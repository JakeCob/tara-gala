"use client";

import { useEffect, useId, useRef, useState } from "react";
import { MenuCursor, PX, cx } from "@/components/pixel";
import Say from "@/components/Say";
import { pickLang, useLang, useWords } from "@/components/useLang";
import { LANGS, type Lang } from "@/lib/lang";

/**
 * TG-74 the 🌐 language picker, behind flags.langPicker: in every page's header next to the Dark mode switch, and as a
 * row of the title screen's start menu. A disclosure: the button opens a short list of the languages, each in its own
 * name, the current one marked with the ▶ cursor. Tapping one switches the page at once and closes the list.
 */
export default function LangPicker({ place }: { place: "header" | "title" }) {
  const lang = useLang();
  const words = useWords();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const listId = useId();

  // Close on a tap outside or Escape; Escape gives focus back to the button
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = (code: Lang) => {
    pickLang(code);
    setOpen(false);
    button.current?.focus();
  };

  const title = place === "title";
  const choices = (
    <ul id={listId} className={title ? "pixel-box absolute bottom-full left-2 z-20 mb-1 flex min-w-44 flex-col border-screen-ink bg-screen-paper py-1" : "pixel-box absolute top-full right-0 z-40 mt-2 flex min-w-40 flex-col bg-card py-1"}>
      {LANGS.map((choice) => (
        <li key={choice.code}>
          <button
            type="button"
            lang={choice.code}
            aria-pressed={lang === choice.code}
            onClick={() => choose(choice.code)}
            className={title ? cx(PX.menuItem, "w-full text-base") : "focus-pixel flex min-h-11 w-full items-center gap-2 px-3 text-left font-semibold text-foreground"}
          >
            <span className="inline-flex w-3">{lang === choice.code && <MenuCursor className="h-3 w-3" />}</span>
            {choice.name}
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <div ref={box} className="relative">
      {title ? (
        <button ref={button} type="button" aria-expanded={open} aria-controls={open ? listId : undefined} onClick={() => setOpen((on) => !on)} className={cx(PX.menuItem, "w-full")}>
          <span data-cursor="" data-blinks="">
            <MenuCursor className="h-3 w-3" />
          </span>
          <span aria-hidden="true">🌐</span>
          <Say w={(d) => d.picker.label} />
        </button>
      ) : (
        <button
          ref={button}
          type="button"
          aria-label={words.picker.choose}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          onClick={() => setOpen((on) => !on)}
          className={cx(PX.btn.icon.skin, "inline-flex items-center justify-center text-lg leading-none")}
        >
          <span aria-hidden="true">🌐</span>
        </button>
      )}
      {open && choices}
    </div>
  );
}
