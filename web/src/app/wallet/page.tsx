import type { Metadata } from "next";
import WalletHome from "@/components/WalletHome";
import { PageShell, PageTitle } from "@/components/pixel";

export const metadata: Metadata = {
  title: "Trip wallet · Tara Gala",
};

export default function WalletPage() {
  return (
    <PageShell>
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
