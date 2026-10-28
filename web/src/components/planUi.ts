// Class strings for the /plan screen (TG-15) and the /i/[slug] share page (TG-23), in the ux-guide v2 shapes
// on the tokens main has today.
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
  // <PixelBox className="p-4 flex flex-col gap-1">: a text box or stop box with tighter lines (TG-23)
  textBox: "border-3 border-foreground bg-card outline-3 outline-solid outline-foreground -outline-offset-9 p-4 flex flex-col gap-1",
  // <PixelButton variant="primary"> (TG-23 Share)
  primaryBtn:
    "inline-flex items-center justify-center w-full min-h-11 px-4 font-bold bg-brand text-brand-ink border-3 border-foreground " +
    "shadow-[0_3px_0_0_var(--foreground)] active:translate-y-[3px] active:shadow-none " +
    "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-foreground",
  // <PixelButton variant="secondary"> / <PixelLink variant="secondary"> (TG-23 Search buses, Try again)
  secondaryBtn:
    "inline-flex items-center justify-center self-start min-h-11 px-4 text-sm font-semibold text-foreground border-3 border-foreground bg-card " +
    "shadow-[0_3px_0_0_var(--foreground)] active:translate-y-[3px] active:shadow-none aria-disabled:opacity-60 aria-disabled:shadow-none " +
    "aria-disabled:active:translate-y-0 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-foreground",
  // ux-guide 4.1 input (TG-23 manual copy field)
  input:
    "w-full min-h-11 px-3 text-base border-3 border-foreground bg-card " +
    "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-foreground",
  // pixel-frame bg-card chip (TG-23 vibe, Pre-made plan); not a button
  chip: "border-3 border-foreground bg-card px-2 py-1 text-sm",
  // TG-21 planner form. TG-23's secondaryBtn is shared; keys that differ from TG-23's have their own names.
  // a box that is a fieldset keeps its border off the legend: the frame goes on a wrapper with UI.box
  fieldset: "m-0 min-w-0 border-0 p-0 flex flex-col gap-3",
  // PX.input, with placeholder colour and min-w-0 for the ₱ row
  formInput:
    "min-h-11 w-full min-w-0 border-3 border-foreground bg-card px-3 py-2 text-base text-foreground placeholder:text-muted " +
    "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-foreground",
  // the ₱ prefix glued to the budget input
  prefix: "inline-flex items-center border-3 border-r-0 border-foreground bg-card px-3 text-base font-bold",
  // <PixelButton variant="primary">, dimmed while a request runs (aria-disabled)
  submitBtn:
    "min-h-11 px-4 py-3 border-3 border-foreground bg-brand text-brand-ink font-bold shadow-[0_3px_0_0_var(--foreground)] " +
    "active:translate-y-[3px] active:shadow-none aria-disabled:opacity-60 aria-disabled:shadow-none aria-disabled:active:translate-y-0 " +
    "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-foreground",
  // <PixelChoice type="checkbox">: a label around an sr-only checkbox; dimmed when its input is aria-disabled
  choice:
    "inline-flex items-center gap-1 min-h-11 px-3 text-sm font-semibold cursor-pointer border-3 border-foreground bg-card " +
    "shadow-[0_3px_0_0_var(--foreground)] has-checked:bg-brand has-checked:text-brand-ink has-checked:translate-y-[3px] " +
    "has-checked:shadow-none has-[[aria-disabled=true]]:opacity-60 has-[[aria-disabled=true]]:shadow-none " +
    "has-focus-visible:outline-3 has-focus-visible:outline-offset-2 has-focus-visible:outline-foreground",
  // PX.chip, small: "Matches your dates" on a trip card
  matchChip: "self-start border-3 border-foreground bg-card px-2 py-1 text-xs font-semibold",
  // PX.dataHeading
  dataHeading: "text-base font-bold",
} as const;
