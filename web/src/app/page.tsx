import { PageShell, PageTitle, PixelLink } from "@/components/pixel";
import HomeDecor from "@/components/HomeDecor";
import TripSearch from "@/components/TripSearch";
import { flags } from "@/lib/flags";
import { formMode } from "@/lib/planForm";

export default function Home() {
  return (
    <PageShell>
      <header className="flex flex-col gap-1">
        <PageTitle>Tara Gala</PageTitle>
        <p className="text-sm text-muted md:max-w-prose">Every Manila to Baguio bus, straight from the operators.</p>
      </header>
      <HomeDecor />
      <TripSearch />
      <PixelLink variant="secondary" href="/baguio" className="flex items-center px-4 py-3 text-sm md:self-start">
        <span>
          In Baguio? Jeeps, taxis and walks from the terminal <span aria-hidden>→</span>
        </span>
      </PixelLink>
      {formMode(flags) !== "none" && (
        <PixelLink variant="secondary" href="/plan" className="flex items-center px-4 py-3 text-sm md:self-start">
          <span>
            Plan a Baguio trip <span aria-hidden>→</span>
          </span>
        </PixelLink>
      )}
      <footer className="mt-auto pt-6 text-xs text-muted">Directions to your terminal are on each trip.</footer>
    </PageShell>
  );
}
