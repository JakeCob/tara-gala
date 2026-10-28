"use client";

import { useId } from "react";
import {
  DISCOUNT_NOTE,
  PICKER_TYPES,
  TYPE_HINT,
  TYPE_LABEL,
  add,
  addLabel,
  canAdd,
  canRemove,
  counts,
  partySummary,
  remove,
  removeLabel,
  type Party,
} from "@/lib/party";
import { chibi, spriteSrc, type PassengerType } from "@/lib/sprites";
import { PX, PixelBox, PixelButton, SectionTitle } from "@/components/pixel";

type Props = {
  party: Party;
  onChange(party: Party): void;
  onAdd?(index: number): void; // the new passenger's index, so the page can spawn its chibi
};

/**
 * "Who's travelling?" steppers (TG-15, ux.md §2.2). Controlled: the page owns the party. Buttons at a limit are
 * aria-disabled, never disabled, so focus stays on the button the user just pressed.
 */
export default function PartyPicker({ party, onChange, onAdd }: Props) {
  const id = useId();
  const n = counts(party);

  function plus(t: PassengerType) {
    if (!canAdd(party)) return;
    const next = add(party, t);
    onChange(next);
    console.info(`[tg-party] add type=${t} size=${next.length}`);
    if (!canAdd(next)) console.info("[tg-party] limit reached");
    onAdd?.(next.length - 1);
  }

  function minus(t: PassengerType) {
    if (!canRemove(party, t)) return;
    const next = remove(party, t);
    onChange(next);
    console.info(`[tg-party] remove type=${t} size=${next.length}`);
  }

  return (
    <PixelBox as="section" className="p-4 flex flex-col gap-3">
      <SectionTitle id={`${id}-h`}>Who&apos;s travelling?</SectionTitle>
      <ul role="group" aria-labelledby={`${id}-h`} className="flex flex-col gap-2">
        {PICKER_TYPES.map((t) => (
          <li key={t} role="group" aria-labelledby={`${id}-${t}-label ${id}-${t}-count`} className="flex items-center gap-3 min-h-14">
            <span className={PX.plate}>
              {/* eslint-disable-next-line @next/next/no-img-element -- pixel art: next/image would resample PNG art and needs dangerouslyAllowSVG */}
              <img src={spriteSrc(chibi(t, "idle-1"))} width={32} height={32} alt="" className="pixelated block" draggable={false} decoding="async" />
            </span>
            <span className="min-w-0 flex-1 flex flex-col">
              <span id={`${id}-${t}-label`} className="text-sm font-bold">
                {TYPE_LABEL[t]}
              </span>
              <span className={PX.meta}>{TYPE_HINT[t]}</span>
            </span>
            <PixelButton variant="icon" aria-label={removeLabel(t)} aria-disabled={!canRemove(party, t)} onClick={() => minus(t)}>
              <span aria-hidden="true" className="text-xl font-bold">
                −
              </span>
            </PixelButton>
            <span id={`${id}-${t}-count`} className="w-8 text-center text-xl font-bold tabular-nums">
              {n[t]}
            </span>
            <PixelButton variant="icon" aria-label={addLabel(t)} aria-disabled={!canAdd(party)} onClick={() => plus(t)}>
              <span aria-hidden="true" className="text-xl font-bold">
                +
              </span>
            </PixelButton>
          </li>
        ))}
      </ul>
      <p aria-live="polite" className="text-sm font-semibold">
        {partySummary(party)}
      </p>
      <p className={PX.meta}>{DISCOUNT_NOTE}</p>
    </PixelBox>
  );
}
