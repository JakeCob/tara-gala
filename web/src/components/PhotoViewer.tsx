"use client";

import { useEffect, useRef, type ComponentPropsWithoutRef } from "react";
import { PixelButton } from "@/components/pixel";

/** A photo kept on this phone. Its object URL goes straight onto the element and is freed when the photo changes or unmounts. */
export function BlobImage({ blob, alt, ...rest }: { blob: Blob; alt: string } & Omit<ComponentPropsWithoutRef<"img">, "src" | "alt">) {
  const img = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const url = URL.createObjectURL(blob);
    if (img.current) img.current.src = url;
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  // eslint-disable-next-line @next/next/no-img-element -- a local blob: URL, which next/image can't load
  return <img ref={img} alt={alt} {...rest} />;
}

/**
 * A ticket or payout QR, full screen on the fixed light screen whatever the theme (QR scanners want a light page),
 * with the screen kept awake where the browser allows. Open while `photo` is set; Close or Escape calls onClose.
 */
export function PhotoViewer({ photo, onClose, logTag }: { photo: { blob: Blob; label: string } | null; onClose: () => void; logTag: string }) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (!photo) return;
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    let wake: WakeLockSentinel | null = null;
    let live = true;
    (async () => {
      try {
        wake = (await navigator.wakeLock?.request("screen")) ?? null;
      } catch {
        wake = null; // refused (battery saver, or no permission): the photo still shows
      }
      if (!live) wake?.release().catch(() => {});
      console.info("[%s] show wakeLock=%s", logTag, wake !== null);
    })();
    return () => {
      live = false;
      wake?.release().catch(() => {});
    };
  }, [photo, logTag]);

  return (
    <dialog ref={dialog} onClose={onClose} aria-label={photo?.label ?? "Photo"} className="m-0 h-dvh max-h-none w-full max-w-none bg-screen-paper p-0 text-screen-ink">
      <div className="mx-auto flex h-full max-w-md flex-col gap-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 break-words text-sm font-bold">{photo?.label}</p>
          <PixelButton variant="secondary" autoFocus onClick={() => dialog.current?.close()}>
            Close
          </PixelButton>
        </div>
        {photo && <BlobImage blob={photo.blob} alt={photo.label} className="min-h-0 w-full flex-1 object-contain" />}
      </div>
    </dialog>
  );
}
