import type { Metadata, Viewport } from "next";
import { Nunito } from "next/font/google";
import localFont from "next/font/local";
import OfflineBanner from "@/components/OfflineBanner";
import ServiceWorkerManager from "@/components/ServiceWorkerManager";
import "./globals.css";

// Self-hosted by next/font under /_next/static/media (no runtime requests to Google). The signboard face (TG-49) is
// Cubao Free by Aaron Amar (OFL, src/fonts/OFL.txt), for static headings only: it has no → (ux-guide 2.2).
const nunito = Nunito({ subsets: ["latin", "latin-ext"], display: "swap", variable: "--font-nunito" });
const sign = localFont({ src: "../fonts/Cubao_Free_Regular.otf", display: "swap", variable: "--font-sign" });

export const metadata: Metadata = {
  title: "Tara Gala",
  description: "Every Manila to Baguio bus, plus how to get around once you're there.",
  appleWebApp: { capable: true, title: "Tara Gala", statusBarStyle: "default" },
  icons: { apple: "/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#fff8e7",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${nunito.variable} ${sign.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <OfflineBanner />
        {children}
        <ServiceWorkerManager />
      </body>
    </html>
  );
}
