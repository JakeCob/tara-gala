import type { Metadata } from "next";
import WalletHome from "@/components/WalletHome";
import { PageShell, PageTitle, PixelLink } from "@/components/pixel";

export const metadata: Metadata = {
  title: "Trip wallet · Tara Gala",
};

export default function WalletPage() {
  return (
    <PageShell>
      <PixelLink variant="secondary" href="/" className="inline-flex items-center self-start px-4 text-sm">
        <span aria-hidden>←&nbsp;</span>Back to bus search
      </PixelLink>
      <header className="flex flex-col gap-1">
        <PageTitle className="text-balance">Trip wallet</PageTitle>
        <p className="text-sm text-muted md:max-w-prose">
          Your bus e-tickets, and a shared list of who paid what on the trip, so everyone settles up at the end.
        </p>
      </header>
      <WalletHome />
    </PageShell>
  );
}
