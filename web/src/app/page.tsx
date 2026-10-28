import Link from "next/link";
import TripSearch from "@/components/TripSearch";

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-md flex-1 px-4 py-6 flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-extrabold tracking-tight text-brand">Tara Gala</h1>
        <p className="text-sm text-muted">Every Manila to Baguio bus, straight from the operators.</p>
      </header>
      <TripSearch />
      <Link
        href="/baguio"
        className="min-h-11 flex items-center rounded-xl border border-border bg-card px-4 py-3 text-sm font-semibold"
      >
        <span>
          In Baguio? Jeeps, taxis and walks from the terminal <span aria-hidden>→</span>
        </span>
      </Link>
      <footer className="mt-auto pt-6 text-xs text-muted">
        Getting to the terminal?{" "}
        <a href="https://sakay.ph" target="_blank" rel="noreferrer" className="underline">
          Sakay.ph
        </a>{" "}
        or{" "}
        <a href="https://maps.google.com" target="_blank" rel="noreferrer" className="underline">
          Google Maps
        </a>
        .
      </footer>
    </main>
  );
}
