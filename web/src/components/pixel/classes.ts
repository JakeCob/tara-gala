// Pixel theme class strings (TG-42, ux-guide v2 section 4.1). A plain module, so tests and Tailwind can read it.
//
// Each primitive has a skin (frame, focus, fill, text colour, weight, min-height) and a default layout (display,
// alignment, padding, text size). There's no class-merge utility, so two classes that set the same property resolve
// by stylesheet order. That's why a primitive's className prop replaces the layout and is never merged with it.
// A different look is a new variant here, never a skin class passed through className.
//
// Usage rules for consumers:
// - inlineLink is only for a link inside running text: it has no min-h-11. A standalone link is a PixelLink.
// - Never put a control on a bg-accent or bg-brand surface. The focus outline is invisible there (1.00:1 on Sun in
//   dark mode; 2.74 and 1.84 on brand). Put the control on a card inside that surface instead.
// - choice uses a named group (group/choice), so an outer .group can't light every MenuCursor.

export const PX = {
  box: { skin: "pixel-box bg-card", layout: "p-4 flex flex-col gap-2" },
  btn: {
    primary: { skin: "pixel-btn focus-pixel min-h-11 bg-brand font-bold text-brand-ink", layout: "px-4 py-3" },
    secondary: { skin: "pixel-btn focus-pixel min-h-11 bg-card font-semibold text-foreground", layout: "inline-flex items-center px-4 text-sm" },
    accent: { skin: "pixel-btn focus-pixel min-h-11 bg-accent font-bold text-accent-ink", layout: "inline-flex items-center px-3 text-sm" },
    icon: { skin: "pixel-btn focus-pixel min-h-11 min-w-11 bg-card", layout: "inline-flex items-center justify-center" },
    iconBrand: { skin: "pixel-btn focus-pixel min-h-11 min-w-11 bg-card text-brand", layout: "inline-flex items-center justify-center text-xl leading-none" },
  },
  choice: {
    skin: "group/choice pixel-btn focus-pixel-within min-h-11 cursor-pointer bg-card font-semibold has-checked:bg-brand has-checked:text-brand-ink has-checked:translate-y-[3px] has-checked:shadow-none has-[[aria-disabled=true]]:opacity-60 has-[[aria-disabled=true]]:shadow-none",
    layout: "flex items-center justify-center gap-1 px-2 py-2 text-center text-sm leading-tight",
  },
  chip: "pixel-frame bg-card px-2 py-1 text-sm",
  screenChip: "pixel-frame bg-screen-paper text-screen-ink px-2 py-1 text-sm",
  // rounded-none is the one deliberate rounded- class: it resets iOS's rounded date input
  input: "min-h-11 rounded-none border-3 border-frame bg-card px-3 py-2 text-base text-foreground focus-pixel",
  h1: "font-pixel text-[2rem] leading-tight font-bold text-brand",
  h2: "font-pixel text-xl font-semibold",
  dataHeading: "text-base font-bold",
  meta: "text-xs text-muted",
  inlineLink: "underline underline-offset-2 focus-pixel",
} as const;

export type ButtonVariant = keyof typeof PX.btn;

/** Joins the truthy parts with single spaces. */
export function cx(...parts: unknown[]): string {
  return parts.filter((p) => typeof p === "string" && p !== "").join(" ");
}
