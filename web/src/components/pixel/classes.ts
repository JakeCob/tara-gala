// Pixel theme class strings (TG-42, ux-guide v2 section 4.1). A plain module, so tests and Tailwind can read it.
//
// Each primitive has a skin (frame, focus, fill, text colour, weight, min-height) and a default layout (display,
// alignment, padding, text size). There's no class-merge utility, so two classes that set the same property resolve
// by stylesheet order. That's why a primitive's className prop replaces the layout and is never merged with it.
// A different look is a new variant here, never a skin class passed through className.
//
// Usage rules for consumers:
// - inlineLink is only for a link inside running text: it has no min-h-11. A standalone link is a PixelLink.
// - Never put a control on a bg-accent, bg-brand or bg-primary surface (Ink focus on Blue is 1.51). The focus outline
//   is invisible there (1.05:1 on Flag Yellow in dark mode; 2.74 and 1.84 on brand; 2.65 on Red). Put the control on a
//   card inside that surface instead.
// - box.alert is the red lining for error and changed boxes (TG-47 ux §7), set by PixelBox tone, never by className.
//   A Blue control may sit above or below an alert box, never inside it.
// - choice uses a named group (group/choice), so an outer .group can't light every MenuCursor.

export const PX = {
  box: {
    skin: "pixel-box bg-card",
    layout: "p-4 flex flex-col gap-2",
    // the 3px gap between the double frame turns Red on all four sides: no element, no layout change
    alert: "shadow-[inset_0_0_0_6px_var(--danger)]",
    alertText: "shadow-[inset_0_0_0_6px_var(--danger)] text-danger-text", // a one-sentence box is its own lead
  },
  btn: {
    primary: { skin: "pixel-btn focus-pixel min-h-11 bg-primary font-bold text-primary-ink", layout: "px-4 py-3" },
    secondary: { skin: "pixel-btn focus-pixel min-h-11 bg-card font-semibold text-foreground", layout: "inline-flex items-center px-4 text-sm" },
    accent: { skin: "pixel-btn focus-pixel min-h-11 bg-accent font-bold text-accent-ink", layout: "inline-flex items-center px-3 text-sm" },
    icon: { skin: "pixel-btn focus-pixel min-h-11 min-w-11 bg-card", layout: "inline-flex items-center justify-center" },
    iconBrand: { skin: "pixel-btn focus-pixel min-h-11 min-w-11 bg-card text-link", layout: "inline-flex items-center justify-center text-xl leading-none" },
  },
  choice: {
    skin: "group/choice pixel-btn focus-pixel-within min-h-11 cursor-pointer bg-card font-semibold has-checked:bg-primary has-checked:text-primary-ink has-checked:translate-y-[3px] has-checked:shadow-none has-[[aria-disabled=true]]:opacity-60 has-[[aria-disabled=true]]:shadow-none",
    layout: "flex items-center justify-center gap-1 px-2 py-2 text-center text-sm leading-tight",
  },
  chip: "pixel-frame bg-card px-2 py-1 text-sm",
  chipHighlight: "pixel-frame bg-accent text-accent-ink px-2 py-1 text-sm", // the chip in Flag Yellow, same box
  screenChip: "pixel-frame bg-screen-paper text-screen-ink px-2 py-1 text-sm",
  // rounded-none is the one deliberate rounding class: it resets the rounded iOS date input
  input: "min-h-11 rounded-none border-3 border-frame bg-card px-3 py-2 text-base text-foreground focus-pixel",
  h1: "font-pixel text-[2rem] leading-tight font-bold text-brand md:text-[2.5rem]",
  // TG-46: the same title on the hero, a fixed light screen
  h1Screen: "font-pixel text-[2rem] leading-tight font-bold text-screen-ink md:text-[2.5rem]",
  h2: "font-pixel text-xl font-semibold",
  dataHeading: "text-base font-bold",
  meta: "text-xs text-muted",
  inlineLink: "underline underline-offset-2 focus-pixel text-link",
  // TG-43: a sprite plate (stepper-row chibis, stop sprites), the stage's name tags, the budget's ₱ prefix, and
  // the share page's decorative step numeral (plan §3.2), so font-pixel stays inside components/pixel
  plate: "pixel-frame bg-screen-paper p-0.5 inline-flex shrink-0",
  numeral: "font-pixel text-xl font-semibold",
  // TG-44 ux §2: every page's main element. Its phone tokens are the old string, in order; md/lg/xl widen it
  shell: "mx-auto w-full max-w-md flex-1 px-4 py-6 flex flex-col gap-5 md:max-w-3xl md:px-6 md:py-8 lg:max-w-5xl lg:px-8 xl:max-w-6xl",
  screenTag: "pixel-frame bg-screen-paper text-screen-ink px-1 text-xs font-semibold",
  inputPrefix: "inline-flex items-center border-3 border-r-0 border-frame bg-card px-3 text-base font-bold text-foreground",
} as const;

export type ButtonVariant = keyof typeof PX.btn;

/** Joins the truthy parts with single spaces. */
export function cx(...parts: unknown[]): string {
  return parts.filter((p) => typeof p === "string" && p !== "").join(" ");
}
