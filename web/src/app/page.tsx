import { PageShell } from "@/components/pixel";
import HomeDecor from "@/components/HomeDecor";
import HowItWorks from "@/components/landing/HowItWorks";
import PremadeTrips from "@/components/landing/PremadeTrips";
import TitleScreen from "@/components/landing/TitleScreen";

export default function Home() {
  return (
    <PageShell>
      {/* TG-49: the game title screen; its start menu leads to the tabs, and the bus search lives on /buses */}
      <TitleScreen />
      <PremadeTrips />
      <HowItWorks />
      <HomeDecor />
      <footer className="mt-auto pt-6 text-xs text-muted">
        <p>Directions to your terminal are on each trip.</p>
        <p>Tara Gala isn&apos;t affiliated with any bus operator. Ingat sa biyahe!</p>
      </footer>
    </PageShell>
  );
}
