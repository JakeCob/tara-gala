import { PixelBox, SectionTitle } from "@/components/pixel";
import { SPRITES, spriteSrc } from "@/lib/sprites";
import SectionStripe from "./SectionStripe";

const POINTS = [
  "Times come from the operators' own booking sites.",
  "Every trip shows a Checked date, so you know how fresh it is.",
  "Works offline once you've opened it.",
];
const BADGE = SPRITES["ui-badge-verified"];

/** Why you can trust it (ux §5.5): only what the data backs, then the reminder to confirm. */
export default function Trust() {
  return (
    <section aria-labelledby="why-trust" className="flex flex-col gap-3">
      <div className="mt-3">
        <SectionTitle id="why-trust">Why you can trust it</SectionTitle>
        <SectionStripe />
      </div>
      <PixelBox className="flex flex-col gap-3 p-4">
        <ul className="flex flex-col gap-2 text-sm">
          {POINTS.map((point) => (
            <li key={point} className="flex items-start gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element -- pixel art: next/image would resample it */}
              <img src={spriteSrc("ui-badge-verified")} alt="" width={BADGE.w * 2} height={BADGE.h * 2} draggable={false} className="pixelated shrink-0" />
              <span>{point}</span>
            </li>
          ))}
        </ul>
        <p className="text-sm font-semibold">Bus times can change. Always confirm with the operator before you travel.</p>
      </PixelBox>
    </section>
  );
}
