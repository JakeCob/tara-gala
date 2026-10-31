import type { ReactNode } from "react";
import { PX, cx } from "./classes";

/** A floating text box. The box draws its own hard shadow (TG-49); className positions the wrapper. */
export function DialogBox({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={className}>
      <div className={cx(PX.box.skin, "p-4 flex flex-col gap-3")}>{children}</div>
    </div>
  );
}
