import type { Metadata } from "next";
import TicketWallet from "@/components/TicketWallet";
import { PageShell, PageTitle, PixelLink } from "@/components/pixel";

export const metadata: Metadata = {
  title: "My tickets · Tara Gala",
};

export default function TicketsPage() {
  return (
    <PageShell>
      <PixelLink variant="secondary" href="/" className="inline-flex items-center self-start px-4 text-sm">
        <span aria-hidden>←&nbsp;</span>Back to bus search
      </PixelLink>
      <header className="flex flex-col gap-1">
        <PageTitle className="text-balance">My tickets</PageTitle>
        <p className="text-sm text-muted md:max-w-prose">
          Save your bus e-ticket photos so they open at the terminal, even without signal. They stay only on this phone; nothing
          is uploaded.
        </p>
      </header>
      <TicketWallet />
    </PageShell>
  );
}
