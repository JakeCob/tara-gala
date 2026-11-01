import type { ReactNode } from "react";
import { PX } from "./classes";

/**
 * A jeepney route sign (TG-49, owner: "look like a jeepney placard", then the painted black signs in
 * data/img): the name on a black board, one word per line, lime over red. The letters' class (placard-letters) does
 * the stacking and the colours, so the name stays one plain "Tara Gala" for screen readers. A painted sign looks the
 * same in both themes, like the game screen.
 * sm is the header's logo, inside its link; lg wraps the title screen's h1.
 */
export function Placard({ size, children }: { size: "sm" | "lg"; children: ReactNode }) {
  if (size === "lg") return <div className={PX.placardLg}>{children}</div>;
  return <span className={PX.placard}>{children}</span>;
}
