"""Tara Gala API."""

import logging
import os
from contextlib import asynccontextmanager
from datetime import date as Date
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

from . import db
from .models import Terminal, Trip

# Minimal root config so app INFO logs reach stdout; TG-13 replaces this.
_log_level = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=_log_level if isinstance(logging.getLevelName(_log_level), int) else "INFO",  # bad value must not stop boot
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("tara_gala.api")

MANILA_TZ = ZoneInfo("Asia/Manila")

# Cities whose terminals count as "Metro Manila" for search
METRO_MANILA_CITIES = [
    "Caloocan", "Las Pinas", "Makati", "Malabon", "Mandaluyong", "Manila",
    "Marikina", "Muntinlupa", "Navotas", "Paranaque", "Pasay", "Pasig",
    "Pateros", "Quezon City", "San Juan", "Taguig", "Valenzuela",
]

CONFIRM_NOTE = "Schedules can change. Confirm with the operator before you travel."


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.open_pool()
    yield
    db.close_pool()


app = FastAPI(title="Tara Gala API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "http://localhost:3000").split(",") if o.strip()],
    allow_methods=["GET"],
    allow_headers=["*"],
)


def _cities(city: str | None) -> list[str] | None:
    if not city:
        return None
    if city.strip().lower() in {"metro manila", "manila area", "ncr"}:
        return METRO_MANILA_CITIES
    return [city.strip()]


def _arrival(travel_date: Date, departure: time, minutes: int | None) -> tuple[str | None, int | None]:
    """Rough arrival as ("HH:MM", days after travel_date). Manila has no DST, so naive maths is fine."""
    if not minutes:
        return None, None
    at = datetime.combine(travel_date, departure) + timedelta(minutes=minutes)
    return at.strftime("%H:%M"), (at.date() - travel_date).days


@app.get("/health")
def health() -> dict:
    with db.get_conn() as conn:
        conn.execute("select 1")
    return {"status": "ok"}


@app.get("/terminals", response_model=list[Terminal])
def list_terminals(city: str | None = None) -> list[Terminal]:
    cities = _cities(city)
    sql = "select slug, name, city, address, lat, lng from terminals"
    params: dict = {}
    if cities:
        sql += " where city = any(%(cities)s)"
        params["cities"] = cities
    sql += " order by city, name"
    with db.get_conn() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [Terminal(**r) for r in rows]


@app.get("/trips", response_model=list[Trip])
def search_trips(
    origin_city: str | None = Query(None, description="City, or 'Metro Manila' for all NCR terminals"),
    destination_city: str | None = Query(None, examples=["Baguio"]),
    origin: str | None = Query(None, description="Origin terminal slug, e.g. vl-cubao"),
    destination: str | None = Query(None, description="Destination terminal slug"),
    date: Date | None = Query(None, description="Travel date; defaults to today in Manila"),
) -> list[Trip]:
    travel_date = date or datetime.now(MANILA_TZ).date()
    # Postgres dow: 0 = Sunday, same as trips.days_of_week
    dow = (travel_date.isoweekday()) % 7

    where = [
        "%(dow)s::smallint = any(days_of_week)",
        "(valid_from is null or valid_from <= %(d)s)",
        "(valid_to is null or valid_to >= %(d)s)",
    ]
    params: dict = {"dow": dow, "d": travel_date}

    if (oc := _cities(origin_city)):
        where.append("origin_city = any(%(oc)s)")
        params["oc"] = oc
    if (dc := _cities(destination_city)):
        where.append("destination_city = any(%(dc)s)")
        params["dc"] = dc
    if origin:
        where.append("origin_slug = %(o)s")
        params["o"] = origin
    if destination:
        where.append("destination_slug = %(dst)s")
        params["dst"] = destination

    sql = f"select * from trip_search where {' and '.join(where)} order by departure_time, operator_name"
    with db.get_conn() as conn:
        rows = conn.execute(sql, params).fetchall()

    trips = []
    for r in rows:
        dep = r["departure_time"]
        arrives, day_offset = _arrival(travel_date, dep, r["travel_minutes"])
        trips.append(
            Trip(
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
        )
    logger.info(
        "trips search date=%s origin_city=%r destination_city=%r origin=%r destination=%r results=%d next_day=%d no_travel_time=%d",
        travel_date, origin_city, destination_city, origin, destination, len(trips),
        sum(1 for t in trips if t.arrives_day_offset),
        sum(1 for t in trips if t.arrives_around is None),
    )
    return trips
