// Sprite manifest (TG-33). Names and sizes follow web/sprites-src/art-prompts.md; files live in web/public/sprites/.
// The 2026-10-29 AI art drop ships as PNG (PNG_ART); the rest are hand-made SVG placeholders from web/sprites-src/ grids.

export const PASSENGER_TYPES = ["adult", "student", "senior", "pwd"] as const; // schema passenger_type minus child
export const SPOT_CATEGORIES = ["park", "food", "market", "museum", "viewpoint", "shopping", "church", "cafe", "other"] as const;
export const LAST_MILE_MODES = ["jeep", "taxi", "walk", "tricycle", "van", "grab"] as const;
export const CHIBI_FRAMES = ["idle-1", "idle-2", "wave"] as const;
export type PassengerType = (typeof PASSENGER_TYPES)[number];
export type SpotCategory = (typeof SPOT_CATEGORIES)[number];
export type LastMileMode = (typeof LAST_MILE_MODES)[number];
export type ChibiFrame = (typeof CHIBI_FRAMES)[number];

const CHIBI = { w: 32, h: 32 };
const TILE = { w: 16, h: 16 };
const PLACE = { w: 24, h: 24 };
const MODE = { w: 24, h: 16 };
const UI = { w: 8, h: 8 };
const DECO_SQUARE = { w: 24, h: 24 };
const DECO_WIDE = { w: 32, h: 24 };

export const SPRITES = {
  "chibi-adult-idle-1": CHIBI, "chibi-adult-idle-2": CHIBI, "chibi-adult-wave": CHIBI,
  "chibi-student-idle-1": CHIBI, "chibi-student-idle-2": CHIBI, "chibi-student-wave": CHIBI,
  "chibi-senior-idle-1": CHIBI, "chibi-senior-idle-2": CHIBI, "chibi-senior-wave": CHIBI,
  "chibi-pwd-idle-1": CHIBI, "chibi-pwd-idle-2": CHIBI, "chibi-pwd-wave": CHIBI,
  "tile-grass": TILE, "tile-path-straight": TILE, "tile-path-corner": TILE, "tile-pine": TILE,
  "tile-mountain": TILE, "tile-road": TILE, "tile-water": TILE,
  "place-terminal": PLACE, "place-lodging": PLACE, "place-park": PLACE, "place-food": PLACE,
  "place-market": PLACE, "place-museum": PLACE, "place-viewpoint": PLACE, "place-shopping": PLACE,
  "place-church": PLACE, "place-cafe": PLACE, "place-other": PLACE,
  "vehicle-bus": { w: 48, h: 24 },
  "mode-jeep": MODE, "mode-taxi": MODE, "mode-tricycle": MODE, "mode-van": MODE, "mode-grab": MODE,
  "mode-walk": TILE,
  "ui-dialog-frame": { w: 24, h: 24 }, // 9-slice, 8px corners
  "ui-cursor": UI, "ui-star": UI, "ui-heart": UI,
  "ui-badge-verified": TILE,
  "logo-wordmark": { w: 192, h: 48 },
  // TG-45 Philippine decor, home strip and map scenery only. chibi-barong and chibi-filipiniana are decor, not passenger types (TG-45)
  "deco-sun-stars": DECO_SQUARE, "deco-carabao": DECO_WIDE, "deco-bahay-kubo": DECO_SQUARE,
  "chibi-barong": CHIBI, "chibi-filipiniana": CHIBI, "deco-taho-vendor": CHIBI,
  "deco-parol": TILE, "deco-sampaguita": TILE, "deco-rice-terraces": DECO_SQUARE, "deco-panagbenga-float": DECO_WIDE,
  // TG-46 the landing hero, drawn at 2x
  "hero-scene": { w: 320, h: 123 },
  // TG-48 diverse Filipino passengers: one look per passenger, cycled per type by party.ts lookFor (11-colour palette)
  "chibi-adult-casual-f-idle-1": CHIBI, "chibi-adult-casual-f-idle-2": CHIBI, "chibi-adult-casual-f-wave": CHIBI,
  "chibi-adult-casual-m-idle-1": CHIBI, "chibi-adult-casual-m-idle-2": CHIBI, "chibi-adult-casual-m-wave": CHIBI,
  "chibi-adult-filipiniana-idle-1": CHIBI, "chibi-adult-filipiniana-idle-2": CHIBI, "chibi-adult-filipiniana-wave": CHIBI,
  "chibi-adult-barong-idle-1": CHIBI, "chibi-adult-barong-idle-2": CHIBI, "chibi-adult-barong-wave": CHIBI,
  "chibi-student-girl-idle-1": CHIBI, "chibi-student-girl-idle-2": CHIBI, "chibi-student-girl-wave": CHIBI,
  "chibi-student-boy-idle-1": CHIBI, "chibi-student-boy-idle-2": CHIBI, "chibi-student-boy-wave": CHIBI,
  "chibi-senior-lola-idle-1": CHIBI, "chibi-senior-lola-idle-2": CHIBI, "chibi-senior-lola-wave": CHIBI,
  "chibi-senior-lolo-idle-1": CHIBI, "chibi-senior-lolo-idle-2": CHIBI, "chibi-senior-lolo-wave": CHIBI,
  "chibi-pwd-woman-idle-1": CHIBI, "chibi-pwd-woman-idle-2": CHIBI, "chibi-pwd-woman-wave": CHIBI,
  "chibi-pwd-man-idle-1": CHIBI, "chibi-pwd-man-idle-2": CHIBI, "chibi-pwd-man-wave": CHIBI,
} as const satisfies Record<string, { w: number; h: number }>;
export type SpriteName = keyof typeof SPRITES;

// Art drop: list each sprite that now ships as PNG. The sprite tests check this matches the files on disk.
export const PNG_ART: ReadonlySet<SpriteName> = new Set<SpriteName>([
  "chibi-adult-idle-1", "chibi-adult-idle-2", "chibi-adult-wave", "chibi-pwd-idle-1",
  "chibi-pwd-idle-2", "chibi-pwd-wave", "chibi-senior-idle-1", "chibi-senior-idle-2",
  "chibi-senior-wave", "chibi-student-idle-1", "chibi-student-idle-2", "chibi-student-wave",
  "logo-wordmark", "mode-grab", "mode-jeep", "mode-taxi",
  "mode-tricycle", "mode-walk", "place-cafe",
  "place-church", "place-food", "place-lodging", "place-market",
  "place-museum", "place-other", "place-park", "place-shopping",
  "place-terminal", "place-viewpoint", "tile-mountain", "tile-pine",
  "ui-badge-verified", "ui-heart", "ui-star", "vehicle-bus",
  "deco-sun-stars", "deco-carabao", "deco-bahay-kubo", "chibi-barong",
  "chibi-filipiniana", "deco-taho-vendor", "deco-parol", "deco-sampaguita",
  "deco-rice-terraces", "deco-panagbenga-float", "hero-scene",
  "chibi-adult-casual-f-idle-1", "chibi-adult-casual-f-idle-2", "chibi-adult-casual-f-wave",
  "chibi-adult-casual-m-idle-1", "chibi-adult-casual-m-idle-2", "chibi-adult-casual-m-wave",
  "chibi-adult-filipiniana-idle-1", "chibi-adult-filipiniana-idle-2", "chibi-adult-filipiniana-wave",
  "chibi-adult-barong-idle-1", "chibi-adult-barong-idle-2", "chibi-adult-barong-wave",
  "chibi-student-girl-idle-1", "chibi-student-girl-idle-2", "chibi-student-girl-wave",
  "chibi-student-boy-idle-1", "chibi-student-boy-idle-2", "chibi-student-boy-wave",
  "chibi-senior-lola-idle-1", "chibi-senior-lola-idle-2", "chibi-senior-lola-wave",
  "chibi-senior-lolo-idle-1", "chibi-senior-lolo-idle-2", "chibi-senior-lolo-wave",
  "chibi-pwd-woman-idle-1", "chibi-pwd-woman-idle-2", "chibi-pwd-woman-wave",
  "chibi-pwd-man-idle-1", "chibi-pwd-man-idle-2", "chibi-pwd-man-wave",
]);

export function spriteSrc(name: SpriteName): string {
  return `/sprites/${name}.${PNG_ART.has(name) ? "png" : "svg"}`;
}

export function chibi(type: PassengerType, frame: ChibiFrame): SpriteName {
  return `chibi-${type}-${frame}`;
}

// TG-48: a passenger's look, "<type>-<look>". party.ts LOOKS holds the order each type cycles through.
export type ChibiLook =
  | "adult-casual-f" | "adult-casual-m" | "adult-filipiniana" | "adult-barong"
  | "student-girl" | "student-boy"
  | "senior-lola" | "senior-lolo"
  | "pwd-woman" | "pwd-man";

export function chibiLook(look: ChibiLook, frame: ChibiFrame): SpriteName {
  return `chibi-${look}-${frame}`;
}

// Takes a string: the API's spot category is a plain string. Unknown values fall back to the generic place.
export function placeSprite(kind: string): SpriteName {
  const known = (SPOT_CATEGORIES as readonly string[]).includes(kind) || kind === "terminal" || kind === "lodging";
  return known ? (`place-${kind}` as SpriteName) : "place-other";
}

// Unknown modes get no sprite (null): show the text label only, never a wrong vehicle.
export function modeSprite(mode: string): SpriteName | null {
  return (LAST_MILE_MODES as readonly string[]).includes(mode) ? (`mode-${mode}` as SpriteName) : null;
}
