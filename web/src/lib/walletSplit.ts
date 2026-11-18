// TG-66: the split preview, the web's twin of api/app/wallet_splits.py (plan §2). Pure, whole centavos, integers only:
// no float rounding anywhere (a source guard in walletSplit.test.ts checks). Both suites read the same vectors
// (api/tests/fixtures/wallet_split_vectors.json), so this preview and the server can't drift. Only the server's shares
// are stored; this file only shows them before Save.
import type { Charge, InputRow, SplitMode } from "./wallet.ts";

export type SplitCode =
  | "shares_mismatch" | "percent_total" | "shares_zero" | "extras_too_big" | "item_no_one" | "too_many_items"
  | "amount_mismatch" | "items_zero" | "amount_too_big" | "charge_too_big" | "payers_mismatch";
export type SplitItem = { name: string; price_centavos: number; who: string[] }; // seq = list position from 1
export type Shares = Record<string, number>;
export type SplitResult = { ok: true; amount: number; shares: Shares } | { ok: false; error: SplitCode; seq?: number };

export const MAX_ITEMS = 40;
const MAX_AMOUNT = 10_000_000; // ₱100,000, the API's cap per expense
const FULL_BP = 10000;

export class SplitError extends Error {
  code: SplitCode;
  seq?: number;
  constructor(code: SplitCode, seq?: number) {
    super(code);
    this.code = code;
    if (seq !== undefined) this.seq = seq;
  }
}

/** floor(amount × w / W) each, then the leftover one each in `order`, skipping weight 0. W must be above 0. */
export function allocate(amount: number, weights: Shares, order: string[]): Shares {
  const W = Object.values(weights).reduce((a, b) => a + b, 0);
  const out: Shares = {};
  for (const [m, w] of Object.entries(weights)) out[m] = Math.floor((amount * w) / W); // < 10^14: exact in a double
  let left = amount - Object.values(out).reduce((a, b) => a + b, 0);
  for (const m of order) {
    if (left === 0) break;
    if ((weights[m] ?? 0) > 0) {
      out[m] += 1;
      left -= 1;
    }
  }
  return out;
}

/** The payer first if they have a weight, then everyone else in wallet order. */
function orderFor(payerFirst: string, walletOrder: string[], weights: Shares): string[] {
  return [...((weights[payerFirst] ?? 0) > 0 ? [payerFirst] : []), ...walletOrder.filter((m) => m !== payerFirst)];
}

/** A charge in centavos: a percent (basis points, 0 to 10000) of the item subtotal, rounding half up, or an amount. */
export function chargeAmount(subtotal: number, basis: Charge["basis"], value: number): number {
  if (value < 0 || (basis === "percent" && value > FULL_BP)) throw new SplitError("charge_too_big");
  if (basis === "amount") return value;
  return Math.floor((subtotal * value + 5000) / 10000);
}

/** Several payers: they sum to the amount, there are at least 2, and each paid at least 1 centavo. */
export function checkPayers(amount: number, payers: Shares): void {
  const paid = Object.values(payers);
  if (paid.length < 2 || paid.some((p) => p < 1) || paid.reduce((a, b) => a + b, 0) !== amount) throw new SplitError("payers_mismatch");
}

/** Who takes the leftover first: the one payer, or the first of several in wallet order. */
export function firstPayer(paidBy: string | null, payers: Shares | null, walletOrder: string[]): string {
  if (payers) {
    const first = walletOrder.find((m) => (payers[m] ?? 0) > 0);
    if (first) return first;
  }
  return paidBy ?? walletOrder[0];
}

const weightsOf = (inputs: InputRow[]): Shares => Object.fromEntries(inputs.map((i) => [i.member_id, i.value]));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/**
 * The final shares for one mode (plan §2). Itemized computes the amount; an amount sent with it must match. Throws a
 * SplitError with ux.md §9's code, and item_no_one with the item's seq (never its name).
 */
export function split(
  mode: SplitMode,
  amount: number | null,
  inputs: InputRow[] | null,
  items: SplitItem[] | null,
  charges: Charge[] | null,
  payerFirst: string,
  walletOrder: string[],
): { amount: number; shares: Shares } {
  if (mode === "itemized") return itemized(amount, items ?? [], charges ?? [], payerFirst, walletOrder);
  const total = amount as number;
  if (total > MAX_AMOUNT) throw new SplitError("amount_too_big"); // before any other check, as the server's
  const rows = inputs ?? [];
  const w = weightsOf(rows);
  switch (mode) {
    case "equal": {
      const ones = Object.fromEntries(rows.map((i) => [i.member_id, 1]));
      return { amount: total, shares: allocate(total, ones, orderFor(payerFirst, walletOrder, ones)) };
    }
    case "exact":
      if (rows.some((i) => i.value < 0) || sum(rows.map((i) => i.value)) !== total) throw new SplitError("shares_mismatch");
      return { amount: total, shares: { ...w } };
    case "percent":
      if (sum(rows.map((i) => i.value)) !== FULL_BP) throw new SplitError("percent_total");
      return { amount: total, shares: allocate(total, w, orderFor(payerFirst, walletOrder, w)) };
    case "shares":
      if (!rows.some((i) => i.value > 0)) throw new SplitError("shares_zero");
      return { amount: total, shares: allocate(total, w, orderFor(payerFirst, walletOrder, w)) };
    case "adjust": {
      // The rows are `among`, each with its extra: the rest is split equally, then each share is its part plus its extra
      const rest = total - sum(rows.map((i) => i.value));
      if (rest < 0) throw new SplitError("extras_too_big");
      const ones = Object.fromEntries(rows.map((i) => [i.member_id, 1]));
      const part = allocate(rest, ones, orderFor(payerFirst, walletOrder, ones));
      const shares = Object.fromEntries(rows.map((i) => [i.member_id, part[i.member_id] + i.value]));
      if (Object.values(shares).some((s) => s < 0)) throw new SplitError("extras_too_big");
      return { amount: total, shares };
    }
  }
}

/** Itemized in plan §2's three steps: each item in seq order, then service, then VAT, both on the item subtotal. */
function itemized(amount: number | null, items: SplitItem[], charges: Charge[], payerFirst: string, walletOrder: string[]) {
  if (items.length > MAX_ITEMS) throw new SplitError("too_many_items");
  items.forEach((it, i) => {
    if (it.who.length === 0) throw new SplitError("item_no_one", i + 1);
  });
  const sub: Shares = {};
  for (const it of items) {
    const ones = Object.fromEntries(it.who.map((m) => [m, 1]));
    for (const [m, v] of Object.entries(allocate(it.price_centavos, ones, orderFor(payerFirst, walletOrder, ones)))) sub[m] = (sub[m] ?? 0) + v;
  }
  const S = sum(items.map((it) => it.price_centavos));
  // The refusal order is the server's: a bad charge before the items at ₱0, then the cap, then a mismatched amount
  const steps = (["service", "vat"] as const).flatMap((kind) => {
    const c = charges.find((x) => x.kind === kind);
    return c ? [chargeAmount(S, c.basis, c.value)] : [];
  });
  if (S === 0) throw new SplitError("items_zero");
  const shares: Shares = { ...sub };
  let total = S;
  for (const C of steps) {
    total += C;
    if (C === 0) continue;
    const weights = Object.fromEntries(Object.entries(sub).filter(([, s]) => s > 0));
    for (const [m, v] of Object.entries(allocate(C, weights, orderFor(payerFirst, walletOrder, weights)))) shares[m] += v;
  }
  if (total > MAX_AMOUNT) throw new SplitError("amount_too_big");
  if (amount !== null && amount !== total) throw new SplitError("amount_mismatch");
  return { amount: total, shares };
}

/** split(), with a refusal as a value instead of a throw: what the form's preview needs. */
export function trySplit(...args: Parameters<typeof split>): SplitResult {
  try {
    return { ok: true, ...split(...args) };
  } catch (e) {
    if (e instanceof SplitError) return e.seq === undefined ? { ok: false, error: e.code } : { ok: false, error: e.code, seq: e.seq };
    throw e;
  }
}
