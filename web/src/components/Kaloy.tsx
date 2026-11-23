"use client";

// TG-75 Kaloy, the chatbot carabao in a salakot. Always decorative (alt="", aria-hidden): the words next to him say who
// is talking. Nothing here shows while flags.kaloy is off, so every page stays as it was.
import { type ReactNode, useEffect, useSyncExternalStore } from "react";
import { cx } from "@/components/pixel";
import { flags } from "@/lib/flags";
import { type KaloyPose, kaloyGreeting, greetingLang, kaloySprite } from "@/lib/kaloy";
import { spriteSrc } from "@/lib/sprites";

/** One pose at a whole multiple of the 32px art (32 or 64), so the pixels stay square */
export function KaloySprite({ pose, size = 32, className }: { pose: KaloyPose; size?: 32 | 64; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- pixel art: next/image would resample it
    <img src={spriteSrc(kaloySprite(pose))} width={size} height={size} alt="" aria-hidden="true" draggable={false} decoding="async"
      className={cx("pixelated shrink-0", className)} />
  );
}

/**
 * Kaloy beside a box or a line, when the flag is on. Off, it is only its children, so the page is today's. `fill`: the
 * box takes the rest of the row (a box that was full width stays full width).
 */
export function KaloyBeside({ pose, size = 64, top = false, fill = false, className, children }: {
  pose: KaloyPose;
  size?: 32 | 64;
  /** Line him up with the first line (a chat reply), not the middle */
  top?: boolean;
  fill?: boolean;
  className?: string;
  children: ReactNode;
}) {
  if (!flags.kaloy) return children;
  return (
    <div className={cx("flex gap-3", top ? "items-start" : "items-center", fill && "[&>:last-child]:min-w-0 [&>:last-child]:flex-1", className)}>
      <KaloySprite pose={pose} size={size} />
      {children}
    </div>
  );
}

function subscribeLang(onChange: () => void) {
  window.addEventListener("languagechange", onChange);
  return () => window.removeEventListener("languagechange", onChange);
}

/**
 * The greeting line. Its language follows the phone (owner: "depends on the language selected by the user"): read on the
 * client only, so a prerender is the same everywhere. TG-74's picker can pass `lang` instead. Display only: the chat
 * never stores or sends it.
 */
export function KaloyGreeting({ lang }: { lang?: string }) {
  const phone = useSyncExternalStore(subscribeLang, () => navigator.language, () => "");
  const tag = lang ?? phone;
  const said = greetingLang(tag);
  useEffect(() => {
    console.info("[tg-kaloy] greeting lang=%s", said); // once per chat open: this line mounts with the empty log
  }, [said]);
  return <p className="text-sm break-words">{kaloyGreeting(tag)}</p>;
}
