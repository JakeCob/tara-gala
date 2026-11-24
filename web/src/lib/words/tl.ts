// TG-74 the Tagalog words of area 1 (tabs, header and title screen), from Claude's draft for the owner to check,
// _team/tickets/TG-74/words-tl-area1.md. Everyday Taglish: Tagalog sentences, English words where people use them.
// "Ambagan" stays "Ambagan" in every language (owner). `satisfies Words`: a missing or extra key fails tsc.
// Pure TS so `node --test` runs it.
import type { Words } from "./en.ts";

export const TL = {
  picker: {
    label: "Wika", // alt: Language
    choose: "Pumili ng wika",
  },
  tabs: {
    nav: "Pangunahing menu",
    buses: "Bus", // Taglish uses "bus" for one or many
    plan: "Plan", // alt: Plano
    baguio: "Baguio", // a place name, never translated
    around: "Libot", // alt: Ikot
    trip: "Trip", // alt: Lakad
    ambagan: "Ambagan",
  },
  header: {
    darkMode: "Dark mode", // alt: Madilim na kulay
    on: "On",
    off: "Off",
  },
  title: {
    tagline: "Bus pa-probinsya, diretso galing sa operators.",
    pressStart: "Press start", // alt: Pindot para magsimula
    findBuses: "Maghanap ng bus",
    planTrip: "Magplano ng trip",
    gettingAround: "Paano mag-libot", // alt: Pag-ikot sa lugar
    myTrip: "Trip ko",
    ambagan: "Ambagan",
  },
} satisfies Words;
