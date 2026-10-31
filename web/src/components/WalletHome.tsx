"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { PX, PixelBox, PixelButton, PixelCardLink, SectionTitle, cx } from "@/components/pixel";
import { MAX_MEMBERS, failureMessage, knownWalletsRaw, parseKnownWallets, rememberWallet, walletApi } from "@/lib/wallet";

const subscribeNothing = () => () => {};

/** Trimmed names, or the first problem with them. The API checks the same rules. */
function checkPeople(names: string[]): { ok: true; names: string[] } | { ok: false; message: string } {
  const people = names.map((n) => n.trim()).filter(Boolean);
  if (people.length === 0) return { ok: false, message: "Add your name first." };
  if (people.some((n) => n.length > 30)) return { ok: false, message: "Keep each name to 30 letters or fewer." };
  if (new Set(people.map((n) => n.toLowerCase())).size !== people.length) return { ok: false, message: "Each person needs a different name." };
  return { ok: true, names: people };
}

/**
 * TG-50: the trip wallet hub. My tickets (on this phone), the shared wallets this phone has opened, and a form to
 * start one. The first name is "you": this phone joins the new wallet as that person.
 */
export default function WalletHome() {
  const router = useRouter();
  const raw = useSyncExternalStore(subscribeNothing, knownWalletsRaw, () => null);
  const known = useMemo(() => parseKnownWallets(raw), [raw]);
  const [tripName, setTripName] = useState("Baguio trip");
  const [people, setPeople] = useState(["", ""]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function setPerson(i: number, value: string) {
    setPeople((p) => p.map((n, j) => (j === i ? value : n)));
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    const name = tripName.trim();
    const check = checkPeople(people);
    if (!name) return setError("Give the trip a name.");
    if (!check.ok) return setError(check.message);
    setError("");
    setBusy(true);
    const r = await walletApi.create(name, check.names);
    console.info("[tg-wallet] create people=%d ok=%s", check.names.length, r.ok ? "yes" : r.why);
    if (!r.ok) {
      setBusy(false);
      return setError(failureMessage(r));
    }
    rememberWallet({ slug: r.wallet.share_slug, name: r.wallet.name, me: r.wallet.members[0].id });
    router.push(`/w/${r.wallet.share_slug}`);
  }

  return (
    <div className="flex flex-col gap-5 md:grid md:grid-cols-2 md:gap-6 md:items-start">
      <div className="flex flex-col gap-4">
        <PixelCardLink href="/tickets" className="flex flex-col gap-1 p-4">
          <span className="font-bold">My tickets</span>
          <span className={PX.meta}>Your bus e-tickets, saved on this phone for the terminal.</span>
        </PixelCardLink>

        <section aria-labelledby="wallets-title" className="flex flex-col gap-3">
          <SectionTitle id="wallets-title">Shared expenses</SectionTitle>
          {known.length === 0 ? (
            <p className="text-sm text-muted">
              No shared wallet on this phone yet. Start one below, or open the link a friend shared with you.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {known.map((w) => (
                <li key={w.slug}>
                  <PixelCardLink href={`/w/${w.slug}`} className="flex items-center justify-between gap-3 p-4">
                    <span className="min-w-0 break-words font-bold">{w.name}</span>
                    <span aria-hidden="true">→</span>
                  </PixelCardLink>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="flex flex-col gap-3">
        <PixelBox as="form" onSubmit={onCreate} noValidate aria-labelledby="start-title" className="flex flex-col gap-3 p-4">
          <SectionTitle id="start-title">Start a trip wallet</SectionTitle>
          <p className="text-sm text-muted">Everyone logs what they paid from their own phone. At the end, it works out who pays whom.</p>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-semibold">Trip name</span>
            <input className={PX.input} value={tripName} maxLength={40} onChange={(e) => setTripName(e.target.value)} />
          </label>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-semibold">Who&apos;s coming?</legend>
            {people.map((person, i) => (
              <div key={i} className="flex items-end gap-2">
                <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
                  <span className={i === 0 ? "font-semibold" : PX.meta}>{i === 0 ? "Your name" : `Person ${i + 1}`}</span>
                  <input className={cx(PX.input, "w-full")} value={person} maxLength={30} autoComplete={i === 0 ? "given-name" : "off"} onChange={(e) => setPerson(i, e.target.value)} />
                </label>
                {i > 0 && (
                  <PixelButton variant="icon" aria-label={`Remove person ${i + 1}`} onClick={() => setPeople((p) => p.filter((_, j) => j !== i))}>
                    ×
                  </PixelButton>
                )}
              </div>
            ))}
            {people.length < MAX_MEMBERS && (
              <PixelButton variant="secondary" className="inline-flex items-center self-start px-4 text-sm" onClick={() => setPeople((p) => [...p, ""])}>
                Add a person
              </PixelButton>
            )}
          </fieldset>
          <PixelButton type="submit" variant="primary" className="px-4 py-3" disabled={busy}>
            {busy ? "Starting..." : "Start the wallet"}
          </PixelButton>
        </PixelBox>
        {error && (
          <PixelBox as="p" tone="alertText" role="alert" className="p-4 text-sm">
            {error}
          </PixelBox>
        )}
      </div>
    </div>
  );
}
