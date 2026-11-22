import type { Metadata } from "next";
import WalletHome from "@/components/WalletHome";
import { PageShell, PageTitle } from "@/components/pixel";
import { AMBAGAN_WORDS } from "@/lib/ambagan";
import { flags } from "@/lib/flags";

export const metadata: Metadata = {
  title: flags.ambaganTab ? `${AMBAGAN_WORDS.title} · Tara Gala` : "Trip wallet · Tara Gala", // TG-72
};

export default function WalletPage() {
  return (
    <PageShell>
      <header className="flex flex-col gap-1">
        <PageTitle className="text-balance">{flags.ambaganTab ? AMBAGAN_WORDS.title : "Trip wallet"}</PageTitle>
        <p className="text-sm text-muted md:max-w-prose">
          {flags.ambaganTab
            ? AMBAGAN_WORDS.intro
            : "Your bus e-tickets, and a shared list of who paid what on the trip, so everyone settles up at the end."}
        </p>
      </header>
      <WalletHome />
    </PageShell>
  );
}
