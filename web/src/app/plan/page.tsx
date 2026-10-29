import type { Metadata } from "next";
import PlanForm from "@/components/PlanForm";
import { PageShell, PageTitle, PixelLink } from "@/components/pixel";

export const metadata: Metadata = {
  title: "Plan your trip · Tara Gala",
};

// Not linked from home until TG-21 ships the rest of the planner form
export default function PlanPage() {
  return (
    <PageShell>
      <PixelLink variant="secondary" href="/" className="inline-flex items-center self-start px-4 text-sm">
        <span aria-hidden="true">←&nbsp;</span>Back to bus search
      </PixelLink>
      <PageTitle>Plan your trip</PageTitle>
      <PlanForm />
    </PageShell>
  );
}
