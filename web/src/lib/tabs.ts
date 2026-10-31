// TG-49 site tabs: the header's tabs from md and the bottom tab bar on phones. The title screen at / is no tab's page.

export type TabHref = "/buses" | "/plan" | "/baguio" | "/wallet";
export type Tab = { href: TabHref; label: string };

const ALL_TABS: readonly Tab[] = [
  { href: "/buses", label: "Buses" },
  { href: "/plan", label: "Plan" },
  { href: "/baguio", label: "Baguio" },
  { href: "/wallet", label: "Wallet" },
];

/** The tabs to show: Plan only while a planner mode is on, like the title screen's menu */
export function visibleTabs(planOn: boolean): readonly Tab[] {
  return planOn ? ALL_TABS : ALL_TABS.filter((tab) => tab.href !== "/plan");
}

/** The tab a path belongs to: a saved plan (/i/…) is Plan; tickets and shared wallets (/w/…) are Wallet. */
export function currentTab(pathname: string): TabHref | null {
  const first = "/" + (pathname.split("/")[1] ?? "");
  if (first === "/buses") return "/buses";
  if (first === "/plan" || first === "/i") return "/plan";
  if (first === "/baguio") return "/baguio";
  if (first === "/wallet" || first === "/tickets" || first === "/w") return "/wallet";
  return null;
}
