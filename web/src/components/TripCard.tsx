// A bus card, as on the search results (TG-12/14), moved out of TripSearch.tsx for the share page (TG-23).
// notice is the share page's "this bus changed" line (ux.md 3.2); search never passes one.
import { formatClass, formatDayOffset, formatTime, formatVerified, type Trip } from "@/lib/api";
import TerminalLinks from "@/components/TerminalLinks";
import { PX, PixelBox } from "@/components/pixel";

export default function TripCard({ trip: t, notice }: { trip: Trip; notice?: string }) {
  return (
    <PixelBox as="li">
      {notice && <p className="text-sm font-semibold text-danger-text">{notice}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={PX.timeTile}>{formatTime(t.departure_time)}</span>
        {t.fare_php != null && <span className="font-bold tabular-nums">₱{t.fare_php.toLocaleString("en-PH")}</span>}
      </div>
      <div className="text-sm">
        <span className="font-semibold">{t.operator_name}</span> · {formatClass(t.service_class)}
        {t.via ? ` · via ${t.via}` : ""}
      </div>
      <div className="text-sm text-muted">
        {t.origin_name} → {t.destination_name}
        {t.arrives_around ? (
          <>
            {` · arrives around ${formatTime(t.arrives_around)}`}
            {/* An overnight arrival is the easiest fact to misread, so the offset gets full contrast (TG-42 ux.md 3.3) */}
            <span className="font-semibold text-foreground">{formatDayOffset(t.arrives_day_offset)}</span>
          </>
        ) : (
          ""
        )}
      </div>
      <TerminalLinks slug={t.origin_slug} name={t.origin_name} city={t.origin_city} />
      <div className="flex items-center justify-between gap-2 pt-1 text-xs text-muted">
        <span>
          {formatVerified(t.last_verified_at)}
          {t.source_url && (
            <>
              {" · "}
              <a href={t.source_url} target="_blank" rel="noreferrer" className={PX.inlineLink}>
                source
              </a>
            </>
          )}
        </span>
        {t.booking_url ? (
          <a
            href={t.booking_url}
            target="_blank"
            rel="noreferrer"
            className="min-h-11 inline-flex items-center pixel-btn focus-pixel bg-accent px-3 text-sm font-bold text-accent-ink"
          >
            Book
          </a>
        ) : (
          <span>No booking link yet</span>
        )}
      </div>
    </PixelBox>
  );
}
