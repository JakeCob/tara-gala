"use client";

import { useEffect, useState, type ReactNode } from "react";
import { PX, PixelBox, PixelButton, PixelChoice, SectionTitle, cx } from "@/components/pixel";
import ItemsEditor from "@/components/wallet/ItemsEditor";
import PayersEditor from "@/components/wallet/PayersEditor";
import { formatPeso, type Category, type SplitMode, type Expense, type ExpenseBodyV2, type ExpensePatch, type LegacyExpenseBody, type Wallet, type WalletBudget } from "@/lib/wallet";
import { editLineMeta, fromPlan, initialLine, lineAfterCategory, linesFor, showLineRow, withBudgetKey } from "@/lib/budgetLines";
import {
  MAX_SHARE_WEIGHT,
  addItem,
  buildBody,
  buildPatch,
  checkForm,
  emptyForm,
  formFromExpense,
  justOnePayer,
  removeItem,
  saveAsAmounts,
  switchMode,
  type FormFlags,
  type FormState,
} from "@/lib/walletRequest";
import { MAX_ITEMS } from "@/lib/walletSplit";

export type ExpenseSubmit = LegacyExpenseBody | ExpenseBodyV2 | ExpensePatch;
/** `asAmounts`: ux.md §9's `Save as Amounts` after a feature_off. It switches the form to Amounts with the preview's ₱
 *  and saves that, so the money is the same. */
export type SubmitContext = { edit: boolean; asAmounts: () => Promise<boolean> };

const SEVERAL = "__several";
/** ux.md §2: the five categories in fixed order, and the six split pills (3×2), with their names. */
export const CATEGORY_LABEL: Record<Category, string> = { transport: "Transport", hotel: "Hotel", food: "Food", activities: "Activities", other: "Other" };
export const MODE_LABEL: Record<SplitMode, string> = { equal: "Equally", exact: "Amounts", percent: "Percent", shares: "Shares", itemized: "Items", adjust: "Equal + extra" };
const ADDED = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" });

/**
 * TG-66: the add-and-edit form (ux.md §2 to §4, §6). The money is walletRequest's (checkForm, buildBody), whose preview
 * is walletSplit, the server's twin. With WALLET_SPLITS off it is today's form (Equally and Custom amounts) and sends
 * today's body, byte for byte. WALLET_MULTI_PAYER adds "Several people..." under Paid by.
 * Edit: pass `editing`; remount with a new `key` to load a newer version (a 409 shows their version, ux.md §6).
 * `notice` is the wallet's alert for this form (a 409 or a feature_off line), shown above the buttons.
 */
export default function ExpenseForm({ wallet, me, busy, flags, editing, notice, budget = null, lineReset = 0, onSubmit, onCancel, onError }: {
  wallet: Wallet;
  me: string;
  busy: boolean;
  flags: FormFlags & { budgetLines?: boolean };
  editing?: { expense: Expense; addedBy?: string | null } | null;
  /** TG-62: the wallet's one trip's lines (WalletOut.budget), already null with NEXT_PUBLIC_BUDGET_LINES off. */
  budget?: WalletBudget | null;
  /** TG-62: bumped by the parent when a save is refused for its line (ux §9): the pick clears and the row reloads. */
  lineReset?: number;
  notice?: ReactNode;
  onSubmit: (body: ExpenseSubmit, ctx: SubmitContext) => Promise<boolean>;
  onCancel?: () => void;
  onError: (text: string) => void;
}) {
  const members = wallet.members;
  const [s, setS] = useState<FormState>(() => (editing ? formFromExpense(editing.expense, members) : emptyForm(me)));
  // TG-62 GW1: the budget line, beside W1's state (walletRequest builds the body; the line goes on after, withBudgetKey)
  const budgetOn = !!flags.budgetLines;
  const [line, setLine] = useState<string | null>(() => (editing ? initialLine(budget, editing.expense.budget_key, editing.expense.category ?? null) : null));
  const [seenReset, setSeenReset] = useState(lineReset);
  if (lineReset !== seenReset) {
    setSeenReset(lineReset);
    setLine(null);
  }
  // The meta is about the plan's change, so it reads against the saved category: a category the person picks here isn't one
  const [linePicked, setLinePicked] = useState(false); // tg-ux2: the edit meta goes once anything is picked in the row
  const lineMeta = editing && line === null && !linePicked ? editLineMeta(budget, editing.expense.budget_key, editing.expense.category ?? null) : null;
  const pickCategory = (c: Category | null) => {
    setLine((l) => lineAfterCategory(budget, l, s.category, c)); // a new category lists its own lines, none picked (G24); no row, no change (F1)
    set({ category: c });
  };
  const edit = !!editing; // with WALLET_SPLITS off, buildPatch refuses (never an add in its place: tg-review2 nit 1)
  const v2 = flags.walletSplits;
  const check = checkForm(s, members, flags);
  const payer = members.some((m) => m.id === s.paidBy) ? s.paidBy : me;
  const several = flags.walletMultiPayer && s.several;
  const label = (id: string, name: string) => (id === me ? `${name} (you)` : name);
  const preview = (id: string) => (check.shares?.[id] !== undefined ? formatPeso(check.shares[id]) : "");
  const set = (patch: Partial<FormState>) => setS((x) => ({ ...x, ...patch }));
  const setIn = (field: "exact" | "percent" | "extras" | "paid", id: string, value: string) => setS((x) => ({ ...x, [field]: { ...x[field], [id]: value } }));
  const editingId = editing?.expense.id;

  // ux.md §6: the edit form takes focus at its title
  useEffect(() => {
    if (editingId) document.getElementById("add-title")?.focus();
  }, [editingId]);

  async function submit(state: FormState): Promise<boolean> {
    const built = edit ? buildPatch(state, members, flags, me, editing!.expense.version ?? 1) : buildBody(state, members, flags, me);
    const lineWord = !budgetOn ? "off" : line === null ? "null" : line === "_none" ? "none" : "line"; // never the key (G10a)
    console.info("[tg-wallet] expense form submit mode=%s edit=%s items=%d payers=%s ok=%s line=%s", state.mode, edit, state.mode === "itemized" ? state.items.length : 0, several, built.ok, lineWord);
    if (!built.ok) {
      onError(built.problem);
      return false;
    }
    const asAmounts = async () => {
      console.info("[tg-wallet] expense form save as amounts from=%s", state.mode);
      const now = checkForm(state, members, flags);
      if (!now.shares) return false;
      const next = saveAsAmounts(state, now.shares);
      setS(next);
      return submit(next);
    };
    const saved = await onSubmit(withBudgetKey(built.body, { on: budgetOn, line }), { edit, asAmounts });
    if (saved && !edit) {
      // Today's reset: the amount, the note and what was typed per person go; the payer, the people and the mode stay
      setS((x) => ({ ...emptyForm(me), paidBy: x.paidBy, mode: x.mode, out: x.out, several: x.several }));
      setLine(null);
    }
    return saved;
  }

  async function onFormSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    await submit(s);
  }

  function stepShare(id: string, by: number) {
    setS((x) => {
      const now = x.shares[id] ?? (x.out.includes(id) ? 0 : 1);
      const next = Math.min(MAX_SHARE_WEIGHT, Math.max(0, now + by));
      return { ...x, shares: { ...x.shares, [id]: next } };
    });
  }

  const ticked = (id: string) => !s.out.includes(id);
  const tick = (id: string, on: boolean) => setS((x) => ({ ...x, out: on ? x.out.filter((m) => m !== id) : [...x.out, id] }));
  const weight = (id: string) => s.shares[id] ?? (ticked(id) ? 1 : 0);

  // ---------------------------------------------------------------- the pieces

  const amountField = (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-semibold">Amount</span>
      <span className="flex">
        <span aria-hidden="true" className={PX.inputPrefix}>₱</span>
        {s.mode === "itemized" ? (
          <input
            id="expense-amount"
            // Read-only, and it looks it: the page's background in the same frame, at full text contrast (tg-ux2 W3 S3)
            className="min-h-11 w-full min-w-0 rounded-none border-3 border-frame bg-background px-3 py-2 text-base text-foreground focus-pixel"
            readOnly
            aria-describedby="expense-amount-meta"
            value={check.amount !== null ? formatPeso(check.amount).replace("₱", "") + (check.amount % 100 ? "" : ".00") : ""} // ux 66-04: "1,188.00"
          />
        ) : (
          <input id="expense-amount" className={cx(PX.input, "w-full min-w-0")} inputMode="decimal" autoComplete="off" placeholder="0.00" value={s.amount} onChange={(e) => set({ amount: e.target.value })} />
        )}
      </span>
      {s.mode === "itemized" && (
        <span id="expense-amount-meta" className={PX.meta}>
          The items plus charges
        </span>
      )}
    </label>
  );
  const noteField = (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-semibold">What for</span>
      <input className={cx(PX.input, "w-full min-w-0")} maxLength={60} placeholder="Taxi, dinner, entrance" value={s.note} onChange={(e) => set({ note: e.target.value })} />
    </label>
  );
  const paidBy = (
    <>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-semibold">Paid by</span>
        <select
          className={PX.input}
          value={several ? SEVERAL : payer}
          onChange={(e) => (e.target.value === SEVERAL ? set({ several: true }) : set({ several: false, paidBy: e.target.value }))}
        >
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {label(m.id, m.name)}
            </option>
          ))}
          {flags.walletMultiPayer && <option value={SEVERAL}>Several people...</option>}
        </select>
      </label>
      {several && (
        <PayersEditor members={members} me={me} paid={s.paid} line={check.payerLine} onChange={(id, v) => setIn("paid", id, v)} onJustOne={() => setS((x) => justOnePayer(x, members))} />
      )}
    </>
  );
  const submitButton = v2 ? (
    <PixelButton type="submit" variant="primary" className="px-4 py-3" aria-disabled={busy || undefined}>
      {busy ? "Saving..." : edit ? "Save changes" : "Add expense"}
    </PixelButton>
  ) : (
    <PixelButton type="submit" variant="primary" className="px-4 py-3" disabled={busy}>
      {busy ? "Saving..." : "Add expense"}
    </PixelButton>
  );

  // ---------------------------------------------------------------- WALLET_SPLITS off: today's form

  if (!v2) {
    return (
      <PixelBox as="form" onSubmit={onFormSubmit} noValidate aria-labelledby="add-title" className="flex flex-col gap-3 p-4">
        <SectionTitle id="add-title">Add an expense</SectionTitle>
        <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-2">
          {amountField}
          {noteField}
        </div>
        {paidBy}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold">Split</legend>
          <div className="grid grid-cols-2 gap-2">
            <PixelChoice name="split-mode" value="equal" checked={s.mode === "equal"} onChange={() => setS((x) => switchMode(x, "equal"))}>
              Equally
            </PixelChoice>
            <PixelChoice name="split-mode" value="custom" checked={s.mode === "exact"} onChange={() => setS((x) => switchMode(x, "exact"))}>
              Custom amounts
            </PixelChoice>
          </div>
          <ul className="flex flex-col gap-2">
            {members.map((m) => (
              <li key={m.id} className="flex min-h-11 items-center justify-between gap-3 text-sm">
                {s.mode === "equal" ? (
                  <>
                    <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2">
                      <input type="checkbox" className="h-5 w-5 shrink-0 accent-[var(--primary)]" checked={ticked(m.id)} onChange={(e) => tick(m.id, e.target.checked)} />
                      <span className="min-w-0 break-words">{m.name}</span>
                    </label>
                    <span className="tabular-nums text-muted">{preview(m.id)}</span>
                  </>
                ) : (
                  <label className="flex min-w-0 flex-1 items-center justify-between gap-3">
                    <span className="min-w-0 break-words">{m.name}</span>
                    <input
                      className={cx(PX.input, "w-28 text-right tabular-nums")}
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder="0"
                      aria-invalid={check.problem === "Check the amounts: pesos, like 300 or 150.50." || undefined}
                      value={s.exact[m.id] ?? ""}
                      onChange={(e) => setIn("exact", m.id, e.target.value)}
                    />
                  </label>
                )}
              </li>
            ))}
          </ul>
          {s.mode === "exact" && check.status !== null && (
            <p className="text-sm tabular-nums" aria-live="polite">
              {check.status}
            </p>
          )}
        </fieldset>
        {notice}
        {submitButton}
      </PixelBox>
    );
  }

  // ---------------------------------------------------------------- WALLET_SPLITS on (ux.md §2)

  const hint: Partial<Record<FormState["mode"], string>> = {
    exact: "Type what each person owes.",
    percent: "Up to 2 decimals, like 33.33.",
    shares: "Someone who had twice as much gets 2.",
    adjust: "Add an extra for anyone who had more. A minus takes some off.",
  };
  const added = editing ? ADDED.format(new Date(editing.expense.created_at)) : "";

  return (
    <PixelBox as="form" onSubmit={onFormSubmit} noValidate aria-labelledby="add-title" className="flex flex-col gap-3 p-4">
      <SectionTitle id="add-title" tabIndex={-1} className="focus-pixel">
        {edit ? "Edit an expense" : "Add an expense"}
      </SectionTitle>
      {edit && (
        <p className="text-sm">
          {editing!.addedBy ? `Added by ${editing!.addedBy}, ${added}.` : `Added ${added}.`} Changes show to everyone and are kept in its history.
        </p>
      )}
      <div className="flex flex-col gap-3 md:grid md:grid-cols-[minmax(0,10rem)_minmax(0,1fr)] md:gap-2">
        {amountField}
        {noteField}
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-semibold">Category</legend>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => (
            <PixelChoice
              key={c}
              name="expense-category"
              value={c}
              checked={s.category === c}
              onChange={() => pickCategory(c)}
              inputProps={{ onClick: () => s.category === c && pickCategory(null) }} // tapping the checked pill clears it
            >
              {CATEGORY_LABEL[c]}
            </PixelChoice>
          ))}
        </div>
      </fieldset>
      {budget && showLineRow(budget, s.category) && (
        // TG-62 GW1, ux §2 item 3: the category's plan lines, then None of these. Never picked for the user (not from the note)
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold">Which budget line?<span className={PX.meta}> (optional)</span></legend>
          <div className="flex flex-col gap-2">
            {linesFor(budget, s.category).map((l) => (
              <PixelChoice
                key={l.key}
                name="budget-line"
                value={l.key}
                checked={line === l.key}
                onChange={() => {
                  setLine(l.key);
                  setLinePicked(true);
                }}
                inputProps={{ onClick: () => line === l.key && setLine(null) }} // tapping the checked line clears it
                className="flex w-full items-center gap-1 px-3 py-2 text-left text-sm leading-tight"
              >
                {l.item}
              </PixelChoice>
            ))}
          </div>
          <p className={PX.meta}>{fromPlan(budget)}</p>
          {lineMeta && <p className={PX.meta}>{lineMeta}</p>}
        </fieldset>
      )}
      {paidBy}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-semibold">Split</legend>
        <div className="grid grid-cols-3 gap-2">
          {(Object.keys(MODE_LABEL) as SplitMode[]).map((mode) => (
            <PixelChoice key={mode} name="split-mode" value={mode} checked={s.mode === mode} onChange={() => setS((x) => switchMode(x, mode))}>
              {MODE_LABEL[mode].replace("Equal +", "Equal\u00a0+") /* breaks at most once at 320 (tg-ux2 W3 S6) */}
            </PixelChoice>
          ))}
        </div>
        {hint[s.mode] && <p className={PX.meta}>{hint[s.mode]}</p>}
        {s.mode === "itemized" ? (
          <ItemsEditor
            items={s.items}
            members={members}
            me={me}
            service={s.service}
            vat={s.vat}
            bill={check.bill}
            shares={check.shares}
            canAdd={s.items.length < MAX_ITEMS}
            onItem={(key, patch) => setS((x) => ({ ...x, items: x.items.map((it) => (it.key === key ? { ...it, ...patch } : it)) }))}
            onAdd={() => setS(addItem)}
            onRemove={(key) => setS((x) => removeItem(x, key))}
            onCharge={(kind, value) => set({ [kind]: value })}
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {members.map((m) => (
              <li key={m.id} className={cx("flex min-h-11 items-center justify-between text-sm", s.mode === "adjust" ? "flex-wrap gap-x-3 gap-y-1" : "gap-3")}>
                {s.mode === "equal" || s.mode === "adjust" ? (
                  <label className={cx("flex min-h-11 flex-1 cursor-pointer items-center gap-2", s.mode === "adjust" ? "min-w-[5.5rem]" : "min-w-0")}>
                    <input type="checkbox" className="h-5 w-5 shrink-0 accent-[var(--primary)]" checked={ticked(m.id)} onChange={(e) => tick(m.id, e.target.checked)} />
                    <span className="min-w-0 break-words">{label(m.id, m.name)}</span>
                  </label>
                ) : (
                  <span id={`share-${m.id}`} className="min-w-0 flex-1 break-words">
                    {label(m.id, m.name)}
                  </span>
                )}
                {s.mode === "exact" && (
                  <span className="flex">
                    <span aria-hidden="true" className={PX.inputPrefix}>₱</span>
                    <input
                      className={cx(PX.input, "w-28 text-right tabular-nums")}
                      aria-labelledby={`share-${m.id}`}
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder="0"
                      value={s.exact[m.id] ?? ""}
                      onChange={(e) => setIn("exact", m.id, e.target.value)}
                    />
                  </span>
                )}
                {s.mode === "percent" && (
                  <span className="flex">
                    <input
                      className={cx(PX.input, "w-20 text-right tabular-nums")}
                      aria-labelledby={`share-${m.id}`}
                      inputMode="decimal"
                      autoComplete="off"
                      value={s.percent[m.id] ?? ""}
                      onChange={(e) => setIn("percent", m.id, e.target.value)}
                    />
                    <span aria-hidden="true" className="inline-flex items-center border-3 border-l-0 border-frame bg-card px-3 text-base font-bold text-foreground">%</span>
                  </span>
                )}
                {s.mode === "shares" && (
                  <span role="group" aria-labelledby={`share-${m.id} share-${m.id}-n`} className="flex items-center gap-2">
                    <PixelButton variant="icon" aria-label={`One share less for ${m.name}`} aria-disabled={weight(m.id) === 0} onClick={() => weight(m.id) > 0 && stepShare(m.id, -1)}>
                      <span aria-hidden="true" className="text-xl font-bold">
                        −
                      </span>
                    </PixelButton>
                    <span id={`share-${m.id}-n`} aria-live="polite" className="w-6 text-center text-base font-bold tabular-nums">
                      {weight(m.id)}
                    </span>
                    <PixelButton
                      variant="icon"
                      aria-label={`One share more for ${m.name}`}
                      aria-disabled={weight(m.id) >= MAX_SHARE_WEIGHT}
                      onClick={() => weight(m.id) < MAX_SHARE_WEIGHT && stepShare(m.id, 1)}
                    >
                      <span aria-hidden="true" className="text-xl font-bold">
                        +
                      </span>
                    </PixelButton>
                  </span>
                )}
                {s.mode === "adjust" && (
                  // Equal + extra: the field and its preview stay together, right-aligned; at 320 they wrap under the name
                  <span className="ml-auto flex shrink-0 items-center gap-2">
                    <label className="flex items-center gap-1">
                      <span className={PX.meta}>extra</span>
                      <span aria-hidden="true" className={PX.inputPrefix}>₱</span>
                      <input
                        className={cx(PX.input, "w-20 text-right tabular-nums")}
                        aria-label={`Extra for ${m.name}`}
                        inputMode="text"
                        autoComplete="off"
                        placeholder="0"
                        disabled={!ticked(m.id)}
                        value={s.extras[m.id] ?? ""}
                        onChange={(e) => setIn("extras", m.id, e.target.value)}
                      />
                    </label>
                    <span className="text-right tabular-nums text-muted">{preview(m.id)}</span>
                  </span>
                )}
                {s.mode !== "exact" && s.mode !== "adjust" && <span className="w-20 text-right tabular-nums text-muted">{preview(m.id)}</span>}
              </li>
            ))}
          </ul>
        )}
        <p aria-live="polite" className={cx(s.mode === "equal" ? PX.meta : "text-sm", "tabular-nums")}>
          {check.status}
        </p>
      </fieldset>
      {notice}
      <div className="flex flex-wrap gap-2">
        {submitButton}
        {edit && onCancel && (
          <PixelButton variant="secondary" onClick={onCancel}>
            Cancel
          </PixelButton>
        )}
      </div>
    </PixelBox>
  );
}
