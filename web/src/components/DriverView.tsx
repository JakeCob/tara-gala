"use client";

import { type RefObject, useEffect, useRef } from "react";
import { PixelButton } from "@/components/pixel";

/**
 * TG-69 ux §8.3: the hotel's name and address in big text, full screen, to hold up to a driver. On the page's own paper
 * and ink, so it follows the theme; no map and no art. Each new `opened` (a count of taps) opens it; Close or Esc
 * closes it, and focus goes back to the button that opened it. It only shows text, so it works offline.
 */
export default function DriverView({ hotel, opened, opener }: { hotel: { name: string; address: string }; opened: number; opener: RefObject<HTMLButtonElement | null> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  // A count, not a flag: a tap straight after Esc comes before the dialog's close event, and still opens it
  useEffect(() => {
    if (!opened || !dialog.current || dialog.current.open) return;
    dialog.current.showModal();
    console.info("[tg-trip] next-up driver open");
  }, [opened]);
  const close = () => dialog.current?.close();
  return (
    <dialog ref={dialog} aria-label="Show the driver"
      onClose={() => {
        console.info("[tg-trip] next-up driver close");
        opener.current?.focus();
      }}
      className="m-0 h-dvh max-h-none w-full max-w-none overflow-y-auto bg-background p-0 text-foreground">
      <div className="mx-auto flex min-h-full max-w-xl flex-col gap-4 p-4">
        <div className="flex justify-end">
          <PixelButton variant="secondary" autoFocus onClick={close}>
            Close
          </PixelButton>
        </div>
        <div className="flex flex-1 flex-col justify-center gap-4">
          <p className="text-2xl font-bold break-words">{hotel.name}</p>
          <p className="text-[28px] leading-tight font-bold break-words select-text">{hotel.address}</p>
        </div>
      </div>
    </dialog>
  );
}
