import type { Metadata } from "next";
import Link from "next/link";
import PlanForm from "@/components/PlanForm";
import { UI } from "@/components/planUi";

export const metadata: Metadata = {
  title: "Plan your trip · Tara Gala",
};

// Not linked from home until TG-21 ships the rest of the planner form
export default function PlanPage() {
  return (
    <main className="mx-auto w-full max-w-md flex-1 px-4 py-6 flex flex-col gap-5">
      <Link href="/" className={UI.backLink}>
        <span aria-hidden="true">←&nbsp;</span>Back to bus search
      </Link>
      <h1 className={UI.h1}>Plan your trip</h1>
      <PlanForm />
    </main>
  );
}
