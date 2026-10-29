"use client";

// Loads one saved plan in the browser (so the TG-27 service worker caches it) and shows its state:
// loading, found, not found, or error with Try again (TG-23, ux.md 5 and 6).
import { useEffect, useState } from "react";
import { fetchItinerary } from "@/lib/api";
import { isValidSlug, type Itinerary } from "@/lib/itinerary";
import ItineraryList from "@/components/ItineraryList";
import { flags } from "@/lib/flags";
import { PixelBox, PixelButton, PixelLink } from "@/components/pixel";

type State =
  | { kind: "loading" }
  | { kind: "found"; itinerary: Itinerary }
  | { kind: "notfound" }
  | { kind: "error"; retrying: boolean };

const LOADING = "Loading your trip...";
const NOT_FOUND = "We couldn't find that trip plan.";
const NOT_FOUND_BODY = "The link may be mistyped, or the plan was removed. Check the link with whoever sent it.";
const ERROR = "Could not load this trip plan. Check your connection and try again.";

async function loadState(slug: string): Promise<State> {
  try {
    const itinerary = await fetchItinerary(slug);
    return itinerary ? { kind: "found", itinerary } : { kind: "notfound" };
  } catch (e) {
    // Only our own "API error 503" text, else the error's name: a JSON SyntaxError message can quote the body,
    // which holds party names and the budget
    const detail = e instanceof Error ? (/^API error \d{3}$/.test(e.message) ? e.message : e.name) : "error";
    console.warn("[tg-itinerary] load failed", detail);
    return { kind: "error", retrying: false };
  }
}

export default function ItineraryView({ slug }: { slug: string }) {
  const valid = isValidSlug(slug);
  const [state, setState] = useState<State>(valid ? { kind: "loading" } : { kind: "notfound" });

  useEffect(() => {
    if (!valid) return; // an invalid slug shows the 404 without a request
    let live = true;
    loadState(slug).then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, [slug, valid]);

  function retry() {
    if (state.kind === "error" && state.retrying) return; // aria-disabled, not disabled: focus stays on the button
    setState({ kind: "error", retrying: true });
    loadState(slug).then(setState);
  }

  const announce =
    state.kind === "loading" ? LOADING
    : state.kind === "found" ? "Trip plan loaded."
    : state.kind === "notfound" ? NOT_FOUND
    : state.retrying ? LOADING
    : ERROR;

  return (
    <>
      <p role="status" className="sr-only">
        {announce}
      </p>
      {state.kind === "loading" && <p className="text-sm text-muted">{LOADING}</p>}
      {state.kind === "found" && <ItineraryList itinerary={state.itinerary} map={flags.overworldMap} />}
      {state.kind === "notfound" && (
        <PixelBox tone="alert" className="p-4 flex flex-col items-start gap-3">
          <p className="text-sm font-bold text-danger-text">{NOT_FOUND}</p>
          <p className="text-sm">{NOT_FOUND_BODY}</p>
          <PixelLink variant="secondary" href="/">
            Search buses
          </PixelLink>
        </PixelBox>
      )}
      {state.kind === "error" && (
        <PixelBox tone="alert" className="p-4 flex flex-col items-start gap-3">
          <p className="text-sm text-danger-text">{ERROR}</p>
          <PixelButton variant="secondary" aria-disabled={state.retrying || undefined} onClick={retry}>
            {state.retrying ? "Loading..." : "Try again"}
          </PixelButton>
        </PixelBox>
      )}
    </>
  );
}
