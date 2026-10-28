"use client";

// Share this trip (TG-23, ux.md 2.2): Web Share, else copy the link, else a field to copy by hand.
// The tap logic lives in runShare (lib/itinerary.ts, unit-tested); this only renders its outcome.
import { useEffect, useRef, useState } from "react";
import { runShare, shareDeps, shareText, shareUrl, type ShareOutcome } from "@/lib/itinerary";
import { UI } from "@/components/planUi";

const STATUS: Record<ShareOutcome, string> = {
  done: "", // the OS share sheet was the feedback
  silent: "",
  copied: "Link copied.",
  manual: "Your phone didn't let us copy it. Press and hold the link to copy it.",
};

export default function ShareButton({ slug, tripDate, returnDate }: { slug: string; tripDate: string; returnDate: string | null }) {
  const [outcome, setOutcome] = useState<ShareOutcome | null>(null);
  const pending = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  // Rendered only in the found state, after mount, so navigator exists and the label never flashes
  const canShare = typeof navigator !== "undefined" && !!shareDeps(navigator).share;
  const url = typeof location !== "undefined" ? shareUrl(location.origin, slug) : "";

  useEffect(() => {
    if (outcome !== "manual") return;
    field.current?.focus(); // the one focus move on this page: they asked for the link
    field.current?.select();
  }, [outcome]);

  async function onShare() {
    if (pending.current) return; // a double tap must not stack share sheets; not `disabled`, so focus stays
    pending.current = true;
    try {
      const result = await runShare(shareDeps(navigator), {
        title: "Tara Gala trip plan",
        text: shareText(tripDate, returnDate),
        url,
      });
      console.info("[tg-itinerary] share method=%s outcome=%s", canShare ? "share" : "copy", result);
      setOutcome(result);
    } finally {
      pending.current = false;
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button type="button" onClick={onShare} className={UI.primaryBtn}>
        {canShare ? "Share this trip" : "Copy link"}
      </button>
      <p role="status" className="text-sm">
        {outcome ? STATUS[outcome] : ""}
      </p>
      {outcome === "manual" && (
        <label className="flex flex-col gap-1">
          <span className={UI.meta}>Trip link</span>
          <input ref={field} readOnly value={url} className={UI.input} onFocus={(e) => e.currentTarget.select()} />
        </label>
      )}
    </div>
  );
}
