import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Tara Gala",
    short_name: "Tara Gala",
    description: "Every Manila to Baguio bus, plus how to get around once you're there.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#fbf7ee",
    theme_color: "#167856",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
