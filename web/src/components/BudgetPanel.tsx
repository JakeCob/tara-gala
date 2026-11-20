"use client";

// TG-62 GW2: the trip page's Budget panel with the wallet's spending (TG-62 ux.md §3, §5 and §6). LevelMap mounts it
// from the trip menu, never in TG-64's recap; with NEXT_PUBLIC_BUDGET_LINES off it's never mounted and today's table
// shows. The words, rounding and totals are budgetPanel.ts's.
import { PX, PixelBox, PixelLink, cx } from "@/components/pixel";
import { type PanelView, panelView, shareHeading, stateLine } from "@/lib/budgetPanel";
import type { Guide } from "@/lib/guide";
import type { BudgetResult, SessionBudget } from "@/lib/sessionBudget";

/** What the trip page hands the map: the load (TripView fetches it), whose wallet, and when the trip ends. */
export type Spending = {
  load: "loading" | BudgetResult;
  walletSlug: string | null;
  /** This phone's member in the wallet, if it knows: "(you)" */
  me: string | null;
  returnDate: string;
  today: string;
  /** Opening the panel fetches again (ux §5) */
  onOpen: () => void;
};

/** ux §5: the line under today's table while there's no spending table: loading, a failure, no wallet, two trips. */
export function SpendingNote({ load }: { load: Spending["load"] }) {
  const line = stateLine(load === "loading" ? "loading" : load.ok ? load.budget.state : load.why);
  if (!line) return null;
  if (load === "loading") return <p className={PX.meta}>{line.text}</p>;
  return (
    <p className="text-sm">
      {line.text}
      {line.link && (
        <>
          {" "}
          <a className={PX.inlineLink} href="#money-title">{line.link}</a>
        </>
      )}
    </p>
  );
}

const WORD = (w: PanelView["total"]["word"]) => w && <span className={w.over ? "text-xs font-semibold text-danger-text" : PX.meta}>{w.text}</span>;

export default function BudgetPanel({ guide, budget, walletSlug, me, returnDate, today }: { guide: Guide; budget: SessionBudget } & Omit<Spending, "load" | "onOpen">) {
  const v = panelView(budget, me);
  return (
    <section className="flex flex-col gap-2 md:max-w-2xl">
      <h3 className={PX.dataHeading}>Budget per person</h3>
      {guide.budget.summary && <p className="text-sm">{guide.budget.summary}</p>}
      <PixelBox className="overflow-x-auto p-0">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">The plan and the spending per person, in pesos</caption>
          <thead>
            <tr className="border-b-2 border-border">
              <th scope="col" className="px-3 py-2 font-semibold">Item</th>
              <th scope="col" className="px-3 py-2 text-right font-semibold whitespace-nowrap">Spent (₱)</th>
            </tr>
          </thead>
          <tbody>
            {v.rows.map((r) => (
              <tr key={r.key} className="border-b border-border">
                <td className="px-3 py-2">
                  <span className="block break-words">{r.item}</span>
                  <span className={cx(PX.meta, "block")}>{r.plan}</span>
                </td>
                <td className="px-3 py-2 text-right align-top whitespace-nowrap tabular-nums">
                  <span className="block font-bold">{r.spent}</span>
                  {WORD(r.word)}
                </td>
              </tr>
            ))}
            <tr className="border-b-2 border-frame">
              <th scope="row" className="px-3 py-2 text-left font-normal">
                <span className="block font-bold">Total</span>
                <span className={cx(PX.meta, "block")}>{v.total.plan}</span>
              </th>
              <td className="px-3 py-2 text-right align-top whitespace-nowrap tabular-nums">
                <span className="block font-bold">{v.total.spent}</span>
                {WORD(v.total.word)}
              </td>
            </tr>
            {v.notInBudget && (
              <tr className="border-b border-border">
                <td className="px-3 py-2">
                  <span className="block">Not in the budget</span>
                  <span className={cx(PX.meta, "block")}>{v.notInBudget.meta}</span>
                </td>
                <td className="px-3 py-2 text-right align-top font-bold whitespace-nowrap tabular-nums">{v.notInBudget.spent}</td>
              </tr>
            )}
            {v.unsorted && (
              <tr className="border-b border-border">
                <td className="px-3 py-2">
                  <span className="block">Not sorted yet</span>
                  <span className={cx(PX.meta, "block")}>{v.unsorted.meta}</span>
                </td>
                <td className="px-3 py-2 text-right align-top font-bold whitespace-nowrap tabular-nums">{v.unsorted.spent}</td>
              </tr>
            )}
          </tbody>
        </table>
      </PixelBox>
      {v.nothingSpent ? <p className="text-sm">{v.nothingSpent}</p> : <p className={PX.meta}>{v.splitLine}</p>}
      {guide.budget.excluded && <p className={PX.meta}>{guide.budget.excluded}</p>}
      {v.nudge && walletSlug && (
        <p className="text-sm">
          {v.nudge.text} <a className={PX.inlineLink} href={`/w/${walletSlug}#expenses-title`}>{v.nudge.link}</a>
        </p>
      )}
      {v.people && (
        <PixelBox className="flex flex-col gap-2 p-4">
          <h3 className={PX.dataHeading}>{shareHeading(returnDate, today)}</h3>
          <ul className="flex flex-col gap-2">
            {v.people.map((p, i) => (
              <li key={`${i}-${p.name}`} className="flex flex-col">
                <span className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="min-w-0 break-words">{p.name}{p.you && " (you)"}</span>
                  <span className="font-bold tabular-nums">{p.total}</span>
                </span>
                {/* personMeta's line, each amount kept with its word (tg-ux2 S2: "₱690 / other" broke at 320). Over is a word
                    in danger-text (ux §6): the Red only repeats it */}
                <span className={PX.meta}>
                  <span className="whitespace-nowrap">{p.lines}</span>
                  {p.word && (p.word.over
                    ? <>, <span className="whitespace-nowrap font-semibold text-danger-text">{p.word.text}</span></>
                    : <>, <span className="whitespace-nowrap">{p.word.text}</span></>)}
                  {p.other && <> · <span className="whitespace-nowrap">{p.other}</span></>}
                </span>
              </li>
            ))}
          </ul>
          <p className={PX.meta}>Shares come from the wallet&apos;s splits. Who pays whom is in the wallet&apos;s Settle up.</p>
          {walletSlug && (
            <PixelLink variant="secondary" href={`/w/${walletSlug}`} className="inline-flex items-center self-start px-4 text-sm">
              Open the wallet
            </PixelLink>
          )}
        </PixelBox>
      )}
    </section>
  );
}
