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

// TG-49: the title screen's trio comes alive. A tick every TICK_MS steps each chibi between its two idle frames, out of
// step with its neighbours, and once a round one of them waves, in turn. Pure, so the timing is tested without timers.
export const TICK_MS = 400;
const ROUND = 20; // ticks per round: 8 seconds
const WAVE = [12, 13, 14, 15]; // the round's ticks that wave: 1.6 seconds

/** The frame chibi `slot` (0, 1 or 2 of the trio) shows at `tick` */
export function castFrame(slot: number, tick: number): ChibiFrame {
  const round = Math.floor(tick / ROUND);
  if (round % CAST.heroTrio.length === slot && WAVE.includes(tick % ROUND)) return "wave";
  return (tick + slot) % 2 === 0 ? "idle-1" : "idle-2";
}
