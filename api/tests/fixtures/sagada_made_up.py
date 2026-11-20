"""TG-67: made-up Sagada rows for tests only. Not real schedules, terminals, spots or legs, and never the owner's trip.

An operator `test-sagada-lines`, terminals `test-sg-cubao` (Quezon City) and `test-sg-sagada` (Sagada), two Manila to
Sagada trips on 2026-11-25 (so a swap is possible) and one Sagada to Manila trip on 2026-11-28, each with
travel_minutes set. Two Sagada spots and two walk legs with city 'Sagada'. Spots and legs go in with SQL, so these
tests don't depend on S1's loader column.
"""

import json
from datetime import date
from pathlib import Path

import psycopg

import load_data
from conftest import write_csvs

SRC = "https://example.test/sagada-schedule"
OUT_DATE, RET_DATE = date(2026, 11, 25), date(2026, 11, 28)
DAY1 = date(2026, 11, 26)  # 22:30 + 720 minutes arrives 10:30 the next day

SEED = """
insert into operators (slug, name) values ('test-sagada-lines', 'Test Sagada Lines (made up)');
insert into terminals (slug, name, city) values
  ('test-sg-cubao', 'Test SG Cubao (made up)', 'Quezon City'),
  ('test-sg-sagada', 'Test SG Sagada stop (made up)', 'Sagada');
insert into operator_terminals (operator_id, terminal_id)
  select o.id, t.id from operators o, terminals t
  where o.slug = 'test-sagada-lines' and t.slug in ('test-sg-cubao', 'test-sg-sagada');
"""

# operator,origin,destination,via,class,fare_php,travel_minutes,seat_layout,has_restroom,departure_time,days,valid_from,valid_to,source_url,verified_on,notes
TRIPS = (
    f"test-sagada-lines,test-sg-cubao,test-sg-sagada,,regular_aircon,1232,720,2x2,yes,22:30,daily,2026-11-25,2026-11-25,{SRC},2026-11-20,made up for tests only\n"
    f"test-sagada-lines,test-sg-cubao,test-sg-sagada,,regular_aircon,1232,720,2x2,yes,21:00,daily,2026-11-25,2026-11-25,{SRC},2026-11-20,made up for tests only\n"
    f"test-sagada-lines,test-sg-sagada,test-sg-cubao,,regular_aircon,1232,720,2x2,yes,14:30,daily,2026-11-28,2026-11-28,{SRC},2026-11-20,made up for tests only\n"
)

SPOTS_SQL = """
insert into spots (slug, name, city, category, description) values
  ('test-sg-info', 'Test SG Info Center (made up)', 'Sagada', 'other', 'made up for tests only'),
  ('test-sg-lodge', 'Test SG Lodge (made up)', 'Sagada', 'other', 'made up for tests only (lodging stand-in, no pin)');
insert into last_mile_routes (city, from_terminal_id, to_spot_id, mode, minutes, notes)
  select 'Sagada', t.id, s.id, 'walk', 5, 'made up for tests only'
  from terminals t, spots s where t.slug = 'test-sg-sagada' and s.slug = 'test-sg-info';
insert into last_mile_routes (city, from_spot_id, to_spot_id, mode, minutes, notes)
  select 'Sagada', a.id, b.id, 'walk', 10, 'made up for tests only'
  from spots a, spots b where a.slug = 'test-sg-info' and b.slug = 'test-sg-lodge';
"""

OUT = ("test-sg-cubao", "22:30", "regular_aircon")  # keys of premade_data.db_ids()
OUT_EARLY = ("test-sg-cubao", "21:00", "regular_aircon")
RET = ("test-sg-sagada", "14:30", "regular_aircon")

# Core day 1: arrive 10:30, walk 5 to the info center, then walk 10 to the lodge. Days 2 and 3 are empty (plan §12.2).
DAYS = [
    (1, [
        ("test-sg-info", "10:35", "11:00", ("test-sg-sagada", "test-sg-info", "walk")),
        ("test-sg-lodge", "11:10", "11:30", ("test-sg-info", "test-sg-lodge", "walk")),
    ]),
    (2, []),
    (3, []),
]


def load(dsn, folder: Path) -> None:
    """The made-up Sagada rows, on top of whatever is loaded already (the loader only upserts)."""
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(SEED)
    folder.mkdir(parents=True, exist_ok=True)
    write_csvs(folder, trips=TRIPS)
    assert load_data.run(dsn, folder, dry_run=False) == 0
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(SPOTS_SQL)


def plan(dsn, out=OUT, ret=RET, days=DAYS) -> dict:
    """The core plan shape, by ids (premade_data.build_plan)."""
    from premade_data import build_plan, db_ids

    trips, spots, legs = db_ids(dsn)
    return build_plan(trips[out], OUT_DATE, trips[ret], RET_DATE, days, spots, legs)


def entry(key: str = "test-sagada") -> dict:
    """The core as a curated file authors it (slugs, never ids)."""
    from premade_data import authored_days

    return {
        "key": key,
        "vibe": "Chill and treks (made up)",
        "party": [{"type": "adult"}, {"type": "adult"}],
        "outbound": {"operator": "test-sagada-lines", "origin": "test-sg-cubao", "departure": "22:30", "date": OUT_DATE.isoformat()},
        "return": {"operator": "test-sagada-lines", "origin": "test-sg-sagada", "departure": "14:30", "date": RET_DATE.isoformat()},
        "days": authored_days(DAYS),
    }


def guide() -> dict:
    """A small made-up guide in the curated file's authoring form: one bus each way, one row per day."""
    return {
        "title": "Test Sagada trip (made up)",
        "lodging": {"spot": "test-sg-lodge"},
        "getting_there": {"title": "Getting there (made up)", "buses": [
            {"trip": {"operator": "test-sagada-lines", "origin": "test-sg-cubao", "departure": "22:30", "date": "2026-11-25"}, "booked": True},
        ]},
        "getting_home": {"title": "Going home (made up)", "buses": [
            {"trip": {"operator": "test-sagada-lines", "origin": "test-sg-sagada", "departure": "14:30", "date": "2026-11-28"}, "booked": True},
        ]},
        "days": [
            {"day": 1, "title": "Day 1 (made up)", "rows": [
                {"key": "d1-01", "time": "22:30", "plan": "Bus departs", "place": {"terminal": "test-sg-cubao"}, "bus": "outbound"},
            ]},
            {"day": 2, "title": "Day 2 (made up)", "pick": {"key": "brunch", "title": "Brunch (made up)", "options": [
                {"id": "A", "label": "Info cafe (made up)", "leave": "11:30", "place": {"spot": "test-sg-info"}},
                {"id": "B", "label": "Lodge cafe (made up)", "leave": "11:30", "place": {"spot": "test-sg-lodge"}},
            ]}, "rows": [
                {"key": "d2-01", "time": "10:35", "plan": "Register", "place": {"spot": "test-sg-info"}},
                {"key": "d2-02", "time": "11:10", "plan": "Drop the bags", "place": {"spot": "test-sg-lodge"}},
            ]},
            {"day": 3, "title": "Day 3 (made up)", "rows": [
                {"key": "d3-01", "time": "14:30", "plan": "Bus home", "place": {"terminal": "test-sg-sagada"}, "bus": "return"},
            ]},
        ],
        "budget": {"rows": [{"key": "bus", "item": "Bus (made up)", "estimate": "₱2,464", "category": "transport"}]},
        "todo": [{"key": "todo-01", "text": "Jacket (made up)", "done": False}],
        "sources": [],
    }


def write_file(folder: Path, slug: str = "test-sagada-2026-11-25", g: dict | None = None, core: dict | None = None) -> Path:
    path = folder / f"{slug}.json"
    raw = {"_readme": "made up for tests only", "share_slug": slug, **(core or entry()), "guide": g or guide()}
    path.write_text(json.dumps(raw), encoding="utf-8")
    return path


def insert_curated(dsn, slug: str = "test-sagada-2026-11-25", g: dict | None = None) -> str:
    """The made-up Sagada core plus its guide, saved as a curated row directly (no validation), so API and edit tests
    can read it whatever the loader says. Returns the share slug."""
    import load_itinerary
    from psycopg.types.json import Jsonb

    core = plan(dsn)
    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            resolved, problems = load_itinerary.resolve_guide(cur, g or guide())
            assert problems == [], problems
            cur.execute(
                """insert into itineraries (share_slug, trip_date, return_date, party, vibe, plan, model)
                   values (%s, %s, %s, %s, %s, %s, 'curated')""",
                (slug, OUT_DATE, RET_DATE, Jsonb([{"type": "adult"}, {"type": "adult"}]), "Chill and treks (made up)",
                 Jsonb({**core, "guide": resolved})),
            )
    return slug
