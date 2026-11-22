import type { MetadataRoute } from "next";
import { AROUND_WORDS } from "../lib/around.ts"; // relative: pwa.test.ts imports this file under node
import { flags } from "../lib/flags.ts";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Tara Gala",
    short_name: "Tara Gala",
    description: flags.aroundTab ? AROUND_WORDS.siteDescription : "Every Manila to Baguio bus, plus how to get around once you're there.", // TG-71/72
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#fff8e7",
    theme_color: "#fff8e7",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
