// TG-49 site tabs: the header's tabs from md and the bottom tab bar on phones. The title screen at / is no tab's page.
// TG-71/72 (flags aroundTab, ambaganTab): the Baguio tab becomes Around, and the wallet gets its own Ambagan tab, last.
// TG-74: each tab's words are in words/en.ts and words/tl.ts under tabs.<word>; label is the English one.
import { EN, type Words } from "./words/en.ts";

export type TabHref = "/buses" | "/plan" | "/baguio" | "/around" | "/trip" | "/wallet";
export type Tab = { href: TabHref; label: string; word: Exclude<keyof Words["tabs"], "nav"> };
/** The two TG-71/72 switches; both off is today's bar, tab for tab. */
export type TabSwitches = { around?: boolean; ambagan?: boolean };

const BUSES: Tab = { href: "/buses", label: EN.tabs.buses, word: "buses" };
const PLAN: Tab = { href: "/plan", label: EN.tabs.plan, word: "plan" };
const BAGUIO: Tab = { href: "/baguio", label: EN.tabs.baguio, word: "baguio" };
const AROUND: Tab = { href: "/around", label: EN.tabs.around, word: "around" }; // TG-71 ux §7.1: it never names a city
const TRIP: Tab = { href: "/trip", label: EN.tabs.trip, word: "trip" }; // TG-52: was Wallet; the trip holds the wallet and the tickets
const AMBAGAN: Tab = { href: "/wallet", label: EN.tabs.ambagan, word: "ambagan" }; // TG-72: the owner's name for the shared wallets

/** The tabs to show: Plan only while a planner mode is on, like the title screen's menu. Owner order (TG-72):
 * Buses · Plan · Around · Trip · Ambagan. */
export function visibleTabs(planOn: boolean, switches: TabSwitches = {}): readonly Tab[] {
  return [BUSES, ...(planOn ? [PLAN] : []), switches.around ? AROUND : BAGUIO, TRIP, ...(switches.ambagan ? [AMBAGAN] : [])];
}

/** The tab a path belongs to: a saved plan (/i/…) is Plan; trips (/t/…), tickets and shared wallets (/w/…) are Trip.
 * With Around on, /around and the old /baguio are Around; with Ambagan on, /wallet and /w/… are Ambagan. */
export function currentTab(pathname: string, switches: TabSwitches = {}): TabHref | null {
  const first = "/" + (pathname.split("/")[1] ?? "");
  if (first === "/buses") return "/buses";
  if (first === "/plan" || first === "/i") return "/plan";
  if (first === "/baguio") return switches.around ? "/around" : "/baguio";
  if (first === "/around") return switches.around ? "/around" : null;
  if (switches.ambagan && (first === "/wallet" || first === "/w")) return "/wallet";
  if (first === "/trip" || first === "/t" || first === "/wallet" || first === "/tickets" || first === "/w") return "/trip";
  return null;
}
