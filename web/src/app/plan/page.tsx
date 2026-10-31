import type { Metadata } from "next";
import PlanForm from "@/components/PlanForm";
import { PageShell, PageTitle } from "@/components/pixel";

export const metadata: Metadata = {
  title: "Plan your trip · Tara Gala",
};

// Not linked from home until TG-21 ships the rest of the planner form
export default function PlanPage() {
  return (
    <PageShell>
      <PageTitle>Plan your trip</PageTitle>
      <PlanForm />
    </PageShell>
  );
}
