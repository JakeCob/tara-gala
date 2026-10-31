import type { Metadata } from "next";
import { PageShell } from "@/components/pixel";
import TripSearch from "@/components/TripSearch";
import Hero from "@/components/landing/Hero";
import Trust from "@/components/landing/Trust";

export const metadata: Metadata = {
  title: "Find buses · Tara Gala",
};

export default function BusesPage() {
  return (
    <PageShell>
      {/* TG-49: from md the hero and the search form share the first row; the results run full width under both.
          The xl column leaves the hero 640px wide, the scene's full 2x width. No row gap: an empty grid row would still
          take one, and a negative margin can't shrink it, so TripSearch spaces its rows with margins instead */}
      <div className="flex flex-col gap-5 md:grid md:grid-cols-[minmax(0,1fr)_20rem] md:gap-x-6 md:gap-y-0 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-x-8 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <Hero />
        <TripSearch />
      </div>
      <Trust />
    </PageShell>
  );
}
