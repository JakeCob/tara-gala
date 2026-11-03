"use client";

// TG-58: the trip's list of people, directly under its header. One box with faces, chosen by the date and the buttons:
// Who's coming, Who's here (the arrival check at the first meet-up) and the edit list. Every result stays next to its
// control, never in the trip's notice area: on a long list that's off-screen (TG-53). Anyone with the trip's link can
// change all of it, and nothing here writes to the wallet: the two lists only meet in one copy of the wallet's names.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { PX, PixelBox, PixelButton, SectionTitle, cx } from "@/components/pixel";
import { BlobImage } from "@/components/PhotoViewer";
import { ACCEPT, picked, useFile } from "@/components/TripFiles";
import { manilaToday } from "@/lib/api";
import type { Guide } from "@/lib/guide";
import {
  type Attendee, type Rsvp, arrivalInput, arrivalTime, comingLines, comingSummary, correctedAt, expected, meetLine, openFace, peopleOf, waitingLine,
} from "@/lib/people";
import { fitAvatar } from "@/lib/shrink";
import { type Trip, type TripFile, type TripResult, tripApi, tripFailureMessage } from "@/lib/trip";
import { walletApi } from "@/lib/wallet";

type Open = "here" | "edit" | null;
type Failed = { row: string; text: string }; // row: a person's id, or the form or button it belongs to
const ANSWERS: { value: Rsvp; label: string }[] = [{ value: "yes", label: "Coming" }, { value: "no", label: "Can't make it" }, { value: "pending", label: "No answer yet" }];
const AVATAR_BOX = "h-10 w-10 shrink-0 border-2 border-frame bg-screen-paper object-cover text-screen-ink";
const ROW = "border-b-2 border-border last:border-b-0 md:[&:nth-last-child(2):nth-child(odd)]:border-b-0";
const ROWS = "flex flex-col md:grid md:grid-cols-2 md:gap-x-6";
const ADD = "people-add";
const answerId = (id: string) => `people-answer-${id}`;

/** The alert under a row or form. It brings itself into view: on the last of 20 rows, below it may be under the tab bar. */
function Alert({ text }: { text: string }) {
  const here = useRef<HTMLDivElement>(null);
  useEffect(() => here.current?.scrollIntoView({ block: "nearest" }), [text]);
  return (
    <div ref={here} className="scroll-mt-16 scroll-mb-24 pb-1">
      <PixelBox as="p" tone="alertText" role="alert" className="p-3 text-sm">
        {text}
      </PixelBox>
    </div>
  );
}

function Avatar({ slug, file, name }: { slug: string; file: TripFile | undefined; name: string }) {
  const blob = useFile(slug, file);
  if (blob) return <BlobImage blob={blob} alt="" width={40} height={40} className={AVATAR_BOX} />;
  return (
    <span aria-hidden="true" className={cx(AVATAR_BOX, "inline-flex items-center justify-center text-sm font-bold")}>
      {[...name][0]?.toUpperCase()}
    </span>
  );
}

export default function TripPeople({ trip, plan, apply }: {
  trip: Trip;
  plan: Guide | "frame" | null;
  apply: (action: string, op: () => Promise<TripResult>) => Promise<TripResult>;
}) {
  const slug = trip.share_slug;
  const list = peopleOf(trip);
  const walletSlug = list.length === 0 ? trip.wallet?.share_slug : undefined;
  const holding = useRef(false); // a write is out: set in the handlers, so a second tap in the same tick sees it
  const forWho = useRef<Attendee | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<Open | undefined>(undefined); // undefined: nobody has tapped, so the date decides
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<Failed | null>(null);
  const [said, setSaid] = useState("");
  const [name, setName] = useState("");
  const [fixing, setFixing] = useState<{ id: string; time: string } | null>(null);
  const [walletNames, setWalletNames] = useState<{ wallet: string; count: number } | null>(null);

  useEffect(() => {
    if (!walletSlug) return;
    let live = true;
    walletApi.get(walletSlug).then((r) => live && r.ok && setWalletNames({ wallet: walletSlug, count: r.wallet.members.length }));
    return () => {
      live = false;
    };
  }, [walletSlug]);

  const open = chosen === undefined ? (openFace(manilaToday(), trip) === "here" ? "here" : null) : chosen;
  const face = list.length === 0 ? "empty" : (open ?? "coming");
  const wide = face === "here" || face === "edit";
  const copyCount = walletNames?.wallet === walletSlug ? (walletNames?.count ?? 0) : 0;
  const off = saving || undefined;
  const fileOf = (id: string) => trip.files.find((f) => f.kind === "avatar" && f.attendee_id === id);
  const problem = (row: string) => (failed?.row === row ? <Alert text={failed.text} /> : null);

  /** One write at a time across the box: each answer is the whole trip, so two could land out of order and hide a tap. */
  async function save(row: string, action: string, op: () => Promise<TripResult>): Promise<TripResult | null> {
    if (holding.current) return null;
    holding.current = true;
    setSaving(true);
    setFailed(null);
    const r = await apply(action, op);
    holding.current = false;
    setSaving(false);
    if (!r.ok) setFailed({ row, text: tripFailureMessage(r) });
    return r;
  }

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    const typed = name.trim();
    if (!typed) return setFailed({ row: "add", text: "Type a name first." });
    const r = await save("add", "attendee-add", () => tripApi.addAttendee(slug, typed));
    if (!r?.ok) return;
    setName("");
    setChosen("edit"); // the form stays, for the next name
    requestAnimationFrame(() => document.getElementById(ADD)?.focus());
  }

  async function onRemove(p: Attendee) {
    if (holding.current || !window.confirm(`Remove ${p.name} from this list? Their answer, arrival time and photo are deleted from the server, not from phones that already saved the trip. The wallet doesn't change.`)) return;
    const next = list[list.findIndex((x) => x.id === p.id) + 1];
    const r = await save(p.id, "attendee-remove", () => tripApi.removeAttendee(slug, p.id));
    if (r?.ok) requestAnimationFrame(() => document.getElementById(next ? answerId(next.id) : ADD)?.focus());
  }

  async function onHere(p: Attendee) {
    const r = await save(p.id, "arrival-set", () => tripApi.arrive(slug, p.id));
    const at = r?.ok && peopleOf(r.trip).find((x) => x.id === p.id)?.arrived_at;
    if (at) setSaid(`${p.name} is here, ${arrivalTime(at)}.`);
  }

  async function onUndo(p: Attendee) {
    const r = await save(p.id, "arrival-clear", () => tripApi.clearArrival(slug, p.id));
    if (r?.ok) setSaid(`${p.name} is no longer marked here.`);
  }

  async function onFix(e: FormEvent, p: Attendee) {
    e.preventDefault();
    const at = fixing && p.arrived_at && correctedAt(p.arrived_at, fixing.time);
    if (!at) return setFailed({ row: p.id, text: "Pick a time first." });
    const r = await save(p.id, "arrival-fix", () => tripApi.arrive(slug, p.id, at));
    if (r?.ok) setFixing(null);
  }

  function pickFor(p: Attendee) {
    if (holding.current) return;
    forWho.current = p;
    picker.current?.click();
  }

  async function onPick() {
    const who = forWho.current;
    const p = picker.current && (await picked(picker.current, fitAvatar));
    if (!p || !who) return;
    if ("problem" in p) return setFailed({ row: who.id, text: p.problem });
    await save(who.id, "avatar-add", () => tripApi.addFile(slug, "avatar", p.picture, { attendee_id: who.id }));
  }

  return (
    <PixelBox as="section" aria-labelledby="people-title" className={cx("flex min-w-0 flex-col gap-3 p-4", wide && "md:col-span-2")}>
      <SectionTitle id="people-title">{face === "here" ? "Who's here" : "Who's coming"}</SectionTitle>
      <p role="status" className="sr-only">{said}</p>
      {face === "empty" && <p className="text-sm text-muted">No names yet. Add the people you&apos;re asking.</p>}

      {face === "coming" && (
        <>
          <p className="text-sm font-semibold">{comingSummary(list)}</p>
          {comingLines(list).map((line) => (
            <p key={line} className="min-w-0 text-sm break-words">{line}</p>
          ))}
        </>
      )}

      {face === "here" && (
        <>
          {/* Holds its height until the plan has loaded or failed, so First meet-up never flashes on a trip with a plan */}
          <p className="min-h-6 text-base font-bold break-words">{plan === "frame" ? "" : meetLine(plan, trip.marks)}</p>
          <p className="text-sm break-words">{waitingLine(list)}</p>
          <ul className={ROWS}>
            {expected(list).map((p) => (
              <li key={p.id} className={ROW}>
                <div className="flex items-center gap-3 py-2">
                  <Avatar slug={slug} file={fileOf(p.id)} name={p.name} />
                  <span className="min-w-0 flex-1 break-words">{p.name}</span>
                  {p.arrived_at && (
                    <button type="button" className="focus-pixel min-h-11 text-sm whitespace-nowrap tabular-nums underline underline-offset-2" aria-label={`Change ${p.name}'s time`}
                      aria-expanded={fixing?.id === p.id} onClick={() => setFixing(fixing?.id === p.id ? null : { id: p.id, time: arrivalInput(p.arrived_at ?? "") })}>
                      {arrivalTime(p.arrived_at)}
                    </button>
                  )}
                  {/* One button, so focus stays in the row when it changes */}
                  <PixelButton variant="secondary" aria-label={p.arrived_at ? `Undo ${p.name}'s arrival` : `Mark ${p.name} here`} aria-disabled={off}
                    onClick={() => (p.arrived_at ? onUndo(p) : onHere(p))}>
                    {p.arrived_at ? "Undo" : "Here"}
                  </PixelButton>
                </div>
                {fixing?.id === p.id && p.arrived_at && (
                  <form onSubmit={(e) => onFix(e, p)} noValidate className="flex flex-wrap items-end gap-2 pb-3">
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="font-semibold">{`${p.name}'s time`}</span>
                      <input type="time" className={PX.input} value={fixing.time} onChange={(e) => setFixing({ id: p.id, time: e.target.value })} />
                    </label>
                    <PixelButton type="submit" variant="secondary" aria-disabled={off}>Save</PixelButton>
                    <PixelButton variant="secondary" onClick={() => setFixing(null)}>Cancel</PixelButton>
                  </form>
                )}
                {problem(p.id)}
              </li>
            ))}
          </ul>
          <p className={PX.meta}>Tap your name when you get there, or tap for a friend.</p>
        </>
      )}

      {face === "edit" && (
        <ul className={ROWS}>
          {list.map((p) => {
            const photo = fileOf(p.id);
            return (
              <li key={p.id} className={ROW}>
                <div className="grid grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] items-center gap-x-2 gap-y-1 py-2">
                  <PixelButton variant="icon" className="row-span-2 inline-flex items-center justify-center self-start" aria-label={`${photo ? "Change" : "Add"} ${p.name}'s photo`}
                    aria-disabled={off} onClick={() => pickFor(p)}>
                    <Avatar slug={slug} file={photo} name={p.name} />
                  </PixelButton>
                  <span className="min-w-0 font-semibold break-words">{p.name}</span>
                  <PixelButton variant="icon" className="row-span-2 inline-flex items-center justify-center self-start max-[359px]:row-span-1" aria-label={`Remove ${p.name}`} aria-disabled={off} onClick={() => onRemove(p)}>
                    <span aria-hidden="true">✕</span>
                  </PixelButton>
                  <select id={answerId(p.id)} aria-label={`${p.name}'s answer`} className={cx(PX.input, "w-full min-w-0 max-[359px]:col-span-2")} value={p.rsvp}
                    onChange={(e) => save(p.id, "attendee-answer", () => tripApi.setAnswer(slug, p.id, e.target.value as Rsvp))}>
                    {ANSWERS.map((a) => (
                      <option key={a.value} value={a.value}>{a.label}</option>
                    ))}
                  </select>
                </div>
                {photo && (
                  <div className="pb-2 pl-[3.25rem]">
                    <PixelButton variant="secondary" aria-label={`Remove ${p.name}'s photo`} aria-disabled={off}
                      onClick={() => !holding.current && window.confirm(`Remove ${p.name}'s photo? It's deleted from the server, not from phones that already saved the trip.`) && save(p.id, "avatar-remove", () => tripApi.deleteFile(slug, photo.id))}>
                      Remove photo
                    </PixelButton>
                  </div>
                )}
                {problem(p.id)}
              </li>
            );
          })}
        </ul>
      )}

      {(face === "empty" || face === "edit") && (
        <>
          <input ref={picker} type="file" accept={ACCEPT} hidden onChange={onPick} />
          <form onSubmit={onAdd} noValidate className="flex flex-col gap-3">
            <div className="flex items-end gap-2">
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
                <span className="font-semibold">Add a name</span>
                <input id={ADD} className={cx(PX.input, "w-full")} value={name} maxLength={30} autoComplete="off" onChange={(e) => setName(e.target.value)} />
              </label>
              <PixelButton type="submit" variant="secondary" aria-disabled={off}>Add</PixelButton>
            </div>
            {problem("add")}
          </form>
        </>
      )}

      {face === "empty" && copyCount > 0 && (
        <>
          <PixelButton variant="secondary" className="self-start px-4 text-sm" aria-disabled={off} onClick={() => save("wallet", "attendee-copy", () => tripApi.copyWalletNames(slug))}>
            {`Use the wallet's ${copyCount} name${copyCount === 1 ? "" : "s"}`}
          </PixelButton>
          {problem("wallet")}
        </>
      )}

      {face !== "empty" && (
        <div className="flex flex-wrap gap-2">
          {face !== "edit" && (
            <PixelButton variant="secondary" onClick={() => setChosen(face === "here" ? null : "here")}>
              {face === "here" ? "Who's coming" : "Who's here"}
            </PixelButton>
          )}
          <PixelButton variant="secondary" aria-expanded={face === "edit"} onClick={() => setChosen(face === "edit" ? undefined : "edit")}>
            {face === "edit" ? "Close" : "Edit the list"}
          </PixelButton>
        </div>
      )}

      {face === "edit" && (
        <>
          <p className={PX.meta}>Anyone with the trip&apos;s link can change this list.</p>
          <p className={PX.meta}>Everyone with the trip&apos;s link sees these photos. They stay until you remove them or delete the trip. That deletes them from the server, not from phones that already saved the trip.</p>
        </>
      )}
    </PixelBox>
  );
}
