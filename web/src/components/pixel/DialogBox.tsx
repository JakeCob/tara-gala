import type { ReactNode } from "react";
import { PX, cx } from "./classes";

/** A floating text box. The box clips its own shadow, so the hard drop sits on the wrapper; className positions it. */
export function DialogBox({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cx("drop-shadow-[0_6px_0_var(--color-frame)]", className)}>
      <div className={cx(PX.box.skin, "p-4 flex flex-col gap-3")}>{children}</div>
    </div>
  );
}
