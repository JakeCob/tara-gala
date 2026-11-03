"use client";

// TG-58 PR 2: the invite page. A friend picks their name (or types a new one) and says yes or no. It shows only what the
// invite can read: the trip's name and dates, the names and a count. A yes never shows the trip's link: the group sends
// that. This phone remembers its answer for this invite only, so coming back shows it. Every result stays next to its
// control, and logs carry no name.
import { useEffect, useRef, useState } from "react";
import { PX, PageTitle, PixelBox, PixelButton, PixelChoice, SectionTitle, cx } from "@/components/pixel";
import { BlobImage } from "@/components/PhotoViewer";
import { ACCEPT, picked } from "@/components/TripFiles";
import {
  type Answer, type Invite, type InviteFailure, type SavedAnswer, countLine, forgetAnswer, inviteApi, inviteMessage, readAnswer, rememberAnswer,
} from "@/lib/invite";
import { fitAvatar } from "@/lib/shrink";
import { datesLine } from "@/lib/trip";

type Load = { state: "loading" } | { state: "ready"; invite: Invite } | { state: "error"; why: InviteFailure };
type Failed = { at: "field" | "buttons" | "photo"; text: string };
const TITLE = "join-title"; // the PageTitle's id, focused after each answer
const NEW = "new"; // the "I'm not on the list" choice
const COLUMN = "flex flex-col gap-6 md:mx-auto md:w-full md:max-w-[448px]";
const BOX = "flex min-w-0 flex-col gap-3 p-4";
const FIELD = "join-name";
const CHOICE = "flex min-w-0 items-center justify-center px-4 py-2 text-center text-base leading-tight break-words";

function Alert({ text }: { text: string }) {
  const here = useRef<HTMLDivElement>(null);
  useEffect(() => here.current?.scrollIntoView({ block: "nearest" }), [text]);
  return (
    <div ref={here} className="scroll-mt-16 scroll-mb-24">
      <PixelBox as="p" tone="alertText" role="alert" className="p-3 text-sm">
        {text}
      </PixelBox>
    </div>
  );
}

function TripLines({ invite }: { invite: Invite }) {
  return (
    <div className="flex flex-col gap-1">
      <h2 className="text-xl font-bold break-words">{invite.name}</h2>
      <p className="text-sm text-muted">{datesLine(invite.start_date, invite.return_date)}</p>
    </div>
  );
}

export default function JoinView({ slug }: { slug: string }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [mine, setMine] = useState<SavedAnswer | null | undefined>(undefined); // undefined: nothing this visit, so the phone's copy decides
  const [stored, setStored] = useState<SavedAnswer | null>(null);
  const [changing, setChanging] = useState(false);
  const [choice, setChoice] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<Failed | null>(null);
  const [photo, setPhoto] = useState<Blob | null>(null);
  const holding = useRef(false);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    inviteApi.get(slug).then((r) => {
      console.info("[tg-invite] load ok=%s", r.ok ? "yes" : r.why);
      if (!live) return;
      setStored(readAnswer(slug)); // after mount: the server's render has no storage
      setLoad(r.ok ? { state: "ready", invite: r.value } : { state: "error", why: r.why });
    });
    return () => {
      live = false;
    };
  }, [slug]);

  const saved = mine === undefined ? stored : mine;
  const focusTitle = () => requestAnimationFrame(() => document.getElementById(TITLE)?.focus());
  const problem = (at: Failed["at"]) => (failed?.at === at ? <Alert text={failed.text} /> : null);

  if (load.state !== "ready") {
    return (
      <div className={COLUMN}>
        <PageTitle id="join-title" tabIndex={-1}>Tara, sama ka?</PageTitle>
        <PixelBox className={BOX}>
          <p className="text-base">
            {load.state === "loading" ? "Opening the invite..." : load.why === "dead" ? inviteMessage(load) : `${inviteMessage(load)} Reload to try again.`}
          </p>
        </PixelBox>
      </div>
    );
  }

  const invite = load.invite;
  if (invite.closed) {
    return (
      <div className={COLUMN}>
        <PageTitle id="join-title" tabIndex={-1}>Tara, sama ka?</PageTitle>
        <PixelBox className={BOX}>
          <TripLines invite={invite} />
          <p className="text-base">{inviteMessage({ why: "rejected", detail: "invite_closed" })}</p>
        </PixelBox>
      </div>
    );
  }

  const people = invite.people;
  const typing = choice === NEW || people.length === 0;

  async function onAnswer(answer: Answer) {
    if (holding.current) return;
    const typed = name.trim();
    if (!typing && !choice) return setFailed({ at: "buttons", text: "Pick your name first." });
    if (typing && !typed) return setFailed({ at: "field", text: "Type your name first." });
    holding.current = true;
    setSaving(true);
    setFailed(null);
    const r = await inviteApi.answer(slug, typing ? { name: typed } : { attendee_id: choice as string }, answer);
    console.info("[tg-invite] answer ok=%s", r.ok ? "yes" : r.why);
    holding.current = false;
    setSaving(false);
    if (!r.ok) {
      const onField = typing && r.why === "rejected" && (r.detail === "name_taken" || r.detail === "party_full");
      return setFailed({ at: onField ? "field" : "buttons", text: inviteMessage(r) });
    }
    const same = saved?.attendee_id === r.value.attendee_id;
    const next: SavedAnswer = { attendee_id: r.value.attendee_id, name: r.value.name, answer: r.value.answer, ...(same && saved?.photo ? { photo: true } : {}) };
    rememberAnswer(slug, next);
    setMine(next);
    if (!same) setPhoto(null);
    setChanging(false);
    setName("");
    // The count and the list move on with this answer
    void inviteApi.get(slug).then((g) => g.ok && setLoad({ state: "ready", invite: g.value }));
    focusTitle();
  }

  function onChange() {
    setChanging(true);
    setChoice(saved && people.some((p) => p.id === saved.attendee_id) ? saved.attendee_id : null);
    setFailed(null);
    focusTitle();
  }

  function onNotMe() {
    forgetAnswer(slug);
    setMine(null);
    setPhoto(null);
    setChanging(false);
    setChoice(null);
    setFailed(null);
    focusTitle();
  }

  async function onPick() {
    if (!saved || holding.current) return;
    const p = picker.current && (await picked(picker.current, fitAvatar));
    if (!p) return;
    if ("problem" in p) return setFailed({ at: "photo", text: p.problem });
    holding.current = true;
    setSaving(true);
    setFailed(null);
    const r = await inviteApi.addPhoto(slug, saved.attendee_id, p.picture);
    console.info("[tg-invite] photo ok=%s", r.ok ? "yes" : r.why);
    holding.current = false;
    setSaving(false);
    if (!r.ok) return setFailed({ at: "photo", text: inviteMessage(r) });
    const next: SavedAnswer = { ...saved, photo: true };
    rememberAnswer(slug, next);
    setMine(next);
    setPhoto(p.picture);
  }

  const off = saving || undefined;

  if (saved && !changing) {
    const yes = saved.answer === "yes";
    return (
      <div className={COLUMN}>
        <PageTitle id="join-title" tabIndex={-1}>{yes ? "You're in" : "Maybe next time"}</PageTitle>
        <PixelBox className={BOX}>
          <TripLines invite={invite} />
          {yes ? (
            <>
              <p className="text-base font-semibold break-words">{`Thanks, ${saved.name}. See you on the trip.`}</p>
              <p className="text-base">The group will send you the trip&apos;s link.</p>
              {saved.photo ? (
                <div className="flex items-center gap-3">
                  {photo && <BlobImage blob={photo} alt="" width={56} height={56} className="h-14 w-14 shrink-0 border-2 border-frame object-cover" />}
                  <p role="status" className="text-sm">Photo added.</p>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <input ref={picker} type="file" accept={ACCEPT} hidden onChange={onPick} />
                  <PixelButton variant="secondary" className="self-start px-4" aria-disabled={off} onClick={() => !holding.current && picker.current?.click()}>
                    Add your photo
                  </PixelButton>
                  <p className={PX.meta}>
                    Optional. Everyone on the trip will see it. To remove it later, ask the group. That deletes it from the server, not from phones that already saved the trip.
                  </p>
                  {problem("photo")}
                </div>
              )}
            </>
          ) : (
            <p className="text-base break-words">{`Thanks for telling the group, ${saved.name}.`}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <PixelButton variant="secondary" className="px-4" onClick={onChange}>Change my answer</PixelButton>
            <PixelButton variant="secondary" className="px-4" onClick={onNotMe}>{`Not ${saved.name}?`}</PixelButton>
          </div>
        </PixelBox>
      </div>
    );
  }

  return (
    <div className={COLUMN}>
      <PageTitle id="join-title" tabIndex={-1}>Tara, sama ka?</PageTitle>
      <PixelBox className={BOX}>
        <TripLines invite={invite} />
        <p className="text-base">{countLine(invite.coming)}</p>
        {people.length > 0 && (
          <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
            <SectionTitle as="legend" className="mb-2">Which one are you?</SectionTitle>
            <div className="flex flex-wrap gap-2">
              {people.map((p) => (
                <PixelChoice key={p.id} name="join-who" value={p.id} checked={choice === p.id} className={CHOICE}
                  onChange={() => (setChoice(p.id), setFailed(null))}>
                  {p.name}
                </PixelChoice>
              ))}
              {choice !== NEW && (
                <PixelChoice name="join-who" value={NEW} checked={false} className={CHOICE}
                  onChange={() => (setChoice(NEW), setFailed(null), requestAnimationFrame(() => document.getElementById(FIELD)?.focus()))}>
                  I&apos;m not on the list
                </PixelChoice>
              )}
            </div>
          </fieldset>
        )}
        {typing && (
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-semibold">Your name</span>
              <input id={FIELD} className={cx(PX.input, "w-full")} value={name} maxLength={30} autoComplete="name" onChange={(e) => setName(e.target.value)} />
            </label>
            {problem("field")}
          </div>
        )}
        <div className="flex flex-col gap-2">
          <PixelButton variant="primary" className="w-full" aria-disabled={off} onClick={() => onAnswer("yes")}>I&apos;m coming</PixelButton>
          <PixelButton variant="secondary" className="w-full" aria-disabled={off} onClick={() => onAnswer("no")}>Can&apos;t make it</PixelButton>
          {problem("buttons")}
        </div>
        <p className={PX.meta}>Everyone with this link can see these names.</p>
      </PixelBox>
    </div>
  );
}
