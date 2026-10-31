import { PageTitle } from "@/components/pixel";
import { CAST, castSprite } from "@/lib/landingCast";
import { spriteSrc } from "@/lib/sprites";

/**
 * The landing hero (ux §5.1): the title and tagline over the sky of a fixed light screen. The scene is 2x at every
 * width, kept left so the bus and sky show; from md the hero shares a row with the search form and fills its cell
 * (TG-49). The trio stands on the left hills.
 */
export default function Hero() {
  return (
    <section className="pixel-frame bg-screen relative h-[252px] overflow-hidden md:h-auto md:min-h-[252px]">
      {/* eslint-disable-next-line @next/next/no-img-element -- pixel art: next/image would resample it */}
      <img
        src={spriteSrc("hero-scene")}
        alt=""
        aria-hidden="true"
        draggable={false}
        width={640}
        height={246}
        fetchPriority="high"
        className="pixelated absolute bottom-0 left-[min(0px,calc(100%_-_400px))] h-[246px] w-[640px] max-w-none"
      />
      <div className="relative flex flex-col gap-1 p-4">
        <PageTitle wordmark id="landing-title" tabIndex={-1}>Tara Gala</PageTitle>
        <p className="text-sm font-semibold text-screen-ink">Manila to Baguio buses, straight from the operators.</p>
      </div>
      <div aria-hidden="true" className="absolute bottom-1 left-3 flex gap-1">
        {CAST.heroTrio.map((slot) => (
          // eslint-disable-next-line @next/next/no-img-element -- pixel art, as above
          <img key={slot.type} src={spriteSrc(castSprite(slot))} alt="" width={64} height={64} draggable={false} className="pixelated" />
        ))}
      </div>
    </section>
  );
}
