import { PX, PixelCardLink, cx } from "@/components/pixel";
import { flags } from "@/lib/flags";
import { CAST, castSprite } from "@/lib/landingCast";
import { formMode } from "@/lib/planForm";
import { SPRITES, spriteSrc, type SpriteName } from "@/lib/sprites";

const TILE = "flex h-full items-center gap-3 p-4";

/** A tile's insides: the sprite at 2x on a light plate, the title, its line and a decorative arrow. */
function TileBody({ sprite, title, line }: { sprite: SpriteName; title: string; line: string }) {
  return (
    <>
      <span className={PX.plate}>
        {/* eslint-disable-next-line @next/next/no-img-element -- pixel art: next/image would resample it */}
        <img src={spriteSrc(sprite)} alt="" width={SPRITES[sprite].w * 2} height={SPRITES[sprite].h * 2} draggable={false} className="pixelated" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-bold">{title}</span>
        <span className={PX.meta}>{line}</span>
      </span>
      <span aria-hidden="true">→</span>
    </>
  );
}

/** The three quick actions under the search (ux §5.3): neutral tiles, the sprites are the colour. */
export default function QuickActions() {
  const cols = formMode(flags) !== "none" ? "md:grid-cols-3" : "md:grid-cols-2";
  return (
    <nav aria-label="Quick actions">
      <ul className={cx("flex flex-col gap-3 md:grid md:gap-4", cols)}>
        <li>
          <PixelCardLink href="#travel-date" className={TILE}>
            <TileBody sprite="vehicle-bus" title="Find buses" line="Every trip on file, with fares and where to book." />
          </PixelCardLink>
        </li>
        {formMode(flags) !== "none" && (
          <li>
            <PixelCardLink href="/plan" className={TILE}>
              <TileBody sprite={castSprite(CAST.planTile)} title="Plan a Baguio trip" line="Tell us who's coming and your vibe. Tara!" />
            </PixelCardLink>
          </li>
        )}
        <li>
          <PixelCardLink href="/baguio" className={TILE}>
            <TileBody sprite="mode-jeep" title="In Baguio?" line="Jeeps, taxis and walks from the terminal." />
          </PixelCardLink>
        </li>
      </ul>
    </nav>
  );
}
