// TG-66: the words for one expense (its split, its payers), its Changes and Comments, and the wallet's activity list.
// Pure helpers over WalletOut and the activity rows (plan §2 addendum, ux.md §5 and §8). The rows' before/after are the
// expense snapshots: ExpenseOut's own fields, lists diffed by member_id, seq or kind, never by position, and any key this
// file doesn't know (TG-62's budget_key) ignored. Logs carry counts and outcomes only: never a name, a note, a comment,
// an id or the slug.
import { failureMessage, formatPeso, splitEqual } from "./wallet.ts";
import type { Activity, ActivityResult, Category, WalletFailed, Charge, Comment, Expense, InputRow, Item, Payer, Share, SplitMode, Wallet } from "./wallet.ts";

export const ACTIVITY_PAGE = 15; // walletApi.activity's default page
export const HISTORY_PAGE = 50; // one expense's rows, with ?expense_id= (the API's most)
export const COMMENT_MAX = 300;
const COUNT_FROM = 250;
const SOMEONE = "Someone";
const NO_CATEGORY = "No category yet";
const CATEGORY_LABEL: Record<Category, string> = { transport: "Transport", hotel: "Hotel", food: "Food", activities: "Activities", other: "Other" };

/** The expense as an activity row holds it (plan §2 addendum). Every field is read defensively: it's JSON from the API. */
export type Snapshot = {
  amount_centavos: number;
  note: string;
  category?: Category | null;
  paid_by: string;
  payers?: Payer[];
  mode?: SplitMode | null;
  inputs?: InputRow[];
  items?: Item[];
  charges?: Charge[];
  shares: Share[];
  version?: number;
  [key: string]: unknown; // the snapshot can grow (TG-62's budget_key): an unknown key is carried, never diffed
};
type Money = Pick<Snapshot, "amount_centavos" | "paid_by" | "payers" | "mode" | "inputs" | "items" | "charges" | "shares">;

// ---------------------------------------------------------------- names and small words

function names(w: Wallet): (id: string | null | undefined) => string {
  const byId = new Map(w.members.map((m) => [m.id, m.name]));
  return (id) => (id ? (byId.get(id) ?? SOMEONE) : SOMEONE);
}

/** Member ids in wallet order; ids the wallet doesn't know go last, in the order given. */
function inWalletOrder(w: Wallet, ids: string[]): string[] {
  const rank = new Map(w.members.map((m, i) => [m.id, i]));
  return [...ids].sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity));
}

/** "Ana", "Ana and Ben", "Ana, Ben and Carla". */
function andList(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Basis points as a percent with up to 2 decimals: 4000 → "40", 3333 → "33.33", 1250 → "12.5". */
function percent(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const frac = Math.abs(bp % 100);
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}`;
}

/** A signed extra: "+₱200", "−₱50". */
const extra = (c: number) => (c < 0 ? formatPeso(c) : `+${formatPeso(c)}`);

export function categoryWords(c: Category | null | undefined): string {
  return c ? CATEGORY_LABEL[c] : NO_CATEGORY;
}

export function editedWords(version: number | undefined): string {
  const edits = (version ?? 1) - 1;
  if (edits <= 0) return "";
  if (edits === 1) return "edited";
  if (edits === 2) return "edited twice";
  return `edited ${edits} times`;
}

export function commentsWords(n: number | undefined): string {
  return n ? plural(n, "comment") : "";
}

// ---------------------------------------------------------------- the split, as stored or inferred

type Split = { mode: SplitMode; inputs: InputRow[] };

/**
 * The mode and inputs, with a legacy expense (no mode) read as plan B22 says: Equally among its people when its shares are
 * splitEqual over them in wallet order, else Amounts with its shares as the inputs.
 */
function splitOf(e: Money, w: Wallet): Split {
  if (e.mode) return { mode: e.mode, inputs: e.inputs ?? [] };
  const people = inWalletOrder(w, e.shares.map((s) => s.member_id));
  const equal = splitEqual(e.amount_centavos, people, e.paid_by);
  const isEqual = e.shares.every((s) => equal[s.member_id] === s.share_centavos);
  return isEqual
    ? { mode: "equal", inputs: people.map((member_id) => ({ member_id, value: 1 })) }
    : { mode: "exact", inputs: e.shares.map((s) => ({ member_id: s.member_id, value: s.share_centavos })) };
}

const ordered = (w: Wallet, rows: InputRow[]) => {
  const byId = new Map(rows.map((r) => [r.member_id, r]));
  return inWalletOrder(w, [...byId.keys()]).map((id) => byId.get(id) as InputRow);
};

function chargeShort(c: Charge): string {
  const name = c.kind === "service" ? "service" : "VAT";
  return `${name} ${c.basis === "percent" ? `${percent(c.value)}%` : formatPeso(c.value)}`;
}

const chargesInOrder = (cs: Charge[] | undefined) => [...(cs ?? [])].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "service" ? -1 : 1));

/** The split's words. `short`: only the pill name, for a Changes line where the mode itself changed. */
function splitWords(e: Money, w: Wallet, short = false): string {
  const { mode, inputs } = splitOf(e, w);
  switch (mode) {
    case "equal":
      return short ? "Equally" : `Equally among ${inputs.length}`;
    case "exact":
      return "Amounts";
    case "percent":
      return `Percent ${ordered(w, inputs).filter((r) => r.value > 0).map((r) => percent(r.value)).join(":")}`;
    case "shares":
      return `Shares ${ordered(w, inputs).filter((r) => r.value > 0).map((r) => r.value).join(":")}`;
    case "adjust":
      return "Equal + extra";
    case "itemized": {
      const items = `Items, ${(e.items ?? []).length}`;
      return short ? items : [items, ...chargesInOrder(e.charges).map(chargeShort)].join(" · ");
    }
  }
}

/** The card's split words: "Equally among 4", "Shares 2:2:1", "Items, 7 · service 10%". */
export function splitLabel(e: Money, w: Wallet): string {
  return splitWords(e, w);
}

/** The card's meta line: the split, then "edited", then the comment count (ux §5). */
export function cardMeta(e: Expense, w: Wallet): string {
  return [splitLabel(e, w), (e.version ?? 1) > 1 ? "edited" : "", commentsWords(e.comment_count)].filter(Boolean).join(" · ");
}

/** The payers in wallet order, with what each paid; one payer is paid_by with the whole amount. */
function payersOf(e: Money, w: Wallet): Payer[] {
  const list = e.payers?.length ? e.payers : [{ member_id: e.paid_by, paid_centavos: e.amount_centavos }];
  const byId = new Map(list.map((p) => [p.member_id, p]));
  return inWalletOrder(w, [...byId.keys()]).map((id) => byId.get(id) as Payer);
}

/** "Ana", "Ana and Ben", "Ana, Ben and 1 more" (ux §4). */
export function payersWords(e: Money, w: Wallet): string {
  const name = names(w);
  const ps = payersOf(e, w).map((p) => name(p.member_id));
  return ps.length <= 2 ? andList(ps) : `${ps.slice(0, 2).join(", ")} and ${ps.length - 2} more`;
}

/** The details' payer line after "Paid by ": "Ana ₱800 and Ben ₱480"; one payer is just the name. */
export function payersDetail(e: Money, w: Wallet): string {
  const name = names(w);
  const ps = payersOf(e, w);
  if (ps.length === 1) return name(ps[0].member_id);
  return andList(ps.map((p) => `${name(p.member_id)} ${formatPeso(p.paid_centavos)}`));
}

/** The details' split heading (ux §5, §11). */
export function splitHeading(e: Money, w: Wallet): string {
  const { mode, inputs } = splitOf(e, w);
  switch (mode) {
    case "equal":
      return `Split equally among ${inputs.length}`;
    case "exact":
      return "Split by amounts";
    case "percent":
      return "Split by percent";
    case "shares":
      return `Split by shares, ${inputs.reduce((a, r) => a + r.value, 0)} in all`;
    case "adjust":
      return "Split equally, plus extras";
    case "itemized":
      return "Split by items";
  }
}

export type SplitRow = { member_id: string; name: string; detail: string };

/** One row per person in the split, in wallet order: what decided their part, then the part (ux §5). */
export function splitRows(e: Money, w: Wallet): SplitRow[] {
  const name = names(w);
  const { mode, inputs } = splitOf(e, w);
  const share = new Map(e.shares.map((s) => [s.member_id, s.share_centavos]));
  const value = new Map(inputs.map((r) => [r.member_id, r.value]));
  const people = mode === "itemized" ? e.shares.map((s) => s.member_id) : inputs.map((r) => r.member_id);
  return inWalletOrder(w, [...new Set(people)]).map((id) => {
    const part = formatPeso(share.get(id) ?? 0);
    const v = value.get(id) ?? 0;
    const lead = mode === "shares" ? plural(v, "share") : mode === "percent" ? `${percent(v)}%` : mode === "adjust" && v !== 0 ? extra(v) : "";
    return { member_id: id, name: name(id), detail: lead ? `${lead} · ${part}` : part };
  });
}

/** An itemized bill's items by seq: "Pinikpikan ₱420 · Ana, Ben". */
export function itemRows(e: Money, w: Wallet): string[] {
  const name = names(w);
  return [...(e.items ?? [])]
    .sort((a, b) => a.seq - b.seq)
    .map((i) => `${i.name} ${formatPeso(i.price_centavos)} · ${inWalletOrder(w, i.who).map(name).join(", ")}`);
}

/** A charge as the form wrote it: "Service charge 10%", "VAT, other charges ₱120" (ux §3). */
export function chargeLabel(c: Charge): string {
  const name = c.kind === "service" ? "Service charge" : "VAT, other charges";
  return `${name} ${c.basis === "percent" ? `${percent(c.value)}%` : formatPeso(c.value)}`;
}

// ---------------------------------------------------------------- Changes: a pure diff of two snapshots (B23)

export type Field = "amount" | "note" | "category" | "split" | "payers" | "items" | "charges";
export type Change = { field: Field; before?: string; after?: string };

const FIELD_LONG: Record<Field, string> = { amount: "the amount", note: "the note", category: "the category", split: "the split", payers: "Paid by", items: "the items", charges: "the charges" };
const FIELD_SHORT: Record<Field, string> = { amount: "amount", note: "note", category: "category", split: "split", payers: "Paid by", items: "items", charges: "charges" };

/** A list as a key → value map, so order never counts. */
const keyed = <T,>(rows: T[] | undefined, key: (r: T) => string | number, value: (r: T) => unknown) =>
  JSON.stringify([...(rows ?? [])].map((r) => [String(key(r)), value(r)] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

const inputsKey = (s: Split) => `${s.mode}|${keyed(s.inputs, (r) => r.member_id, (r) => r.value)}`;
// One payer is who paid, not how much: the amount has its own line
const payersKey = (e: Money) => (e.payers?.length ? keyed(e.payers, (p) => p.member_id, (p) => p.paid_centavos) : `one:${e.paid_by}`);
const itemsKey = (e: Money) => keyed(e.items, (i) => i.seq, (i) => [i.name, i.price_centavos, [...i.who].sort()]);
const chargesKey = (e: Money) => keyed(e.charges, (c) => c.kind, (c) => [c.basis, c.value]);
const itemsWords = (e: Money) => `${plural((e.items ?? []).length, "item")}, ${formatPeso((e.items ?? []).reduce((a, i) => a + i.price_centavos, 0))}`;
const chargesWords = (e: Money) => chargesInOrder(e.charges).map(chargeShort).join(", ") || "none";

function change(field: Field, before: string, after: string): Change {
  return before === after ? { field } : { field, before, after };
}

/**
 * What changed between two snapshots, one entry per field in ux §5's order. Only the money and the words count: the
 * version, and keys this file doesn't know, never make a line. Under an equal split the shares follow the amount, so a
 * new amount isn't also a split change. A legacy `before` (mode null) is read as its inferred mode (B22, B23).
 */
export function changes(before: Snapshot, after: Snapshot, w: Wallet): Change[] {
  const out: Change[] = [];
  if (before.amount_centavos !== after.amount_centavos) out.push(change("amount", formatPeso(before.amount_centavos), formatPeso(after.amount_centavos)));
  if (before.note !== after.note) out.push(change("note", `"${before.note}"`, `"${after.note}"`));
  if ((before.category ?? null) !== (after.category ?? null)) out.push(change("category", categoryWords(before.category), categoryWords(after.category)));
  const [sb, sa] = [splitOf(before, w), splitOf(after, w)];
  if (inputsKey(sb) !== inputsKey(sa)) {
    const short = sb.mode !== sa.mode;
    out.push(change("split", splitWords(before, w, short), splitWords(after, w, short)));
  }
  if (payersKey(before) !== payersKey(after)) out.push(change("payers", payersWords(before, w), payersWords(after, w)));
  if (itemsKey(before) !== itemsKey(after)) out.push(change("items", itemsWords(before), itemsWords(after)));
  if (chargesKey(before) !== chargesKey(after)) out.push(change("charges", chargesWords(before), chargesWords(after)));
  return out;
}

const more = (n: number) => (n > 0 ? `, and ${plural(n, "more change", "more changes")}` : "");
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A Changes line in the details (ux §5): "Ben changed the split: Equally → Shares 2:2:1. Paid by: Ana → Ana and Ben."
 * Two fields at most, then ", and N more change(s)". A field whose words read the same both sides has no arrow.
 */
export function changeLine(who: string, list: Change[]): string {
  return `${who} ${changeRest(list)}`;
}

function changeRest(list: Change[]): string {
  if (list.length === 0) return "changed it.";
  const [first, second] = list;
  const arrow = (c: Change) => `${c.before} → ${c.after}`;
  let s = first.before !== undefined ? `changed ${FIELD_LONG[first.field]}: ${arrow(first)}` : `changed ${FIELD_LONG[first.field]}`;
  if (second) s += second.before !== undefined ? `. ${capital(FIELD_LONG[second.field])}: ${arrow(second)}` : `. ${capital(FIELD_LONG[second.field])} changed`;
  return `${s}${more(list.length - 2)}.`;
}

// ---------------------------------------------------------------- times (Manila)

const DAY = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "Asia/Manila" });
const DAY_KEY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" });
const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" });
const DAY_TIME = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" });

/** "4:12 PM", Manila time. */
export const timeOnly = (iso: string) => TIME.format(new Date(iso));
/** "Fri, Nov 6, 1:02 PM", Manila time. */
export const dayTime = (iso: string) => DAY_TIME.format(new Date(iso));

// ---------------------------------------------------------------- one expense's history (the details)

const isHistory = (r: Activity) => r.action === "expense_add" || r.action === "expense_edit";
const asSnapshot = (v: unknown) => (v && typeof v === "object" && Array.isArray((v as Snapshot).shares) ? (v as Snapshot) : null);

export type HistoryLine = { id: number; who: string; rest: string; at: string };

/** The details' Changes, newest first: one line per edit, then "<who> added it: ₱1,180, Equally among 4." if the add is listed. */
export function historyLines(rows: Activity[], e: Expense, w: Wallet): HistoryLine[] {
  const name = names(w);
  return rows
    .filter((r) => r.expense_id === e.id && isHistory(r))
    .sort((a, b) => b.id - a.id)
    .flatMap((r) => {
      const after = asSnapshot(r.after);
      if (r.action === "expense_add") {
        return after ? [{ id: r.id, who: name(r.actor), rest: `added it: ${formatPeso(after.amount_centavos)}, ${splitLabel(after, w)}.`, at: r.at }] : [];
      }
      const before = asSnapshot(r.before);
      return before && after ? [{ id: r.id, who: name(r.actor), rest: changeRest(changes(before, after, w)), at: r.at }] : [];
    });
}

/** "Added by Ben, Fri, Nov 6, 1:02 PM · edited twice". Without the history (offline, or a legacy expense) there's no who. */
export function addedLine(e: Expense, rows: Activity[] | null, w: Wallet): string {
  const add = rows?.find((r) => r.expense_id === e.id && r.action === "expense_add");
  const when = dayTime(e.created_at);
  return [add ? `Added by ${names(w)(add.actor)}, ${when}` : `Added ${when}`, editedWords(e.version)].filter(Boolean).join(" · ");
}

type HistoryApi = { activity: (slug: string, opts?: { before?: number; expenseId?: string; limit?: number }) => Promise<ActivityResult> };
export type HistoryResult = { ok: true; rows: Activity[]; complete: boolean } | Extract<ActivityResult, { ok: false }>;

/**
 * One expense's add and edit rows, newest first, from GET …/activity?expense_id= (plan §2 addendum). It pages with
 * `before` only past 50 rows, and stops at `maxPages`, with `complete: false`, so a runaway list can't loop.
 */
export async function loadExpenseHistory(api: HistoryApi, slug: string, e: Pick<Expense, "id">, maxPages = 10): Promise<HistoryResult> {
  const rows: Activity[] = [];
  let before: number | undefined;
  for (let pages = 1; ; pages++) {
    const r = await api.activity(slug, before === undefined ? { expenseId: e.id, limit: HISTORY_PAGE } : { expenseId: e.id, limit: HISTORY_PAGE, before });
    if (!r.ok) {
      console.info("[tg-wallet] history ok=%s pages=%d", r.why, pages);
      return r;
    }
    rows.push(...r.rows);
    const complete = r.rows.length < HISTORY_PAGE;
    if (complete || pages >= maxPages) {
      const kept = rows.filter(isHistory).sort((a, b) => b.id - a.id);
      console.info("[tg-wallet] history ok=yes pages=%d rows=%d complete=%s", pages, kept.length, complete ? "yes" : "no");
      return { ok: true, rows: kept, complete };
    }
    before = Math.min(...r.rows.map((x) => x.id));
  }
}

/**
 * A failed Delete expense, said inside the details: the parent's alert sits behind the modal (ux review M1). A 409 brings
 * the newer wallet, which the parent shows, so the dialog re-renders with their version.
 */
export function deleteFailure(r: Pick<WalletFailed, "why" | "detail">): string {
  if (r.detail === "expense_gone") return "This expense was already deleted.";
  if (r.detail === "expense_changed") return "Someone changed this expense while you were looking. Check it, then delete again if you still want to.";
  return failureMessage(r);
}

// ---------------------------------------------------------------- comments (B24a)

export type CommentsState = { rev: number; comments: Comment[] };

/** The list on screen is replaced only by an answer with a rev at least its own, so a deleted comment never comes back. */
export function mergeComments(prev: CommentsState | null, next: CommentsState): CommentsState {
  return prev && next.rev < prev.rev ? prev : next;
}

/** A comment write's answer as a list state: its rev is the wallet's. */
export function commentsFromWrite(r: { wallet: Wallet; comments: Comment[] }): CommentsState {
  return { rev: r.wallet.rev ?? 0, comments: r.comments };
}

/** Characters as the server counts them (code points, not UTF-16 units). */
const chars = (s: string) => [...s].length;

/** "12 left", shown only from 250 characters (ux §5). */
export function commentsLeft(text: string): string {
  const n = chars(text);
  return n >= COUNT_FROM ? `${Math.max(0, COMMENT_MAX - n)} left` : "";
}

export const commentTooLong = (text: string) => chars(text) > COMMENT_MAX;

// ---------------------------------------------------------------- the activity list (ux §8, B24)

export type Seg = string | { note: string; expenseId: string };
export type ActivityLine = { who: string; segs: Seg[] };

/** The plain text of a line, for tests and screen readers' sake: who, then the sentence. */
export function lineText(l: ActivityLine): string {
  return `${l.who} ${l.segs.map((s) => (typeof s === "string" ? s : s.note)).join("")}`;
}

type Payment = { from_member: string; to_member: string; amount_centavos: number };
const asPayment = (v: unknown) => (v && typeof v === "object" && "from_member" in v ? (v as Payment) : null);

/**
 * One activity line (ux §8). `known` is every row on screen, so a comment on a deleted expense can still name it from
 * its delete row. A live expense's note is a link to its details; a deleted one's is plain text. ", with proof" comes
 * from the settlement as it is now (B24b), never from the row.
 */
export function activityLine(r: Activity, w: Wallet, known: Activity[]): ActivityLine {
  const name = names(w);
  const who = r.action === "member_join" ? name(r.member_id ?? r.actor) : name(r.actor);
  const live = r.expense_id ? w.expenses.find((e) => e.id === r.expense_id) : undefined;
  const snapNote = (rows: Activity[]) => {
    for (const x of rows) {
      const s = x.expense_id === r.expense_id ? (asSnapshot(x.after) ?? asSnapshot(x.before)) : null;
      if (s) return s.note;
    }
    return null;
  };
  const note = (fallback = "an expense that was deleted"): Seg => {
    if (live && r.expense_id) return { note: live.note, expenseId: r.expense_id };
    return snapNote([r, ...known]) ?? fallback;
  };
  const pay = asPayment(r.after);
  const payment = pay ? `${name(pay.from_member)} paid ${name(pay.to_member)} ${formatPeso(pay.amount_centavos)}` : "a payment";
  const after = asSnapshot(r.after);
  const before = asSnapshot(r.before);

  switch (r.action) {
    case "expense_add":
      return { who, segs: ["added ", note(), `, ${formatPeso(after?.amount_centavos ?? live?.amount_centavos ?? 0)}.`] };
    case "expense_edit": {
      const list = before && after ? changes(before, after, w) : [];
      const first = list[0];
      const what = first ? `: ${FIELD_SHORT[first.field]}${first.before !== undefined ? ` ${first.before} → ${first.after}` : ""}${more(list.length - 1)}` : "";
      return { who, segs: ["changed ", note(), `${what}.`] };
    }
    case "expense_delete":
      return { who, segs: ["deleted ", before?.note ?? "an expense", `, ${formatPeso(before?.amount_centavos ?? 0)}.`] };
    case "comment_add":
      return { who, segs: ["commented on ", note(), "."] };
    case "comment_delete":
      return { who, segs: ["deleted a comment on ", note(), "."] };
    case "settle": {
      const proof = w.settlements.some((s) => s.id === r.settlement_id && s.has_proof);
      return { who, segs: [`marked a payment: ${payment}${proof ? ", with proof" : ""}.`] };
    }
    case "settle_undo":
      return { who, segs: [`undid a payment: ${payment}.`] };
    case "proof_add":
      return { who, segs: [`added proof for ${payment}.`] };
    case "proof_change":
      return { who, segs: [`changed the proof for ${payment}.`] };
    case "proof_remove":
      return { who, segs: [`removed the proof for ${payment}.`] };
    case "member_join":
      return { who, segs: ["joined the wallet."] };
    default:
      return { who, segs: ["changed the wallet."] }; // an action from a newer API
  }
}

export type DayGroup = { key: string; label: string; rows: Activity[] };

/** Rows grouped by Manila day, keeping their order (newest first). */
export function groupByDay(rows: Activity[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const r of rows) {
    const d = new Date(r.at);
    const key = DAY_KEY.format(d);
    if (groups.at(-1)?.key !== key) groups.push({ key, label: DAY.format(d), rows: [] });
    groups.at(-1)!.rows.push(r);
  }
  return groups;
}

export type ActivityState = { rev: number; rows: Activity[]; more: boolean };

/**
 * A page into the list: rows by id, newest first, no duplicates. A first-page answer with a lower rev than the list is
 * older than it and changes nothing (the same object back). `older`: a Show older page, whose length says if there's more.
 * A full first page with nothing at or below the newest row on screen replaces the list, so Show older fills the gap.
 */
export function mergeActivity(prev: ActivityState | null, page: { rev: number; rows: Activity[] }, older: boolean): ActivityState {
  if (prev && !older && page.rev < prev.rev) return prev;
  // A full refresh that doesn't reach the newest row on screen leaves rows between them that nothing would fetch
  // (tg-review2 S1). Ids aren't per wallet, so a gap can't be ruled out: start again from this page
  const newest = prev?.rows[0]?.id;
  if (prev && !older && newest !== undefined && page.rows.length >= ACTIVITY_PAGE && page.rows.every((r) => r.id > newest)) {
    return { rev: Math.max(prev.rev, page.rev), rows: [...page.rows].sort((a, b) => b.id - a.id), more: true };
  }
  const byId = new Map((prev?.rows ?? []).map((r) => [r.id, r]));
  for (const r of page.rows) byId.set(r.id, r);
  const rows = [...byId.values()].sort((a, b) => b.id - a.id);
  const more = older || !prev ? page.rows.length >= ACTIVITY_PAGE : prev.more;
  return { rev: Math.max(prev?.rev ?? 0, page.rev), rows, more };
}

/** The `before` for Show older: the oldest id on screen. */
export function oldestId(s: ActivityState): number | undefined {
  return s.rows.length ? s.rows[s.rows.length - 1].id : undefined;
}
