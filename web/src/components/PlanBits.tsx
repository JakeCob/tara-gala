"use client";

// TG-61: small pieces the plan editor's steps share: a failed step's alert, the list of what a change does, and how to
// get to a stop.
import { useEffect, useRef } from "react";
import { PX, PixelBox } from "@/components/pixel";
import type { LegOut } from "@/lib/guide";
import { type ChangeLine, changeRows, legLines } from "@/lib/planLines";

/** A failed step, under its control. It brings itself into view: a long dialog may have it below the fold (TG-53). */
export function PlanProblem({ text }: { text: string }) {
  const here = useRef<HTMLDivElement>(null);
  useEffect(() => here.current?.scrollIntoView({ block: "nearest" }), [text]);
  return (
    <div ref={here}>
      <PixelBox as="p" tone="alertText" role="alert" className="p-3 text-sm">
        {text}
      </PixelBox>
    </div>
  );
}

/** What changes (ux.md §4.4): a bold word, the World, the text. Never colour alone. */
export function ChangeList({ lines }: { lines: ChangeLine[] }) {
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {changeRows(lines).map((l, i) => (
        <li key={i} className="break-words">
          {l.word ? (
            <>
              <span className="font-bold">{l.word}</span> · {l.text}
            </>
          ) : (
            l.text
          )}
        </li>
      ))}
    </ul>
  );
}

/** How to get to a stop: a route on file with its trust line, or an estimate, which never has a fare (D1). */
export function LegLine({ leg }: { leg: LegOut | null }) {
  if (!leg) return <p className="text-sm">No pin for one of these places, so there&apos;s no travel estimate.</p>;
  const { line, note } = legLines(leg);
  return (
    <>
      <p className="text-sm">{line}</p>
      <p className={PX.meta}>{note}</p>
    </>
  );
}
