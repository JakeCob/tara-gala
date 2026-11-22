// TG-72 (flag ambaganTab): the words of the Ambagan tab, the shared wallets' own tab. Owner, 2026-11-22: "Ambagan" is
// the name and everything else is plain English, so one for a dinner or rent reads as right as one for a trip.
// Pure TS so `node --test` runs it. A wallet that belongs to a trip keeps its budget lines (TG-62), untouched here.

export const AMBAGAN_WORDS = {
  tab: "Ambagan",
  title: "Ambagan",
  intro: "Split costs with your barkada: who paid what, and who pays whom at the end.",
  listTitle: "On this phone",
  listEmpty: "No ambagan on this phone yet. Start one below, or open the link a friend shared with you.",
  startTitle: "Start an ambagan",
  startLine: "Everyone logs what they paid from their own phone. At the end, it works out who pays whom.",
  nameLabel: "What's it for?",
  namePlaceholder: "Like Sagada trip, Friday dinner, rent",
  nameEmpty: "Say what it's for first.",
  start: "Start the ambagan",
  starting: "Starting...",
  back: "Back to Ambagan",
  all: "All ambagan",
  shareTitle: "Tara Gala ambagan",
  tripCard: "Who paid what, and who pays whom at the end.",
  ticketsBack: "Back to my trip",
  opening: "Opening the ambagan...",
} as const;
