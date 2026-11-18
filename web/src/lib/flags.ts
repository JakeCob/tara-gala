// Feature flags from NEXT_PUBLIC_* env vars. See README section 7.
// Pure TS with no imports so `node --test` can run it with type stripping.

export type Flags = {
  plannerLive: boolean;
  premadeItineraries: boolean;
  realMap: boolean;
  serviceWorker: boolean;
  overworldMap: boolean;
  planEditing: boolean;
  walletSplits: boolean;
  walletMultiPayer: boolean;
  walletActivity: boolean;
  chatbotLive: boolean;
  budgetLines: boolean;
};

export const FLAG_DEFAULTS: Flags = {
  plannerLive: false,
  premadeItineraries: true,
  realMap: false,
  serviceWorker: true,
  overworldMap: true,
  planEditing: false, // TG-61: the hand editor, until the API's PLAN_EDITING is on
  walletSplits: false, // TG-66: the split modes, edit and categories; off sends today's add body, byte for byte
  walletMultiPayer: false, // TG-66: several payers, which ships last
  walletActivity: false, // TG-66: the activity list and comments
  chatbotLive: false, // TG-61 PR 2: the chatbot, inside the hand editor, until the API's CHATBOT_LIVE is on
  budgetLines: false, // TG-62: the wallet's budget line and the trip's Budget panel; off sends no budget_key and makes no budget request
};

const TRUE_WORDS = ["1", "true", "yes", "on"];
const FALSE_WORDS = ["0", "false", "no", "off"];

/** Same rules as api/app/flags.py; unset, empty or unknown values give the fallback (silently). */
export function parseFlag(raw: string | undefined, fallback: boolean): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  if (TRUE_WORDS.includes(value)) return true;
  if (FALSE_WORDS.includes(value)) return false;
  return fallback;
}

/**
 * Each flag must be read as a literal process.env.NEXT_PUBLIC_* access: Next inlines only those
 * at build time. A computed key or an alias of process.env stays undefined in the browser.
 */
export function readFlags(): Flags {
  return {
    plannerLive: parseFlag(process.env.NEXT_PUBLIC_PLANNER_LIVE, FLAG_DEFAULTS.plannerLive),
    premadeItineraries: parseFlag(process.env.NEXT_PUBLIC_PREMADE_ITINERARIES, FLAG_DEFAULTS.premadeItineraries),
    realMap: parseFlag(process.env.NEXT_PUBLIC_REAL_MAP, FLAG_DEFAULTS.realMap),
    serviceWorker: parseFlag(process.env.NEXT_PUBLIC_SERVICE_WORKER, FLAG_DEFAULTS.serviceWorker),
    overworldMap: parseFlag(process.env.NEXT_PUBLIC_OVERWORLD_MAP, FLAG_DEFAULTS.overworldMap),
    planEditing: parseFlag(process.env.NEXT_PUBLIC_PLAN_EDITING, FLAG_DEFAULTS.planEditing),
    walletSplits: parseFlag(process.env.NEXT_PUBLIC_WALLET_SPLITS, FLAG_DEFAULTS.walletSplits),
    walletMultiPayer: parseFlag(process.env.NEXT_PUBLIC_WALLET_MULTI_PAYER, FLAG_DEFAULTS.walletMultiPayer),
    walletActivity: parseFlag(process.env.NEXT_PUBLIC_WALLET_ACTIVITY, FLAG_DEFAULTS.walletActivity),
    chatbotLive: parseFlag(process.env.NEXT_PUBLIC_CHATBOT_LIVE, FLAG_DEFAULTS.chatbotLive),
    budgetLines: parseFlag(process.env.NEXT_PUBLIC_BUDGET_LINES, FLAG_DEFAULTS.budgetLines),
  };
}

/** Values baked in at `next build`. Components import this. */
export const flags: Flags = readFlags();
