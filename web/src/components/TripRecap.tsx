"use client";

// TG-64: the trip page's Trip recap box (ux.md §2). It turns the read-only recap link on and off, and picks what the
// recap shows: map only until someone picks more. Every change is one PUT with all three choices; turning it off
// resets them on the server (owner decision 3), so the box never shows choices left from an earlier link.

import { useRef, useState } from "react";
import { PX, PixelBox, PixelButton, PixelChoice, SectionTitle, cx } from "@/components/pixel";
import { runShare, shareDeps } from "@/lib/itinerary";
import { type RecapChoice, type RecapPeople, type RecapSpending, type Trip, type TripResult, RECAP_OFF, tripApi } from "@/lib/trip";

const MAP_ONLY: RecapChoice = { photos: RECAP_OFF.photos, people: RECAP_OFF.people, spending: RECAP_OFF.spending };
const NEVER = "Never on it: tickets, QRs, the hotel booking (its address, reference and notes), who owes whom, or this trip's link. The map shows the plan's places and notes as written, including where you're staying and any names.";
const ANYONE = " Anyone with the recap link can see it.";
const PEOPLE: [RecapPeople, string, string][] = [
  ["none", "Just how many came", "shows only how many came now"],
  ["names", "Names and arrival times", "shows names now"],
  ["names_photos", "Names, times and profile photos", "shows names and profile photos now"],
];
const SPENDING: [RecapSpending, string, string][] = [
  ["none", "Don't show", "hides spending now"],
  ["total", "The group's total", "shows the group's total now"],
];

type Part = keyof RecapChoice;

export default function TripRecap({ trip, busy, online, apply }: {
  trip: Trip;
  busy: boolean;
  online: boolean;
  apply: (action: string, op: () => Promise<TripResult>) => Promise<TripResult>;
}) {
  const slug = trip.share_slug;
  const saved = trip.recap ?? RECAP_OFF;
  const on = !!saved.slug;
  const holding = useRef(false); // a write is out: set in the handlers, so a second tap in the same tick sees it
  const [offChoice, setOffChoice] = useState<RecapChoice>(MAP_ONLY); // picked before it's on, sent with Turn on
  const [pending, setPending] = useState<RecapChoice | null>(null); // a change on its way: shown until the answer
  const [said, setSaid] = useState("");
  const [failed, setFailed] = useState("");
  const [shared, setShared] = useState<{ text: string; url?: string } | null>(null);
  const shown: RecapChoice = on ? (pending ?? { photos: saved.photos, people: saved.people, spending: saved.spending }) : offChoice;
  const held = !online || busy || undefined;

  /** The one write that turns it on or changes it. Each answer is the whole trip, so one at a time (TG-54) */
  async function save(choice: RecapChoice, action: string): Promise<boolean> {
    if (holding.current || busy || !online) return false;
    holding.current = true;
    setFailed("");
    setSaid("");
    const r = await apply(action, () => tripApi.setRecap(slug, { photos: choice.photos, people: choice.people, spending: choice.spending }));
    holding.current = false;
    setPending(null); // the answer's settings, or back to the last saved ones
    if (!r.ok) setFailed("Couldn't save that. Try again with signal.");
    return r.ok;
  }

  async function change<P extends Part>(part: P, value: RecapChoice[P], clause: string) {
    if (holding.current || !online || busy) return;
    const next = { ...shown, [part]: value };
    if (!on) return setOffChoice(next);
    console.info("[tg-trip] recap-set %s", part);
    setPending(next);
    if (await save(next, "recap-set")) setSaid(`Saved. The recap ${clause}.`);
  }

  async function onTurnOn() {
    if (holding.current || !online || busy) return;
    console.info("[tg-trip] recap-on photos=%s people=%s spending=%s", shown.photos, shown.people, shown.spending);
    if (await save(shown, "recap-on")) setSaid("The recap link is on.");
  }

  async function onTurnOff() {
    if (holding.current || !online || busy) return;
    if (!window.confirm("Turn off the recap link? It stops working for everyone who has it. Turning it on again makes a new link, starting from the map only.")) return;
    console.info("[tg-trip] recap-off");
    holding.current = true;
    setFailed("");
    const r = await apply("recap-off", () => tripApi.stopRecap(slug));
    holding.current = false;
    if (!r.ok) return setFailed("Couldn't save that. Try again with signal.");
    setOffChoice(MAP_ONLY);
    setShared(null);
    setSaid("The recap link is off.");
  }

  /** Shares the recap's own link, never the trip's */
  async function onShare() {
    if (!saved.slug) return;
    setShared(null);
    const url = `${window.location.origin}/r/${saved.slug}`;
    const outcome = await runShare(shareDeps(navigator), { title: "Tara Gala trip recap", text: `How "${trip.name}" went, on Tara Gala.`, url });
    console.info("[tg-trip] recap-share outcome=%s", outcome);
    if (outcome === "copied") setShared({ text: "Link copied. Send it to whoever you like." });
    if (outcome === "manual") setShared({ text: "Copy this link and send it to whoever you like.", url });
  }

  return (
    <PixelBox as="section" aria-labelledby="recap-title" className="flex min-w-0 flex-col gap-3 p-4">
      <SectionTitle id="recap-title">Trip recap</SectionTitle>
      {on ? (
        <div className="flex flex-col gap-1 text-sm">
          <p className="font-semibold">The recap link is on.</p>
          <p>{"Anyone with it sees the map and what's picked below. Changes show at once."}</p>
        </div>
      ) : (
        <p className="text-sm">A read-only page of the trip to share with anyone: the map as you went, with the times you ticked each stop. Add only what you pick below.</p>
      )}
      {on && (
        <div className="flex flex-wrap gap-2">
          <PixelButton variant="secondary" onClick={onShare}>
            Share recap link
          </PixelButton>
          <a className={cx(PX.btn.secondary.skin, PX.btn.secondary.layout)} href={`/r/${saved.slug}`} target="_blank" rel="noopener noreferrer">
            Open the recap<span aria-hidden="true">&nbsp;↗</span>
          </a>
        </div>
      )}
      {shared && (
        <div className="flex flex-col gap-1 text-sm">
          <p>{shared.text}</p>
          {shared.url && <p className="font-semibold break-all select-all">{shared.url}</p>}
        </div>
      )}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-semibold">Photos</legend>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 h-6 w-6 shrink-0" checked={shown.photos} aria-disabled={!online || held}
            onChange={(e) => change("photos", e.target.checked, e.target.checked ? "shows the album now" : "hides the album now")} />
          <span>Show the album. Faces of the group may be in it.</span>
        </label>
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-semibold">People</legend>
        <div className="flex flex-wrap gap-2">
          {PEOPLE.map(([value, label, clause]) => (
            <PixelChoice key={value} name="recap-people" value={value} checked={shown.people === value} inputProps={{ "aria-disabled": held }}
              onChange={() => change("people", value, clause)}>
              {label}
            </PixelChoice>
          ))}
        </div>
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-semibold">Spending</legend>
        <div className="flex flex-wrap gap-2">
          {SPENDING.map(([value, label, clause]) => (
            <PixelChoice key={value} name="recap-spending" value={value} checked={shown.spending === value} inputProps={{ "aria-disabled": held }}
              onChange={() => change("spending", value, clause)}>
              {label}
            </PixelChoice>
          ))}
        </div>
      </fieldset>
      <p role="status" className="text-sm empty:sr-only">{said}</p>
      {failed && <PixelBox as="p" tone="alertText" role="alert" className="p-3 text-sm">{failed}</PixelBox>}
      <p className={PX.meta}>{NEVER}{on ? "" : ANYONE}</p>
      {!online && <p className={PX.meta}>Changing the recap needs signal.</p>}
      <PixelButton variant="secondary" className="self-start" aria-disabled={!online || held} onClick={on ? onTurnOff : onTurnOn}>
        {on ? "Turn off the recap link" : "Turn on the recap link"}
      </PixelButton>
    </PixelBox>
  );
}
