import type { Metadata } from "next";
import LastMile from "@/components/LastMile";
import { PageShell, PageTitle } from "@/components/pixel";

export const metadata: Metadata = {
  title: "Getting around Baguio · Tara Gala",
};

export default function BaguioPage() {
  return (
    <PageShell>
      <header className="flex flex-col gap-1">
        <PageTitle className="text-balance">Getting around Baguio</PageTitle>
        <p className="text-sm text-muted md:max-w-prose">Jeeps, taxis and walks from the bus terminal to the top spots.</p>
      </header>
      <LastMile />
    </PageShell>
  );
}
