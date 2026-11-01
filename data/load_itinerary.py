"""Load one curated itinerary with its guide (TG-52) into `itineraries`: the owner's real trip, as the trip's data.

Usage:
    python data/load_itinerary.py data/itineraries/baguio-barkada-2026-11-06.json --dry-run
    python data/load_itinerary.py data/itineraries/baguio-barkada-2026-11-06.json

The file is a pre-made entry (see load_premade.py: slugs and natural keys, never ids) plus a "guide": the day tables,
bus tables, sunrise pick, budget, to-do and sources. The core is resolved and checked with the planner's validator,
exactly like a pre-made plan; the guide's bus rows are resolved to trips (their times and fares come from the
schedule data, never the file) and its places to spots and terminals, then the guide is checked (app/guide.py).
Saved with model = 'curated' and share_slug = the file's "share_slug", updated in place on re-runs. Any problem rolls
back. Reads DATABASE_URL like data/load_data.py.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb
from pydantic import ValidationError

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "api"))

import load_data  # noqa: E402
import load_premade  # noqa: E402
from app.guide import parse_guide  # noqa: E402
from app.plan_validation import loc_path, validate_plan  # noqa: E402

MODEL = "curated"
SLUG = r"^[a-z0-9]+(-[a-z0-9]+)*$"


def read(path: Path) -> tuple[dict | None, list[str]]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        return None, [f"{path.name}: cannot read it as JSON ({type(e).__name__})"]
    if not isinstance(raw, dict):
        return None, [f"{path.name}: must be a JSON object"]
    return raw, []


def resolve_guide(cur, raw: dict) -> tuple[dict | None, list[str]]:
    """The guide with trips, spots and terminals as ids, or the problems."""
    operators = load_data.slug_map(cur, "operators")
    terminals = load_data.slug_map(cur, "terminals")
    spots = load_data.slug_map(cur, "spots")
    problems: list[str] = []
    g = json.loads(json.dumps(raw))  # a deep copy to fill in

    def place(p: dict | None, path: str) -> dict | None:
        if p is None:
            return None
        if "spot" in p:
            if p["spot"] not in spots:
                problems.append(f"{path}.spot: unknown spot {p['spot']!r}")
            return {"spot_id": spots.get(p["spot"])}
        if "terminal" in p:
            if p["terminal"] not in terminals:
                problems.append(f"{path}.terminal: unknown terminal {p['terminal']!r}")
            return {"terminal_id": terminals.get(p["terminal"])}
        problems.append(f"{path}: a place is a spot or a terminal")
        return None

    for table in ("getting_there", "getting_home"):
        for i, bus in enumerate(g.get(table, {}).get("buses", [])):
            try:
                ref = load_premade.TripKey.model_validate(bus.pop("trip"))
            except (ValidationError, KeyError) as e:
                problems.append(f"{table}.buses[{i}].trip: {e if isinstance(e, KeyError) else loc_path(e.errors()[0]['loc'])}")
                continue
            trip_id, errs = load_premade._resolve_trip(cur, ref, operators, terminals)
            problems += [f"{table}.buses[{i}].{e}" for e in errs]
            bus["trip_id"], bus["date"] = trip_id, ref.date.isoformat()
    if g.get("lodging") is not None:
        g["lodging"] = place(g["lodging"], "lodging")
    for d in g.get("days", []):
        for r in d.get("rows", []):
            r["place"] = place(r.get("place"), f"days[{d.get('day')}].{r.get('key')}.place")
            if r["place"] is None:
                del r["place"]
        for o in (d.get("pick") or {}).get("options", []):
            o["place"] = place(o.get("place"), f"days[{d.get('day')}].pick.{o.get('id')}.place")
            if o["place"] is None:
                del o["place"]
    if problems:
        return None, problems
    parsed, errs = parse_guide(g)
    if parsed is None:
        return None, [f"guide.{e}" for e in errs]
    return parsed.model_dump(mode="json", by_alias=True, exclude_none=True), []


UPSERT = """
insert into itineraries (share_slug, trip_date, return_date, party, budget_php, vibe, plan, model)
values (%(slug)s, %(trip_date)s, %(return_date)s, %(party)s, %(budget)s, %(vibe)s, %(plan)s, %(model)s)
on conflict (share_slug) do update set
  trip_date = excluded.trip_date, return_date = excluded.return_date, party = excluded.party,
  budget_php = excluded.budget_php, vibe = excluded.vibe, plan = excluded.plan
where itineraries.model = %(model)s
returning (xmax = 0) as inserted
"""


def run(dsn: str, path: Path, *, dry_run: bool) -> int:
    raw, problems = read(path)
    if raw is None:
        print("\n".join(problems), file=sys.stderr)
        return 1
    slug = raw.get("share_slug")
    if not isinstance(slug, str) or not __import__("re").fullmatch(SLUG, slug) or slug.startswith(load_premade.SLUG_PREFIX):
        print(f"{path.name}: share_slug must be a lower-case slug, not starting with {load_premade.SLUG_PREFIX}", file=sys.stderr)
        return 1
    core = {k: v for k, v in raw.items() if k not in ("_readme", "guide", "share_slug")}
    try:
        entry = load_premade.Entry.model_validate(core)
    except ValidationError as e:
        for d in e.errors(include_url=False, include_input=False):
            print(f"{loc_path(d['loc'])}: {d['msg']}", file=sys.stderr)
        return 1
    with psycopg.connect(dsn, prepare_threshold=None) as conn:
        with conn.cursor() as cur:
            plan, errs = load_premade.resolve(cur, entry)
            problems += errs
            guide, errs = resolve_guide(cur, raw.get("guide") or {})
            problems += errs
            if plan is not None:
                result = validate_plan(conn, plan, trip_date=entry.outbound.date, return_date=entry.return_.date)
                problems += [str(e) for e in result.errors]
            if not problems:
                stored = {**result.plan.to_json(), "guide": guide}
                cur.execute(UPSERT, {
                    "slug": slug, "trip_date": entry.outbound.date, "return_date": entry.return_.date,
                    "party": Jsonb([p.model_dump() for p in entry.party]), "budget": entry.budget_php,
                    "vibe": entry.vibe, "plan": Jsonb(stored), "model": MODEL,
                })
                if cur.fetchone() is None:
                    problems.append(f"share_slug {slug} belongs to an itinerary that isn't curated")
        if problems:
            conn.rollback()
            print(f"FAILED, nothing was written: {len(problems)} problem(s) found:\n", file=sys.stderr)
            for p in problems:
                print(f"  - {p}", file=sys.stderr)
            return 1
        rows = sum(len(d["rows"]) for d in guide["days"])
        if dry_run:
            conn.rollback()
            print(f"Dry run OK, nothing saved. Would load {slug}: {len(entry.days)} days, {rows} rows, {len(guide['todo'])} to-dos")
        else:
            conn.commit()
            print(f"Loaded {slug}: {len(entry.days)} days, {rows} rows, {len(guide['todo'])} to-dos")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("file", type=Path)
    p.add_argument("--dry-run", action="store_true", help="resolve and validate, then roll back")
    p.add_argument("--database-url", default=None, help=load_data.DATABASE_URL_FLAG_HELP)
    args = p.parse_args()
    dsn = load_data.database_url(args.database_url)
    if not dsn:
        print("DATABASE_URL is not set (env var or repo-root .env).", file=sys.stderr)
        return 2
    try:
        return run(dsn, args.file, dry_run=args.dry_run)
    except psycopg.Error as e:  # one redacted line, no traceback: the message can hold the DSN
        print(load_data.db_failure(e, dsn), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
