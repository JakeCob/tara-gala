import type { Metadata } from "next";
import LastMile from "@/components/LastMile";
import { PageShell, PageTitle, PixelLink } from "@/components/pixel";

export const metadata: Metadata = {
  title: "Getting around Baguio · Tara Gala",
};

export default function BaguioPage() {
  return (
    <PageShell>
      <PixelLink variant="secondary" href="/" className="inline-flex items-center self-start px-4 text-sm">
        <span aria-hidden>←&nbsp;</span>Back to bus search
      </PixelLink>
      <header className="flex flex-col gap-1">
        <PageTitle className="text-balance">Getting around Baguio</PageTitle>
        <p className="text-sm text-muted md:max-w-prose">Jeeps, taxis and walks from the bus terminal to the top spots.</p>
      </header>
      <LastMile />
    </PageShell>
  );
}
