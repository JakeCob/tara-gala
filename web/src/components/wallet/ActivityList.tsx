"use client";

// TG-66 ux §8: the wallet's activity, newest first, by Manila day, 15 at a time. It needs signal (the worker doesn't
// cache it). The first page loads again whenever the wallet's rev moves, so the user's own write shows up, and an
// older answer never replaces newer rows (mergeActivity, B24). Logs carry counts and outcomes only.
import { useEffect, useState } from "react";
import { PX, PixelBox, PixelButton, SectionTitle } from "@/components/pixel";
import { activityLine, groupByDay, mergeActivity, oldestId, timeOnly, type ActivityState } from "@/lib/walletActivity";
import { failureMessage, walletApi, type Wallet } from "@/lib/wallet";

const SOMEONE_LINE = `"Someone" is a phone that hasn't picked who it is. Activity from before this update isn't listed.`;

export default function ActivityList({ slug, wallet, online, onOpenExpense }: {
  slug: string;
  wallet: Wallet;
  online: boolean;
  /** A line's expense note: open that expense's details. */
  onOpenExpense: (expenseId: string) => void;
}) {
  const [list, setList] = useState<ActivityState | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const rev = wallet.rev ?? 0;

  useEffect(() => {
    if (!online) return;
    let current = true;
    void walletApi.activity(slug).then((r) => {
      console.info("[tg-wallet] activity load ok=%s rows=%d", r.ok ? "yes" : r.why, r.ok ? r.rows.length : 0);
      if (!current) return;
      if (r.ok) {
        setList((prev) => mergeActivity(prev, r, false));
        setFailed(null);
      } else setFailed(failureMessage(r));
    });
    return () => {
      current = false;
    };
  }, [online, slug, rev]);

  async function older() {
    const before = list ? oldestId(list) : undefined;
    if (loadingOlder || !online || before === undefined) return;
    setLoadingOlder(true);
    const r = await walletApi.activity(slug, { before });
    console.info("[tg-wallet] activity older ok=%s rows=%d", r.ok ? "yes" : r.why, r.ok ? r.rows.length : 0);
    setLoadingOlder(false);
    if (r.ok) setList((prev) => mergeActivity(prev, r, true));
    else setFailed(failureMessage(r));
  }

  const rows = list?.rows ?? [];

  return (
    <PixelBox as="section" aria-labelledby="activity-title" className="flex flex-col gap-3 p-4">
      <SectionTitle id="activity-title">Activity</SectionTitle>
      {!online && rows.length === 0 ? (
        <p className="text-sm text-muted">Activity needs signal.</p>
      ) : failed && rows.length === 0 ? (
        <p className="text-sm text-muted">{failed}</p>
      ) : list === null ? (
        <p className="text-sm text-muted">Loading...</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">Nothing yet. Adds, changes and payments show here.</p>
      ) : (
        groupByDay(rows).map((g) => (
          <div key={g.key} className="flex flex-col gap-2">
            <h3 className="text-sm font-bold">{g.label}</h3>
            <ul className="flex flex-col gap-2">
              {g.rows.map((r) => {
                const line = activityLine(r, wallet, rows);
                return (
                  <li key={r.id} className="flex flex-col border-b-2 border-border pb-2 last:border-b-0 last:pb-0">
                    <p className="text-sm break-words">
                      <span className="font-semibold">{line.who}</span>{" "}
                      {line.segs.map((s, i) =>
                        typeof s === "string" ? (
                          <span key={i}>{s}</span>
                        ) : (
                          <button key={i} type="button" className={PX.inlineLink} onClick={() => onOpenExpense(s.expenseId)}>
                            {s.note}
                          </button>
                        ),
                      )}
                    </p>
                    <p className={PX.meta}>{timeOnly(r.at)}</p>
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
      {list?.more && rows.length > 0 && (
        <PixelButton variant="secondary" className="inline-flex items-center self-start px-4 text-sm" aria-disabled={loadingOlder || !online || undefined} onClick={() => void older()}>
          {loadingOlder ? "Loading..." : "Show older"}
        </PixelButton>
      )}
      {failed && rows.length > 0 && <p className="text-sm text-muted">{failed}</p>}
      <p className={PX.meta}>{SOMEONE_LINE}</p>
    </PixelBox>
  );
}
