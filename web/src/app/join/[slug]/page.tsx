import { Suspense } from "react";
import type { Metadata } from "next";
import JoinView from "@/components/JoinView";
import { PageShell } from "@/components/pixel";

// TG-58 PR 2: the invite link. It can only answer yes or no, and never names the trip here, so a chat's link preview
// shows nothing of it. Never indexed, and no referrer.
export const metadata: Metadata = {
  title: "You're invited · Tara Gala",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

// As /t/[slug]: the slug is only known at request time, so this renders per request; the data loads in the browser
export const instant = false

async function SlugView({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <JoinView key={slug} slug={slug} />;
}

export default function InvitePage({ params }: PageProps<"/join/[slug]">) {
  return (
    <PageShell>
      <Suspense fallback={<p className="text-sm text-muted">Opening the invite...</p>}>
        <SlugView params={params} />
      </Suspense>
    </PageShell>
  );
}
