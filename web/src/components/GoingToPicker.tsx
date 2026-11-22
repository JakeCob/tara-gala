import { PX, PixelChoice, SectionTitle, cx } from "@/components/pixel";
import { GOING_TO_LEGEND } from "@/lib/goingTo";

/**
 * TG-71 ux.md §7.2: the "Going to" radios, one pill per city, in a row that wraps at 320. Native radios in a
 * fieldset, so arrow keys move between cities and the legend names the group. Only rendered with NEXT_PUBLIC_GOING_TO.
 * `heading`: the legend in the pixel font, like /plan's other boxes; else a small muted label, like /buses' From and To.
 */
export default function GoingToPicker(props: {
  name: string;
  cities: readonly string[];
  city: string;
  onPick(city: string): void;
  heading?: boolean;
}) {
  const { name, cities, city, heading } = props;
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0">
      {heading ? (
        <SectionTitle as="legend" className="mb-3">
          {GOING_TO_LEGEND}
        </SectionTitle>
      ) : (
        <legend className="mb-1 text-sm text-muted">{GOING_TO_LEGEND}</legend>
      )}
      <div className="flex flex-wrap gap-2">
        {cities.map((c) => (
          <PixelChoice key={c} name={name} value={c} checked={c === city} onChange={() => props.onPick(c)} className={cx(PX.choice.layout, "min-w-24")}>
            {c}
          </PixelChoice>
        ))}
      </div>
    </fieldset>
  );
}
