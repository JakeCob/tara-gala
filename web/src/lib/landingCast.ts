// The landing's chibi slots (TG-46 ux §5.1, §5.3, §5.5). `index` picks one of a type's looks once TG-48 adds them;
// until then every index draws the TG-33 sprite for its type. Plain module.
import { chibi, type ChibiFrame, type PassengerType, type SpriteName } from "./sprites.ts";

export type CastSlot = { type: PassengerType; index: number; frame: ChibiFrame };

export const CAST = {
  heroTrio: [
    { type: "adult", index: 1, frame: "idle-1" },
    { type: "senior", index: 0, frame: "idle-1" },
    { type: "student", index: 1, frame: "idle-1" },
  ],
  planTile: { type: "adult", index: 0, frame: "wave" },
  planStep: { type: "senior", index: 1, frame: "idle-1" },
} as const satisfies { heroTrio: readonly CastSlot[]; planTile: CastSlot; planStep: CastSlot };

/** The sprite for one slot (TG-48 swaps the looks in here). */
export function castSprite(slot: CastSlot): SpriteName {
  return chibi(slot.type, slot.frame);
}
