import type { ReactNode } from "react";
import { PX, cx } from "./classes";

type Props = {
  as?: "h2" | "h3" | "legend" | "label";
  /** On the fixed game screen, which stays light in dark mode (guide 1.3) */
  onScreen?: boolean;
  htmlFor?: string;
  id?: string;
  className?: string;
  children: ReactNode;
};

/** A static section heading, legend or label in the pixel font. Never for data (place names, ₱, →). */
export function SectionTitle({ as: Tag = "h2", onScreen, htmlFor, id, className, children }: Props) {
  return (
    <Tag
      id={id}
      htmlFor={Tag === "label" ? htmlFor : undefined}
      className={cx(PX.h2, onScreen ? "text-screen-ink" : "text-foreground", className)}
    >
      {children}
    </Tag>
  );
}
