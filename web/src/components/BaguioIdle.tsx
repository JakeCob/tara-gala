// The /baguio empty state (TG-49 PR 2, ux.md section 3), shown until a terminal is picked. The action is the picker
// directly above, so this has no control of its own and asks for no data. The scene is decoration: hidden from
// assistive technology and inert, with sprites as CSS backgrounds on sized spans, like HomeDecor, so one that fails
// to load just leaves grass.
import { cx, PixelBox } from "@/components/pixel";
import { BAGUIO_IDLE_COPY, BAGUIO_IDLE_ROW, BAGUIO_IDLE_SCENE_CLASS } from "@/lib/baguioIdle";
import { SHOW_CLASS } from "@/lib/homeDecor";
import { SPRITES, spriteSrc } from "@/lib/sprites";

export default function BaguioIdle() {
  return (
    <PixelBox className="p-0 flex flex-col">
      <div aria-hidden="true" className={BAGUIO_IDLE_SCENE_CLASS} style={{ backgroundImage: `url(${spriteSrc("tile-grass")})`, backgroundSize: "32px" }}>
        {BAGUIO_IDLE_ROW.map((d) => (
          <span
            key={d.name}
            aria-hidden="true"
            className={cx("pixelated bg-no-repeat bg-[length:100%_100%]", SHOW_CLASS[d.show])}
            style={{ backgroundImage: `url(${spriteSrc(d.name)})`, width: SPRITES[d.name].w * 2, height: SPRITES[d.name].h * 2 }}
          />
        ))}
      </div>
      <div className="p-4 flex flex-col gap-1">
        <p className="text-base font-bold">{BAGUIO_IDLE_COPY.lead}</p>
        <p className="text-sm text-muted md:max-w-prose">{BAGUIO_IDLE_COPY.line}</p>
      </div>
    </PixelBox>
  );
}
