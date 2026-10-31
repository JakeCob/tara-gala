// The landing's chibi slots (TG-46 ux §5.1, §5.3, §5.5). `index` picks one of a type's TG-48 looks, as the party stage
// does, so the landing is one cast with /plan and the home strip. Plain module.
import { lookFor } from "./party.ts";
import { chibiLook, type ChibiFrame, type PassengerType, type SpriteName } from "./sprites.ts";

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

/** The sprite for one slot: the slot type's look at `index` (TG-48). Every PassengerType has looks, so never null. */
export function castSprite(slot: CastSlot): SpriteName {
  return chibiLook(lookFor(slot.type, slot.index)!, slot.frame);
}

