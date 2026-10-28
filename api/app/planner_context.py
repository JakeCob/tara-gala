"""The rows the planner model is allowed to use (TG-20): trips for the dates, Baguio spots and legs.

The model only ever sees these rows, and FastAPI validates its answer against the database anyway.
"""

import logging
from dataclasses import dataclass
from datetime import date as Date
from datetime import datetime, time, timedelta

from psycopg.rows import dict_row

logger = logging.getLogger("tara_gala.api")

BAGUIO = "Baguio"
MAX_TRIPS = 60  # per direction
MAX_SPOTS = 80
MAX_LEGS = 400  # keeps the prompt far below Haiku 5.5's 100k-token price boundary


@dataclass(frozen=True)
class PlannerContext:
    outbound: list[dict]
    returns: list[dict]
    spots: list[dict]
    legs: list[dict]
    empty_reason: str | None  # set when there's nothing to plan with; no model call is made


def _arrival(travel_date: Date, departure: time, minutes: int | None) -> tuple[str | None, int | None]:
    # TODO(TG-24 rebase): use schedule.arrival (same maths as main._arrival; importing main here is circular)
    if not minutes:
        return None, None
    at = datetime.combine(travel_date, departure) + timedelta(minutes=minutes)
    return at.strftime("%H:%M"), (at.date() - travel_date).days


# Same day and validity filter as main.search_trips; trip_search already drops inactive trips.
TRIPS_SQL = """
    select trip_id, operator_slug, origin_slug, destination_slug, departure_time, travel_minutes,
           class, fare_php, count(*) over () as total
    from trip_search
    where %(dow)s::smallint = any(days_of_week)
      and (valid_from is null or valid_from <= %(d)s)
      and (valid_to is null or valid_to >= %(d)s)
      and {direction}
    order by departure_time, operator_slug, trip_id
    limit %(cap)s
"""
OUTBOUND = "destination_city = %(baguio)s and origin_city <> %(baguio)s and travel_minutes is not null"
RETURN = "origin_city = %(baguio)s and destination_city <> %(baguio)s"

SPOTS_SQL = """
    select id as spot_id, slug, name, category, visit_minutes, opening_hours, entrance_fee_php,
           count(*) over () as total
    from spots where city = %(baguio)s
    order by slug
    limit %(cap)s
"""
LEGS_SQL = """
    select l.id as last_mile_route_id, coalesce(ft.slug, fs.slug) as "from", coalesce(tt.slug, ts.slug) as "to",
           l.mode, l.minutes, l.fare_min_php, l.fare_max_php, count(*) over () as total
    from last_mile_routes l
    left join terminals ft on ft.id = l.from_terminal_id
    left join spots fs on fs.id = l.from_spot_id
    left join terminals tt on tt.id = l.to_terminal_id
    left join spots ts on ts.id = l.to_spot_id
    where l.city = %(baguio)s
    order by 2, 3, l.mode, l.id
    limit %(cap)s
"""


def _float(v) -> float | None:
    return float(v) if v is not None else None


def _capped(rows: list[dict], name: str, cap: int) -> list[dict]:
    if rows and rows[0]["total"] > cap:
        logger.warning("planner context truncated %s=%d cap=%d", name, rows[0]["total"], cap)
    for r in rows:
        del r["total"]
    return rows


def _trips(cur, d: Date, direction: str) -> list[dict]:
    cur.execute(TRIPS_SQL.format(direction=direction),
                {"dow": d.isoweekday() % 7, "d": d, "baguio": BAGUIO, "cap": MAX_TRIPS})
    rows = cur.fetchall()
    total = rows[0]["total"] if rows else 0
    trips = []
    for r in rows:
        arrives, offset = _arrival(d, r["departure_time"], r["travel_minutes"])
        trips.append({
            "trip_id": str(r["trip_id"]),
            "operator": r["operator_slug"],
            "from": r["origin_slug"],
            "to": r["destination_slug"],
            "departs": r["departure_time"].strftime("%H:%M"),
            "arrives": arrives,
            "arrives_day_offset": offset,
            "class": r["class"],
            "fare_php": _float(r["fare_php"]),
            "total": total,
        })
    return trips


def load_context(conn, d: Date, rd: Date) -> PlannerContext:
    """Four queries; capped lists. `d` is the outbound date, `rd` the return date."""
    with conn.cursor(row_factory=dict_row) as cur:
        outbound = _capped(_trips(cur, d, OUTBOUND), "outbound", MAX_TRIPS)
        returns = _capped(_trips(cur, rd, RETURN), "returns", MAX_TRIPS)
        cur.execute(SPOTS_SQL, {"baguio": BAGUIO, "cap": MAX_SPOTS})
        spots = _capped([
            {**r, "spot_id": str(r["spot_id"]), "entrance_fee_php": _float(r["entrance_fee_php"])}
            for r in cur.fetchall()
        ], "spots", MAX_SPOTS)
        cur.execute(LEGS_SQL, {"baguio": BAGUIO, "cap": MAX_LEGS})
        legs = _capped([
            {**r, "last_mile_route_id": str(r["last_mile_route_id"]),
             "fare_min_php": _float(r["fare_min_php"]), "fare_max_php": _float(r["fare_max_php"])}
            for r in cur.fetchall()
        ], "legs", MAX_LEGS)

    empty_reason = None
    if not outbound:
        empty_reason = "no outbound buses with a travel time on file"
    elif not returns:
        empty_reason = "no return buses"
    elif not spots:
        empty_reason = "no spots"
    elif not legs:
        empty_reason = "no last-mile legs"
    return PlannerContext(outbound, returns, spots, legs, empty_reason)
