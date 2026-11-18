"""TG-62 GP1: give a key to every keyless budget row in stored plans (plan.md §3 G21, §5 step 4).

Usage:
    python data/backfill_budget_keys.py            # a dry run: counts only, nothing saved
    python data/backfill_budget_keys.py --apply
    python data/backfill_budget_keys.py --strip    # §6 N1, only before a G0 revert: remove every key and category

Reads every itineraries.plan and itinerary_versions.plan with a guide, in one transaction:
- a keyless row whose text matches a row of the curated file its plan was copied from (data/itineraries/, by share_slug)
  gets that row's key and category;
- any other keyless row gets budget_keys.slug_key of its text, the same key for the same text in every version of one
  trip's plan, so itineraries.plan still equals its newest version;
- a row that already has a key is never changed, and two rows of one plan never share a key. Run twice, the second run
  keys 0 (§5's check that no stored row is keyless).

It prints counts only: plans read, rows keyed, rows already keyed. Never a line's text or key, a slug or an id: they're
the group's own words. Reads DATABASE_URL like data/load_data.py. Never point it at a database without the owner's yes.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "api"))

import load_data  # noqa: E402
from app.budget_keys import unique_key  # noqa: E402

ITINERARIES = HERE / "itineraries"
CURATED = "curated"  # load_itinerary.MODEL

ITS_SQL = """
select i.id, i.share_slug, i.model, i.plan,
       (select b.share_slug from itinerary_versions v join itineraries b on b.id = v.based_on
         where v.itinerary_id = i.id and v.seq = 0) as copied_from
from itineraries i where i.plan ? 'guide' order by i.id for update of i
"""
VERSIONS_SQL = "select id, itinerary_id, plan from itinerary_versions where plan ? 'guide' order by itinerary_id, seq for update"


def curated_files(folder: Path) -> dict[str, list[dict]]:
    """Each curated file's budget rows, by its share_slug."""
    out = {}
    for path in sorted(folder.glob("*.json")):
        raw = json.loads(path.read_text(encoding="utf-8"))
        rows = (((raw.get("guide") or {}).get("budget") or {}).get("rows")) or []
        if isinstance(raw.get("share_slug"), str):
            out[raw["share_slug"]] = [r for r in rows if isinstance(r, dict) and r.get("key")]
    return out


def _rows(plan: dict) -> list[dict]:
    rows = ((plan.get("guide") or {}).get("budget") or {}).get("rows")
    return [r for r in rows if isinstance(r, dict) and isinstance(r.get("item"), str)] if isinstance(rows, list) else []


class Trip:
    """One itinerary's plans (its versions, then the plan it holds), keyed the same way throughout."""

    def __init__(self, plans: list[dict], curated: list[dict]):
        self.taken = {r["key"] for p in plans for r in _rows(p) if r.get("key")} | {r["key"] for r in curated}
        self.curated = defaultdict(list)
        for r in curated:
            self.curated[r["item"]].append(r)
        self.by_text: dict[tuple[str, int], tuple[str, str | None]] = {}
        self.keyed = self.already = 0

    def key(self, plan: dict) -> None:
        rows = _rows(plan)
        here = {r["key"] for r in rows if r.get("key")}
        seen: dict[str, int] = defaultdict(int)
        for r in rows:
            n = seen[r["item"]]
            seen[r["item"]] += 1
            if r.get("key"):
                self.already += 1
                continue
            known = self.by_text.get((r["item"], n))
            same = self.curated[r["item"]][n] if n < len(self.curated[r["item"]]) else None
            if known and known[0] not in here:
                key, category = known
            elif same and same["key"] not in here:
                key, category = same["key"], same.get("category")
            else:
                key, category = unique_key(r["item"], self.taken | here), None
            self.by_text.setdefault((r["item"], n), (key, category))
            r["key"] = key
            if category is not None and r.get("category") is None:
                r["category"] = category
            here.add(key)
            self.taken.add(key)
            self.keyed += 1


def _strip(plan: dict) -> int:
    n = 0
    for r in _rows(plan):
        if "key" in r or "category" in r:
            r.pop("key", None)
            r.pop("category", None)
            n += 1
    return n


class Counts:
    def __init__(self):
        self.plans = self.keyed = self.already = self.stripped = 0
        self.writes: list[tuple[str, object, dict]] = []

    def group(self, group: list[tuple[str, object, dict]], curated: list[dict] | None, strip: bool) -> None:
        """One itinerary's plans, as (table, id, plan): keyed together (or stripped), and the changed ones kept to write."""
        self.plans += len(group)
        before = [json.dumps(p, sort_keys=True) for _, _, p in group]
        if strip:
            self.stripped += sum(_strip(p) for _, _, p in group)
        else:
            trip = Trip([p for _, _, p in group], curated or [])
            for _, _, p in group:
                trip.key(p)
            self.keyed, self.already = self.keyed + trip.keyed, self.already + trip.already
        self.writes += [g for g, b in zip(group, before, strict=True) if json.dumps(g[2], sort_keys=True) != b]


def run(dsn: str, *, apply: bool, strip: bool = False, folder: Path = ITINERARIES) -> int:
    curated = curated_files(folder)
    c = Counts()
    with psycopg.connect(dsn, prepare_threshold=None) as conn:
        its = conn.execute(ITS_SQL).fetchall()
        by_it: dict = defaultdict(list)
        for v_id, it_id, plan in conn.execute(VERSIONS_SQL).fetchall():
            by_it[it_id].append(("itinerary_versions", v_id, plan))
        for it_id, slug, model, plan, copied_from in its:
            source = slug if model == CURATED else copied_from
            c.group(by_it.pop(it_id, []) + [("itineraries", it_id, plan)], curated.get(source), strip)
        for rest in by_it.values():  # versions whose itinerary holds no guide now: keyed on their own
            c.group(rest, None, strip)
        for table, row_id, plan in c.writes:
            conn.execute(f"update {table} set plan = %s where id = %s", (Jsonb(plan), row_id))
        if apply:
            conn.commit()
        else:
            conn.rollback()
            print("Dry run: nothing saved.")
    print(f"plans read: {c.plans}")
    if strip:
        print(f"rows stripped: {c.stripped}")
    else:
        print(f"rows keyed: {c.keyed}")
        print(f"rows already keyed: {c.already}")
    print(f"plans {'saved' if apply else 'that would change'}: {len(c.writes)}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--apply", action="store_true", help="save; without it, a dry run that rolls back")
    p.add_argument("--strip", action="store_true", help="remove every budget key and category instead (plan §6)")
    p.add_argument("--database-url", default=None, help=load_data.DATABASE_URL_FLAG_HELP)
    args = p.parse_args()
    dsn = load_data.database_url(args.database_url)
    if not dsn:
        print("DATABASE_URL is not set (env var or repo-root .env).", file=sys.stderr)
        return 2
    try:
        return run(dsn, apply=args.apply, strip=args.strip)
    except psycopg.Error as e:  # one redacted line, no traceback: the message can hold the DSN
        print(load_data.db_failure(e, dsn), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
