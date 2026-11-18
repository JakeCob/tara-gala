"use client";

import { PX, PixelButton, cx } from "@/components/pixel";
import type { Member } from "@/lib/wallet";

/**
 * TG-66 ux.md §4: "Several people..." under Paid by. A ₱ field per member, the left-to-place line (from checkForm),
 * and `Just one person paid`, which goes back to the select. Behind WALLET_MULTI_PAYER; the form decides when it shows.
 */
export default function PayersEditor({ members, me, paid, line, onChange, onJustOne }: {
  members: Member[];
  me: string;
  paid: Record<string, string>;
  line: string | null;
  onChange: (memberId: string, value: string) => void;
  onJustOne: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-2">
        {members.map((m) => (
          <li key={m.id} className="flex min-h-11 items-center justify-between gap-3 text-sm">
            <label className="flex min-w-0 flex-1 items-center justify-between gap-3">
              <span className="min-w-0 break-words">{m.id === me ? `${m.name} (you)` : m.name}</span>
              <span className="flex">
                <span aria-hidden="true" className={PX.inputPrefix}>₱</span>
                <input
                  className={cx(PX.input, "w-28 text-right tabular-nums")}
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0"
                  value={paid[m.id] ?? ""}
                  onChange={(e) => onChange(m.id, e.target.value)}
                />
              </span>
            </label>
          </li>
        ))}
      </ul>
      <p aria-live="polite" className="text-sm tabular-nums">
        {line}
      </p>
      <PixelButton variant="secondary" className="inline-flex items-center self-start px-4 text-sm" onClick={onJustOne}>
        Just one person paid
      </PixelButton>
    </div>
  );
}
