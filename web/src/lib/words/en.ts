// TG-74 the English words of the language picker's area 1: tabs, header and title screen. The keys are shared with
// tl.ts, which must have every one (`satisfies Words`), so a missing Tagalog word fails tsc. Areas not done yet stay
// inline English. Words that already live in AROUND_WORDS or AMBAGAN_WORDS point there, so English has one source.
// Pure TS so `node --test` runs it.
import { AMBAGAN_WORDS } from "../ambagan.ts";
import { AROUND_WORDS } from "../around.ts";

export const EN = {
  picker: {
    /** The title screen menu's row, after the 🌐 */
    label: "Language",
    /** The header's 🌐 button, for screen readers */
    choose: "Choose a language",
  },
  tabs: {
    /** The tab bar and header nav, for screen readers */
    nav: "Main",
    buses: "Buses",
    plan: "Plan",
    baguio: "Baguio",
    around: AROUND_WORDS.tab,
    trip: "Trip",
    ambagan: AMBAGAN_WORDS.tab,
  },
  header: {
    darkMode: "Dark mode",
    on: "On",
    off: "Off",
  },
  title: {
    tagline: AROUND_WORDS.tagline,
    pressStart: "Press start",
    findBuses: "Find buses",
    planTrip: "Plan a trip",
    gettingAround: AROUND_WORDS.menu,
    myTrip: "My trip",
    ambagan: AMBAGAN_WORDS.tab,
  },
};

/** Every language's dictionary has this shape: the same keys, each a string (AROUND_WORDS is `as const`, so widen) */
export type Words = { [S in keyof typeof EN]: { [K in keyof (typeof EN)[S]]: string } };
