import type { Metadata } from "next";
import TicketWallet from "@/components/TicketWallet";
import { PageShell, PageTitle, PixelLink } from "@/components/pixel";
import { AMBAGAN_WORDS } from "@/lib/ambagan";
import { flags } from "@/lib/flags";

export const metadata: Metadata = {
  title: "My tickets · Tara Gala",
};

export default function TicketsPage() {
  return (
    <PageShell>
      {/* TG-72: with the Ambagan tab, tickets stay under Trip, so the way back is the trip */}
      <PixelLink variant="secondary" href={flags.ambaganTab ? "/trip" : "/wallet"} className="inline-flex items-center self-start px-4 text-sm">
        <span aria-hidden>←&nbsp;</span>{flags.ambaganTab ? AMBAGAN_WORDS.ticketsBack : "Back to trip wallet"}
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
