"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PX, Placard, cx } from "@/components/pixel";
import LangPicker from "@/components/LangPicker";
import Say from "@/components/Say";
import TabIcon from "@/components/TabIcon";
import ThemeToggle from "@/components/ThemeToggle";
import { useWords } from "@/components/useLang";
import { flags } from "@/lib/flags";
import { formMode } from "@/lib/planForm";
import { currentTab, visibleTabs } from "@/lib/tabs";

/** Every page's top bar (TG-49): the signboard logo home to the title screen, the tabs from md, the 🌐 language picker
 * (TG-74, flag langPicker) and the Dark mode switch.
 * Phones get the same tabs in TabBar at the bottom. */
export default function SiteHeader() {
  const switches = { around: flags.aroundTab, ambagan: flags.ambaganTab }; // TG-71/72
  const current = currentTab(usePathname(), switches);
  const tabs = visibleTabs(formMode(flags) !== "none", switches);
  const words = useWords(); // TG-74: the nav's name; the visible words swap by CSS (Say)
  return (
    <header className="border-b-3 border-frame bg-card">
      <div className="mx-auto flex w-full max-w-md items-center gap-4 px-4 py-2 md:max-w-3xl md:px-6 lg:max-w-5xl lg:px-8 xl:max-w-6xl">
        <Link href="/" className={PX.logo}>
          <Placard size="sm">
            <span className={PX.placardName}>Tara Gala</span>
          </Placard>
        </Link>
        <nav aria-label={words.tabs.nav} className="hidden md:block">
          <ul className="flex gap-1">
            {tabs.map((tab) => (
              <li key={tab.href}>
                <Link href={tab.href} aria-current={current === tab.href ? "page" : undefined} className={cx(PX.tab, "min-h-11 gap-2 border-b-4")}>
                  <TabIcon tab={tab.href} scale={1} />
                  <Say w={(d) => d.tabs[tab.word]} />
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        {flags.langPicker ? (
          // TG-74: the 🌐 picker sits left of the Dark mode switch
          <div className="ml-auto flex items-center gap-2">
            <LangPicker place="header" />
            <ThemeToggle />
          </div>
        ) : (
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        )}
      </div>
    </header>
  );
}
