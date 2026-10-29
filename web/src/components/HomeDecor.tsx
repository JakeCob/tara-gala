// The home page's Philippine decor strip (TG-45, ux.md section 1): a fixed light screen with sprites at 2×, the
// same surface as the /plan party stage. Pure decoration, so it's hidden from assistive technology and inert.
import { cx } from "@/components/pixel";
import { HOME_ROW, HOME_SKY, HOME_STRIP_CLASS, SHOW_CLASS } from "@/lib/homeDecor";
import { SPRITES, spriteSrc } from "@/lib/sprites";

export default function HomeDecor() {
  return (
    <div aria-hidden="true" className={HOME_STRIP_CLASS} style={{ backgroundImage: `url(${spriteSrc("tile-grass")})`, backgroundSize: "32px" }}>
      {HOME_SKY.map((d) => (
        // eslint-disable-next-line @next/next/no-img-element -- pixel art: next/image would resample it
        <img
          key={d.name}
          src={spriteSrc(d.name)}
          width={SPRITES[d.name].w * 2}
          height={SPRITES[d.name].h * 2}
          alt=""
          draggable={false}
          decoding="async"
          // decoration: low priority, and no React preload hint (which a prefetch of / would push into every page)
          fetchPriority="low"
          className={cx("pixelated", SHOW_CLASS[d.show], d.at)}
        />
      ))}
      {HOME_ROW.map((d) => (
        // eslint-disable-next-line @next/next/no-img-element -- pixel art: next/image would resample it
        <img
          key={d.name}
          src={spriteSrc(d.name)}
          width={SPRITES[d.name].w * 2}
          height={SPRITES[d.name].h * 2}
          alt=""
          draggable={false}
          decoding="async"
          // decoration: low priority, and no React preload hint (which a prefetch of / would push into every page)
          fetchPriority="low"
          className={cx("pixelated", SHOW_CLASS[d.show])}
        />
      ))}
    </div>
  );
}
