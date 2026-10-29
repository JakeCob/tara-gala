// The home page's Philippine decor strip (TG-45, ux.md section 1): which sprites show at which widths. Plain data
// with no imports; HomeDecor.tsx renders it. Decoration only: the strip is aria-hidden and carries no content.

export type DecorShow = "all" | "min375" | "md";

// Literal class strings, so Tailwind finds them. The carabao needs a 375px phone to fit (ux.md 1.3).
export const SHOW_CLASS: Record<DecorShow, string> = { all: "", min375: "hidden min-[375px]:block", md: "hidden md:block" };

// The grounded row, left to right (ux.md 1.3)
export const HOME_ROW = [
  { name: "deco-rice-terraces", show: "md" },
  { name: "deco-bahay-kubo", show: "all" },
  { name: "chibi-barong", show: "all" },
  { name: "chibi-filipiniana", show: "all" },
  { name: "deco-taho-vendor", show: "md" },
  { name: "deco-carabao", show: "min375" },
  { name: "deco-sampaguita", show: "md" },
  { name: "deco-panagbenga-float", show: "md" },
] as const;

// The sky. The sun with three stars is an emblem, not the flag (RA 8491), and appears only here.
export const HOME_SKY = [
  { name: "deco-sun-stars", show: "all", at: "absolute top-1 right-1" },
  { name: "deco-parol", show: "md", at: "absolute top-1 left-2" },
] as const;

// pr-14 keeps the row out from under the sun, md:pl-12 out from under the parol; h-20 is fixed so nothing shifts
export const HOME_STRIP_CLASS =
  "pointer-events-none relative h-20 pixel-frame bg-screen pixelated flex items-end justify-center gap-2 pl-2 pr-14 pb-1 md:gap-4 md:pl-12 lg:gap-6";
