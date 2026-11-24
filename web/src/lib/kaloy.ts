// TG-75 Kaloy, the chatbot carabao in a salakot (owner decision 2026-11-23): his words, the greeting's language and his
// poses. Pure, so `node --test` runs it; components/Kaloy.tsx draws him, behind flags.kaloy.
import type { SpriteName } from "./sprites.ts";

export const KALOY_WORDS = {
  name: "Kaloy",
  ask: "Ask Kaloy",
  thinking: "Kaloy is thinking...",
  /** Under his greeting, in place of FIRST_MESSAGE: its examples and the Apply line, without a second hello */
  howTo: 'For example, "add merienda after Burnham Park" or "mas chill ang Day 2". I only use places on Tara Gala and ones your group added. Nothing changes until someone taps Apply.',
  /** Shown when the chat opens with an empty log. Display only: never kept in tg-chat:<slug>, never sent */
  greeting: {
    fil: "Uy! Ako si Kaloy. Ano'ng gusto mong baguhin sa plan?",
    en: "Hi, I'm Kaloy! What should we change in your plan?",
  },
} as const;

export type KaloyLang = keyof typeof KALOY_WORDS.greeting;
export type KaloyPose = "idle" | "talk" | "think" | "happy" | "sad";
export const KALOY_POSES: readonly KaloyPose[] = ["idle", "talk", "think", "happy", "sad"];
export const KALOY_WALK = ["kaloy-walk-1", "kaloy-walk-2"] as const satisfies readonly SpriteName[];

/**
 * The greeting's language from a BCP 47 tag: Filipino ("fil") or Tagalog ("tl") as the primary subtag gives "fil",
 * anything else (or nothing) "en". Today the tag is the phone's (navigator.language); TG-74's language picker can pass
 * the picked one instead.
 */
export function greetingLang(lang: string | null | undefined): KaloyLang {
  const primary = (lang ?? "").trim().toLowerCase().split(/[-_]/)[0];
  return primary === "fil" || primary === "tl" ? "fil" : "en";
}

export function kaloyGreeting(lang: string | null | undefined): string {
  return KALOY_WORDS.greeting[greetingLang(lang)];
}

export function kaloySprite(pose: KaloyPose): SpriteName {
  return `kaloy-${pose}`;
}

/**
 * Kaloy's pose beside one of his replies. Only the newest reply moves: it talks, or cheers right after a change from
 * the chat was applied. While a message is out the thinking line has the think pose, so every reply above it idles.
 * `newest` is the index of the newest reply in the log (-1: none, the greeting is the newest).
 */
export function replyPose(at: { index: number; newest: number; sending: boolean; cheer: boolean }): KaloyPose {
  if (at.sending || at.index !== at.newest) return "idle";
  return at.cheer ? "happy" : "talk";
}

/**
 * TG-75 the game-style chat (flags.chatGameUi, owner 2026-11-23: "looks like a plain form"): its own words, so
 * KALOY_WORDS stays the owner's. privacy is PRIVACY_LINE made short; it still says where the chat is kept and where the
 * messages go.
 */
export const KALOY_CHAT = {
  /** Read before each of your bubbles by a screen reader: who said it never rests on side or colour */
  you: "You:",
  placeholder: "Message Kaloy",
  privacy: "This chat stays on this phone. To answer, your messages and the plan go to an AI service.",
} as const;

/** Kaloy beside a limit, no-signal or no-fit box in the game chat: sad while it's the newest line, idle once it isn't */
export function alertPose(at: { newest: boolean; sending: boolean }): KaloyPose {
  return at.newest && !at.sending ? "sad" : "idle";
}
