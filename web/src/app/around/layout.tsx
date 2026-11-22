import { notFound } from "next/navigation";
import { flags } from "@/lib/flags";

/** TG-71/72: every /around page is a real 404 while the Around flag is off (a page-level notFound alone streams the
 * fallback shell with status 200 under cacheComponents). */
export default function AroundLayout({ children }: LayoutProps<"/around">) {
  if (!flags.aroundTab) notFound();
  return children;
}
