import { flags } from "@/lib/flags";
import { WORDS } from "@/lib/lang";
import type { Words } from "@/lib/words/en";

/**
 * TG-74: one word or line in the picked language. No hooks, so server and client components both use it. With the
 * flag on it renders every language and globals.css shows the one matching <html data-lang>, so a prerendered page
 * never flashes English. With the flag off it's the plain English text, today's markup.
 */
export default function Say({ w }: { w: (words: Words) => string }) {
  if (!flags.langPicker) return w(WORDS.en);
  return (
    <>
      <span data-lang-only="en">{w(WORDS.en)}</span>
      <span data-lang-only="tl">{w(WORDS.tl)}</span>
    </>
  );
}
