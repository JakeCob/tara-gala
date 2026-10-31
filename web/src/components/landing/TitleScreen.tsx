import Link from "next/link";
import { MenuCursor, PageTitle, PX } from "@/components/pixel";
import { flags } from "@/lib/flags";
import { formMode } from "@/lib/planForm";
import { spriteSrc } from "@/lib/sprites";
import TitleBlink from "./TitleBlink";
import TitleCast from "./TitleCast";

/**
 * The game title screen at / (TG-49, owner: "like a title screen of a game"): the wordmark, PRESS START and a start
 * menu over the mountain scene, on a fixed light screen. The menu goes straight to each tab, so it never costs a tap.
 * The cursor sits on the first item until another is hovered or focused (globals.css title-menu); it and PRESS START blink (TitleBlink).
 */
export default function TitleScreen() {
  const menu = [
    { href: "/buses", label: "Find buses" },
    ...(formMode(flags) !== "none" ? [{ href: "/plan", label: "Plan a trip" }] : []),
    { href: "/baguio", label: "In Baguio" },
    { href: "/wallet", label: "Trip wallet" },
  ];
  return (
    <section
      aria-labelledby="landing-title"
      className="pixel-frame bg-screen relative mx-auto flex min-h-[38rem] w-full flex-col items-center overflow-hidden md:max-w-[640px] lg:min-h-[42rem] lg:max-w-[960px]"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- pixel art: next/image would resample it */}
      <img
        src={spriteSrc("hero-scene")}
        alt=""
        aria-hidden="true"
        draggable={false}
        width={640}
        height={246}
        fetchPriority="high"
        className="pixelated absolute bottom-0 left-[min(0px,calc(100%_-_400px))] h-[246px] w-[640px] max-w-none md:left-0 lg:h-[369px] lg:w-[960px]"
      />
      <div className="relative flex flex-col items-center gap-3 px-4 pt-10 text-center lg:pt-14">
        <PageTitle titleScreen id="landing-title">
          Tara Gala
        </PageTitle>
        <p className="text-sm font-semibold text-screen-ink md:text-base">Manila to Baguio buses, straight from the operators.</p>
        <TitleBlink>
          <p aria-hidden="true" data-blinks="" className={PX.pressStart}>
            Press start
          </p>
          <nav aria-label="Start menu" className="title-menu mt-1">
            <ul className="pixel-box flex min-w-60 flex-col border-screen-ink bg-screen-paper py-2 text-left">
              {menu.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className={PX.menuItem}>
                    <span data-cursor="" data-blinks="">
                      <MenuCursor className="h-3 w-3" />
                    </span>
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </TitleBlink>
      </div>
      <TitleCast />
    </section>
  );
}
