// TG-62 GW2: the trip page's Budget panel, its words, rounding and totals (plan §3 G28 to G30; TG-62 ux.md §3, §5 and
// §7, with tg-ux2's "GW2 Q1" to "Q7"). Pure, so node tests it; BudgetPanel.tsx and TripView render it. The API's money is
// whole centavos; the panel shows whole pesos, rounded half up, and the wallet keeps the centavos.
import type { BudgetLineSpend, BudgetResult, SessionBudget } from "./sessionBudget.ts";

export type Word = { text: string; over: boolean };
export type PanelRow = { key: string; item: string; plan: string; spent: string; word: Word | null };
export type Person = { name: string; you: boolean; total: string; lines: string; word: Word | null; other: string | null };
export type PanelView = {
  rows: PanelRow[];
  total: { plan: string; spent: string; word: Word | null };
  notInBudget: { spent: string; meta: string } | null;
  unsorted: { spent: string; meta: string } | null;
  splitLine: string;
  nudge: { text: string; link: string } | null;
  nothingSpent: string | null;
  people: Person[] | null;
};

const NUM = new Intl.NumberFormat("en-PH", { maximumFractionDigits: 0 });
const num = (pesos: number) => NUM.format(pesos);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Whole pesos, half up. Money here is never negative. */
export function pesosOf(centavos: number): number {
  return Math.floor((centavos + 50) / 100);
}

/** A group's spend for one person: an integer division in centavos, half up, as the API's spent_each. */
export function eachOf(spent: number, members: number): number {
  return members > 0 ? Math.floor((2 * spent + members) / (2 * members)) : 0;
}

/** The plan figure: the server's min and max, en-dashed, or one number; an estimate it can't read, as written. */
export function planText(line: Pick<BudgetLineSpend, "estimate" | "min" | "max" | "readable">): string {
  if (!line.readable || line.min === null || line.max === null) return `Plan: ${line.estimate}`;
  return line.min === line.max ? `Plan ${num(line.max)}` : `Plan ${num(line.min)}–${num(line.max)}`;
}

/** Left or over against the high end, in whole pesos. Exactly max reads 0 left. No max, no word. */
export function leftOver(eachCentavos: number, max: number | null, prefix = ""): Word | null {
  if (max === null) return null;
  const each = pesosOf(eachCentavos);
  return each > max ? { text: `${prefix}${num(each - max)} over`, over: true } : { text: `${prefix}${num(max - each)} left`, over: false };
}

/** The panel's table, meta lines, nudge and per-person box, for state "ok". `me` is this phone's member, if it knows. */
export function panelView(b: SessionBudget, me: string | null): PanelView {
  const spentAny = b.total_centavos > 0;
  const rows = b.lines.map((l) => ({ key: l.key, item: l.item, plan: planText(l), spent: num(pesosOf(l.spent_each)), word: spentAny ? leftOver(l.spent_each, l.max) : null }));
  const readable = b.lines.every((l) => l.readable && l.min !== null && l.max !== null);
  const sumMin = b.lines.reduce((a, l) => a + (l.min ?? 0), 0);
  const sumMax = b.lines.reduce((a, l) => a + (l.max ?? 0), 0);
  const totalEach = b.lines.reduce((a, l) => a + l.spent_each, 0);
  const total = {
    plan: readable ? planText({ estimate: "", min: sumMin, max: sumMax, readable: true }) : "Plan: not all lines have a number",
    spent: num(pesosOf(totalEach)),
    word: spentAny && readable ? leftOver(totalEach, sumMax) : null,
  };
  const nib = b.not_in_budget && b.not_in_budget.count > 0 ? b.not_in_budget : null;
  const uns = b.unsorted && b.unsorted.count > 0 ? b.unsorted : null;
  const removed = uns && uns.removed > 0 ? `, ${uns.removed} from ${uns.removed === 1 ? "a line that was" : "lines that were"} removed` : "";
  return {
    rows,
    total,
    notInBudget: nib && { spent: num(pesosOf(eachOf(nib.spent, b.member_count))), meta: "Bus fares, the condo, anything else" },
    unsorted: uns && { spent: num(pesosOf(eachOf(uns.spent, b.member_count))), meta: `${plural(uns.count, "expense", "expenses")}${removed}` },
    splitLine: `Spent is the wallet's total for each line, split over its ${plural(b.member_count, "person", "people")}. Left and over are against the high end of the plan.`,
    nudge: uns && (uns.count === 1 ? { text: "1 expense isn't sorted yet.", link: "Sort it in the wallet" } : { text: `${uns.count} expenses aren't sorted yet.`, link: "Sort them in the wallet" }),
    nothingSpent: spentAny ? null : "Nothing spent yet. Expenses added in the wallet show here.",
    people: spentAny
      ? b.members.map((m) => {
          const other = pesosOf(m.share_total - m.share_lines);
          return {
            name: m.name,
            you: m.member_id === me,
            total: `₱${num(pesosOf(m.share_total))}`,
            lines: `₱${num(pesosOf(m.share_lines))} on the plan's lines`,
            word: readable ? leftOver(m.share_lines, sumMax, "₱") : null,
            other: other > 0 ? `₱${num(other)} other` : null,
          };
        })
      : null,
  };
}

/** One person's meta: `₱3,900 on the plan's lines, ₱250 left · ₱920 other`, its parts left out as they're empty. */
export function personMeta(p: Pick<Person, "lines" | "word" | "other">): string {
  return `${p.lines}${p.word ? `, ${p.word.text}` : ""}${p.other ? ` · ${p.other}` : ""}`;
}

/** ux §5: the line under today's table when there's no spending table to show. */
export function stateLine(state: SessionBudget["state"] | "loading" | Exclude<BudgetResult, { ok: true }>["why"]): { text: string; link: string | null } | null {
  switch (state) {
    case "no_wallet":
      return { text: "Start a wallet for this trip and its spending shows here, line by line.", link: "Go to Shared expenses" };
    case "two_trips":
      return { text: "This trip's wallet is also on another trip, so its spending isn't matched to these lines.", link: null };
    case "failed":
    case "offline":
      return { text: "Spending couldn't load. Try again with signal.", link: null };
    case "loading":
      return { text: "Loading spending...", link: null };
    default:
      return null; // ok, no_budget, and the API's flag off: today's table alone
  }
}

/** After the trip's return date (Manila), the share is final. */
export function shareHeading(returnDate: string, today: string): string {
  return today > returnDate ? "Each person's share" : "Each person's share so far";
}

/** The Shared expenses card's line, from the wallet's total and member count. Hidden at 0. */
export function cardLine(b: Pick<SessionBudget, "total_centavos" | "member_count">): string | null {
  if (b.total_centavos <= 0 || b.member_count <= 0) return null;
  return `₱${num(pesosOf(b.total_centavos))} spent · about ₱${num(pesosOf(eachOf(b.total_centavos, b.member_count)))} each`;
}

/**
 * A reopen's answer (tg-ux2, ux-review-gw2.md Q1): new numbers replace the old, but a refetch that fails while numbers
 * are on screen keeps them with no line, as the saved copy offline does. "Couldn't load" is only for nothing to show.
 */
export function afterRefetch(prev: "loading" | BudgetResult | null, next: BudgetResult): BudgetResult {
  return !next.ok && prev !== null && prev !== "loading" && prev.ok ? prev : next;
}

/**
 * tg-review N1: on slow signal the first load's fetch and a reopen's can answer out of order. Each call through one
 * guard gets its answer only if no newer call started since; an older answer that lands last is null, and dropped.
 */
export function newestOnly<T>(): (work: Promise<T>) => Promise<T | null> {
  let latest = 0;
  return async (work) => {
    const mine = ++latest;
    const answer = await work;
    return mine === latest ? answer : null;
  };
}
