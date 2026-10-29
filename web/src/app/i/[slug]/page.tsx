import { Suspense } from "react";
import type { Metadata } from "next";
import ItineraryView from "@/components/ItineraryView";
import { PageShell, PageTitle, PixelLink } from "@/components/pixel";

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
  return <ItineraryView key={slug} slug={slug} />; // a new slug starts from "loading", never the old plan
}

export default function TripPlanPage({ params }: PageProps<"/i/[slug]">) {
  return (
    <PageShell>
      {/* From md the share page is one centred phone-width column, so the map world stays W = 416 (TG-44) */}
      <div className="contents md:flex md:flex-col md:gap-5 md:mx-auto md:w-full md:max-w-md">
        <PixelLink variant="secondary" href="/" className="inline-flex items-center self-start px-4 text-sm">
          <span aria-hidden="true">←&nbsp;</span>Back to bus search
        </PixelLink>
        <PageTitle>Your trip</PageTitle>
        <Suspense fallback={<p className="text-sm text-muted">Loading your trip...</p>}>
          <SlugView params={params} />
        </Suspense>
      </div>
    </PageShell>
  );
}
