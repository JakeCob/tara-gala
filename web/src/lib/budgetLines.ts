// TG-62 GW1: the wallet's budget line (plan §3 G23 to G27; TG-66 ux.md §2 item 3, §5, §9; tg-ux2's answers in
// TG-62/ux-arch-notes.md). Pure, so node tests it; ExpenseForm, ExpenseDetails and WalletView render it. The lines come
// from WalletOut.budget (GA1): keys, items and categories only, never estimates. A key is never logged (G10a).
import type { Category, WalletBudget } from "./wallet.ts";

export const NONE = "_none"; // "None of these": Not in the budget
const CATEGORY_NAME: Record<Category, string> = { transport: "Transport", hotel: "Hotel", food: "Food", activities: "Activities", other: "Other" };
const LATER = "Pick again, or leave it for later.";

const categoryOf = (c: Category | null) => c ?? "other"; // a line with no category is listed under other
const lineOf = (b: WalletBudget | null, key: string | null | undefined) => (b && key ? b.lines.find((l) => l.key === key) : undefined);

/** G23: the category's lines in plan order, then None of these. Empty without a budget or a category: no row. */
export function linesFor(b: WalletBudget | null, category: Category | null): { key: string; item: string }[] {
  if (!b || !category) return [];
  return [...b.lines.filter((l) => categoryOf(l.category) === category).map(({ key, item }) => ({ key, item })), { key: NONE, item: "None of these" }];
}

/** G23 (tg-ux2): the line's words in Changes. A key the plan no longer has isn't "Not sorted yet": it was sorted (TG-68 N1). */
export function lineLabel(b: WalletBudget | null, key: string | null | undefined): string {
  if (key === NONE) return "Not in the budget";
  if (!key) return "Not sorted yet";
  return lineOf(b, key)?.item ?? "Removed from the plan";
}

/** G24: the row shows with the wallet's one trip's lines and a picked category. */
export function showLineRow(b: WalletBudget | null, category: Category | null): boolean {
  return !!b && b.lines.length > 0 && !!category;
}

/** The row's meta (ux §2 item 3). */
export function fromPlan(b: WalletBudget): string {
  return `From the plan of ${b.trip_name}.`;
}

/**
 * G25: what an edit reopens with. The saved line, if the row lists it; None of these as saved. A line the plan has since
 * moved or removed isn't listed, so nothing is picked and editLineMeta says why. With no budget on screen (the flag off, or
 * the wallet now on two trips) the row is hidden and the stored key rides along unchanged: GA1 accepts it back (G5).
 */
export function initialLine(b: WalletBudget | null, saved: string | null | undefined, category: Category | null): string | null {
  if (!saved) return null;
  if (!b) return saved;
  if (saved === NONE) return NONE;
  const line = lineOf(b, saved);
  return line && categoryOf(line.category) === category ? saved : null;
}

/** tg-ux2's open question: the meta under the row when the saved line isn't listed. Null when there's nothing to say. */
export function editLineMeta(b: WalletBudget | null, saved: string | null | undefined, category: Category | null): string | null {
  if (!b || !saved || saved === NONE) return null;
  const line = lineOf(b, saved);
  if (!line) return "Its budget line isn't in the plan any more. Pick another, or leave it for later."; // its item text left with it (tg-ux2)
  if (categoryOf(line.category) === category) return null;
  return `Its line was ${line.item}, which the plan now lists under ${CATEGORY_NAME[categoryOf(line.category)]}. ${LATER}`;
}

/**
 * G24: a new category lists its own lines with none picked. With no row on screen (no budget, or no keyed lines) the line
 * stays: the new web clears a line only where the person sees it (tg-test F1), as on a reopen (initialLine) and as GA1
 * keeps a key it can't compare (G9c).
 */
export function lineAfterCategory(b: WalletBudget | null, line: string | null, from: Category | null, to: Category | null): string | null {
  if (!b || b.lines.length === 0) return line;
  return to !== null && to === from ? line : null;
}

/**
 * G24, G25, G27: the body with its line. Off (NEXT_PUBLIC_BUDGET_LINES): the body as TG-66 built it, byte for byte. On:
 * every v2 body says its line, null included, so an edit never leans on GA1's kept-key rule (Rev 1 M2). Today's body
 * never gets one: it forbids extra keys.
 */
export function withBudgetKey<T extends object>(body: T, opts: { on: boolean; line: string | null }): T {
  if (!opts.on || !("mode" in body)) return body;
  return { ...body, budget_key: opts.line };
}

/** G26: Details' words beside the category chip, or a meta line. Null without a budget: TG-66's Details exactly. */
export function detailsLine(b: WalletBudget | null, key: string | null | undefined): { text: string; meta: boolean } | null {
  if (!b || b.lines.length === 0) return null;
  if (key === NONE) return { text: "Not in the budget", meta: false };
  if (!key) return { text: "No budget line yet", meta: true };
  const line = lineOf(b, key);
  return line ? { text: line.item, meta: false } : { text: "A line no longer in the plan", meta: true };
}

/**
 * G10a on the web (tg-test S1): the submit log's word for the line. A key is a slug of the group's own line text, so it
 * never reaches a log: whatever the key, the answer is one of four fixed words.
 */
export function logLine(on: boolean, line: string | null): "off" | "null" | "none" | "line" {
  if (!on) return "off";
  if (line === null) return "null";
  return line === NONE ? "none" : "line";
}

/**
 * ux §9: the two refusals GA1 adds. Anything else is someone else's line. TG-68 N2: the moved line's refusal names the
 * category it's under now, from the reread lines and the key the form sent; without them, "another category". It's named
 * only when it differs from the category the form sent (`sentCat`, when given): a stale saved copy can still list the
 * old one, and "under Food" to someone who picked Food is wrong (tg-ux2, N2f).
 */
export function budgetRefusal(code: string | undefined, budget?: WalletBudget | null, sent?: string | null, sentCat?: Category | null): string | null {
  if (code === "unknown_budget_line") return "That budget line isn't in the plan any more. Pick another, or leave it for later.";
  if (code !== "budget_line_category") return null;
  const line = sent && sent !== NONE ? lineOf(budget ?? null, sent) : undefined;
  const now = line ? categoryOf(line.category) : undefined;
  const named = now && (sentCat === undefined || now !== categoryOf(sentCat)) ? CATEGORY_NAME[now] : "another category";
  return `That budget line is under ${named} in the plan now. Pick the line again, or leave it for later.`;
}

/** TG-68 N2: the line a body sent (a v2 body's budget_key), for budgetRefusal. Today's body has none. */
export function sentLine(body: object): string | null {
  return "budget_key" in body && typeof body.budget_key === "string" ? body.budget_key : null;
}

/** TG-68 N2f: the category a body sent, as the API reads it (`body.category`; missing is none). */
export function sentCategory(body: object): Category | null {
  return "category" in body && typeof body.category === "string" ? (body.category as Category) : null;
}
