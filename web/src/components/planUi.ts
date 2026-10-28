// Class strings for the /plan screen (TG-15), in the ux-guide v2 shapes on the tokens main has today.
// TG-42 swap: each key names the PR A primitive or token that replaces it, so the restyle is one element at a time
// and this file is then deleted. Plain module.
export const UI = {
  // <PageTitle>
  h1: "text-[2rem] leading-tight font-bold text-brand",
  // <SectionTitle>
  h2: "text-xl font-semibold",
  // <PixelBox className="p-4 flex flex-col gap-3">
  box: "border-3 border-foreground bg-card outline-3 outline-solid outline-foreground -outline-offset-9 p-4 flex flex-col gap-3",
  // <PixelButton variant="icon">
  iconBtn:
    "inline-flex items-center justify-center min-h-11 min-w-11 border-3 border-foreground bg-card shadow-[0_3px_0_0_var(--foreground)] " +
    "active:translate-y-[3px] active:shadow-none aria-disabled:opacity-60 aria-disabled:shadow-none aria-disabled:active:translate-y-0 " +
    "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-foreground",
  // <PixelLink variant="secondary">
  backLink:
    "inline-flex items-center self-start min-h-11 px-4 text-sm font-semibold text-foreground border-3 border-foreground bg-card " +
    "shadow-[0_3px_0_0_var(--foreground)] active:translate-y-[3px] active:shadow-none " +
    "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-foreground",
  // pixel-frame bg-screen (the grass tile covers it, fixed in both themes)
  stage: "border-3 border-foreground",
  // PX.screenChip: bg-screen-paper text-screen-ink (fixed light paper in both themes, ux-guide §1.3)
  screenChip: "border-3 border-stone-900 bg-stone-50 text-stone-900",
  // pixel-frame bg-screen-paper p-0.5: the 1× sprite plate in each row
  plate: "border-3 border-stone-900 bg-stone-50 p-0.5",
  // the pixelated utility
  pixelated: "[image-rendering:pixelated]",
  // PX.meta
  meta: "text-xs text-muted",
} as const;
