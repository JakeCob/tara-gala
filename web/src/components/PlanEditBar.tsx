"use client";

// TG-61 ux.md §3: the slim bar that stays in view while editing, above the World tabs. It holds Undo (Redo right after
// an undo), Changes and Done editing, and one status line that every change replaces, so a result never lands
// off-screen (the TG-53 lesson).
import { useState } from "react";
import { PX, PixelBox, PixelButton } from "@/components/pixel";
import { type PlanEdits, historyLine, undoLabel } from "@/lib/planLines";

export default function PlanEditBar({ edits, status, can, stale, today, onUndo, onReload, onDone }: {
  edits: PlanEdits | null;
  status: string;
  can: boolean;
  /** A newer plan is known but isn't on screen, and its fetch failed or came back older (review M2) */
  stale: boolean;
  today: string;
  onUndo: () => void;
  onReload: () => void;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const nothing = !edits || edits.versions[0]?.seq === 0;
  return (
    <PixelBox className="sticky top-0 z-20 flex flex-col gap-2 p-3">
      <p className="font-semibold">Editing the plan</p>
      <div className="flex flex-wrap gap-2">
        <PixelButton variant="secondary" aria-disabled={!can || nothing || undefined} onClick={() => can && onUndo()}>
          {undoLabel(edits)}
        </PixelButton>
        <PixelButton variant="secondary" aria-expanded={open} aria-controls="plan-changes" onClick={() => setOpen((o) => !o)}>
          Changes
        </PixelButton>
        <PixelButton variant="secondary" onClick={onDone}>
          Done editing
        </PixelButton>
      </div>
      <p role="status" aria-live="polite" className="text-sm break-words empty:sr-only">{status}</p>
      {stale && (
        <PixelButton variant="secondary" className="inline-flex items-center self-start px-4 text-sm" onClick={onReload}>
          Reload the plan
        </PixelButton>
      )}
      {open && (
        <div id="plan-changes" className="flex flex-col gap-2 border-t-2 border-border pt-2">
          {edits?.versions.length ? (
            <ol className="flex flex-col gap-1 text-sm">
              {edits.versions.map((v) => (
                <li key={v.seq} className="break-words">{historyLine(v, today)}</li>
              ))}
            </ol>
          ) : (
            <p className="text-sm">No changes yet.</p>
          )}
          <p className={PX.meta}>Undo takes back the newest change only.</p>
        </div>
      )}
    </PixelBox>
  );
}
