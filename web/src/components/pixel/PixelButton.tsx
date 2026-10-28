import type { ComponentPropsWithoutRef } from "react";
import { PX, cx, type ButtonVariant } from "./classes";

/** A native button with a pixel skin. className replaces the variant's default layout. */
export function PixelButton({
  variant,
  type = "button",
  className,
  ...rest
}: { variant: ButtonVariant } & ComponentPropsWithoutRef<"button">) {
  return <button type={type} className={cx(PX.btn[variant].skin, className ?? PX.btn[variant].layout)} {...rest} />;
}
