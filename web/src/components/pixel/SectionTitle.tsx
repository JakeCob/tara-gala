import type { ReactNode } from "react";
import { PX, cx } from "./classes";

type Props = {
  as?: "h2" | "h3" | "legend" | "label";
  /** On the fixed game screen, which stays light in dark mode (guide 1.3) */
  onScreen?: boolean | "banner";
  htmlFor?: string;
  id?: string;
  /** -1 lets a result move focus here (TG-53) */
  tabIndex?: number;
  className?: string;
  children: ReactNode;
};

/** A static section heading, legend or label in the pixel font. Never for data (place names, ₱, →). */
export function SectionTitle({ as: Tag = "h2", onScreen, htmlFor, id, tabIndex, className, children }: Props) {
  return (
    <Tag
      id={id}
      tabIndex={tabIndex}
      htmlFor={Tag === "label" ? htmlFor : undefined}
      className={cx(PX.h2, onScreen === "banner" ? "text-screen-paper" : onScreen ? "text-screen-ink" : "text-foreground", className)}
    >
      {children}
    </Tag>
  );
}
