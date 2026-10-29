import type { ReactNode } from "react";
import { PX } from "./classes";

/** Every page's <main> (TG-44). Phone classes are today's string; md/lg/xl widen it. */
export function PageShell({ children }: { children: ReactNode }) {
  return <main className={PX.shell}>{children}</main>;
}
