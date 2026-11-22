import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageShell, PageTitle, PixelCardLink } from "@/components/pixel";
import { AROUND_CITIES, AROUND_WORDS } from "@/lib/around";
import { flags } from "@/lib/flags";

export const metadata: Metadata = {
  title: `${AROUND_WORDS.title} · Tara Gala`,
};

/** TG-71/72 (aroundTab): the Around tab. One card per city we've checked, each to its own Getting around page. */
export default function AroundPage() {
  if (!flags.aroundTab) notFound();
  return (
    <PageShell>
      <header className="flex flex-col gap-1">
        <PageTitle className="text-balance">{AROUND_WORDS.title}</PageTitle>
        <p className="text-sm text-muted md:max-w-prose">{AROUND_WORDS.intro}</p>
      </header>
      <ul className="flex flex-col gap-3 md:grid md:grid-cols-2 md:gap-4">
        {AROUND_CITIES.map((c) => (
          <li key={c.slug} className="grid">
            <PixelCardLink href={`/around/${c.slug}`} className="flex items-center justify-between gap-3 p-4">
              <span className="flex min-w-0 flex-col gap-1">
                <span className="font-bold">{c.name}</span>
                <span className="text-sm text-muted">{c.blurb}</span>
              </span>
              <span aria-hidden="true">→</span>
            </PixelCardLink>
          </li>
        ))}
      </ul>
    </PageShell>
  );
}
