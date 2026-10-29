import { PageShell } from "@/components/pixel";
import HomeDecor from "@/components/HomeDecor";
import TripSearch from "@/components/TripSearch";
import Hero from "@/components/landing/Hero";
import HowItWorks from "@/components/landing/HowItWorks";
import PremadeTrips from "@/components/landing/PremadeTrips";
import QuickActions from "@/components/landing/QuickActions";
import Trust from "@/components/landing/Trust";

export default function Home() {
  return (
    <PageShell>
      <Hero />
      <TripSearch />
      <QuickActions />
      <PremadeTrips />
      <HowItWorks />
      <Trust />
      <HomeDecor />
      <footer className="mt-auto pt-6 text-xs text-muted">
        <p>Directions to your terminal are on each trip.</p>
        <p>Tara Gala isn&apos;t affiliated with any bus operator. Ingat sa biyahe!</p>
      </footer>
    </PageShell>
  );
}
