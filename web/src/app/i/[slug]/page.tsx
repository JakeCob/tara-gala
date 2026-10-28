import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import ItineraryView from "@/components/ItineraryView";
import { UI } from "@/components/planUi";

// A capability link: never indexed, and no referrer when it links out to operators, Maps or Sakay
export const metadata: Metadata = {
  title: "Trip plan · Tara Gala",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

// The slug is only known at request time. The layout's OfflineBanner (TG-27) reads usePathname outside a
// Suspense boundary, which can't be prerendered for an unknown param, so this route renders per request
// instead of from a prerendered shell. The plan data is fetched in the browser either way (TG-27 caching).
export const instant = false

// Reading the slug suspends; the header above renders first
async function SlugView({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <ItineraryView slug={slug} />;
}

export default function TripPlanPage({ params }: PageProps<"/i/[slug]">) {
  return (
    <main className="mx-auto w-full max-w-md flex-1 px-4 py-6 flex flex-col gap-5">
      <Link href="/" className={UI.backLink}>
        <span aria-hidden="true">←&nbsp;</span>Back to bus search
      </Link>
      <h1 className={UI.h1}>Your trip</h1>
      <Suspense fallback={<p className="text-sm text-muted">Loading your trip...</p>}>
        <SlugView params={params} />
      </Suspense>
    </main>
  );
}
