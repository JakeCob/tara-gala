"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PX, cx } from "@/components/pixel";
import TabIcon from "@/components/TabIcon";
import ThemeToggle from "@/components/ThemeToggle";
import { flags } from "@/lib/flags";
import { formMode } from "@/lib/planForm";
import { currentTab, visibleTabs } from "@/lib/tabs";

/** Every page's top bar (TG-49): the wordmark home to the title screen, the tabs from md, and the Dark mode switch.
 * Phones get the same tabs in TabBar at the bottom. */
export default function SiteHeader() {
  const current = currentTab(usePathname());
  const tabs = visibleTabs(formMode(flags) !== "none");
  return (
    <header className="border-b-3 border-frame bg-card">
      <div className="mx-auto flex w-full max-w-md items-center gap-4 px-4 py-2 md:max-w-3xl md:px-6 lg:max-w-5xl lg:px-8 xl:max-w-6xl">
        <Link href="/" className={PX.logo}>
          Tara Gala
        </Link>
        <nav aria-label="Main" className="hidden md:block">
          <ul className="flex gap-1">
            {tabs.map((tab) => (
              <li key={tab.href}>
                <Link href={tab.href} aria-current={current === tab.href ? "page" : undefined} className={cx(PX.tab, "min-h-11 gap-2 border-b-4")}>
                  <TabIcon tab={tab.href} scale={1} />
                  {tab.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
