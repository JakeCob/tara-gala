import { partyLooks, tagLabel } from "@/lib/party";
import type { SpawnStep } from "@/lib/spawn";
import { chibiLook, spriteSrc } from "@/lib/sprites";
import { PX } from "@/components/pixel";

type Props = {
  party: readonly { type: string }[];
  spawning?: ReadonlySet<number>;
  step?: SpawnStep;
  fixedRows?: boolean; // the picker keeps 2 rows so the steppers below never move; TG-22's map party doesn't
};

/**
 * The party on a patch of grass (TG-15; TG-22 reuses it). Decorative: the picker's live summary says the same
 * thing in text. Each passenger is drawn in its own TG-48 appearance, by its ordinal within its type, so /plan and a
 * saved party agree. Types without a sprite (child or unknown, only from saved data) get a tag and no chibi.
 */
export default function PartyStage({ party, spawning, step, fixedRows = false }: Props) {
  const looks = partyLooks(party);
  return (
    <div
      aria-hidden="true"
      className={`pixel-frame bg-screen pixelated grid grid-cols-5 px-1 py-3 gap-y-2 ${fixedRows ? "grid-rows-[repeat(2,5.5rem)]" : ""}`}
      style={{ backgroundImage: `url(${spriteSrc("tile-grass")})`, backgroundSize: "32px" }}
    >
      {party.map((p, i) => {
        const live = step && spawning?.has(i) ? step : null;
        const look = looks[i];
        const src = look ? spriteSrc(chibiLook(look, live ? live.frame : "idle-1")) : null;
        return (
          <div key={i} className="relative flex flex-col items-center justify-end">
            {src && (
              // eslint-disable-next-line @next/next/no-img-element -- pixel art: next/image would resample PNG art and needs dangerouslyAllowSVG
              <img
                src={src}
                width={64}
                height={64}
                alt=""
                className="pixelated"
                draggable={false}
                decoding="async"
                onError={(e) => {
                  // A sprite never fetched before going offline: hide it (no broken-image icon); the tag still names the type
                  e.currentTarget.style.visibility = "hidden";
                  console.warn("[tg-party] sprite failed src=%s", src);
                }}
              />
            )}
            {src && live?.stars && (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element -- pixel art, as above */}
                <img src={spriteSrc("ui-star")} width={24} height={24} alt="" className="pixelated absolute left-0 top-0" draggable={false} />
                {/* eslint-disable-next-line @next/next/no-img-element -- pixel art, as above */}
                <img src={spriteSrc("ui-star")} width={24} height={24} alt="" className="pixelated absolute right-0 top-0" draggable={false} />
              </>
            )}
            <span className={PX.screenTag}>{tagLabel(p.type)}</span>
          </div>
        );
      })}
    </div>
  );
}
