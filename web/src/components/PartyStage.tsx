import { isPickerType, tagLabel } from "@/lib/party";
import type { SpawnStep } from "@/lib/spawn";
import { chibi, spriteSrc } from "@/lib/sprites";
import { UI } from "./planUi";

type Props = {
  party: readonly { type: string }[];
  spawning?: ReadonlySet<number>;
  step?: SpawnStep;
  fixedRows?: boolean; // the picker keeps 2 rows so the steppers below never move; TG-22's map party doesn't
};

/**
 * The party on a patch of grass (TG-15; TG-22 reuses it). Decorative: the picker's live summary says the same
 * thing in text. Types without a sprite (child or unknown, only from saved data) get a tag and no chibi.
 */
export default function PartyStage({ party, spawning, step, fixedRows = false }: Props) {
  return (
    <div
      aria-hidden="true"
      className={`${UI.stage} ${UI.pixelated} grid grid-cols-5 px-1 py-3 gap-y-2 ${fixedRows ? "grid-rows-[repeat(2,5.5rem)]" : ""}`}
      style={{ backgroundImage: `url(${spriteSrc("tile-grass")})`, backgroundSize: "32px" }}
    >
      {party.map((p, i) => {
        const live = step && spawning?.has(i) ? step : null;
        const src = isPickerType(p.type) ? spriteSrc(chibi(p.type, live ? live.frame : "idle-1")) : null;
        return (
          <div key={i} className="relative flex flex-col items-center justify-end">
            {src && (
              // eslint-disable-next-line @next/next/no-img-element -- pixel art: next/image would resample PNG art and needs dangerouslyAllowSVG
              <img src={src} width={64} height={64} alt="" className={UI.pixelated} draggable={false} decoding="async" />
            )}
            {src && live?.stars && (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element -- pixel art, as above */}
                <img src={spriteSrc("ui-star")} width={24} height={24} alt="" className={`${UI.pixelated} absolute left-0 top-0`} draggable={false} />
                {/* eslint-disable-next-line @next/next/no-img-element -- pixel art, as above */}
                <img src={spriteSrc("ui-star")} width={24} height={24} alt="" className={`${UI.pixelated} absolute right-0 top-0`} draggable={false} />
              </>
            )}
            <span className={`${UI.screenChip} px-1 text-xs font-semibold`}>{tagLabel(p.type)}</span>
          </div>
        );
      })}
    </div>
  );
}
