import { PageTitle, PixelLink } from "@/components/pixel";
import TripSearch from "@/components/TripSearch";

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-md flex-1 px-4 py-6 flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <PageTitle>Tara Gala</PageTitle>
        <p className="text-sm text-muted">Every Manila to Baguio bus, straight from the operators.</p>
      </header>
      <TripSearch />
      <PixelLink variant="secondary" href="/baguio" className="flex items-center px-4 py-3 text-sm">
        <span>
          In Baguio? Jeeps, taxis and walks from the terminal <span aria-hidden>→</span>
        </span>
      </PixelLink>
      <footer className="mt-auto pt-6 text-xs text-muted">Directions to your terminal are on each trip.</footer>
    </main>
  );
}
