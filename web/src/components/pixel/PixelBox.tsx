import type { ComponentPropsWithoutRef, ElementType } from "react";
import { PX, cx } from "./classes";

type BoxTag = "div" | "section" | "article" | "li" | "p" | "form";

/** The RPG text box: cards, notices, panels. Not focusable (its clip-path would cut a focus outline). */
export function PixelBox<T extends BoxTag = "div">({
  as,
  className,
  ...rest
}: { as?: T; className?: string } & Omit<ComponentPropsWithoutRef<T>, "className">) {
  const Tag = (as ?? "div") as ElementType;
  return <Tag className={cx(PX.box.skin, className ?? PX.box.layout)} {...rest} />;
}
