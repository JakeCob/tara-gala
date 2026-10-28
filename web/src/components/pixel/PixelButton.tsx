import type { ComponentPropsWithoutRef } from "react";
import { PX, cx, type ButtonVariant } from "./classes";

/** A native button with a pixel skin. className replaces the variant's default layout. */
export function PixelButton({
  variant,
  type = "button",
  className,
  ...rest
}: { variant: ButtonVariant } & ComponentPropsWithoutRef<"button">) {
  const v = PX.btn[variant];
  return <button type={type} className={cx(v.skin, className ?? PX.btn[variant].layout)} {...rest} />;
}
