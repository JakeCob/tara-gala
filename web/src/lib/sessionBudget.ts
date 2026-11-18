// TG-62: the trip page's Budget panel, `GET /sessions/{slug}/budget` (api/app/budget_models.py). These are the types and
// the one client call; the panel, its words and the sums' rounding are GW2's (budgetPanel.ts).
// Money is whole centavos, except a line's min and max, which are the estimate's whole pesos (null when unreadable).
import { API_URL } from "./api.ts";

export type BudgetState = "ok" | "no_wallet" | "two_trips" | "no_budget";
export type BudgetLineSpend = {
  key: string;
  item: string;
  estimate: string; // the plan's own text
  min: number | null;
  max: number | null;
  readable: boolean;
  spent: number;
  spent_each: number; // spent / member_count, half rounding up
};
/** lines, not_in_budget, unsorted and members are filled only when state is "ok"; member_count and total_centavos whenever there's a wallet. */
export type SessionBudget = {
  state: BudgetState;
  member_count: number;
  total_centavos: number;
  lines: BudgetLineSpend[]; // plan order
  not_in_budget: { count: number; spent: number } | null; // "None of these"
  unsorted: { count: number; spent: number; removed: number } | null; // no line, or a line that was removed
  members: { member_id: string; name: string; share_lines: number; share_total: number }[]; // wallet order
};
export type BudgetResult = { ok: true; budget: SessionBudget } | { ok: false; why: "offline" | "off" | "failed" };

/** The panel's numbers. "off" is the API's BUDGET_LINES off (404 feature_off); any other refusal is "failed". */
export async function getBudget(slug: string): Promise<BudgetResult> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/sessions/${encodeURIComponent(slug)}/budget`, { cache: "no-store", method: "GET" });
  } catch {
    return { ok: false, why: "offline" };
  }
  const body: unknown = await res.json().catch(() => undefined);
  if (res.ok && body && typeof body === "object") return { ok: true, budget: body as SessionBudget };
  if (res.status === 404 && (body as { detail?: unknown } | null)?.detail === "feature_off") return { ok: false, why: "off" };
  return { ok: false, why: "failed" };
}
