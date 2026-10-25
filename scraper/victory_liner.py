"""Scrape Victory Liner trips (Manila terminals to Baguio) into Supabase.

Usage:
    python scraper/victory_liner.py --dry-run   # fetch, show what would change, write nothing
    python scraper/victory_liner.py             # fetch and upsert (safe to re-run)

Fetches the next 14 days for 4 origins (56 requests, one at a time, 2 seconds apart).
If any request fails or returns an unexpected shape, nothing is written and the exit code is non-zero.
Reads DATABASE_URL from the environment or from the repo-root .env file (same as data/load_data.py).
"""

from __future__ import annotations

import argparse
import os
import sys
import time as clock
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from pathlib import Path

import httpx
import psycopg

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "data"))
from load_data import MANILA, _dotenv_database_url, slug_map  # noqa: E402

API_URL = "https://tickets.victoryliner.com/api/v1/trips"
SOURCE_URL = "https://tickets.victoryliner.com"
USER_AGENT = "TaraGala-Scraper/0.1 (personal Manila-Baguio trip planner; reads public schedules, 56 requests per run)"
OPERATOR = "victory-liner"
ORIGINS = {  # API origin code -> terminal slug
    "CUBAO": "vl-cubao",
    "PASAY": "vl-pasay",
    "CALOOCAN": "vl-caloocan",
    "SAMPALOC": "vl-sampaloc",
}
DESTINATION = ("BAGUIO", "vl-baguio")
DAYS = 14
DELAY_SECONDS = 2.0
CLASS_MAP = {
    "REGULAR AIRCON": "regular_aircon",
    "DELUXE": "deluxe",
    "FIRST CLASS": "first_class",
    "ROYAL CLASS": "royal_class",
}


class ScrapeError(Exception):
    pass


@dataclass(frozen=True)
class Observation:
    origin: str  # terminal slug
    day: date
    departure: time
    service_class: str
    branding: str
    fare: float
    minutes: int


@dataclass
class RouteSpec:
    fare: float
    minutes: int
    notes: str
    trips: dict[time, set[int]] = field(default_factory=dict)  # departure -> weekdays (0 = Sunday)


# Parsing
def service_class(bus_type: str) -> str:
    try:
        return CLASS_MAP[bus_type]
    except KeyError:
        raise ScrapeError(f"unknown busType {bus_type!r}; known: {', '.join(CLASS_MAP)}") from None


def parse_trip(raw: object, origin: str, day: date) -> Observation:
    """Validate one trip from the API. Raises ScrapeError on anything unexpected."""
    where = f"{origin} {day}"
    if not isinstance(raw, dict):
        raise ScrapeError(f"{where}: trip is not an object: {raw!r}")
    try:
        trip_id, dep, bus, branding = raw["tripId"], raw["departureTime"], raw["busType"], raw["branding"]
        fare, running = raw["fareAmount"], raw["runningTime"]
    except KeyError as e:
        raise ScrapeError(f"{where}: trip is missing field {e}: {raw!r}") from None
    if not all(isinstance(v, str) and v for v in (trip_id, dep, bus, branding)):
        raise ScrapeError(f"{where}: tripId, departureTime, busType and branding must be non-empty strings: {raw!r}")
    for name, v in (("fareAmount", fare), ("runningTime", running)):
        if isinstance(v, bool) or not isinstance(v, (int, float)) or v <= 0:
            raise ScrapeError(f"{where}: {name} must be a positive number, got {v!r} ({trip_id})")
    try:
        departure = time.fromisoformat(dep)
    except ValueError:
        raise ScrapeError(f"{where}: departureTime must be HH:MM:SS, got {dep!r} ({trip_id})") from None
    return Observation(
        origin=origin,
        day=day,
        departure=departure.replace(second=0, microsecond=0),
        service_class=service_class(bus),
        branding=branding,
        fare=float(fare),
        minutes=round(running * 60),
    )


def parse_response(payload: object, origin: str, day: date) -> list[Observation]:
    if not isinstance(payload, list):
        raise ScrapeError(f"{origin} {day}: expected a JSON list of trips, got {type(payload).__name__}")
    return [parse_trip(raw, origin, day) for raw in payload]


# Fetching
def fetch_all(client: httpx.Client, days: list[date], delay: float = DELAY_SECONDS, log=print) -> list[Observation]:
    jobs = [(code, slug, d) for code, slug in ORIGINS.items() for d in days]
    out: list[Observation] = []
    for i, (code, slug, d) in enumerate(jobs):
        if i:
            clock.sleep(delay)
        params = {"origin": code, "destination": DESTINATION[0], "date": d.isoformat(), "passengers": 1}
        try:
            resp = client.get(API_URL, params=params)
            resp.raise_for_status()
            payload = resp.json()
        except (httpx.HTTPError, ValueError) as e:
            raise ScrapeError(f"request {i + 1}/{len(jobs)} failed ({code} {d}): {e}") from e
        out.extend(parse_response(payload, slug, d))
        log(f"  [{i + 1}/{len(jobs)}] {code} {d}: {len(payload)} trips")
    return out


# Aggregation
def _mode_lowest(values: list[float]) -> float:
    counts = Counter(values)
    top = max(counts.values())
    return min(v for v, c in counts.items() if c == top)


def aggregate(observations: list[Observation]) -> dict[tuple[str, str], RouteSpec]:
    """One route per (origin terminal, class); one trip per departure time with the weekdays seen."""
    grouped: dict[tuple[str, str], list[Observation]] = defaultdict(list)
    for o in observations:
        grouped[(o.origin, o.service_class)].append(o)

    routes: dict[tuple[str, str], RouteSpec] = {}
    for key, obs in grouped.items():
        # Express and Inner Cities share a class but can differ in running time; keep the longest on the
        # route (safer for arrival estimates) and record each branding's own time in the notes.
        by_branding: dict[str, int] = {}
        for o in obs:
            by_branding[o.branding] = max(by_branding.get(o.branding, 0), o.minutes)
        notes = "Branding: " + ", ".join(f"{b} {m / 60:g}h" for b, m in sorted(by_branding.items()))
        spec = RouteSpec(
            fare=_mode_lowest([o.fare for o in obs]),
            minutes=max(by_branding.values()),
            notes=notes,
        )
        for o in obs:
            spec.trips.setdefault(o.departure, set()).add((o.day.weekday() + 1) % 7)  # Python Mon=0 -> Sun=0
        routes[key] = spec
    return routes


# Database
@dataclass
class Result:
    routes_new: int = 0
    routes_existing: int = 0
    trips_new: int = 0
    trips_updated: int = 0
    trips_skipped_manual: int = 0
    trips_deactivated: int = 0
    booking_url_set: bool = False


def apply(cur, routes: dict[tuple[str, str], RouteSpec], verified_at: datetime) -> Result:
    """Upsert into the open transaction. Matching keys follow data/load_data.py."""
    res = Result()
    operators = slug_map(cur, "operators")
    terminals = slug_map(cur, "terminals")
    op = operators[OPERATOR]
    dest = terminals[DESTINATION[1]]

    cur.execute(
        "update operators set booking_url = %s where id = %s and coalesce(booking_url, '') = '' returning id",
        (SOURCE_URL, op),
    )
    res.booking_url_set = cur.fetchone() is not None

    seen: set = set()
    for (origin_slug, cls), spec in sorted(routes.items()):
        origin = terminals[origin_slug]
        cur.execute(
            """
            select id, notes from routes
            where operator_id = %s and origin_terminal_id = %s and destination_terminal_id = %s
              and via is null and class = %s
            """,
            (op, origin, dest, cls),
        )
        found = cur.fetchone()
        if found:
            route_id, old_notes = found
            res.routes_existing += 1
            # Notes written by hand are left alone; ours always start with "Branding:"
            set_notes = old_notes is None or old_notes.startswith("Branding:")
            cur.execute(
                "update routes set fare_php = %s, travel_minutes = %s, notes = case when %s then %s else notes end where id = %s",
                (spec.fare, spec.minutes, set_notes, spec.notes, route_id),
            )
        else:
            cur.execute(
                """
                insert into routes (operator_id, origin_terminal_id, destination_terminal_id, via, class,
                                    fare_php, travel_minutes, notes)
                values (%s, %s, %s, null, %s, %s, %s, %s) returning id
                """,
                (op, origin, dest, cls, spec.fare, spec.minutes, spec.notes),
            )
            route_id = cur.fetchone()[0]
            res.routes_new += 1

        for dep, weekdays in sorted(spec.trips.items()):
            days = sorted(weekdays)
            cur.execute("select id, source, valid_from from trips where route_id = %s and departure_time = %s", (route_id, dep))
            existing = cur.fetchall()
            if any(src == "manual" for _, src, _ in existing):
                res.trips_skipped_manual += 1  # hand-entered rows win; never touched
                continue
            ours = next((id_ for id_, src, vf in existing if src == "scraped" and vf is None), None)
            if ours:
                cur.execute(
                    """
                    update trips set days_of_week = %s, is_active = true, source_url = %s,
                      last_verified_at = %s, updated_at = now()
                    where id = %s
                    """,
                    (days, SOURCE_URL, verified_at, ours),
                )
                res.trips_updated += 1
                seen.add(ours)
            else:
                cur.execute(
                    """
                    insert into trips (route_id, departure_time, days_of_week, source, source_url, last_verified_at)
                    values (%s, %s, %s, 'scraped', %s, %s) returning id
                    """,
                    (route_id, dep, days, SOURCE_URL, verified_at),
                )
                res.trips_new += 1
                seen.add(cur.fetchone()[0])

    # Scraped Victory Liner trips we did not see this run. Manual and other operators' trips are never matched.
    cur.execute(
        """
        update trips t set is_active = false, updated_at = now()
        from routes r
        where t.route_id = r.id and r.operator_id = %s and t.source = 'scraped' and t.is_active
          and t.id <> all(%s::uuid[])
        """,
        (op, list(seen)),
    )
    res.trips_deactivated = cur.rowcount
    return res


def run(dsn: str, observations: list[Observation], dry_run: bool, verified_at: datetime | None = None) -> Result:
    if not observations:
        raise ScrapeError("the site returned no trips at all; refusing to deactivate everything")
    routes = aggregate(observations)
    verified_at = verified_at or datetime.now(MANILA)
    with psycopg.connect(dsn, prepare_threshold=None) as conn:
        with conn.cursor() as cur:
            res = apply(cur, routes, verified_at)
        if dry_run:
            conn.rollback()
        else:
            conn.commit()
    return res


# Entry point
def print_summary(observations: list[Observation], routes: dict[tuple[str, str], RouteSpec]) -> None:
    print(f"\nScraped {len(observations)} trip rows -> {len(routes)} routes, "
          f"{sum(len(r.trips) for r in routes.values())} distinct departures\n")
    print(f"  {'origin':<13}{'class':<16}{'fare':>7}{'min':>5}{'trips':>6}  notes")
    for (origin, cls), r in sorted(routes.items()):
        print(f"  {origin:<13}{cls:<16}{r.fare:>7.0f}{r.minutes:>5}{len(r.trips):>6}  {r.notes}")
    for slug in ORIGINS.values():
        if not any(o == slug for o, _ in routes):
            print(f"  WARNING: no trips at all for {slug} in the whole window")


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dry-run", action="store_true", help="fetch and report, write nothing")
    p.add_argument("--database-url", default=None, help="defaults to DATABASE_URL or the repo .env")
    args = p.parse_args()

    dsn = args.database_url or os.environ.get("DATABASE_URL") or _dotenv_database_url()
    if not dsn:
        print("DATABASE_URL is not set (env var or repo-root .env).", file=sys.stderr)
        return 2

    today = datetime.now(MANILA).date()
    days = [today + timedelta(days=i) for i in range(DAYS)]
    print(f"Fetching {len(ORIGINS) * len(days)} requests, {DELAY_SECONDS:g}s apart ({days[0]} to {days[-1]})")
    try:
        with httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=20, follow_redirects=False) as client:
            observations = fetch_all(client, days)
        print_summary(observations, aggregate(observations))
        res = run(dsn, observations, args.dry_run)
    except ScrapeError as e:
        print(f"\nFAILED, nothing was written: {e}", file=sys.stderr)
        return 1
    except psycopg.Error as e:
        print(f"\nFAILED, nothing was written (database error): {e}", file=sys.stderr)
        return 1

    verb = "Would change" if args.dry_run else "Changed"
    print(f"\n{verb}: routes +{res.routes_new} new / {res.routes_existing} existing; "
          f"trips +{res.trips_new} new, {res.trips_updated} updated, {res.trips_deactivated} deactivated, "
          f"{res.trips_skipped_manual} skipped (manual rows win)"
          + ("; operator booking_url set" if res.booking_url_set else ""))
    if args.dry_run:
        print("Dry run: rolled back, nothing saved.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
