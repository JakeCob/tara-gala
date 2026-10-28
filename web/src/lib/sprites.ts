// Sprite manifest (TG-33). RED stub: the real lists, manifest and helpers land in GREEN.

export const PASSENGER_TYPES: readonly string[] = [];
export const SPOT_CATEGORIES: readonly string[] = [];
export const LAST_MILE_MODES: readonly string[] = [];
export const CHIBI_FRAMES: readonly string[] = [];
export type PassengerType = string;
export type SpotCategory = string;
export type LastMileMode = string;
export type ChibiFrame = string;

export const SPRITES: Record<string, { w: number; h: number }> = {};
export type SpriteName = string;

export const PNG_ART: ReadonlySet<SpriteName> = new Set<SpriteName>([]);

export function spriteSrc(name: SpriteName): string {
  throw new Error(`spriteSrc not implemented (${name})`);
}

export function chibi(type: PassengerType, frame: ChibiFrame): SpriteName {
  throw new Error(`chibi not implemented (${type}, ${frame})`);
}

export function placeSprite(kind: string): SpriteName {
  throw new Error(`placeSprite not implemented (${kind})`);
}

export function modeSprite(mode: string): SpriteName | null {
  throw new Error(`modeSprite not implemented (${mode})`);
}
