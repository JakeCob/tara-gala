"""Load hand-entered CSVs into Supabase.

Usage:
    python data/load_data.py --dry-run     # validate everything, write nothing
    python data/load_data.py               # load (safe to re-run: rows are matched and updated)

Reads DATABASE_URL from the environment or from the repo-root .env file. --database-url still works but warns:
it shows the password in the process list (ps). Database errors are printed with the password and DSN masked.
Load order: spots.csv, routes_trips.csv, last_mile_routes.csv.
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
from collections.abc import Iterable
from datetime import date, datetime, time
from pathlib import Path
from zoneinfo import ZoneInfo

import psycopg

MANILA = ZoneInfo("Asia/Manila")
HERE = Path(__file__).resolve().parent
API_DIR = HERE.parent / "api"
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))  # app.redact: stdlib only, no FastAPI (TG-40)
from app.redact import redact_error  # noqa: E402

SEEDS_HINT = "run supabase/schema.sql seeds"
DATABASE_URL_FLAG_WARNING = (
    "WARNING: --database-url shows the password in the process list (ps) while this runs. "
    "Set DATABASE_URL in the environment or the repo .env instead."
)
DATABASE_URL_FLAG_HELP = "deprecated: visible in ps while it runs; set DATABASE_URL (env or repo .env) instead"

CLASSES = {
    "regular_aircon", "deluxe", "super_deluxe", "executive", "premiere",
    "first_class", "luxury", "royal_class", "p2p",
}
MODES = {"jeep", "taxi", "walk", "tricycle", "van", "grab"}
SPOT_CATEGORIES = {"park", "food", "market", "museum", "viewpoint", "shopping", "church", "cafe", "other"}
DAY_NAMES = {"sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6}
DAY_PRESETS = {"daily": [0, 1, 2, 3, 4, 5, 6], "weekdays": [1, 2, 3, 4, 5], "weekends": [0, 6]}


class RowError(Exception):
    pass


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------
def _s(row: dict, key: str) -> str | None:
    v = (row.get(key) or "").strip()
    return v or None


def _req(row: dict, key: str) -> str:
    v = _s(row, key)
    if v is None:
        raise RowError(f"'{key}' is required")
    return v


def _num(row: dict, key: str) -> float | None:
    v = _s(row, key)
    if v is None:
        return None
    try:
        return float(v.replace(",", ""))
    except ValueError:
        raise RowError(f"'{key}' must be a number, got {v!r}")


def _int(row: dict, key: str) -> int | None:
    v = _num(row, key)
    return int(v) if v is not None else None


def _bool(row: dict, key: str) -> bool | None:
    v = _s(row, key)
    if v is None:
        return None
    if v.lower() in {"yes", "y", "true", "1"}:
        return True
    if v.lower() in {"no", "n", "false", "0"}:
        return False
    raise RowError(f"'{key}' must be yes or no, got {v!r}")


def _date(row: dict, key: str) -> date | None:
    v = _s(row, key)
    if v is None:
        return None
    try:
        return date.fromisoformat(v)
    except ValueError:
        raise RowError(f"'{key}' must be YYYY-MM-DD, got {v!r}")


def _time(row: dict, key: str) -> time:
    v = _req(row, key).upper().replace(".", "")
    for fmt in ("%H:%M", "%I:%M %p", "%I:%M%p", "%I %p", "%I%p"):
        try:
            return datetime.strptime(v, fmt).time()
        except ValueError:
            pass
    raise RowError(f"'{key}' must be a time like 09:30 or 9:30 PM, got {v!r}")


def _days(row: dict, key: str) -> list[int]:
    v = (_s(row, key) or "daily").lower()
    if v in DAY_PRESETS:
        return DAY_PRESETS[v]
    out = []
    for part in v.replace(" ", "").split(","):
        if part in DAY_NAMES:
            out.append(DAY_NAMES[part])
        elif part.isdigit() and 0 <= int(part) <= 6:
            out.append(int(part))
        else:
            raise RowError(f"'{key}' must be daily, weekdays, weekends or a list like fri,sat,sun; got {v!r}")
    return sorted(set(out))


def _verified(row: dict, key: str = "verified_on") -> datetime:
    d = _date(row, key)
    if d is None:
        raise RowError("'verified_on' is required: the date you checked this against the source")
    return datetime(d.year, d.month, d.day, 12, 0, tzinfo=MANILA)


def _choice(row: dict, key: str, allowed: set[str], default: str | None = None) -> str:
    v = (_s(row, key) or default or "").lower()
    if v not in allowed:
        raise RowError(f"'{key}' must be one of {', '.join(sorted(allowed))}; got {v!r}")
    return v


def read_csv(path: Path) -> list[tuple[int, dict]]:
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8-sig") as f:
        rows = []
        for i, row in enumerate(csv.DictReader(f), start=2):  # row 1 is the header
            if not any((v or "").strip() for v in row.values()):
                continue
            if (next(iter(row.values())) or "").lstrip().startswith("#"):
                continue  # comment row
            rows.append((i, row))
        return rows


# ---------------------------------------------------------------------------
# Lookups
# ---------------------------------------------------------------------------
def slug_map(cur, table: str) -> dict[str, str]:
    cur.execute(f"select slug, id from {table}")
    return {slug: str(id_) for slug, id_ in cur.fetchall()}


def _lookup(mapping: dict[str, str], slug: str | None, what: str) -> str | None:
    if slug is None:
        return None
    if slug not in mapping:
        known = ', '.join(sorted(mapping)) or '(none)'
        # Operators and terminals are seeds: a typo and a deleted seed look the same here, so hint at both
        hint = f" (if it should exist, {SEEDS_HINT})" if what in ("operator", "terminal") else ""
        raise RowError(f"unknown {what} {slug!r}; known: {known}{hint}")
    return mapping[slug]


def missing_seed_message(what: str, slugs: Iterable[str]) -> str:
    """E.g. "missing terminal slug 'vl-cubao' (run supabase/schema.sql seeds)"; plural 'slugs' for several, sorted."""
    names = sorted(slugs)
    return f"missing {what} slug{'s' if len(names) > 1 else ''} {', '.join(map(repr, names))} ({SEEDS_HINT})"


# ---------------------------------------------------------------------------
# Loaders
# ---------------------------------------------------------------------------
def load_spots(cur, rows) -> tuple[int, list[str]]:
    errors, n = [], 0
    for line, row in rows:
        try:
            vals = dict(
                slug=_req(row, "slug"),
                name=_req(row, "name"),
                category=_choice(row, "category", SPOT_CATEGORIES, "other"),
                lat=_num(row, "lat"),
                lng=_num(row, "lng"),
                description=_s(row, "description"),
                visit_minutes=_int(row, "visit_minutes"),
                entrance_fee_php=_num(row, "entrance_fee_php"),
            )
        except RowError as e:
            errors.append(f"spots.csv line {line}: {e}")
            continue
        cur.execute(
            """
            insert into spots (slug, name, category, lat, lng, description, visit_minutes, entrance_fee_php)
            values (%(slug)s, %(name)s, %(category)s, %(lat)s, %(lng)s, %(description)s, %(visit_minutes)s, %(entrance_fee_php)s)
            on conflict (slug) do update set
              name = excluded.name, category = excluded.category, lat = excluded.lat, lng = excluded.lng,
              description = excluded.description, visit_minutes = excluded.visit_minutes,
              entrance_fee_php = excluded.entrance_fee_php
            """,
            vals,
        )
        n += 1
    return n, errors


def load_routes_trips(cur, rows) -> tuple[int, int, list[str]]:
    operators = slug_map(cur, "operators")
    terminals = slug_map(cur, "terminals")
    errors, new_routes, n_trips = [], 0, 0
    for line, row in rows:
        try:
            op = _lookup(operators, _req(row, "operator"), "operator")
            origin = _lookup(terminals, _req(row, "origin"), "terminal")
            dest = _lookup(terminals, _req(row, "destination"), "terminal")
            if origin == dest:
                raise RowError("origin and destination are the same terminal")
            route = dict(
                op=op, origin=origin, dest=dest,
                via=_s(row, "via"),
                cls=_choice(row, "class", CLASSES),
                fare=_num(row, "fare_php"),
                minutes=_int(row, "travel_minutes"),
                layout=_s(row, "seat_layout"),
                restroom=_bool(row, "has_restroom"),
            )
            trip = dict(
                dep=_time(row, "departure_time"),
                days=_days(row, "days"),
                vfrom=_date(row, "valid_from"),
                vto=_date(row, "valid_to"),
                src_url=_s(row, "source_url"),
                verified=_verified(row),
                notes=_s(row, "notes"),
            )
            if trip["vfrom"] and trip["vto"] and trip["vto"] < trip["vfrom"]:
                raise RowError("valid_to is before valid_from")
            if not trip["src_url"]:
                raise RowError("'source_url' is required: the operator page or FB post you checked")
        except RowError as e:
            errors.append(f"routes_trips.csv line {line}: {e}")
            continue

        # Route: matched on operator, ends, via and class
        cur.execute(
            """
            select id from routes
            where operator_id = %(op)s and origin_terminal_id = %(origin)s and destination_terminal_id = %(dest)s
              and via is not distinct from %(via)s and class = %(cls)s
            """,
            route,
        )
        found = cur.fetchone()
        if found:
            route_id = found[0]
            # Only overwrite optional route fields when the row gives a value
            cur.execute(
                """
                update routes set
                  fare_php = coalesce(%(fare)s, fare_php),
                  travel_minutes = coalesce(%(minutes)s, travel_minutes),
                  seat_layout = coalesce(%(layout)s, seat_layout),
                  has_restroom = coalesce(%(restroom)s, has_restroom)
                where id = %(id)s
                """,
                {**route, "id": route_id},
            )
        else:
            cur.execute(
                """
                insert into routes (operator_id, origin_terminal_id, destination_terminal_id, via, class,
                                    fare_php, travel_minutes, seat_layout, has_restroom)
                values (%(op)s, %(origin)s, %(dest)s, %(via)s, %(cls)s, %(fare)s, %(minutes)s, %(layout)s, %(restroom)s)
                returning id
                """,
                route,
            )
            route_id = cur.fetchone()[0]
            new_routes += 1

        # Trip: matched on route, departure time and valid_from
        trip["route_id"] = route_id
        cur.execute(
            """
            select id from trips
            where route_id = %(route_id)s and departure_time = %(dep)s and valid_from is not distinct from %(vfrom)s
            """,
            trip,
        )
        found = cur.fetchone()
        if found:
            cur.execute(
                """
                update trips set days_of_week = %(days)s, valid_to = %(vto)s, is_active = true, source = 'manual',
                  source_url = %(src_url)s, last_verified_at = %(verified)s, notes = %(notes)s
                where id = %(id)s
                """,
                {**trip, "id": found[0]},
            )
        else:
            cur.execute(
                """
                insert into trips (route_id, departure_time, days_of_week, valid_from, valid_to, source,
                                   source_url, last_verified_at, notes)
                values (%(route_id)s, %(dep)s, %(days)s, %(vfrom)s, %(vto)s, 'manual', %(src_url)s, %(verified)s, %(notes)s)
                """,
                trip,
            )
        n_trips += 1
    return new_routes, n_trips, errors


def load_last_mile(cur, rows) -> tuple[int, list[str]]:
    terminals = slug_map(cur, "terminals")
    spots = slug_map(cur, "spots")
    errors, n = [], 0
    for line, row in rows:
        try:
            vals = dict(
                ft=_lookup(terminals, _s(row, "from_terminal"), "terminal"),
                fs=_lookup(spots, _s(row, "from_spot"), "spot"),
                tt=_lookup(terminals, _s(row, "to_terminal"), "terminal"),
                ts=_lookup(spots, _s(row, "to_spot"), "spot"),
                mode=_choice(row, "mode", MODES),
                signboard=_s(row, "signboard"),
                boarding=_s(row, "boarding_point"),
                alighting=_s(row, "alighting_point"),
                fmin=_num(row, "fare_min_php"),
                fmax=_num(row, "fare_max_php"),
                minutes=_int(row, "minutes"),
                verified=_verified(row),
                notes=_s(row, "notes"),
            )
            if (vals["ft"] is None) == (vals["fs"] is None):
                raise RowError("fill exactly one of from_terminal or from_spot")
            if (vals["tt"] is None) == (vals["ts"] is None):
                raise RowError("fill exactly one of to_terminal or to_spot")
            if vals["fmin"] is not None and vals["fmax"] is not None and vals["fmax"] < vals["fmin"]:
                raise RowError("fare_max_php is below fare_min_php")
        except RowError as e:
            errors.append(f"last_mile_routes.csv line {line}: {e}")
            continue

        cur.execute(
            """
            select id from last_mile_routes
            where from_terminal_id is not distinct from %(ft)s and from_spot_id is not distinct from %(fs)s
              and to_terminal_id is not distinct from %(tt)s and to_spot_id is not distinct from %(ts)s
              and mode = %(mode)s and signboard is not distinct from %(signboard)s
            """,
            vals,
        )
        found = cur.fetchone()
        if found:
            cur.execute(
                """
                update last_mile_routes set boarding_point = %(boarding)s, alighting_point = %(alighting)s,
                  fare_min_php = %(fmin)s, fare_max_php = %(fmax)s, minutes = %(minutes)s,
                  source = 'manual', last_verified_at = %(verified)s, notes = %(notes)s
                where id = %(id)s
                """,
                {**vals, "id": found[0]},
            )
        else:
            cur.execute(
                """
                insert into last_mile_routes (from_terminal_id, from_spot_id, to_terminal_id, to_spot_id, mode,
                  signboard, boarding_point, alighting_point, fare_min_php, fare_max_php, minutes,
                  source, last_verified_at, notes)
                values (%(ft)s, %(fs)s, %(tt)s, %(ts)s, %(mode)s, %(signboard)s, %(boarding)s, %(alighting)s,
                        %(fmin)s, %(fmax)s, %(minutes)s, 'manual', %(verified)s, %(notes)s)
                """,
                vals,
            )
        n += 1
    return n, errors


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def _dotenv_database_url() -> str | None:
    env = HERE.parent / ".env"
    if not env.exists():
        return None
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("DATABASE_URL="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def database_url(cli_value: str | None) -> str | None:
    """--database-url (warns once on stderr, never with the value), else DATABASE_URL, else the repo .env."""
    if cli_value:
        print(DATABASE_URL_FLAG_WARNING, file=sys.stderr)
        return cli_value
    return os.environ.get("DATABASE_URL") or _dotenv_database_url()


def db_failure(exc: psycopg.Error, dsn: str | None) -> str:
    """The FAILED line both scripts print, redacted; adds the schema hint for UndefinedTable."""
    line = f"FAILED, nothing was written (database error): {redact_error(exc, dsn)}"
    return line + " (run supabase/schema.sql first)" if isinstance(exc, psycopg.errors.UndefinedTable) else line


def run(dsn: str, data_dir: Path, dry_run: bool) -> int:
    spots_rows = read_csv(data_dir / "spots.csv")
    trip_rows = read_csv(data_dir / "routes_trips.csv")
    lm_rows = read_csv(data_dir / "last_mile_routes.csv")

    with psycopg.connect(dsn, prepare_threshold=None) as conn:
        with conn.cursor() as cur:
            n_spots, e1 = load_spots(cur, spots_rows)
            new_routes, n_trips, e2 = load_routes_trips(cur, trip_rows)
            n_lm, e3 = load_last_mile(cur, lm_rows)
        errors = e1 + e2 + e3

        if errors:
            conn.rollback()
            print(f"FAILED, nothing was written: {len(errors)} problem(s) found:\n", file=sys.stderr)
            for e in errors:
                print(f"  - {e}", file=sys.stderr)
            return 1

        summary = f"spots: {n_spots}, trips: {n_trips} ({new_routes} new routes), last-mile routes: {n_lm}"
        if dry_run:
            conn.rollback()
            print(f"Dry run OK, nothing saved. Would load {summary}")
        else:
            conn.commit()
            print(f"Loaded {summary}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dry-run", action="store_true", help="validate and roll back")
    p.add_argument("--data-dir", type=Path, default=HERE, help="folder with the CSVs (default: data/)")
    p.add_argument("--database-url", default=None, help=DATABASE_URL_FLAG_HELP)
    args = p.parse_args()

    dsn = database_url(args.database_url)
    if not dsn:
        print("DATABASE_URL is not set (env var or repo-root .env).", file=sys.stderr)
        return 2
    try:
        return run(dsn, args.data_dir, args.dry_run)
    except psycopg.Error as e:
        print(db_failure(e, dsn), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
