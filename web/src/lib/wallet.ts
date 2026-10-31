// TG-50 shared trip wallet: the API client, money helpers and what this phone remembers. The API (api/app/wallets.py)
// owns the ledger and recomputes balances on every write; these helpers only parse input and preview a split.
// Money is whole centavos everywhere. Logs carry counts and outcomes, never a name, a note or the slug.
import { API_URL } from "./api.ts";

export const WALLET_SLUG = /^[0-9a-f]{32}$/; // the API's SLUG, 128 random bits in hex
export const MAX_CENTAVOS = 10_000_000; // PHP 100,000, the API's cap per expense
export const MAX_MEMBERS = 20;

export type Member = { id: string; name: string };
export type Share = { member_id: string; share_centavos: number };
export type Expense = { id: string; paid_by: string; amount_centavos: number; note: string; created_at: string; shares: Share[] };
export type Settlement = { id: string; from_member: string; to_member: string; amount_centavos: number; created_at: string };
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
export type WalletResult = { ok: true; wallet: Wallet } | { ok: false; why: WalletFailure; detail?: string };

const DETAIL: Record<string, string> = {
  shares_mismatch: "The amounts don't add up to the total.",
  unknown_member: "That person isn't in this wallet any more. Reload and try again.",
  name_taken: "Someone in this wallet already has that name.",
  party_full: "A wallet holds up to 20 people.",
  wallet_full: "This wallet is full: it holds up to 500 expenses.",
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

async function call(path: string, init?: { method: "POST" | "DELETE"; body?: unknown }): Promise<WalletResult> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      cache: "no-store",
      method: init?.method ?? "GET",
      headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    return { ok: false, why: "offline" };
  }
  if (res.ok) return { ok: true, wallet: (await res.json()) as Wallet };
  if (res.status === 404) return { ok: false, why: "not_found" };
  if (res.status === 429) return { ok: false, why: "rate_limited" };
  if (res.status >= 500) return { ok: false, why: "server" };
  const body = await res.json().catch(() => null);
  return { ok: false, why: "rejected", detail: typeof body?.detail === "string" ? body.detail : undefined };
}

const at = (slug: string) => `/wallets/${encodeURIComponent(slug)}`;

export const walletApi = {
  create: (name: string, members: string[]) => call("/wallets", { method: "POST", body: { name, members } }),
  get: (slug: string) => call(at(slug)),
  addMember: (slug: string, name: string) => call(`${at(slug)}/members`, { method: "POST", body: { name } }),
  addExpense: (
    slug: string,
    body: { paid_by: string; amount_centavos: number; note: string } & ({ split_among: string[] } | { shares: Share[] }),
  ) => call(`${at(slug)}/expenses`, { method: "POST", body }),
  deleteExpense: (slug: string, id: string) => call(`${at(slug)}/expenses/${encodeURIComponent(id)}`, { method: "DELETE" }),
  settle: (slug: string, t: Transfer) => call(`${at(slug)}/settlements`, { method: "POST", body: t }),
  undoSettlement: (slug: string, id: string) => call(`${at(slug)}/settlements/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

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
