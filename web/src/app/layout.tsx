import type { Metadata, Viewport } from "next";
import { Nunito, Pixelify_Sans } from "next/font/google";
import OfflineBanner from "@/components/OfflineBanner";
import ServiceWorkerManager from "@/components/ServiceWorkerManager";
import "./globals.css";

// Self-hosted by next/font under /_next/static/media (no runtime requests to Google). Pixelify is for static
// headings only: it has no ₱ or → (ux-guide 2.2).
const nunito = Nunito({ subsets: ["latin", "latin-ext"], display: "swap", variable: "--font-nunito" });
const pixelify = Pixelify_Sans({ subsets: ["latin"], display: "swap", variable: "--font-pixelify" });

export const metadata: Metadata = {
  title: "Tara Gala",
  description: "Every Manila to Baguio bus, plus how to get around once you're there.",
  appleWebApp: { capable: true, title: "Tara Gala", statusBarStyle: "default" },
  icons: { apple: "/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#167856",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${nunito.variable} ${pixelify.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <OfflineBanner />
        {children}
        <ServiceWorkerManager />
      </body>
    </html>
  );
}
