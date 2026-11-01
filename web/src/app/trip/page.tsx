import type { Metadata } from "next";
import TripHome from "@/components/TripHome";
import { PageShell, PageTitle } from "@/components/pixel";

export const metadata: Metadata = {
  title: "My trip · Tara Gala",
};

export default function TripPage() {
  return (
    <PageShell>
      <header className="flex flex-col gap-1">
        <PageTitle className="text-balance">My trip</PageTitle>
        <p className="text-sm text-muted md:max-w-prose">
          Everything for the trip in one place: the plan, the shared wallet, the hotel and your tickets.
        </p>
      </header>
      <TripHome />
    </PageShell>
  );
}
