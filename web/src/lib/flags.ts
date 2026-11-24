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
  recapLinks: boolean;
  offlineExpenses: boolean;
  nextUp: boolean;
  aroundTab: boolean;
  ambaganTab: boolean;
  goingTo: boolean;
  kaloy: boolean;
  chatGameUi: boolean;
  chatAllCities: boolean;
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
  recapLinks: false, // TG-64: the trip page's Trip recap box and /r/<slug>, until the API's RECAP_LINKS is on
  offlineExpenses: false, // TG-70: Add expense with no signal waits here and sends itself; needs walletSplits; off sends today's add
  nextUp: false, // TG-69: the trip page's Next up card, the Who's coming fold and Show the driver; web only
  aroundTab: false, // TG-71/72: the Around tab (Baguio and Sagada pages) and site words that aren't only Manila to Baguio; web only
  ambaganTab: false, // TG-72: the Ambagan tab (the wallet hub and shared wallets) and its words; web only
  goingTo: false, // TG-71: the Going to city picker on /buses and on /plan's ready-made trips; web only
  chatAllCities: false, // the chatbot on a Sagada (or any served city's) plan, not only Baguio; needs chatbotLive and the API's CHAT_ALL_CITIES
  kaloy: false, // TG-75: Kaloy, the chatbot carabao: the chat's name, greeting and poses, the title screen walk and the sad and empty boxes; web only
  chatGameUi: false, // TG-75: the game-style Ask Kaloy chat (speech bubbles, a one-row text entry); needs kaloy; web only
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
    recapLinks: parseFlag(process.env.NEXT_PUBLIC_RECAP_LINKS, FLAG_DEFAULTS.recapLinks),
    offlineExpenses: parseFlag(process.env.NEXT_PUBLIC_OFFLINE_EXPENSES, FLAG_DEFAULTS.offlineExpenses),
    nextUp: parseFlag(process.env.NEXT_PUBLIC_NEXT_UP, FLAG_DEFAULTS.nextUp),
    aroundTab: parseFlag(process.env.NEXT_PUBLIC_AROUND_TAB, FLAG_DEFAULTS.aroundTab),
    ambaganTab: parseFlag(process.env.NEXT_PUBLIC_AMBAGAN_TAB, FLAG_DEFAULTS.ambaganTab),
    goingTo: parseFlag(process.env.NEXT_PUBLIC_GOING_TO, FLAG_DEFAULTS.goingTo),
    kaloy: parseFlag(process.env.NEXT_PUBLIC_KALOY, FLAG_DEFAULTS.kaloy),
    chatGameUi: parseFlag(process.env.NEXT_PUBLIC_CHAT_GAME_UI, FLAG_DEFAULTS.chatGameUi),
    chatAllCities: parseFlag(process.env.NEXT_PUBLIC_CHAT_ALL_CITIES, FLAG_DEFAULTS.chatAllCities),
  };
}

/** Values baked in at `next build`. Components import this. */
export const flags: Flags = readFlags();
