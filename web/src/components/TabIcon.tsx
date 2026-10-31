import { ICON_SIZE, TAB_ICONS, iconPath } from "@/lib/pixelIcons";
import type { TabHref } from "@/lib/tabs";

/** A tab's pixel icon at a whole-number scale (1x in the header, 2x in the phones' bar), in the text colour. */
export default function TabIcon({ tab, scale }: { tab: TabHref; scale: 1 | 2 }) {
  const size = ICON_SIZE * scale;
  return (
    <svg aria-hidden="true" viewBox={`0 0 ${ICON_SIZE} ${ICON_SIZE}`} width={size} height={size} shapeRendering="crispEdges" fill="currentColor" className="shrink-0">
      <path d={iconPath(TAB_ICONS[tab])} />
    </svg>
  );
}
