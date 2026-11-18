// TG-66 W1: the expense form's model. What the user typed (FormState), what it adds up to (checkForm: the preview, the
// status lines and the reason Save is refused), and the request body it sends (buildBody, buildPatch), by flag.
// With WALLET_SPLITS off the add sends today's body byte for byte (plan §2, B18a): WalletView.tsx at a1c4299, lines 87
// and 91 to 96. With WALLET_MULTI_PAYER off it never sends payers. Every ₱ shown comes from walletSplit.ts, the twin of
// the server's split. The copy is ux.md §3, §4 and §9's. Pure: the components (components/wallet/) only render this.
import { formatPeso, parsePeso, splitEqual } from "./wallet.ts";
import type { Category, Charge, Expense, ExpenseBodyV2, ExpensePatch, InputRow, LegacyExpenseBody, Member, SplitMode } from "./wallet.ts";
import { MAX_ITEMS, chargeAmount, firstPayer, trySplit, type Shares, type SplitCode, type SplitItem } from "./walletSplit.ts";

export type FormFlags = { walletSplits: boolean; walletMultiPayer: boolean };
export type FormItem = { key: string; name: string; price: string; who: string[] };
/** Everything the form holds. Each mode keeps its own values, so switching back restores them (ux.md §2). */
export type FormState = {
  amount: string;
  note: string;
  category: Category | null;
  paidBy: string;
  several: boolean; // "Several people..." under Paid by (WALLET_MULTI_PAYER)
  paid: Record<string, string>; // what each of several paid, as typed
  mode: SplitMode;
  out: string[]; // left out of Equally and Equal + extra: everyone else is in, so a newcomer is in too
  exact: Record<string, string>;
  percent: Record<string, string>;
  shares: Record<string, number>; // a person with none yet has 1 if ticked, else 0
  extras: Record<string, string>;
  items: FormItem[];
  service: string;
  vat: string;
};
export type Bill = { items: number; charges: { label: string; amount: number }[]; total: number; typedBefore: string | null };
export type FormCheck = {
  ok: boolean;
  problem: string | null; // why Save is refused: the first thing to fix, in ux.md's words
  status: string | null; // the mode's status line (ux.md §3)
  payerLine: string | null; // several payers' line (ux.md §4)
  amount: number | null; // what will be saved: as typed, or the items plus charges
  shares: Shares | null; // the preview, from walletSplit
  bill: Bill | null; // Items' totals block
};
type Built<T> = { ok: true; body: T } | { ok: false; problem: string };

export const MAX_SHARE_WEIGHT = 20;

const NO_AMOUNT = "Enter an amount, like 450 or 1,151.50.";
const NO_NOTE = "Say what it was for, like Taxi to Burnham Park.";
const NO_ONE = "Pick at least one person to split it with.";
const BAD_AMOUNTS = "Check the amounts: pesos, like 300 or 150.50.";
const BAD_PERCENTS = "Check the percents: up to 2 decimals, like 33.33.";
const BAD_EXTRAS = "Check the extras: pesos, like 200 or -50.";
const BAD_PAID = "Check what each person paid: pesos, like 800 or 150.50.";
const BAD_PRICES = "Check the prices: pesos, like 120 or 99.50.";
const BAD_CHARGE = "Type each charge in pesos or as a percent, like 120 or 10%.";
const NO_ITEMS = "Add an item, with its price and who had it.";
/** ux.md §9, for the split's own refusals. item_no_one is built from the item's name. */
export const SPLIT_COPY: Record<Exclude<SplitCode, "item_no_one">, string> = {
  shares_mismatch: "What each person owes needs to add up to the amount.",
  percent_total: "The percents need to add up to 100%.",
  shares_zero: "Give someone at least 1 share.",
  extras_too_big: "The extras are more than the amount.",
  too_many_items: "That's more than 40 items. Put the small ones together on one line.",
  amount_mismatch: "The amount doesn't match the items. Check them and try again.",
  items_zero: "The items come to ₱0. Type a price for at least one.",
  amount_too_big: "The items come to more than ₱100,000, the most one expense can be.",
  charge_too_big: "A service charge or VAT can't be more than 100%.",
  payers_mismatch: "What people paid needs to add up to the amount.",
};
/** `Pick who had <item>.`, or the general line when that item isn't in the form any more (a refusal's seq). */
export function pickWhoHad(name: string | undefined): string {
  return name?.trim() ? `Pick who had ${name.trim()}.` : "Pick who had each item.";
}

/** An item's own line under its pills (ux.md §3): only once it has a name or a price, so a fresh row doesn't shout. */
export function itemLine(item: FormItem, index: number): string | null {
  if (item.who.length > 0 || (!item.name.trim() && !item.price.trim())) return null;
  return `Pick who had ${item.name.trim() || `item ${index + 1}`}.`;
}

let nextKey = 0;
const freshKey = () => `item-${++nextKey}`;

export function emptyForm(me: string): FormState {
  return {
    amount: "",
    note: "",
    category: null,
    paidBy: me,
    several: false,
    paid: {},
    mode: "equal",
    out: [],
    exact: {},
    percent: {},
    shares: {},
    extras: {},
    items: [{ key: freshKey(), name: "", price: "", who: [] }],
    service: "",
    vat: "",
  };
}

/** B19: only the mode changes; the amount, the note, the category, the payer, the people and each mode's values stay. */
export function switchMode(s: FormState, mode: SplitMode): FormState {
  return { ...s, mode };
}

/** `Add an item`: an empty row at the end, up to 40. */
export function addItem(s: FormState): FormState {
  if (s.items.length >= MAX_ITEMS) return s;
  return { ...s, items: [...s.items, { key: freshKey(), name: "", price: "", who: [] }] };
}

export function removeItem(s: FormState, key: string): FormState {
  return { ...s, items: s.items.filter((i) => i.key !== key) };
}

/** `Just one person paid`: back to the select, with the first payer in wallet order chosen. */
export function justOnePayer(s: FormState, members: Member[]): FormState {
  const first = members.find((m) => (parsePeso(s.paid[m.id] ?? "") ?? 0) > 0);
  return { ...s, several: false, paidBy: first?.id ?? s.paidBy };
}

/** `Save as Amounts` after a feature_off (ux.md §9): each person's previewed ₱ as Amounts, so the money is the same. */
export function saveAsAmounts(s: FormState, shares: Shares): FormState {
  const total = Object.values(shares).reduce((a, b) => a + b, 0);
  return { ...s, mode: "exact", amount: pesoInput(total), exact: Object.fromEntries(Object.entries(shares).map(([m, c]) => [m, pesoInput(c)])) };
}

// ---------------------------------------------------------------- typed text to numbers

/** Centavos as a field shows them: "1280", "300.50", "-50.50". No commas, so it parses back the same. */
export function pesoInput(centavos: number): string {
  const abs = Math.abs(centavos);
  const cents = abs % 100;
  return `${centavos < 0 ? "-" : ""}${Math.floor(abs / 100)}${cents ? `.${String(cents).padStart(2, "0")}` : ""}`;
}

/** Basis points as a percent: 4000 → "40", 3333 → "33.33", 1250 → "12.5". */
export function percentInput(bp: number): string {
  const frac = String(bp % 100).padStart(2, "0").replace(/0+$/, "");
  return `${Math.floor(bp / 100)}${frac ? `.${frac}` : ""}`;
}

/** An extra: pesos that may be minus (`-50`, `−50`). Empty is 0; null if it isn't one. */
export function parseSignedPeso(raw: string): number | null {
  const s = raw.trim().replace(/^[−-]\s*/, "-");
  if (s === "" || s === "-") return 0;
  const minus = s.startsWith("-");
  const centavos = parsePeso(minus ? s.slice(1) : s, { allowZero: true });
  if (centavos === null) return null;
  return minus ? -centavos : centavos;
}

/** A percent with up to 2 decimals, as basis points (0 to 10000). Empty is 0; null if it isn't one. */
export function parsePercentBp(raw: string): number | null {
  const s = raw.trim().replace(/\s*%$/, "");
  if (s === "") return 0;
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return bp <= 10000 ? bp : null;
}

/** A charge field: `10%` (basis points, over 100% kept for the split's own line) or `120` (pesos). Empty or 0 is
 *  no charge (null); undefined if it isn't a charge. */
export function parseCharge(raw: string): { basis: Charge["basis"]; value: number } | null | undefined {
  const s = raw.trim();
  if (s === "") return null;
  const pct = /^(\d{1,5})(?:\.(\d{1,2}))?\s*%$/.exec(s);
  if (pct) {
    const bp = Number(pct[1]) * 100 + Number((pct[2] ?? "").padEnd(2, "0"));
    return bp === 0 ? null : { basis: "percent", value: bp };
  }
  const centavos = parsePeso(s, { allowZero: true });
  if (centavos === null) return undefined;
  return centavos === 0 ? null : { basis: "amount", value: centavos };
}

function chargeText(c: Charge): string {
  return c.basis === "percent" ? `${percentInput(c.value)}%` : pesoInput(c.value);
}

/** ₱1,188.00: always with centavos, for the "You typed" check. */
function peso2(centavos: number): string {
  const p = formatPeso(centavos);
  return centavos % 100 ? p : `${p}.00`;
}

function percentLine(bp: number): string {
  return `${percentInput(bp)}%`;
}

// ---------------------------------------------------------------- what the form adds up to

type Parsed = { ok: true; inputs: InputRow[] } | { ok: false; problem: string };
type ItemsParsed = { ok: true; items: SplitItem[]; charges: Charge[] } | { ok: false; problem: string };

const among = (s: FormState, members: Member[]) => members.filter((m) => !s.out.includes(m.id)).map((m) => m.id);
const weightOf = (s: FormState, m: string) => s.shares[m] ?? (s.out.includes(m) ? 0 : 1);

/** The mode's inputs, every member in wallet order (zeros kept, for the preview's ₱0 rows). */
function parseInputs(s: FormState, members: Member[]): Parsed {
  const rows = (pick: (m: Member) => number | null, problem: string): Parsed => {
    const values = members.map((m) => ({ member_id: m.id, value: pick(m) }));
    return values.some((v) => v.value === null) ? { ok: false, problem } : { ok: true, inputs: values as InputRow[] };
  };
  switch (s.mode) {
    case "equal":
      return { ok: true, inputs: among(s, members).map((m) => ({ member_id: m, value: 1 })) };
    case "exact":
      return rows((m) => (s.exact[m.id]?.trim() ? parsePeso(s.exact[m.id], { allowZero: true }) : 0), BAD_AMOUNTS);
    case "percent":
      return rows((m) => parsePercentBp(s.percent[m.id] ?? ""), BAD_PERCENTS);
    case "shares":
      return { ok: true, inputs: members.map((m) => ({ member_id: m.id, value: weightOf(s, m.id) })) };
    case "adjust": {
      const ids = among(s, members);
      const values = ids.map((m) => ({ member_id: m, value: parseSignedPeso(s.extras[m] ?? "") }));
      return values.some((v) => v.value === null) ? { ok: false, problem: BAD_EXTRAS } : { ok: true, inputs: values as InputRow[] };
    }
    default:
      return { ok: true, inputs: [] };
  }
}

function parseItems(s: FormState, members: Member[]): ItemsParsed {
  if (s.items.length === 0) return { ok: false, problem: NO_ITEMS };
  const order = members.map((m) => m.id);
  const items: SplitItem[] = [];
  for (const [i, it] of s.items.entries()) {
    if (!it.name.trim()) return { ok: false, problem: `Give item ${i + 1} a name.` };
    const price = it.price.trim() ? parsePeso(it.price, { allowZero: true }) : 0;
    if (price === null) return { ok: false, problem: BAD_PRICES };
    items.push({ name: it.name.trim(), price_centavos: price, who: order.filter((m) => it.who.includes(m)) });
  }
  const charges: Charge[] = [];
  for (const kind of ["service", "vat"] as const) {
    const c = parseCharge(s[kind]);
    if (c === undefined) return { ok: false, problem: BAD_CHARGE };
    if (c) charges.push({ kind, ...c });
  }
  return { ok: true, items, charges };
}

/** Several payers, typed: each member's centavos (0 for empty), or null if one isn't pesos. */
function parsePaid(s: FormState, members: Member[]): Shares | null {
  const out: Shares = {};
  for (const m of members) {
    const raw = s.paid[m.id]?.trim() ?? "";
    const c = raw ? parsePeso(raw, { allowZero: true }) : 0;
    if (c === null) return null;
    out[m.id] = c;
  }
  return out;
}

function splitProblem(code: SplitCode, seq: number | undefined, s: FormState): string {
  return code === "item_no_one" ? pickWhoHad(s.items[(seq ?? 0) - 1]?.name) : SPLIT_COPY[code];
}

/** The preview, the status lines and why Save is refused. With WALLET_SPLITS off only Equally and Amounts exist. */
export function checkForm(s: FormState, members: Member[], flags: FormFlags): FormCheck {
  const out: FormCheck = { ok: false, problem: null, status: null, payerLine: null, amount: null, shares: null, bill: null };
  const fail = (problem: string): FormCheck => ({ ...out, ok: false, problem: out.problem ?? problem });
  const order = members.map((m) => m.id);
  const legacyModes: SplitMode[] = ["equal", "exact"];
  if (!flags.walletSplits && !legacyModes.includes(s.mode)) return fail("Pick Equally or Custom amounts.");

  // The amount: as typed, or the items plus charges
  let amount: number | null;
  let parsedItems: ItemsParsed | null = null;
  if (s.mode === "itemized") {
    parsedItems = parseItems(s, members);
    amount = null;
  } else {
    amount = parsePeso(s.amount);
  }

  // Who paid: one, or several (only with WALLET_MULTI_PAYER)
  const several = flags.walletMultiPayer && s.several;
  const paid = several ? parsePaid(s, members) : null;
  const payer = firstPayer(members.some((m) => m.id === s.paidBy) ? s.paidBy : order[0], paid, order);

  // The split
  let result: ReturnType<typeof trySplit> | null = null;
  let inputs: InputRow[] = [];
  if (s.mode === "itemized") {
    if (parsedItems && parsedItems.ok) {
      result = trySplit("itemized", null, null, parsedItems.items, parsedItems.charges, payer, order);
      if (result.ok) {
        amount = result.amount;
        const typed = parsePeso(s.amount);
        const S = parsedItems.items.reduce((a, it) => a + it.price_centavos, 0);
        out.bill = {
          items: S,
          charges: parsedItems.charges.map((c) => ({
            label: `${c.kind === "service" ? "Service charge" : "VAT, other charges"} ${c.basis === "percent" ? percentLine(c.value) : formatPeso(c.value)}`,
            amount: chargeAmount(S, c.basis, c.value),
          })),
          total: result.amount,
          typedBefore:
            typed === null || typed === result.amount
              ? null
              : typed > result.amount
                ? `You typed ${peso2(typed)} before. The items come to ${peso2(result.amount)}, so ${peso2(typed - result.amount)} isn't on any item.`
                : `You typed ${peso2(typed)} before. The items come to ${peso2(result.amount)}, ${peso2(result.amount - typed)} more.`,
        };
        out.shares = result.shares;
      }
    }
  } else {
    const parsed = parseInputs(s, members);
    if (parsed.ok) {
      inputs = parsed.inputs;
      if (s.mode === "exact") {
        const assigned = inputs.reduce((a, i) => a + i.value, 0);
        if (amount !== null) {
          const left = amount - assigned;
          out.status = left === 0 ? "Adds up." : left > 0 ? `${formatPeso(left)} left to assign.` : `${formatPeso(-left)} too much.`;
        }
      } else if (s.mode === "percent") {
        const bp = inputs.reduce((a, i) => a + i.value, 0);
        const left = 10000 - bp;
        out.status = left === 0 ? "Adds up to 100%." : left > 0 ? `${percentLine(left)} left to assign.` : `${percentLine(-left)} too much.`;
      } else if (s.mode === "shares") {
        const n = inputs.reduce((a, i) => a + i.value, 0);
        out.status = n === 0 ? SPLIT_COPY.shares_zero : `${n} ${n === 1 ? "share" : "shares"}${amount !== null ? ` · ${formatPeso(Math.floor(amount / n))} a share` : ""}`;
      } else if (s.mode === "equal") {
        out.status = "Odd centavos go to whoever paid first.";
      }
      if (amount !== null && inputs.length > 0) {
        result = trySplit(s.mode, amount, inputs, null, null, payer, order);
        if (result.ok) out.shares = result.shares;
        if (s.mode === "adjust") {
          const extras = inputs.reduce((a, i) => a + i.value, 0);
          out.status = result.ok
            ? `${formatPeso(extras)} in extras, then ${formatPeso(amount - extras)} split equally over ${inputs.length}.`
            : SPLIT_COPY.extras_too_big;
        }
      }
    }
  }
  out.amount = amount;
  // Items: while there's no bill, the status line says why the totals aren't there (tg-ux2 M1)
  if (s.mode === "itemized" && !out.bill) {
    out.status = parsedItems && !parsedItems.ok ? parsedItems.problem : result && !result.ok ? splitProblem(result.error, result.seq, s) : null;
  }

  // Several payers' line, once the amount is known
  if (several) {
    if (paid === null) out.payerLine = null;
    else if (amount !== null) {
      const left = amount - Object.values(paid).reduce((a, b) => a + b, 0);
      out.payerLine = left === 0 ? "Paid in full." : left > 0 ? `${formatPeso(left)} left to place.` : `${formatPeso(-left)} more than the amount.`;
    }
  }

  // Why Save is refused, the first thing to fix, top of the form first
  if (s.mode !== "itemized" && amount === null) return fail(NO_AMOUNT);
  if (!s.note.trim()) return fail(NO_NOTE);
  if (several && paid === null) return fail(BAD_PAID);
  if (parsedItems && !parsedItems.ok) return fail(parsedItems.problem);
  if (s.mode !== "itemized") {
    const parsed = parseInputs(s, members);
    if (!parsed.ok) return fail(parsed.problem);
    if ((s.mode === "equal" || s.mode === "adjust") && parsed.inputs.length === 0) return fail(NO_ONE);
  }
  if (result && !result.ok) {
    if (!flags.walletSplits && s.mode === "exact" && amount !== null) {
      // Today's words for today's form (WalletView.tsx at a1c4299)
      const left = amount - inputs.reduce((a, i) => a + i.value, 0);
      return fail(`The amounts need to add up to ${formatPeso(amount)}. ${left > 0 ? `${formatPeso(left)} is left.` : `They're ${formatPeso(-left)} over.`}`);
    }
    const statusIsReason = s.mode === "exact" || s.mode === "percent" || s.mode === "shares" || s.mode === "adjust";
    return fail(statusIsReason && out.status ? out.status : splitProblem(result.error, result.seq, s));
  }
  if (several && out.payerLine && out.payerLine !== "Paid in full.") return fail(out.payerLine);
  return { ...out, ok: true, problem: null };
}

// ---------------------------------------------------------------- the request bodies

function payersOf(s: FormState, members: Member[], flags: FormFlags): { paid_by: string } | { payers: { member_id: string; paid_centavos: number }[] } {
  const order = members.map((m) => m.id);
  const one = members.some((m) => m.id === s.paidBy) ? s.paidBy : order[0];
  if (!flags.walletMultiPayer || !s.several) return { paid_by: one };
  const paid = parsePaid(s, members) ?? {};
  const payers = order.filter((m) => (paid[m] ?? 0) > 0).map((m) => ({ member_id: m, paid_centavos: paid[m] }));
  if (payers.length === 0) return { paid_by: one };
  if (payers.length === 1) return { paid_by: payers[0].member_id };
  return { payers };
}

/** The add's body. WALLET_SPLITS off and one payer: today's body, byte for byte. Otherwise v2, which the server takes. */
export function buildBody(s: FormState, members: Member[], flags: FormFlags, by: string | null): Built<LegacyExpenseBody | ExpenseBodyV2> {
  const check = checkForm(s, members, flags);
  if (!check.ok) return { ok: false, problem: check.problem ?? NO_AMOUNT };
  const amount = check.amount as number;
  const note = s.note.trim();
  const who = payersOf(s, members, flags);

  if (!flags.walletSplits && "paid_by" in who) {
    // Today's body (WalletView.tsx at a1c4299): this key order, no mode, by or category, zero shares left out
    if (s.mode === "equal") return { ok: true, body: { paid_by: who.paid_by, amount_centavos: amount, note, split_among: among(s, members) } };
    const shares = members
      .map((m) => ({ member_id: m.id, share_centavos: s.exact[m.id]?.trim() ? (parsePeso(s.exact[m.id], { allowZero: true }) as number) : 0 }))
      .filter((x) => x.share_centavos > 0);
    return { ok: true, body: { paid_by: who.paid_by, amount_centavos: amount, note, shares } };
  }

  const head = { mode: s.mode, ...who } as const;
  const tail = flags.walletSplits ? { note, category: s.category, by } : { note, by }; // the server drops a category with the flag off
  if (s.mode === "itemized") {
    const p = parseItems(s, members) as Extract<ItemsParsed, { ok: true }>;
    return { ok: true, body: { ...head, amount_centavos: amount, ...tail, items: p.items, charges: p.charges } as ExpenseBodyV2 };
  }
  const parsed = parseInputs(s, members) as Extract<Parsed, { ok: true }>;
  const keepZero = s.mode === "equal" || s.mode === "adjust"; // their rows are `among`
  const inputs = parsed.inputs.filter((i) => keepZero || i.value !== 0);
  return { ok: true, body: { ...head, amount_centavos: amount, ...tail, inputs } as ExpenseBodyV2 };
}

/** An edit: the v2 body plus the version the form opened with. Editing needs WALLET_SPLITS (ux.md §9's line otherwise). */
export function buildPatch(s: FormState, members: Member[], flags: FormFlags, by: string | null, version: number): Built<ExpensePatch> {
  if (!flags.walletSplits) return { ok: false, problem: "Editing isn't switched on right now. Your changes weren't saved." };
  const r = buildBody(s, members, flags, by);
  if (!r.ok) return r;
  return { ok: true, body: { ...(r.body as ExpenseBodyV2), version } };
}

// ---------------------------------------------------------------- reopening a saved expense

/**
 * The form an expense reopens in (edit). A legacy one (no mode) opens as Equally when its shares are splitEqual over its
 * people in wallet order with its payer, otherwise as Amounts (B22, ux.md §6).
 */
export function formFromExpense(e: Expense, members: Member[]): FormState {
  const s: FormState = { ...emptyForm(e.paid_by), amount: pesoInput(e.amount_centavos), note: e.note, category: e.category ?? null };
  const order = members.map((m) => m.id);
  if (e.payers && e.payers.length > 1) {
    s.several = true;
    s.paid = Object.fromEntries(e.payers.map((p) => [p.member_id, pesoInput(p.paid_centavos)]));
  }
  const notIn = (ids: string[]) => order.filter((m) => !ids.includes(m));
  const inputs = e.inputs ?? [];
  switch (e.mode) {
    case "equal":
      return { ...s, mode: "equal", out: notIn(inputs.map((i) => i.member_id)) };
    case "exact":
      return { ...s, mode: "exact", exact: Object.fromEntries(inputs.map((i) => [i.member_id, pesoInput(i.value)])) };
    case "percent":
      return { ...s, mode: "percent", percent: Object.fromEntries(inputs.map((i) => [i.member_id, percentInput(i.value)])) };
    case "shares":
      return { ...s, mode: "shares", shares: Object.fromEntries(order.map((m) => [m, inputs.find((i) => i.member_id === m)?.value ?? 0])) };
    case "adjust":
      return {
        ...s,
        mode: "adjust",
        out: notIn(inputs.map((i) => i.member_id)),
        extras: Object.fromEntries(inputs.filter((i) => i.value !== 0).map((i) => [i.member_id, pesoInput(i.value)])),
      };
    case "itemized": {
      const charge = (kind: Charge["kind"]) => {
        const c = (e.charges ?? []).find((x) => x.kind === kind);
        return c ? chargeText(c) : "";
      };
      const items = [...(e.items ?? [])].sort((a, b) => a.seq - b.seq).map((it) => ({ key: freshKey(), name: it.name, price: pesoInput(it.price_centavos), who: [...it.who] }));
      return { ...s, mode: "itemized", items, service: charge("service"), vat: charge("vat") };
    }
  }
  // Legacy: Equally if the shares are exactly today's equal split over the same people, else Amounts
  const people = order.filter((m) => e.shares.some((x) => x.member_id === m));
  const equal = splitEqual(e.amount_centavos, people, e.paid_by);
  const same = people.length === e.shares.length && e.shares.every((x) => equal[x.member_id] === x.share_centavos);
  if (same && people.length > 0) return { ...s, mode: "equal", out: notIn(people) };
  return { ...s, mode: "exact", exact: Object.fromEntries(e.shares.map((x) => [x.member_id, pesoInput(x.share_centavos)])) };
}

