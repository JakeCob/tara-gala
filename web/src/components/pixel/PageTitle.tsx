import { PX, cx } from "./classes";

/** The page h1 in the pixel font. Static text only: the font has no ₱ or →. className may add text-balance. */
export function PageTitle({ className, children }: { className?: "text-balance"; children: string }) {
  return <h1 className={cx(PX.h1, className)}>{children}</h1>;
}
