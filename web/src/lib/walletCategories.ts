// TG-66 ux §7: the wallet's Categories box, computed from WalletOut with no endpoint of its own. Whole centavos only.
// Everyone: each category's total and about-each. One person: their part of every expense, by its category. Both sum to
// the wallet's own figures (B25): total_centavos, and that person's share_centavos.
import { formatPeso } from "./wallet.ts";
import type { Category, Expense, Wallet } from "./wallet.ts";

export const CATEGORIES: { key: Category; label: string }[] = [
  { key: "transport", label: "Transport" },
  { key: "hotel", label: "Hotel" },
  { key: "food", label: "Food" },
  { key: "activities", label: "Activities" },
  { key: "other", label: "Other" },
];
const NO_CATEGORY = "No category yet";

export function categoryLabel(c: Category | null | undefined): string {
  return CATEGORIES.find((x) => x.key === c)?.label ?? NO_CATEGORY;
}

export type CategoryRow = { key: Category | null; label: string; total: number; each: number };
export type CategoryTable = { rows: CategoryRow[]; total: number; each: number };

/**
 * About each: total ÷ n in whole pesos, rounded half up, in integers, as centavos (ux review M2: it's "about" by
 * definition, so no centavos). 0 people gives 0.
 */
export function eachOf(total: number, n: number): number {
  return n > 0 ? Math.floor((2 * total + 100 * n) / (200 * n)) * 100 : 0;
}

/** "2,780", "1,151.50": the table's header says ₱, so the cells don't. `cents`: always 2 decimals ("2,780.00"). */
export function tableAmount(centavos: number, cents = false): string {
  if (!cents) return formatPeso(centavos).replace("₱", "");
  const abs = Math.abs(centavos);
  return `${centavos < 0 ? "−" : ""}${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

/** One column's cells: if any has centavos, every cell shows 2 decimals, so the digits line up (ux review M2). */
export function tableColumn(values: number[]): string[] {
  const cents = values.some((v) => v % 100 !== 0);
  return values.map((v) => tableAmount(v, cents));
}

/** Sums by category in fixed order, then No category yet. Every row shows, even at 0, so the table never jumps. */
function byCategory(expenses: Expense[], amount: (e: Expense) => number, people: number): CategoryTable {
  const keys: (Category | null)[] = [...CATEGORIES.map((c) => c.key), null];
  const rows = keys.map((key) => {
    const total = expenses.filter((e) => (e.category ?? null) === key).reduce((a, e) => a + amount(e), 0);
    return { key, label: categoryLabel(key), total, each: eachOf(total, people) };
  });
  const total = rows.reduce((a, r) => a + r.total, 0);
  return { rows, total, each: eachOf(total, people) };
}

/** Everyone: each category's total, and Each = the total over the wallet's people. */
export function categoryTable(w: Wallet): CategoryTable {
  return byCategory(w.expenses, (e) => e.amount_centavos, w.members.length);
}

/** One person: their share of each expense, by its category. Each isn't used here. */
export function personTable(w: Wallet, memberId: string): CategoryTable {
  return byCategory(w.expenses, (e) => e.shares.find((s) => s.member_id === memberId)?.share_centavos ?? 0, 1);
}

/** The Show for select: Everyone, then this phone's person as "(you)", then everyone else in wallet order. */
export function showForOptions(w: Wallet, me: string | null): { value: string; label: string }[] {
  const mine = w.members.filter((m) => m.id === me);
  const rest = w.members.filter((m) => m.id !== me);
  return [{ value: "", label: "Everyone" }, ...mine.map((m) => ({ value: m.id, label: `${m.name} (you)` })), ...rest.map((m) => ({ value: m.id, label: m.name }))];
}

export function everyoneMeta(people: number): string {
  return `Each is the total split over the wallet's ${people} ${people === 1 ? "person" : "people"}.`;
}

export function personColumn(name: string): string {
  return `${name}'s share`;
}

export function personMeta(name: string): string {
  return `${name}'s part of every expense, by its category: what ${name} spent, whoever paid.`;
}

export function onlyUncategorized(expenses: Expense[]): Expense[] {
  return expenses.filter((e) => !e.category);
}

export function uncategorizedCount(w: Wallet): number {
  return onlyUncategorized(w.expenses).length;
}

/** "3 expenses have no category yet. Show them", or null when there are none. */
export function nudge(n: number): { text: string; link: string } | null {
  if (n === 0) return null;
  return n === 1 ? { text: "1 expense has no category yet.", link: "Show it" } : { text: `${n} expenses have no category yet.`, link: "Show them" };
}

/** Above the filtered expense list (W3's): "Showing 3 expenses with no category. Show all". */
export function showingLine(n: number): { text: string; link: string } {
  return { text: `Showing ${n} ${n === 1 ? "expense" : "expenses"} with no category.`, link: "Show all" };
}
