"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PX, cx } from "@/components/pixel";
import TabIcon from "@/components/TabIcon";
import { flags } from "@/lib/flags";
import { formMode } from "@/lib/planForm";
import { currentTab, visibleTabs } from "@/lib/tabs";

/** The phones' tab bar (TG-49): fixed to the bottom, over the safe area. The body leaves room for it (layout.tsx), and
 * from md the same tabs sit in the header instead. */
export default function TabBar() {
  const current = currentTab(usePathname());
  const tabs = visibleTabs(formMode(flags) !== "none");
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 border-t-3 border-frame bg-card pb-[env(safe-area-inset-bottom)] md:hidden">
      <ul className={cx("mx-auto grid max-w-md", tabs.length === 4 ? "grid-cols-4" : "grid-cols-3")}>
        {tabs.map((tab) => (
          <li key={tab.href} className="grid">
            <Link href={tab.href} aria-current={current === tab.href ? "page" : undefined} className={cx(PX.tab, "min-h-16 flex-col gap-0.5 border-t-4 pt-1 text-sm")}>
              <TabIcon tab={tab.href} scale={2} />
              {tab.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
