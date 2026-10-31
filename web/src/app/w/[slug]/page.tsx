import { Suspense } from "react";
import type { Metadata } from "next";
import WalletView from "@/components/WalletView";
import { PageShell, PageTitle, PixelLink } from "@/components/pixel";

// A capability link (TG-50): whoever has it can read and write the wallet. Never indexed, and no referrer.
export const metadata: Metadata = {
  title: "Trip wallet · Tara Gala",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

// As /i/[slug]: the slug is only known at request time, so this renders per request; the data loads in the browser
export const instant = false

async function SlugView({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <WalletView key={slug} slug={slug} />;
}

export default function SharedWalletPage({ params }: PageProps<"/w/[slug]">) {
  return (
    <PageShell>
      <PixelLink variant="secondary" href="/" className="inline-flex items-center self-start px-4 text-sm">
        <span aria-hidden="true">←&nbsp;</span>Back to bus search
      </PixelLink>
      <PageTitle>Trip wallet</PageTitle>
      <Suspense fallback={<p className="text-sm text-muted">Opening the wallet...</p>}>
        <SlugView params={params} />
      </Suspense>
    </PageShell>
  );
}
