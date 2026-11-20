import { Suspense } from "react";
import type { Metadata } from "next";
import RecapView from "@/components/RecapView";
import { PageShell } from "@/components/pixel";

// TG-64: the read-only recap link. Its metadata is the same for every trip: no trip name, and no photo for a link
// preview. Never indexed, and no referrer, so the link doesn't leak to the sites it opens.
export const metadata: Metadata = {
  title: "Trip recap · Tara Gala",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

// As /join/[slug]: the slug is only known at request time, so this renders per request; the recap loads in the browser
export const instant = false

async function SlugView({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <RecapView key={slug} slug={slug} />;
}

export default function RecapPage({ params }: PageProps<"/r/[slug]">) {
  return (
    <PageShell>
      <Suspense fallback={<p className="text-sm text-muted">Opening the recap...</p>}>
        <SlugView params={params} />
      </Suspense>
    </PageShell>
  );
}
