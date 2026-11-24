"use client";

import { PixelButton } from "@/components/pixel";
import { KALOY_WORDS } from "@/lib/kaloy";
import { KaloySprite } from "./Kaloy";

/**
 * TG-75 the floating Ask Kaloy button (owner, 2026-11-24): the trip page's bottom-right, above the phones' tab bar and
 * in the corner from md. It opens the same chat as the World buttons with no need to tap Edit the plan, and it stays
 * with no signal: the chat itself says it needs signal. TripView shows it only behind NEXT_PUBLIC_KALOY_FAB.
 */
export function KaloyFab({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="fixed right-4 bottom-[calc(5.25rem+env(safe-area-inset-bottom))] z-30 md:bottom-6 md:right-6">
      <PixelButton variant="primary" className="inline-flex items-center px-4 py-2 text-sm"
        onClick={() => {
          console.info("[tg-trip] chat open from=fab");
          onOpen();
        }}>
        <KaloySprite pose="idle" className="-my-1 mr-2" />{KALOY_WORDS.ask}
      </PixelButton>
    </div>
  );
}
