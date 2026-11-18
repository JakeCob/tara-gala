"use client";

// TG-66 ux §7: where the money went, by category, for everyone or for one person. Computed from the wallet on screen,
// so it works offline. The nudge's link filters the expense list, which is the parent's (W3).
import { useId, useState } from "react";
import { PX, PixelBox, SectionTitle, cx } from "@/components/pixel";
import { categoryTable, everyoneMeta, nudge, personColumn, personMeta, personTable, showForOptions, tableColumn, uncategorizedCount } from "@/lib/walletCategories";
import type { Wallet } from "@/lib/wallet";

export default function CategoryBox({ wallet, me, onShowUncategorized }: {
  wallet: Wallet;
  me: string | null;
  /** The nudge's "Show them": filter the expense list to the ones with no category. */
  onShowUncategorized: () => void;
}) {
  const selectId = useId();
  const [picked, setPicked] = useState("");
  const person = wallet.members.find((m) => m.id === picked) ?? null; // someone who left the list falls back to Everyone
  const table = person ? personTable(wallet, person.id) : categoryTable(wallet);
  const ask = nudge(uncategorizedCount(wallet));
  const cell = "py-2 text-right tabular-nums";
  // Each column lines up: the totals (rows, then Total) share one decimals rule, and Each is whole pesos (ux review M2)
  const totals = tableColumn([...table.rows.map((r) => r.total), table.total]);
  const eachs = tableColumn([...table.rows.map((r) => r.each), table.each]);

  return (
    <PixelBox as="section" aria-labelledby="categories-title" className="flex flex-col gap-3 p-4">
      <SectionTitle id="categories-title">Categories</SectionTitle>
      <label htmlFor={selectId} className="text-sm font-semibold">
        Show for
      </label>
      <select id={selectId} className={PX.input} value={person?.id ?? ""} onChange={(e) => setPicked(e.target.value)}>
        {showForOptions(wallet, me).map((o) => (
          <option key={o.value || "everyone"} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{person ? `${personColumn(person.name)} by category` : "Spending by category"}</caption>
        <thead>
          <tr className="border-b-2 border-border">
            <th scope="col" className="py-2 text-left font-semibold">
              Category (₱)
            </th>
            {person ? (
              <th scope="col" className={cx(cell, "font-semibold")}>
                {personColumn(person.name)}
              </th>
            ) : (
              <>
                <th scope="col" className={cx(cell, "font-semibold")}>
                  Total
                </th>
                <th scope="col" className={cx(cell, "font-semibold")}>
                  Each
                </th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r, i) => (
            <tr key={r.key ?? "none"} className="border-b-2 border-border">
              <th scope="row" className="py-2 text-left font-normal">
                {r.label}
              </th>
              <td className={cell}>{totals[i]}</td>
              {!person && <td className={cell}>{eachs[i]}</td>}
            </tr>
          ))}
          <tr>
            <th scope="row" className="py-2 text-left font-bold">
              Total
            </th>
            <td className={cx(cell, "font-bold")}>{totals.at(-1)}</td>
            {!person && <td className={cx(cell, "font-bold")}>{eachs.at(-1)}</td>}
          </tr>
        </tbody>
      </table>
      <p className={PX.meta}>{person ? personMeta(person.name) : everyoneMeta(wallet.members.length)}</p>
      {ask && (
        <p className="text-sm">
          {ask.text}{" "}
          <button type="button" className={PX.inlineLink} onClick={onShowUncategorized}>
            {ask.link}
          </button>
        </p>
      )}
    </PixelBox>
  );
}
