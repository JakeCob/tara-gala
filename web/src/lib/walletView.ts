// TG-66 W3: the wallet screen's pure logic, so node can test it (WalletView.tsx renders it). Which parts show per flag
// (B28), what an add's or an edit's answer does (B26: a 409 shows their version and says what they changed, never a
// lost edit), the feature_off line from what was sent (B28a), and the dropped-category line (ux.md §9). Copy is ux.md's.
// No logging here: WalletView logs each outcome once.
import { failureMessage, type Activity, type Expense, type ExpenseBodyV2, type ExpensePatch, type LegacyExpenseBody, type Wallet, type WalletResult } from "./wallet.ts";
import { changeLine, changes, type Snapshot } from "./walletActivity.ts";
import { onlyUncategorized } from "./walletCategories.ts";
import { SPLIT_COPY, pickWhoHad } from "./walletRequest.ts";

export type ViewFlags = { walletSplits: boolean; walletMultiPayer: boolean; walletActivity: boolean; offlineExpenses?: boolean };
export type ScreenParts = {
  compactCards: boolean; // the short card with Details (ux §5), instead of today's card with its shares line and Delete
  categories: boolean; // the Categories box (ux §7)
  activity: boolean; // the Activity box (ux §8)
  outbox: boolean; // TG-70: an add with no signal waits here (the queue, the Waiting box, the cue); it sends only v2 bodies
};
export type Sent = LegacyExpenseBody | ExpenseBodyV2 | ExpensePatch;

/** B28: with every flag off the screen is today's. Details (and so the compact card) is where Edit, Comments and several payers' amounts live. */
export function screenParts(f: ViewFlags): ScreenParts {
  return {
    compactCards: f.walletSplits || f.walletActivity || f.walletMultiPayer,
    categories: f.walletSplits,
    activity: f.walletActivity,
    outbox: !!f.offlineExpenses && f.walletSplits,
  };
}

const SPLIT_NAME: Record<string, string> = { percent: "Percent", shares: "Shares", adjust: "Equal + extra", itemized: "Items" };
const EDIT_OFF = "Editing isn't switched on right now. Your changes weren't saved.";
const PAYERS_OFF = "More than one payer isn't switched on right now. Pick one person under Paid by.";
const GONE = "This expense was deleted, so there's nothing to save.";

/** ux §9's feature_off table, from what this phone sent, in table order: edit, several payers, then the split. */
export function featureOffLine(sent: { edit: boolean; body: Sent }): { text: string; asAmounts: boolean } {
  if (sent.edit) return { text: EDIT_OFF, asAmounts: false };
  const b = sent.body as { payers?: unknown[]; mode?: string };
  if (Array.isArray(b.payers) && b.payers.length > 1) return { text: PAYERS_OFF, asAmounts: false };
  const name = b.mode ? SPLIT_NAME[b.mode] : undefined;
  if (name) return { text: `The ${name} split isn't switched on right now. Equally and Amounts still work.`, asAmounts: true };
  return { text: failureMessage({ why: "rejected" }), asAmounts: false }; // the server takes Equally and Amounts with the flag off
}

/** A refused add or edit, in ux §9's words. item_no_one names the item from what was sent (never from the server). */
function refusal(r: Extract<WalletResult, { ok: false }>, sent: Sent, edit: boolean): { alert: string; asAmounts: boolean } {
  if (!("mode" in sent)) return { alert: failureMessage(r), asAmounts: false }; // today's body: today's words (B28)
  if (r.detail === "feature_off") {
    const line = featureOffLine({ edit, body: sent });
    return { alert: line.text, asAmounts: line.asAmounts };
  }
  if (r.detail === "item_no_one") {
    const items = (sent as { items?: { name: string }[] }).items;
    return { alert: pickWhoHad(r.seq ? items?.[r.seq - 1]?.name : undefined), asAmounts: false };
  }
  const split = r.detail ? (SPLIT_COPY as Record<string, string>)[r.detail] : undefined;
  return { alert: split ?? failureMessage(r), asAmounts: false };
}

export type AddOutcome = { ok: true; wallet: Wallet; text: string } | { ok: false; alert: string; asAmounts: boolean };

/** An add's answer: `Expense added.`, or the dropped-category line when a picked category came back null (the server's flag is off). */
export function addOutcome(before: Wallet, sent: Sent, r: WalletResult): AddOutcome {
  if (!r.ok) return { ok: false, ...refusal(r, sent, false) };
  const known = new Set(before.expenses.map((e) => e.id));
  const added = r.wallet.expenses.find((e) => !known.has(e.id));
  const picked = (sent as { category?: string | null }).category;
  const dropped = !!picked && !!added && (added.category ?? null) === null;
  return { ok: true, wallet: r.wallet, text: dropped ? "Added. Categories aren't switched on right now, so it has no category yet." : "Expense added." };
}

export type EditOutcome =
  | { kind: "saved"; wallet: Wallet; text: string }
  | { kind: "changed"; wallet: Wallet; expense: Expense; alert: string } // the form reloads with their version
  | { kind: "gone"; wallet: Wallet | null; alert: string } // the form goes back to Add
  | { kind: "refused"; alert: string; asAmounts: boolean }; // the form stays open with what was typed

/**
 * An edit's answer (ux §6). A 409 brings the wallet as it is now: the form reopens on their version, and the alert says
 * what they changed (`actor` is who, from the activity, when known). A 409 or 404 without the expense means it was deleted.
 */
export function editOutcome(r: WalletResult, sent: ExpensePatch, before: Expense, actor: string | null): EditOutcome {
  if (r.ok) return { kind: "saved", wallet: r.wallet, text: "Changes saved." };
  if (r.detail === "expense_changed" || r.detail === "expense_gone") {
    const theirs = r.detail === "expense_changed" ? r.wallet?.expenses.find((e) => e.id === before.id) : undefined;
    if (!theirs || !r.wallet) return { kind: "gone", wallet: r.wallet ?? null, alert: GONE };
    const line = changeLine(actor ?? "Someone", changes(before as unknown as Snapshot, theirs as unknown as Snapshot, r.wallet));
    return {
      kind: "changed",
      wallet: r.wallet,
      expense: theirs,
      alert: `Someone changed this expense while you were editing. The form now shows their version, so your change isn't saved. ${line} Make your change again if it's still needed.`,
    };
  }
  return { kind: "refused", ...refusal(r, sent, true) };
}

/** The edit header's `Added by <who>` (ux §6): the add row's actor, "Someone" for a phone that hadn't picked, null with no add row. */
export function addedBy(rows: Activity[], w: Wallet): string | null {
  const add = rows.find((r) => r.action === "expense_add");
  if (!add) return null;
  return w.members.find((m) => m.id === add.actor)?.name ?? "Someone";
}

/** The expense list, all of it or only those with no category (the Categories nudge, ux §7). */
export function visibleExpenses(list: Expense[], uncategorizedOnly: boolean): Expense[] {
  return uncategorizedOnly ? onlyUncategorized(list) : list;
}
