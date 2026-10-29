import type { ReactNode } from "react";
import { PX, PixelBox, SectionTitle } from "@/components/pixel";
import { CAST, castSprite } from "@/lib/landingCast";
import { SPRITES, spriteSrc, type SpriteName } from "@/lib/sprites";
import SectionStripe from "./SectionStripe";

/** One step in its box. The numeral is decorative: the ordered list already numbers the steps. */
function Step({ numeral, sprite, title, line }: { numeral: ReactNode; sprite: SpriteName; title: string; line: string }) {
  return (
    <PixelBox as="li" className="flex items-start gap-3 p-4">
      <span className={PX.plate}>
        {/* eslint-disable-next-line @next/next/no-img-element -- pixel art: next/image would resample it */}
        <img src={spriteSrc(sprite)} alt="" width={SPRITES[sprite].w * 2} height={SPRITES[sprite].h * 2} draggable={false} className="pixelated" />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="font-bold">
          {numeral} {title}
        </span>
        <span className="text-sm text-muted">{line}</span>
      </span>
    </PixelBox>
  );
}

/** How it works (ux §5.5): three steps, 3-up from md. */
export default function HowItWorks() {
  return (
    <section aria-labelledby="how-it-works" className="flex flex-col gap-3">
      <div className="mt-3">
        <SectionTitle id="how-it-works">How it works</SectionTitle>
        <SectionStripe />
      </div>
      <ol className="flex flex-col gap-3 md:grid md:grid-cols-3 md:gap-4">
        <Step
          numeral={<span aria-hidden="true" className="text-sm font-bold">1.</span>}
          sprite="vehicle-bus"
          title="Search"
          line="Pick a date. See the buses on file, with fares and booking links."
        />
        <Step
          numeral={<span aria-hidden="true" className="text-sm font-bold">2.</span>}
          sprite={castSprite(CAST.planStep)}
          title="Plan"
          line="Tell us who's coming and what you're into, or pick a ready-made trip."
        />
        <Step
          numeral={<span aria-hidden="true" className="text-sm font-bold">3.</span>}
          sprite="tile-mountain"
          title="Go offline"
          line="Open your trip once with signal. It stays on your phone for the mountain roads."
        />
      </ol>
    </section>
  );
}
