// TG-50 shared trip wallet: the API client, money helpers and what this phone remembers. The API (api/app/wallets.py)
// owns the ledger and recomputes balances on every write; these helpers only parse input and preview a split.
// Money is whole centavos everywhere. Logs carry counts and outcomes, never a name, a note or the slug.
import { API_URL } from "./api.ts";

export const WALLET_SLUG = /^[0-9a-f]{32}$/; // the API's SLUG, 128 random bits in hex
export const MAX_CENTAVOS = 10_000_000; // PHP 100,000, the API's cap per expense
export const MAX_MEMBERS = 20;

export type Member = { id: string; name: string };
export type Share = { member_id: string; share_centavos: number };
// TG-66: how an expense's shares were worked out. A wallet saved before TG-66 (the API's or the worker's copy) has none
// of these, so every new field is optional: a missing mode is a legacy expense, a missing category is "No category yet" (ux.md).
export type SplitMode = "equal" | "exact" | "percent" | "shares" | "adjust" | "itemized";
export type Category = "transport" | "hotel" | "food" | "activities" | "other";
/** One row per person: 1 (equal, the rows are among), centavos (exact), basis points (percent), weight (shares), extra centavos (adjust). */
export type InputRow = { member_id: string; value: number };
export type Item = { seq: number; name: string; price_centavos: number; who: string[] };
export type Charge = { kind: "service" | "vat"; basis: "percent" | "amount"; value: number };
export type Payer = { member_id: string; paid_centavos: number };
export type Expense = {
  id: string;
  paid_by: string;
  amount_centavos: number;
  note: string;
  created_at: string;
  shares: Share[];
  category?: Category | null;
  mode?: SplitMode | null;
  inputs?: InputRow[];
  items?: Item[];
  charges?: Charge[];
  payers?: Payer[]; // only with several payers; one payer is paid_by
  version?: number;
  updated_at?: string | null;
  comment_count?: number;
  budget_key?: string | null; // TG-62: a budget line's key, "_none" (Not in the budget) or null/missing (Not sorted yet)
};
export type Settlement = { id: string; from_member: string; to_member: string; amount_centavos: number; created_at: string; has_proof?: boolean; proof_at?: string | null };
export type Balance = { member_id: string; paid_centavos: number; share_centavos: number; net_centavos: number };
export type Transfer = { from_member: string; to_member: string; amount_centavos: number };
export type Wallet = {
  share_slug: string;
  name: string;
  created_at: string;
  members: Member[];
  expenses: Expense[];
  settlements: Settlement[];
  balances: Balance[];
  transfers: Transfer[];
  total_centavos: number;
  rev?: number; // TG-66: the wallet's write counter; missing on a wallet saved before it, so afterGet's rev rule needs it on both sides
  budget?: WalletBudget | null; // TG-62: the lines of the wallet's one trip; null or missing hides the line row
};
/** TG-62: the trip plan's budget lines, for the "Which budget line?" row. Lines only, never estimates or amounts. */
export type BudgetLine = { key: string; item: string; category: Category | null }; // null category: listed under other
export type WalletBudget = { trip_name: string; lines: BudgetLine[] }; // plan order

/** TG-66: the add and edit bodies. The web with WALLET_SPLITS off sends LegacyExpenseBody, byte for byte as before. */
export type LegacyExpenseBody = { paid_by: string; amount_centavos: number; note: string } & ({ split_among: string[] } | { shares: Share[] });
// TG-62: budget_key is a line's key, "_none" or null. On an edit, leaving it out keeps the stored line (the API's G9a).
type V2Base = { note: string; category?: Category | null; by?: string | null; budget_key?: string | null } & ({ paid_by: string } | { payers: Payer[] });
export type ExpenseBodyV2 = V2Base &
  (
    | { mode: Exclude<SplitMode, "itemized">; amount_centavos: number; inputs: InputRow[] }
    | { mode: "itemized"; amount_centavos?: number; items: Omit<Item, "seq">[]; charges: Charge[] }
  );
export type ExpensePatch = ExpenseBodyV2 & { version: number };
export type Comment = { id: string; expense_id: string; author: string | null; body: string; created_at: string };
export type ActivityAction =
  | "expense_add" | "expense_edit" | "expense_delete" | "comment_add" | "comment_delete" | "settle" | "settle_undo"
  | "proof_add" | "proof_change" | "proof_remove" | "member_join";
export type Activity = {
  id: number;
  at: string;
  actor: string | null; // null: "Someone"
  action: ActivityAction;
  expense_id: string | null;
  settlement_id: string | null;
  member_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

// ---------------------------------------------------------------- money

/** "1,151.50", "₱450" or "20" → centavos; null if it isn't a peso amount from ₱0.01 to ₱100,000. `allowZero` for a custom share. */
export function parsePeso(raw: string, { allowZero = false } = {}): number | null {
  const s = raw.replace(/[₱,\s]/g, "").replace(/^php/i, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const centavos = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (centavos > MAX_CENTAVOS || (centavos === 0 && !allowZero)) return null;
  return centavos;
}

/** ₱1,151.50, or ₱450 when there are no centavos. Negative amounts get a minus sign. */
export function formatPeso(centavos: number): string {
  const abs = Math.abs(centavos);
  const cents = abs % 100;
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  return `${centavos < 0 ? "−" : ""}₱${whole}${cents ? `.${String(cents).padStart(2, "0")}` : ""}`;
}

/** The API's equal split, for the preview: leftover centavos go one each to the payer first, then in list order. */
export function splitEqual(amount: number, memberIds: string[], payer: string): Record<string, number> {
  if (memberIds.length === 0) return {};
  const base = Math.floor(amount / memberIds.length);
  const extra = amount % memberIds.length;
  const order = [...(memberIds.includes(payer) ? [payer] : []), ...memberIds.filter((m) => m !== payer)];
  return Object.fromEntries(order.map((m, i) => [m, base + (i < extra ? 1 : 0)]));
}

/** What a custom split still has to place: above zero is left to assign, below zero is too much. */
export function leftToAssign(amount: number, parts: number[]): number {
  return amount - parts.reduce((a, b) => a + b, 0);
}

/** "Ana gets back ₱300", "Ben owes ₱300" or "All square", from a balance's net. */
export function netLine(net: number): string {
  if (net > 0) return `gets back ${formatPeso(net)}`;
  if (net < 0) return `owes ${formatPeso(-net)}`;
  return "all square";
}

const WHEN = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" });

/** "Nov 6, 1:30 PM", Manila time. */
export function whenLine(iso: string): string {
  return WHEN.format(new Date(iso));
}

// ---------------------------------------------------------------- API

export type WalletFailure = "offline" | "not_found" | "rate_limited" | "server" | "rejected";
/** `saved`: the service worker answered with its copy, not the API, so it may be older than what's on screen. */
/**
 * A refusal's `detail` is its code. TG-66: 409 expense_changed and 404 expense_gone also bring the wallet as it is now,
 * and 422 item_no_one the item's seq (never its name).
 */
export type WalletFailed = {
  ok: false;
  why: WalletFailure;
  detail?: string;
  wallet?: Wallet;
  seq?: number;
  timedOut?: true; // TG-70: an add with timeoutMs that got no answer in time (why is "offline"); it may have landed
  retryAfter?: number; // TG-70: a 429's Retry-After in seconds, when the header is there and readable (needs O1's CORS)
};
export type WalletResult = { ok: true; wallet: Wallet; saved?: boolean } | WalletFailed;
export type CommentsResult = { ok: true; rev: number; comments: Comment[] } | WalletFailed;
export type CommentWriteResult = { ok: true; wallet: Wallet; comments: Comment[] } | WalletFailed;
export type ActivityResult = { ok: true; rev: number; rows: Activity[] } | WalletFailed;
export type WalletLoad = { state: "loading" } | { state: "ready"; wallet: Wallet } | { state: "error"; why: WalletFailure };

/**
 * TG-65: what a GET's answer does to the wallet screen. `overtaken`: a write landed after this GET left, so the answer
 * predates it and would bring a deleted expense back or drop a new one; the screen stays and the next reload brings
 * anything newer. A saved copy never replaces a wallet on screen (TG-53). `dialogOpen`: a failed reload mustn't take an
 * open dialog and its picture with the page.
 */
export function afterGet(prev: WalletLoad, r: WalletResult, slug: string, overtaken: boolean, dialogOpen: boolean): WalletLoad {
  const showing = prev.state === "ready" && prev.wallet.share_slug === slug;
  if (showing && (overtaken || (r.ok && r.saved))) return prev;
  // TG-66: an answer with a lower rev is older than the screen, across tabs and phones, whatever the clocks say. Only when
  // both carry a rev: a live answer with none comes from an API reverted to before TG-66, and must still show
  const revs = r.ok && showing ? [r.wallet.rev, prev.wallet.rev] : [];
  if (typeof revs[0] === "number" && typeof revs[1] === "number" && revs[0] < revs[1]) return prev;
  if (r.ok) return { state: "ready", wallet: r.wallet };
  return prev.state === "ready" && (r.why === "offline" || dialogOpen) ? prev : { state: "error", why: r.why }; // offline with a copy on screen: the offline banner says so
}

/**
 * TG-66 B27: what a write's wallet does to the screen. An answer with a lower rev than the wallet on screen is older
 * (another tab's slower write, or a raced fresh GET), so the screen stays. Only when both carry a rev, as afterGet.
 */
export function afterWrite(prev: WalletLoad, wallet: Wallet): WalletLoad {
  const showing = prev.state === "ready" && prev.wallet.share_slug === wallet.share_slug;
  const [mine, shown] = [wallet.rev, showing ? prev.wallet.rev : undefined];
  if (typeof mine === "number" && typeof shown === "number" && mine < shown) return prev;
  return { state: "ready", wallet };
}

export const DETAIL: Record<string, string> = {
  shares_mismatch: "The amounts don't add up to the total.",
  unknown_member: "That person isn't in this wallet any more. Reload and try again.",
  name_taken: "Someone in this wallet already has that name.",
  party_full: "A wallet holds up to 20 people.",
  wallet_full: "This wallet is full: it holds up to 500 expenses.",
  too_many_proofs: "This wallet is full: it holds up to 50 screenshots.",
};

/** One plain sentence for a failed call. */
export function failureMessage(r: { why: WalletFailure; detail?: string }): string {
  switch (r.why) {
    case "offline":
      return "No signal, so this wasn't saved. Try again when you're back online.";
    case "not_found":
      return "This wallet link doesn't work. Check it with whoever shared it.";
    case "rate_limited":
      return "Too many changes at once. Wait a minute, then try again.";
    case "server":
      return "The server had a problem. Try again in a minute.";
    default:
      return (r.detail && DETAIL[r.detail]) || "That didn't save. Check the details and try again.";
  }
}

/** A refusal's `detail`: today's string code, or TG-66's {code, wallet?, seq?}. Pydantic's own 422 list has no code. */
function refusal(why: WalletFailure, body: unknown): WalletFailed {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string") return { ok: false, why, detail };
  const d = detail as { code?: unknown; wallet?: unknown; seq?: unknown } | null | undefined;
  if (!d || Array.isArray(d) || typeof d.code !== "string") return { ok: false, why, detail: undefined };
  return {
    ok: false,
    why,
    detail: d.code,
    ...(d.wallet && typeof d.wallet === "object" ? { wallet: d.wallet as Wallet } : {}),
    ...(typeof d.seq === "number" ? { seq: d.seq } : {}),
  };
}

type Init = { method: "POST" | "PATCH" | "DELETE"; body?: unknown; raw?: Blob; timeoutMs?: number };

/** A 429's Retry-After in whole seconds: a number, or an HTTP date from now. Undefined when missing or unreadable. */
function retryAfterS(res: Response): number | undefined {
  const raw = res.headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw);
  const when = Date.parse(raw);
  return Number.isNaN(when) ? undefined : Math.max(0, Math.ceil((when - Date.now()) / 1000));
}

/**
 * One request; `read` turns a good answer into its result. Every failure is a WalletFailed, as call() has always given.
 * TG-70 `timeoutMs`: AbortController + setTimeout, never AbortSignal's static timeout helper (iOS before 16 lacks it,
 * and a throw here would read as offline forever). The timer stays armed through the answer's body (review S1): a 2xx
 * whose JSON stalls or drops has landed, so it comes back as offline with timedOut (may have landed, B11b), never a
 * hang or a throw. Without it the fetch gets no signal and a broken body throws, as before.
 */
async function request<T>(path: string, init: Init | undefined, read: (body: unknown, res: Response) => T): Promise<T | WalletFailed> {
  const ctrl = init?.timeoutMs ? new AbortController() : null;
  let timedOut = false;
  const timer = ctrl
    ? setTimeout(() => {
        timedOut = true;
        ctrl.abort();
      }, init?.timeoutMs)
    : undefined;
  // Ends a stalled body read when the timer fires; handled here, so an abort during the fetch leaves no stray rejection
  const aborted = ctrl ? new Promise<never>((_, reject) => ctrl.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true })) : null;
  aborted?.catch(() => {});
  try {
    let res: Response;
    try {
      res = await fetch(`${API_URL}${path}`, {
        cache: "no-store",
        method: init?.method ?? "GET",
        headers: init?.raw ? { "content-type": init.raw.type } : init?.body !== undefined ? { "content-type": "application/json" } : undefined,
        body: init?.raw ?? (init?.body !== undefined ? JSON.stringify(init.body) : undefined),
        ...(ctrl ? { signal: ctrl.signal } : {}),
      });
    } catch {
      if (timedOut) console.info(`[tg-wallet] request timed out ms=${init?.timeoutMs}`);
      return timedOut ? { ok: false, why: "offline", timedOut: true } : { ok: false, why: "offline" };
    }
    const json = () => (aborted ? Promise.race([res.json(), aborted]) : res.json()); // every body read, under the timer
    if (res.ok && aborted) {
      let body: unknown;
      try {
        body = await json();
      } catch {
        console.info(`[tg-wallet] answer body lost status=${res.status} timed_out=${timedOut}`);
        return { ok: false, why: "offline", timedOut: true }; // the write landed; the outbox resends it as a replay
      }
      return read(body, res);
    }
    if (res.ok) return read(await res.json(), res);
    if (res.status === 404) return refusal("not_found", await json().catch(() => null));
    if (res.status === 429) {
      const after = retryAfterS(res);
      return after === undefined ? { ok: false, why: "rate_limited" } : { ok: false, why: "rate_limited", retryAfter: after };
    }
    if (res.status >= 500) return { ok: false, why: "server" };
    return refusal("rejected", await json().catch(() => null));
  } finally {
    clearTimeout(timer);
  }
}

function call(path: string, init?: Init): Promise<WalletResult> {
  return request<WalletResult>(path, init, (body, res) => {
    const wallet = body as Wallet;
    return res.headers.has("x-tg-saved-at") ? { ok: true, wallet, saved: true } : { ok: true, wallet };
  });
}

const at = (slug: string) => `/wallets/${encodeURIComponent(slug)}`;
/** TG-66: who's writing, as ?by= (A2, A3: these routes' bodies forbid extra keys, and a DELETE has none). None: today's URL. */
const byQuery = (by: string | null | undefined, sep = "?") => (by ? `${sep}by=${encodeURIComponent(by)}` : "");

export const walletApi = {
  create: (name: string, members: string[]) => call("/wallets", { method: "POST", body: { name, members } }),
  get: (slug: string) => call(at(slug)),
  addMember: (slug: string, name: string, by?: string | null) => call(`${at(slug)}/members${byQuery(by)}`, { method: "POST", body: { name } }),
  /** TG-70 `timeoutMs`: the outbox's add (15 s); no answer in time is offline with timedOut. None: today's call. */
  addExpense: (slug: string, body: LegacyExpenseBody | ExpenseBodyV2, opts?: { timeoutMs?: number }) =>
    call(`${at(slug)}/expenses`, { method: "POST", body, ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) }),
  /** TG-66: `version` is the one the screen showed; a stale one is 409 expense_changed with the wallet as it is now. */
  deleteExpense: (slug: string, id: string, version?: number, by?: string | null) =>
    call(`${at(slug)}/expenses/${encodeURIComponent(id)}${version === undefined ? byQuery(by) : `?version=${version}${byQuery(by, "&")}`}`, { method: "DELETE" }),
  editExpense: (slug: string, id: string, body: ExpensePatch) => call(`${at(slug)}/expenses/${encodeURIComponent(id)}`, { method: "PATCH", body }),
  comments: (slug: string, id: string) =>
    request<CommentsResult>(`${at(slug)}/expenses/${encodeURIComponent(id)}/comments`, undefined, (b) => ({ ok: true, ...(b as { rev: number; comments: Comment[] }) })),
  addComment: (slug: string, id: string, body: { body: string; by?: string | null }) =>
    request<CommentWriteResult>(`${at(slug)}/expenses/${encodeURIComponent(id)}/comments`, { method: "POST", body }, (b) => ({ ok: true, ...(b as { wallet: Wallet; comments: Comment[] }) })),
  /** `by`: this phone's person, as ?by= (a DELETE has no body), so the activity line names them; none is "Someone". */
  deleteComment: (slug: string, id: string, commentId: string, by?: string | null) =>
    request<CommentWriteResult>(`${at(slug)}/expenses/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}${by ? `?by=${encodeURIComponent(by)}` : ""}`, { method: "DELETE" }, (b) => ({
      ok: true,
      ...(b as { wallet: Wallet; comments: Comment[] }),
    })),
  /**
   * Newest first, 15 a page; `before` is the oldest row's id on screen. Never cached by the worker (needs signal).
   * TG-66 W2: `expenseId` asks for one expense's rows only (plan §2 addendum), with `limit` up to 50. A bare number is
   * `before`, as first written.
   */
  activity: (slug: string, opts?: number | { before?: number; expenseId?: string; limit?: number }) => {
    const o = typeof opts === "number" ? { before: opts } : (opts ?? {});
    const q = [
      ...(o.before === undefined ? [] : [`before=${o.before}`]),
      ...(o.expenseId === undefined ? [] : [`expense_id=${encodeURIComponent(o.expenseId)}`]),
      `limit=${o.limit ?? 15}`,
    ].join("&");
    return request<ActivityResult>(`${at(slug)}/activity?${q}`, undefined, (b) => ({ ok: true, ...(b as { rev: number; rows: Activity[] }) }));
  },
  settle: (slug: string, t: Transfer, by?: string | null) => call(`${at(slug)}/settlements${byQuery(by)}`, { method: "POST", body: t }),
  undoSettlement: (slug: string, id: string, by?: string | null) => call(`${at(slug)}/settlements/${encodeURIComponent(id)}${byQuery(by)}`, { method: "DELETE" }),
  addProof: (slug: string, id: string, picture: Blob, by?: string | null) =>
    call(`${at(slug)}/settlements/${encodeURIComponent(id)}/proof${byQuery(by)}`, { method: "POST", raw: picture }),
  removeProof: (slug: string, id: string, by?: string | null) => call(`${at(slug)}/settlements/${encodeURIComponent(id)}/proof${byQuery(by)}`, { method: "DELETE" }),
};

/** A payment's proof. Rows never call this on load: files come at full size, and no copy stays on the phone. */
export async function fetchProof(slug: string, id: string): Promise<Blob | null> {
  try {
    const res = await fetch(`${API_URL}${at(slug)}/settlements/${encodeURIComponent(id)}/proof`, { cache: "no-store" });
    return res.ok ? await res.blob() : null;
  } catch {
    return null;
  }
}

const samePayment = (a: Transfer, b: Transfer) => a.from_member === b.from_member && a.to_member === b.to_member && a.amount_centavos === b.amount_centavos;

/** Is this exact transfer still open? A transfer has no id, and any write can change who pays whom. */
export function sameTransfer(w: Wallet, t: Transfer): boolean {
  return w.transfers.some((x) => samePayment(x, t));
}

/** The newest payment matching this transfer: the API lists newest first. */
export function newestSettlement(w: Wallet, t: Transfer): string | null {
  return w.settlements.find((s) => samePayment(s, t))?.id ?? null;
}

/** "deleted" is only ever the sweep: removing a proof clears proof_at too. */
export function proofState(s: Settlement): "none" | "kept" | "deleted" {
  if (s.has_proof) return "kept";
  return s.proof_at ? "deleted" : "none";
}

/** Who gets which button (TG-53 ux 4.6). A courtesy, not a lock: anyone with the link can use the API. */
export function proofControls(s: Settlement, me: string | null): { show: boolean; add: boolean; change: boolean } {
  const mine = s.from_member === me || s.to_member === me;
  const kept = proofState(s) === "kept";
  return { show: kept, add: mine && !kept, change: mine && kept };
}

type Failure = { why: WalletFailure; detail?: string };

/** upload_failed's wallet is null on a retry: that call made no new wallet, so keep the one you have. */
export type MarkPaid =
  | { stage: "done"; wallet: Wallet }
  | { stage: "not_saved"; failure: Failure }
  | { stage: "upload_failed"; wallet: Wallet | null; settlementId: string; failure: Failure };

/** Marks a transfer paid, then uploads its picture. With settlementId it only uploads, so a retry can't pay twice. */
export async function markPaid(
  api: Pick<typeof walletApi, "settle" | "addProof">,
  slug: string,
  t: Transfer,
  picture: Blob | null,
  settlementId?: string,
  by?: string | null, // TG-66: who's writing, on both calls
): Promise<MarkPaid> {
  let id = settlementId ?? null;
  let wallet: Wallet | null = null;
  if (!id) {
    const r = await api.settle(slug, t, by);
    if (!r.ok) return { stage: "not_saved", failure: r };
    if (!picture) return { stage: "done", wallet: r.wallet };
    wallet = r.wallet;
    id = newestSettlement(r.wallet, t) as string; // settle's own response holds the row it just made
  }
  const up = await api.addProof(slug, id, picture as Blob, by);
  return up.ok ? { stage: "done", wallet: up.wallet } : { stage: "upload_failed", wallet, settlementId: id, failure: up };
}

// ---------------------------------------------------------------- what this phone remembers

/** A wallet this phone has opened, and which person in it this phone is. */
export type KnownWallet = { slug: string; name: string; me: string | null };
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
const KEY = "tg-wallets";

/** The raw stored list, for useSyncExternalStore: a string compares stable between renders, a parsed list doesn't. */
export function knownWalletsRaw(): string | null {
  try {
    return storage()?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
}

/** knownWallets() over a raw string from knownWalletsRaw(). */
export function parseKnownWallets(raw: string | null): KnownWallet[] {
  return knownWallets({ getItem: () => raw, setItem: () => {} });
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // some private modes throw on access
  }
}

export function knownWallets(store: Storage | null = storage()): KnownWallet[] {
  try {
    const raw = JSON.parse(store?.getItem(KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (w): w is KnownWallet =>
        !!w && typeof w.slug === "string" && WALLET_SLUG.test(w.slug) && typeof w.name === "string" && (w.me === null || typeof w.me === "string"),
    );
  } catch {
    return [];
  }
}

/** Adds or updates one wallet, most recent first. Keeps `me` unless a new one is given. */
export function rememberWallet(entry: { slug: string; name: string; me?: string | null }, store: Storage | null = storage()): KnownWallet[] {
  const list = knownWallets(store);
  const old = list.find((w) => w.slug === entry.slug);
  const next = [{ slug: entry.slug, name: entry.name, me: entry.me !== undefined ? entry.me : (old?.me ?? null) }, ...list.filter((w) => w.slug !== entry.slug)].slice(0, 20);
  try {
    store?.setItem(KEY, JSON.stringify(next));
  } catch {
    // full or blocked: the wallet still works, this phone just won't list it or remember who you are
  }
  return next;
}

export function whoAmI(slug: string, store: Storage | null = storage()): string | null {
  return knownWallets(store).find((w) => w.slug === slug)?.me ?? null;
}
