import type { Metadata } from "next";
import Link from "next/link";
import LastMile from "@/components/LastMile";

export const metadata: Metadata = {
  title: "Getting around Baguio · Tara Gala",
};

export default function BaguioPage() {
  return (
    <main className="mx-auto w-full max-w-md flex-1 px-4 py-6 flex flex-col gap-5">
      <Link href="/" className="min-h-11 inline-flex items-center self-start text-sm underline">
        <span aria-hidden>←&nbsp;</span>Back to bus search
      </Link>
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-extrabold tracking-tight text-brand">Getting around Baguio</h1>
        <p className="text-sm text-muted">Jeeps, taxis and walks from the bus terminal to the top spots.</p>
      </header>
      <LastMile />
    </main>
  );
}
