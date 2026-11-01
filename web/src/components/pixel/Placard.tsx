import type { ReactNode } from "react";
import { PX } from "./classes";

const ROUTE = "Manila – Baguio";

/**
 * A jeepney route signboard (TG-49, owner: "look like a jeepney placard"): the name on a cream board in a thick Ink
 * frame with an inner trim line, over the route. The route line is decor (the pages say it in words), so screen
 * readers skip it. A painted sign looks the same in both themes, like the game screen.
 * sm is the header's logo, inside its link; lg wraps the title screen's h1.
 */
export function Placard({ size, children }: { size: "sm" | "lg"; children: ReactNode }) {
  if (size === "lg") {
    return (
      <div className={PX.placardLg}>
        {children}
        <span aria-hidden="true" className={PX.placardRouteLg}>
          {ROUTE}
        </span>
      </div>
    );
  }
  return (
    <span className={PX.placard}>
      {children}
      <span aria-hidden="true" className={PX.placardRoute}>
        {ROUTE}
      </span>
    </span>
  );
}
