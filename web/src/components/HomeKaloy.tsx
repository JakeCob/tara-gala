"use client";

import { useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { flags } from "@/lib/flags";
import { askChatOnOpen, knownTripsRaw, parseKnownTrips } from "@/lib/trip";
import { KaloyFab } from "./KaloyFab";

const subscribeNothing = () => () => {};

/** The home page's Ask Kaloy goes to the last trip this phone opened (TripView remembers each one it loads, most
 * recent first). No trip on this phone, no button. */
export function homeChatSlug(raw: string | null): string | null {
  return parseKnownTrips(raw)[0]?.slug ?? null;
}

/**
 * TG-75 Ask Kaloy on the home page (owner, 2026-11-24): the chat answers about one plan and the home page has none,
 * so the button opens the last trip this phone opened, with the chat open (a note for this tab, read once). Behind NEXT_PUBLIC_KALOY_FAB_HOME.
 */
export default function HomeKaloy() {
  const router = useRouter();
  const raw = useSyncExternalStore(subscribeNothing, knownTripsRaw, () => null);
  const slug = flags.kaloy && flags.kaloyFab && flags.kaloyFabHome ? homeChatSlug(raw) : null;
  if (!slug) return null;
  return (
    <>
      <KaloyFab from="home" onOpen={() => {
        askChatOnOpen(slug); // the trip page reads it as it mounts: a client move changes the address only after that
        router.push(`/t/${slug}`);
      }} />
      <div aria-hidden="true" className="h-20" /> {/* room at the page's end, so Kaloy never covers the footer */}
    </>
  );
}
