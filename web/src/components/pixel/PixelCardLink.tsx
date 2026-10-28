import Link from "next/link";
import type { ReactNode } from "react";
import { PX, cx } from "./classes";

/** A tappable card. The focus outline goes on the outer link, because the inner pixel-box clips anything outside it. */
export function PixelCardLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  return (
    <Link href={href} className="block focus-pixel">
      <div className={cx(PX.box.skin, className ?? PX.box.layout)}>{children}</div>
    </Link>
  );
}
