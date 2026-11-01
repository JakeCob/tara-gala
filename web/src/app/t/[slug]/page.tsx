import { Suspense } from "react";
import type { Metadata } from "next";
import TripView from "@/components/TripView";
import { PageShell, PageTitle, PixelLink } from "@/components/pixel";

// A capability link (TG-52): whoever has it can read and change the trip. Never indexed, and no referrer.
export const metadata: Metadata = {
  title: "My trip · Tara Gala",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

// As /w/[slug]: the slug is only known at request time, so this renders per request; the data loads in the browser
export const instant = false

async function SlugView({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <TripView key={slug} slug={slug} />;
}

export default function SharedTripPage({ params }: PageProps<"/t/[slug]">) {
  return (
    <PageShell>
      <PixelLink variant="secondary" href="/trip" className="inline-flex items-center self-start px-4 text-sm">
        <span aria-hidden="true">←&nbsp;</span>Back to my trips
      </PixelLink>
      <PageTitle>My trip</PageTitle>
      <Suspense fallback={<p className="text-sm text-muted">Opening the trip...</p>}>
        <SlugView params={params} />
      </Suspense>
    </PageShell>
  );
}
