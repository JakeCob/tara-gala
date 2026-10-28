import type { Metadata } from "next";
import LastMile from "@/components/LastMile";
import { PageTitle, PixelLink } from "@/components/pixel";

export const metadata: Metadata = {
  title: "Getting around Baguio · Tara Gala",
};

export default function BaguioPage() {
  return (
    <main className="mx-auto w-full max-w-md flex-1 px-4 py-6 flex flex-col gap-5">
      <PixelLink variant="secondary" href="/" className="inline-flex items-center self-start px-4 text-sm">
        <span aria-hidden>←&nbsp;</span>Back to bus search
      </PixelLink>
      <header className="flex flex-col gap-1">
        <PageTitle className="text-balance">Getting around Baguio</PageTitle>
        <p className="text-sm text-muted">Jeeps, taxis and walks from the bus terminal to the top spots.</p>
      </header>
      <LastMile />
    </main>
  );
}
