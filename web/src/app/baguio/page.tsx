import type { Metadata } from "next";
import { redirect } from "next/navigation";
import LastMile from "@/components/LastMile";
import { PageShell, PageTitle } from "@/components/pixel";
import { flags } from "@/lib/flags";

export const metadata: Metadata = {
  title: "Getting around Baguio · Tara Gala",
};

export default function BaguioPage() {
  if (flags.aroundTab) redirect("/around/baguio"); // TG-71 ux §7.1: old links and saved phones still land on Baguio
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
