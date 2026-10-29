import { PageTitle } from "@/components/pixel";
import { CAST, castSprite } from "@/lib/landingCast";
import { spriteSrc } from "@/lib/sprites";

/**
 * The landing hero (ux §5.1): the title and tagline over the sky of a fixed light screen. The scene is 2x on the
 * phone, kept left so the bus and sky show, and 3x centred from md. The trio stands on the left hills, phone only.
 */
export default function Hero() {
  return (
    <section className="pixel-frame bg-screen relative h-[252px] overflow-hidden md:h-[375px] md:w-full md:max-w-[966px]">
      {/* eslint-disable-next-line @next/next/no-img-element -- pixel art: next/image would resample it */}
      <img
        src={spriteSrc("hero-scene")}
        alt=""
        aria-hidden="true"
        draggable={false}
        width={640}
        height={246}
        fetchPriority="high"
        className="pixelated absolute bottom-0 left-[min(0px,calc(100%_-_400px))] h-[246px] w-[640px] max-w-none md:left-[calc((100%_-_960px)/2)] md:h-[369px] md:w-[960px]"
      />
      <div className="relative flex flex-col gap-1 p-4">
        <PageTitle onScreen id="landing-title" tabIndex={-1}>Tara Gala</PageTitle>
        <p className="text-sm font-semibold text-screen-ink">Manila to Baguio buses, straight from the operators.</p>
      </div>
      <div aria-hidden="true" className="absolute bottom-1 left-3 flex gap-1 md:hidden">
        {CAST.heroTrio.map((slot) => (
          // eslint-disable-next-line @next/next/no-img-element -- pixel art, as above
          <img key={slot.type} src={spriteSrc(castSprite(slot))} alt="" width={64} height={64} draggable={false} className="pixelated" />
        ))}
      </div>
    </section>
  );
}
