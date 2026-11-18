"use client";

import { useEffect, useRef } from "react";
import { PX, PixelButton, PixelChoice, cx } from "@/components/pixel";
import { formatPeso, type Member } from "@/lib/wallet";
import { itemLine, type Bill, type FormItem } from "@/lib/walletRequest";

/**
 * TG-66 ux.md §3, Items (66-04-items): each item is a name, Remove, a price and a person pill per member. A shared
 * item is split equally among the people ticked; the charges follow what each person had. Every ₱ here comes from
 * checkForm (walletSplit, the server's twin). TG-63 can open it prefilled later, with every pill empty.
 */
export default function ItemsEditor({ items, members, me, service, vat, bill, shares, canAdd, onItem, onAdd, onRemove, onCharge }: {
  items: FormItem[];
  members: Member[];
  me: string;
  service: string;
  vat: string;
  bill: Bill | null;
  shares: Record<string, number> | null;
  canAdd: boolean;
  onItem: (key: string, patch: Partial<Omit<FormItem, "key">>) => void;
  onAdd: () => void;
  onRemove: (key: string) => void;
  onCharge: (kind: "service" | "vat", value: string) => void;
}) {
  // `Add an item` moves focus to the new row's name
  const focusKey = useRef<string | null>(null);
  const names = useRef(new Map<string, HTMLInputElement>());
  const lastKey = items[items.length - 1]?.key;
  useEffect(() => {
    if (focusKey.current === "next" && lastKey) {
      names.current.get(lastKey)?.focus();
      focusKey.current = null;
    }
  }, [lastKey]);

  const label = (it: FormItem, i: number) => it.name.trim() || `item ${i + 1}`;
  const nameOf = (id: string) => {
    const m = members.find((x) => x.id === id);
    return m ? (m.id === me ? `${m.name} (you)` : m.name) : "Someone";
  };

  return (
    <div className="flex flex-col gap-3">
      <p className={PX.meta}>
        Add each item and tap who had it. A shared item is split equally among them. For a senior or PWD discount, type that item&apos;s price after the discount.
      </p>
      <ul className="flex flex-col gap-3">
        {items.map((it, i) => (
          <li key={it.key} className="flex flex-col gap-2 border-b-2 border-border pb-3">
            <div className="flex items-center gap-2">
              <input
                ref={(el) => {
                  if (el) names.current.set(it.key, el);
                  else names.current.delete(it.key);
                }}
                className={cx(PX.input, "w-full min-w-0 flex-1")}
                aria-label={`Item ${i + 1}`}
                maxLength={40}
                placeholder="Item"
                value={it.name}
                onChange={(e) => onItem(it.key, { name: e.target.value })}
              />
              <PixelButton variant="icon" aria-label={`Remove ${label(it, i)}`} onClick={() => onRemove(it.key)}>
                ✕
              </PixelButton>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <span className="font-semibold">Price</span>
              <span className="flex">
                <span aria-hidden="true" className={PX.inputPrefix}>₱</span>
                <input
                  className={cx(PX.input, "w-28 text-right tabular-nums")}
                  aria-label={`Price of ${label(it, i)}`}
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0"
                  value={it.price}
                  onChange={(e) => onItem(it.key, { price: e.target.value })}
                />
              </span>
            </label>
            <div role="group" aria-label={`Who had ${label(it, i)}`} className="flex flex-wrap gap-2">
              {members.map((m) => (
                <PixelChoice
                  key={m.id}
                  type="checkbox"
                  name={`who-${it.key}`}
                  value={m.id}
                  checked={it.who.includes(m.id)}
                  onChange={(e) => onItem(it.key, { who: e.target.checked ? [...it.who, m.id] : it.who.filter((w) => w !== m.id) })}
                >
                  {m.name}
                </PixelChoice>
              ))}
            </div>
            {itemLine(it, i) && <p className="text-sm text-danger-text">{itemLine(it, i)}</p>}
          </li>
        ))}
      </ul>
      {canAdd && (
        <PixelButton
          variant="secondary"
          className="inline-flex items-center self-start px-4 text-sm"
          onClick={() => {
            focusKey.current = "next";
            onAdd();
          }}
        >
          Add an item
        </PixelButton>
      )}
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-semibold">Service charge</span>
          <input className={cx(PX.input, "w-full min-w-0")} autoComplete="off" value={service} onChange={(e) => onCharge("service", e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-semibold">VAT, other charges</span>
          <input className={cx(PX.input, "w-full min-w-0")} autoComplete="off" value={vat} onChange={(e) => onCharge("vat", e.target.value)} />
        </label>
      </div>
      <p className={PX.meta}>
        A peso amount or a percent of the items, like 10%. Charges are shared in proportion to what each person had. If VAT is already in the prices, leave it empty.
      </p>
      {bill && (
        <div className="flex flex-col gap-1 border-t-3 border-frame pt-3 text-sm">
          <p className="flex justify-between gap-3">
            <span>Items</span>
            <span className="tabular-nums">{formatPeso(bill.items)}</span>
          </p>
          {bill.charges.map((c) => (
            <p key={c.label} className="flex justify-between gap-3">
              <span>{c.label}</span>
              <span className="tabular-nums">{formatPeso(c.amount)}</span>
            </p>
          ))}
          <p className="flex justify-between gap-3 font-bold">
            <span>Total</span>
            <span className="tabular-nums">{formatPeso(bill.total)}</span>
          </p>
          {bill.typedBefore && <p className="mt-1">{bill.typedBefore}</p>}
        </div>
      )}
      {shares && (
        <div className="flex flex-col gap-1 text-sm">
          <h3 className="font-semibold">Each person</h3>
          <ul className="flex flex-col gap-1">
            {members
              .filter((m) => shares[m.id] !== undefined)
              .map((m) => (
                <li key={m.id} className="flex justify-between gap-3">
                  <span className="min-w-0 break-words">{nameOf(m.id)}</span>
                  <span className="tabular-nums font-bold">{formatPeso(shares[m.id])}</span>
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}
