// A last-mile leg card, as on /baguio (TG-17), moved out of LastMile.tsx for the share page (TG-23).
// notice is the share page's "this ride changed" line (ux.md 3.2); /baguio never passes one.
import { formatVerified } from "@/lib/api";
import { formatFare, formatMinutes, modeLabel, type LastMileLeg } from "@/lib/lastMile";
import { PixelBox } from "@/components/pixel";

const line = "text-sm min-w-0 break-words";

export default function LegCard({ leg, notice }: { leg: LastMileLeg; notice?: string }) {
  const fare = formatFare(leg.fare_min_php, leg.fare_max_php);
  const minutes = formatMinutes(leg.minutes);
  return (
    <PixelBox as="li" className="p-4 flex flex-col gap-1.5">
      {notice && <p className="text-sm font-semibold">{notice}</p>}
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-bold">{modeLabel(leg.mode)}</span>
        {fare && <span className="font-bold tabular-nums">{fare}</span>}
      </div>
      {leg.signboard && (
        <p className={line}>
          Signboard: <span className="font-semibold">{leg.signboard}</span>
        </p>
      )}
      {leg.boarding_point && <p className={line}>Board at {leg.boarding_point}</p>}
      {leg.alighting_point && <p className={line}>Get off at {leg.alighting_point}</p>}
      {minutes && <p className={line}>{minutes}</p>}
      {leg.notes && <p className={`${line} text-muted`}>{leg.notes}</p>}
      <p className="pt-1 text-xs text-muted">{formatVerified(leg.last_verified_at)}</p>
    </PixelBox>
  );
}
