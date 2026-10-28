"""One builder for bus cards, so /trips and the share page (TG-23) can't drift."""

from datetime import date as Date

from .models import Trip
from .schedule import arrival

CONFIRM_NOTE = "Schedules can change. Confirm with the operator before you travel."

# The trip_search view's columns plus is_active, from the base tables with no is_active filter, so a saved
# plan still shows a trip a scraper run has since deactivated. Keep in step with the view in schema.sql:
# test_trip_rows_columns_match_trip_search_view pins it.
TRIP_ROWS_SQL = """
select
  t.id                 as trip_id,
  o.slug               as operator_slug,
  o.name               as operator_name,
  ot.slug              as origin_slug,
  ot.name              as origin_name,
  ot.city              as origin_city,
  dt.slug              as destination_slug,
  dt.name              as destination_name,
  dt.city              as destination_city,
  r.via,
  r.class,
  r.fare_php,
  r.travel_minutes,
  t.departure_time,
  t.days_of_week,
  t.valid_from,
  t.valid_to,
  coalesce(r.booking_url, o.booking_url) as booking_url,
  t.source,
  t.source_url,
  t.last_verified_at,
  t.is_active
from trips t
join routes r     on r.id = t.route_id
join operators o  on o.id = r.operator_id
join terminals ot on ot.id = r.origin_terminal_id
join terminals dt on dt.id = r.destination_terminal_id
where t.id = any(%s)
"""


def trip_from_row(r: dict, travel_date: Date) -> Trip:
    """A trip_search-shaped row as the API's Trip for one travel date (arrival and day offset depend on it)."""
    dep = r["departure_time"]
    arrives, day_offset = arrival(travel_date, dep, r["travel_minutes"])
    return Trip(
        trip_id=r["trip_id"],
        operator_slug=r["operator_slug"],
        operator_name=r["operator_name"],
        origin_slug=r["origin_slug"],
        origin_name=r["origin_name"],
        origin_city=r["origin_city"],
        destination_slug=r["destination_slug"],
        destination_name=r["destination_name"],
        destination_city=r["destination_city"],
        via=r["via"],
        service_class=r["class"],
        fare_php=float(r["fare_php"]) if r["fare_php"] is not None else None,
        travel_minutes=r["travel_minutes"],
        departure_time=dep.strftime("%H:%M"),
        arrives_around=arrives,
        arrives_day_offset=day_offset,
        booking_url=r["booking_url"],
        source=r["source"],
        source_url=r["source_url"],
        last_verified_at=r["last_verified_at"],
        confirm_note=CONFIRM_NOTE,
    )
