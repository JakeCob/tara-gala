"""Load hand-made itineraries (TG-24) from data/premade_itineraries.json into `itineraries`.

Usage:
    python data/load_premade.py --dry-run     # resolve and validate everything, write nothing
    python data/load_premade.py               # load (safe to re-run: rows are matched by key and updated)
    python data/load_premade.py --prune       # also delete pre-made rows that are no longer in the file

Entries are authored by slugs and natural keys, never ids. Each one is resolved against the
database, checked with the same validator the planner uses, and saved as an ordinary
`itineraries` row with model = 'premade' and share_slug = 'premade-<key>'. Any problem rolls
back the whole run. Reads DATABASE_URL and reports problems and database errors like
data/load_data.py, through its helpers (TG-40). See data/README.md.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date as Date
from datetime import time
from pathlib import Path
from typing import Annotated, Literal

import psycopg
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "api"))  # for app.plan_validation; imports no FastAPI or pool

import load_data  # noqa: E402
from app.plan_validation import HHMM, MODEL_PREMADE, loc_path, validate_plan  # noqa: E402
from app.schedule import runs_on  # noqa: E402

DEFAULT_FILE = HERE / "premade_itineraries.json"
SLUG_PREFIX = "premade-"

Key = Annotated[str, StringConstraints(pattern=r"^[a-z0-9]+(-[a-z0-9]+)*$")]


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class Passenger(_Model):  # no name field: pre-made plans are public
    type: Literal["adult", "student", "senior", "pwd", "child"]


class TripKey(_Model):
    operator: str
    origin: str
    departure: HHMM
    date: Date
    destination: str | None = None  # optional disambiguators
    class_: str | None = Field(None, alias="class")
    via: str | None = None


class LegKey(_Model):
    from_: str = Field(alias="from")  # terminal or spot slug
    to: str
    mode: str
    signboard: str | None = None


class AuthoredStop(_Model):
    spot: str
    arrive: HHMM
    leave: HHMM
    leg: LegKey


class AuthoredDay(_Model):
    day: int
    stops: list[AuthoredStop]


class Entry(_Model):
    key: Key
    vibe: Annotated[str, StringConstraints(min_length=1, max_length=40)]
    budget_php: float | None = Field(None, ge=0, lt=100_000_000)  # itineraries.budget_php is numeric(10,2)
    party: list[Passenger] = Field(min_length=1, max_length=10)
    outbound: TripKey
    return_: TripKey = Field(alias="return")
    days: list[AuthoredDay]


def _plural(n: int) -> str:
    return f"{n} pre-made itinerary" if n == 1 else f"{n} pre-made itineraries"


# ---------------------------------------------------------------------------
# Reading the file
# ---------------------------------------------------------------------------
def read_entries(path: Path) -> tuple[list[Entry], list[str]]:
    """Parse the file. Keys starting with _ (the readme and example) are ignored."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        return [], [f"{path.name}: cannot read it as JSON ({type(e).__name__})"]
    if not isinstance(data, dict) or not isinstance(data.get("itineraries"), list):
        return [], [f"{path.name}: must be a JSON object with an \"itineraries\" list"]

    entries, problems, seen = [], [], set()
    for i, raw in enumerate(data["itineraries"]):
        key = raw.get("key") if isinstance(raw, dict) else None
        label = key if isinstance(key, str) and key else f"itineraries[{i}]"  # names the entry in every problem line
        try:
            entry = Entry.model_validate(raw)
        except ValidationError as e:
            # include_input=False: never echo values, e.g. a passenger name that shouldn't be there
            for d in e.errors(include_url=False, include_input=False):
                problems.append(f"{label}: {loc_path(d['loc'])}: {d['msg']}")
            continue
        if entry.key in seen:
            problems.append(f"{entry.key}: key: used by more than one itinerary")
            continue
        seen.add(entry.key)
        entries.append(entry)
    return entries, problems


# ---------------------------------------------------------------------------
# Resolving slugs and natural keys to ids
# ---------------------------------------------------------------------------
def _unknown_seed(what: str, slug: str, known: dict[str, str]) -> str:
    """Operators and terminals are seeds: a typo and a deleted seed look the same, so hint at both (as load_data)."""
    return f"unknown {what} {slug!r}; known: {', '.join(sorted(known)) or '(none)'} (if it should exist, {load_data.SEEDS_HINT})"


def _resolve_trip(cur, ref: TripKey, operators: dict[str, str], terminals: dict[str, str]) -> tuple[str | None, list[str]]:
    """The trip id, or problems as "<field>: <message>"."""
    seeds = [(field, what, slug, known) for field, what, slug, known in (
        ("operator", "operator", ref.operator, operators),
        ("origin", "terminal", ref.origin, terminals),
        ("destination", "terminal", ref.destination, terminals),
    ) if slug is not None and slug not in known]
    if seeds:
        return None, [f"{field}: {_unknown_seed(what, slug, known)}" for field, what, slug, known in seeds]
    cur.execute(
        """
        select t.id, r.class::text, r.via, d.slug, t.days_of_week, t.valid_from, t.valid_to
        from trips t
        join routes r on r.id = t.route_id
        join operators o on o.id = r.operator_id
        join terminals s on s.id = r.origin_terminal_id
        join terminals d on d.id = r.destination_terminal_id
        where t.is_active and o.slug = %s and s.slug = %s and t.departure_time = %s
        order by r.class, r.via nulls first, d.slug
        """,
        (ref.operator, ref.origin, time.fromisoformat(ref.departure)),
    )
    matches = [
        row for row in cur.fetchall()
        if (ref.destination is None or row[3] == ref.destination)
        and (ref.class_ is None or row[1] == ref.class_)
        and (ref.via is None or row[2] == ref.via)
        and runs_on(row[4], row[5], row[6], ref.date)
    ]
    if not matches:
        return None, [f"trip_id: no active {ref.operator} trip from {ref.origin} at {ref.departure} running on {ref.date}"]
    if len(matches) > 1:
        options = ", ".join(f"{cls} via {via or '-'} to {dest}" for _, cls, via, dest, *_ in matches)
        return None, [f"trip_id: {len(matches)} trips match; add class, via or destination: {options}"]
    return str(matches[0][0]), []


def _place(slug: str, terminals: dict[str, str], spots: dict[str, str]) -> tuple[tuple[str | None, str | None] | None, str | None]:
    """(terminal id, spot id) for a slug, or an error."""
    if slug in terminals and slug in spots:
        return None, f"ambiguous place {slug!r}: it is both a terminal and a spot slug"
    if slug in terminals:
        return (terminals[slug], None), None
    if slug in spots:
        return (None, spots[slug]), None
    return None, f"unknown place {slug!r}: not a terminal or spot slug (if it's a terminal that should exist, {load_data.SEEDS_HINT})"


def _resolve_leg(cur, leg: LegKey, terminals, spots) -> tuple[str | None, str | None]:
    start, err = _place(leg.from_, terminals, spots)
    if err:
        return None, err
    end, err = _place(leg.to, terminals, spots)
    if err:
        return None, err
    cur.execute(
        """
        select id from last_mile_routes
        where from_terminal_id is not distinct from %s and from_spot_id is not distinct from %s
          and to_terminal_id is not distinct from %s and to_spot_id is not distinct from %s
          and mode::text = %s and (%s::text is null or signboard = %s)
        """,
        (*start, *end, leg.mode, leg.signboard, leg.signboard),
    )
    ids = [row[0] for row in cur.fetchall()]
    what = f"{leg.mode} leg from {leg.from_} to {leg.to}" + (f" ({leg.signboard})" if leg.signboard else "")
    if not ids:
        return None, f"no {what}"
    if len(ids) > 1:
        return None, f"{len(ids)} matches for the {what}; add its signboard"
    return str(ids[0]), None


def resolve(cur, entry: Entry) -> tuple[dict | None, list[str]]:
    """The entry as the CLAUDE.md planner output shape, or the problems ("<path>: <message>")."""
    operators = load_data.slug_map(cur, "operators")
    terminals = load_data.slug_map(cur, "terminals")
    spots = load_data.slug_map(cur, "spots")
    problems = []
    trip_ids = {}
    for name, ref in (("outbound", entry.outbound), ("return", entry.return_)):
        trip_ids[name], errs = _resolve_trip(cur, ref, operators, terminals)
        problems += [f"{name}.{e}" for e in errs]
    days = []
    for di, day in enumerate(entry.days):
        stops = []
        for si, stop in enumerate(day.stops):
            path = f"days[{di}].stops[{si}]"
            if stop.spot not in spots:
                problems.append(f"{path}.spot: unknown spot {stop.spot!r}")
            leg_id, err = _resolve_leg(cur, stop.leg, terminals, spots)
            if err:
                problems.append(f"{path}.leg: {err}")
            stops.append({
                "spot_id": spots.get(stop.spot), "arrive": stop.arrive, "leave": stop.leave,
                "leg": {"last_mile_route_id": leg_id},
            })
        days.append({"day": day.day, "stops": stops})
    if problems:
        return None, problems
    plan = {
        "outbound": {"trip_id": trip_ids["outbound"], "date": entry.outbound.date.isoformat()},
        "return": {"trip_id": trip_ids["return"], "date": entry.return_.date.isoformat()},
        "days": days,
    }
    return plan, []


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
UPSERT = """
insert into itineraries (share_slug, trip_date, return_date, party, budget_php, vibe, plan, model)
values (%(slug)s, %(trip_date)s, %(return_date)s, %(party)s, %(budget)s, %(vibe)s, %(plan)s, %(model)s)
on conflict (share_slug) do update set
  trip_date = excluded.trip_date, return_date = excluded.return_date, party = excluded.party,
  budget_php = excluded.budget_php, vibe = excluded.vibe, plan = excluded.plan
where itineraries.model = %(model)s
returning (xmax = 0) as inserted
"""


def run(dsn: str, path: Path, *, dry_run: bool, prune: bool) -> int:
    entries, problems = read_entries(path)
    with psycopg.connect(dsn, prepare_threshold=None) as conn:
        plans = []
        with conn.cursor() as cur:
            for entry in entries:
                plan, errs = resolve(cur, entry)
                problems += [f"{entry.key}: {e}" for e in errs]
                if plan is None:
                    continue
                result = validate_plan(conn, plan, trip_date=entry.outbound.date, return_date=entry.return_.date)
                problems += [f"{entry.key}: {e}" for e in result.errors]
                if result.ok:
                    plans.append((entry, result.plan.to_json()))

            new = updated = 0
            stale: list[str] = []
            if not problems:
                for entry, plan in plans:
                    cur.execute(UPSERT, {
                        "slug": SLUG_PREFIX + entry.key, "trip_date": entry.outbound.date,
                        "return_date": entry.return_.date,
                        "party": Jsonb([p.model_dump() for p in entry.party]),
                        "budget": entry.budget_php, "vibe": entry.vibe, "plan": Jsonb(plan), "model": MODEL_PREMADE,
                    })
                    row = cur.fetchone()
                    if row is None:  # the guard skipped a row that isn't pre-made
                        problems.append(f"{entry.key}: share_slug {SLUG_PREFIX + entry.key} belongs to an itinerary that isn't pre-made")
                    elif row[0]:
                        new += 1
                    else:
                        updated += 1
                cur.execute(
                    "select share_slug from itineraries where model = %s and share_slug <> all(%s) order by share_slug",
                    (MODEL_PREMADE, [SLUG_PREFIX + e.key for e, _ in plans]),
                )
                stale = [row[0] for row in cur.fetchall()]
                if stale and prune:
                    cur.execute("delete from itineraries where model = %s and share_slug = any(%s)", (MODEL_PREMADE, stale))

        if problems:
            conn.rollback()
            print(f"FAILED, nothing was written: {len(problems)} problem(s) found:\n", file=sys.stderr)
            for p in problems:
                print(f"  - {p}", file=sys.stderr)
            return 1

        if stale and prune:
            print(f"{'Would prune' if dry_run else 'Pruned'} {_plural(len(stale))} ({', '.join(stale)})")
        elif stale:
            verb, them = ("is", "it") if len(stale) == 1 else ("are", "them")
            print(f"{_plural(len(stale))} in the database {verb} not in the file ({', '.join(stale)}); run with --prune to delete {them}")
        if dry_run:
            conn.rollback()
            print(f"Dry run OK, nothing saved. Would load {_plural(len(plans))}")
        else:
            conn.commit()
            print(f"Loaded {_plural(len(plans))} ({new} new, {updated} updated)")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dry-run", action="store_true", help="resolve and validate, then roll back")
    p.add_argument("--file", type=Path, default=DEFAULT_FILE, help="itineraries file (default: data/premade_itineraries.json)")
    p.add_argument("--database-url", default=None, help=load_data.DATABASE_URL_FLAG_HELP)
    p.add_argument("--prune", action="store_true", help="delete pre-made rows that are not in the file")
    args = p.parse_args()

    dsn = load_data.database_url(args.database_url)
    if not dsn:
        print("DATABASE_URL is not set (env var or repo-root .env).", file=sys.stderr)
        return 2
    try:
        return run(dsn, args.file, dry_run=args.dry_run, prune=args.prune)
    except psycopg.Error as e:  # one redacted line, no traceback: the message can hold the DSN
        print(load_data.db_failure(e, dsn), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
