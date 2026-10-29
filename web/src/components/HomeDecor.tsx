// The home page's Philippine decor strip (TG-45, ux.md section 1): a fixed light screen with sprites at 2×, the
// same surface as the /plan party stage. Pure decoration, so it's hidden from assistive technology and inert.
// Each sprite is a CSS background on a sized span, not an image element: one that fails to load just leaves grass,
// with no broken-image icon (ux-review S1). The fixed width and height keep the layout still while the pictures load.
import { cx } from "@/components/pixel";
import { HOME_ROW, HOME_SKY, HOME_STRIP_CLASS, SHOW_CLASS } from "@/lib/homeDecor";
import { SPRITES, spriteSrc } from "@/lib/sprites";

export default function HomeDecor() {
  return (
    <div aria-hidden="true" className={HOME_STRIP_CLASS} style={{ backgroundImage: `url(${spriteSrc("tile-grass")})`, backgroundSize: "32px" }}>
      {HOME_SKY.map((d) => (
        <span
          key={d.name}
          aria-hidden="true"
          className={cx("pixelated bg-no-repeat bg-[length:100%_100%]", SHOW_CLASS[d.show], d.at)}
          style={{ backgroundImage: `url(${spriteSrc(d.name)})`, width: SPRITES[d.name].w * 2, height: SPRITES[d.name].h * 2 }}
        />
      ))}
      {HOME_ROW.map((d) => (
        <span
          key={d.name}
          aria-hidden="true"
          className={cx("pixelated bg-no-repeat bg-[length:100%_100%]", SHOW_CLASS[d.show])}
          style={{ backgroundImage: `url(${spriteSrc(d.name)})`, width: SPRITES[d.name].w * 2, height: SPRITES[d.name].h * 2 }}
        />
      ))}
    </div>
  );
}
