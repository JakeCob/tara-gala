import type { Metadata } from "next";
import { notFound } from "next/navigation";
import LastMile from "@/components/LastMile";
import WarmLegs from "@/components/WarmLegs";
import { PageShell, PageTitle, PixelLink } from "@/components/pixel";
import { AROUND_CITIES, AROUND_WORDS, aroundCity } from "@/lib/around";
import { flags } from "@/lib/flags";

// Only the cities we've checked are built; any other slug is a 404 (notFound below). cacheComponents rules out
// dynamicParams here.
export const generateStaticParams = () => AROUND_CITIES.map((c) => ({ city: c.slug }));

export async function generateMetadata({ params }: PageProps<"/around/[city]">): Promise<Metadata> {
  const city = aroundCity((await params).city);
  return { title: `${AROUND_WORDS.pageTitle(city?.name ?? "")} · Tara Gala` };
}

/** TG-71/72 (aroundTab): one city's Getting around page. Baguio's is today's /baguio, which now comes here. */
export default async function AroundCityPage({ params }: PageProps<"/around/[city]">) {
  const city = aroundCity((await params).city);
  if (!flags.aroundTab || !city) notFound();
  return (
    <PageShell>
      <PixelLink variant="secondary" href="/around" className="inline-flex items-center self-start px-4 text-sm">
        <span aria-hidden="true">←&nbsp;</span>All places
      </PixelLink>
      <header className="flex flex-col gap-1">
        <PageTitle className="text-balance">{AROUND_WORDS.pageTitle(city.name)}</PageTitle>
        <p className="text-sm text-muted md:max-w-prose">{city.blurb}</p>
      </header>
      <LastMile key={city.slug} city={city} />
      {/* Pre-trip check 2026-11-23: every start saved for offline; Baguio stays as it was (it asks for nothing until a tap) */}
      {city.slug !== "baguio" && <WarmLegs city={city} />}
    </PageShell>
  );
}
