"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PX, cx } from "@/components/pixel";
import Say from "@/components/Say";
import TabIcon from "@/components/TabIcon";
import { useWords } from "@/components/useLang";
import { flags } from "@/lib/flags";
import { formMode } from "@/lib/planForm";
import { currentTab, visibleTabs } from "@/lib/tabs";

// Literal classes, so Tailwind finds them. Five tabs at 320 are 64px each (TG-72: Ambagan is the fifth), so their
// labels drop to text-xs with no side padding; the descendant rule outranks the tab's own size and padding.
const GRID_COLS: Record<number, string> = { 3: "grid-cols-3", 4: "grid-cols-4", 5: "grid-cols-5 [&_a]:px-0 [&_a]:text-xs" };

/** The phones' tab bar (TG-49): fixed to the bottom, over the safe area. The body leaves room for it (layout.tsx), and
 * from md the same tabs sit in the header instead. */
export default function TabBar() {
  const switches = { around: flags.aroundTab, ambagan: flags.ambaganTab }; // TG-71/72
  const current = currentTab(usePathname(), switches);
  const tabs = visibleTabs(formMode(flags) !== "none", switches);
  const words = useWords(); // TG-74: the nav's name; the visible words swap by CSS (Say)
  return (
    <nav aria-label={words.tabs.nav} className="fixed inset-x-0 bottom-0 z-30 border-t-3 border-frame bg-card pb-[env(safe-area-inset-bottom)] md:hidden">
      <ul className={cx("mx-auto grid max-w-md", GRID_COLS[tabs.length] ?? "grid-cols-4")}>
        {tabs.map((tab) => (
          <li key={tab.href} className="grid">
            <Link href={tab.href} aria-current={current === tab.href ? "page" : undefined} className={cx(PX.tab, "min-h-16 flex-col gap-0.5 border-t-4 pt-1 text-sm")}>
              <TabIcon tab={tab.href} scale={2} />
              <Say w={(d) => d.tabs[tab.word]} />
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
