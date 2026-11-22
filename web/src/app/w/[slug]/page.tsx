import { Suspense } from "react";
import type { Metadata } from "next";
import WalletView from "@/components/WalletView";
import { PageShell, PageTitle, PixelLink } from "@/components/pixel";
import { AMBAGAN_WORDS } from "@/lib/ambagan";
import { flags } from "@/lib/flags";

// A capability link (TG-50): whoever has it can read and write the wallet. Never indexed, and no referrer.
export const metadata: Metadata = {
  title: flags.ambaganTab ? `${AMBAGAN_WORDS.title} · Tara Gala` : "Trip wallet · Tara Gala", // TG-72
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
      <PixelLink variant="secondary" href="/wallet" className="inline-flex items-center self-start px-4 text-sm">
        <span aria-hidden="true">←&nbsp;</span>{flags.ambaganTab ? AMBAGAN_WORDS.back : "Back to trip wallet"}
      </PixelLink>
      <PageTitle>{flags.ambaganTab ? AMBAGAN_WORDS.title : "Trip wallet"}</PageTitle>
      <Suspense fallback={<p className="text-sm text-muted">{flags.ambaganTab ? AMBAGAN_WORDS.opening : "Opening the wallet..."}</p>}>
        <SlugView params={params} />
      </Suspense>
    </PageShell>
  );
}
