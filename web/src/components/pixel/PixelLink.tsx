import Link from "next/link";
import type { ComponentPropsWithoutRef } from "react";
import { PX, cx, type ButtonVariant } from "./classes";

type Props = { variant: ButtonVariant; href: string; external?: boolean } & Omit<ComponentPropsWithoutRef<"a">, "href">;

/** A link that looks like a button: next/link inside the app, a new-tab anchor when external. */
export function PixelLink({ variant, href, external, className, ...rest }: Props) {
  const classes = cx(PX.btn[variant].skin, className ?? PX.btn[variant].layout);
  if (external) return <a href={href} target="_blank" rel="noopener noreferrer" className={classes} {...rest} />;
  return <Link href={href} className={classes} {...rest} />;
}
