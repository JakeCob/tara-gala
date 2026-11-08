"use client";

// TG-61 ux.md §3: the slim bar that stays in view while editing, above the World tabs. Its top line is the title and
// Done editing; under it, Add a place (round 4, §4.8), Undo (Redo right after an undo) and Changes; then one status
// line that every change replaces, so a result never lands off-screen (the TG-53 lesson).
import { PX, PixelBox, PixelButton } from "@/components/pixel";
import { type PlanEdits, type Said, historyRow, undoLabel } from "@/lib/planLines";
import { LineText, SaidText } from "./PlanBits";

export default function PlanEditBar({ edits, status, can, online, stale, today, changesOpen: open, onChanges, onAddPlace, onUndo, onReload, onDone }: {
  edits: PlanEdits | null;
  status: Said | string;
  can: boolean;
  online: boolean;
  /** A newer plan is known but isn't on screen, and its fetch failed or came back older (review M2) */
  stale: boolean;
  today: string;
  /** Changes is open: the page opens it itself after an undo that met a newer change (ux §6) */
  changesOpen: boolean;
  onChanges: () => void;
  onAddPlace: () => void;
  onUndo: () => void;
  onReload: () => void;
  onDone: () => void;
}) {
  const nothing = !edits || edits.versions[0]?.seq === 0;
  return (
    <PixelBox className="sticky top-0 z-20 flex flex-col gap-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="font-semibold">Editing the plan</p>
        <PixelButton variant="secondary" onClick={onDone}>
          Done editing
        </PixelButton>
      </div>
      <div className="flex flex-wrap gap-2">
        {/* Saves nothing, so it stays live while a write is out; it needs signal (ux.md §4.8) */}
        <PixelButton variant="secondary" aria-disabled={!online || undefined} onClick={() => {
          console.info("[tg-trip] plan add-place bar open=%s", online ? "yes" : "offline");
          if (online) onAddPlace();
        }}>
          Add a place
        </PixelButton>
        <PixelButton variant="secondary" aria-disabled={!can || nothing || undefined} onClick={() => can && onUndo()}>
          {undoLabel(edits)}
        </PixelButton>
        <PixelButton variant="secondary" aria-expanded={open} aria-controls="plan-changes" onClick={onChanges}>
          Changes
        </PixelButton>
      </div>
      <p role="status" aria-live="polite" className="text-sm break-words empty:sr-only"><SaidText said={status} /></p>
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
                <li key={v.seq} className="break-words"><HistoryRow v={v} today={today} /></li>
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

/** A row in Changes (F13 FINAL): its time, then its first line in the shared display. */
function HistoryRow({ v, today }: { v: PlanEdits["versions"][number]; today: string }) {
  const r = historyRow(v, today);
  return (
    <>
      {r.at} · {r.lead}
      {r.line && <LineText line={r.line} />}
    </>
  );
}
