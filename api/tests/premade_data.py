"""Shared fixture rows for the TG-24 tests. Everything here is made up for tests only:
not real schedules, spots, legs or itineraries. Not a test module (no test_ prefix)."""

import copy
import json
from datetime import date
from pathlib import Path

import psycopg

import load_data
from conftest import write_csvs

SRC = "https://example.test/schedule"
THU, FRI, SAT, SUN = date(2026, 11, 5), date(2026, 11, 6), date(2026, 11, 7), date(2026, 11, 8)

# operator,origin,destination,via,class,fare_php,travel_minutes,seat_layout,has_restroom,departure_time,days,valid_from,valid_to,source_url,verified_on,notes
TRIPS = (
    f"victory-liner,vl-cubao,vl-baguio,,regular_aircon,700,360,2x2,yes,07:00,daily,,,{SRC},2026-10-24,made up for tests only\n"
    f"victory-liner,vl-cubao,vl-baguio,,regular_aircon,700,360,2x2,yes,22:00,daily,,,{SRC},2026-10-24,made up for tests only\n"
    f"victory-liner,vl-pasay,vl-baguio,,regular_aircon,700,360,2x2,yes,07:00,daily,,,{SRC},2026-10-24,made up for tests only\n"
    f"genesis,gen-pasay,gen-baguio,,premiere,900,300,2x1,yes,09:00,weekends,,,{SRC},2026-10-24,made up for tests only\n"
    # separate route so travel_minutes stays null (the CSV loader keeps travel_minutes per route)
    f"victory-liner,vl-cubao,vl-baguio,,deluxe,800,,2x2,yes,09:00,daily,,,{SRC},2026-10-24,made up for tests only\n"
    f"victory-liner,vl-baguio,vl-cubao,,regular_aircon,700,360,2x2,yes,21:00,daily,,,{SRC},2026-10-24,made up for tests only\n"
)

# slug,name,category,lat,lng,description,visit_minutes,entrance_fee_php
SPOTS = (
    "test-park,Test Park (made up),park,,,made up for tests only,60,\n"
    "test-market,Test Market (made up),market,,,made up for tests only,45,\n"
    "test-cafe,Test Cafe (made up),cafe,,,made up for tests only,30,\n"
    "test-lodge,Test Lodge (made up),other,,,made up for tests only (lodging stand-in),,\n"
)

# from_terminal,from_spot,to_terminal,to_spot,mode,signboard,boarding_point,alighting_point,fare_min_php,fare_max_php,minutes,verified_on,notes
LAST_MILE = (
    "vl-baguio,,,test-market,walk,,,,,,10,2026-10-24,made up for tests only\n"
    ",test-market,,test-park,jeep,Test Signboard (made up),,,13,13,15,2026-10-24,made up for tests only\n"
    ",test-park,,test-lodge,taxi,,,,100,150,20,2026-10-24,made up for tests only\n"
    ",test-lodge,,test-cafe,taxi,,,,100,150,15,2026-10-24,made up for tests only\n"
    ",test-cafe,,test-lodge,taxi,,,,100,150,15,2026-10-24,made up for tests only\n"
    ",test-lodge,,test-park,taxi,,,,100,150,20,2026-10-24,made up for tests only\n"
)

# The valid baseline P0 (test plan): out 07:00 Fri (arrives 13:00 at vl-baguio), back 21:00 Sun.
# (day, [(spot, arrive, leave, (leg from, leg to, mode))])
P0_DAYS = [
    (1, [
        ("test-market", "13:30", "14:30", ("vl-baguio", "test-market", "walk")),
        ("test-park", "15:00", "16:30", ("test-market", "test-park", "jeep")),
        ("test-lodge", "17:00", "18:00", ("test-park", "test-lodge", "taxi")),
    ]),
    (2, [
        ("test-cafe", "10:30", "13:00", ("test-lodge", "test-cafe", "taxi")),
        ("test-lodge", "13:30", "14:00", ("test-cafe", "test-lodge", "taxi")),
    ]),
    (3, [
        ("test-park", "10:00", "12:00", ("test-lodge", "test-park", "taxi")),
    ]),
]

# Overnight variant: out 22:00 Thu, arrives 04:00 Fri, so day 1 is Fri and days 2 and 3 match P0.
NIGHT_DAYS = [
    (1, [
        ("test-market", "05:00", "06:00", ("vl-baguio", "test-market", "walk")),
        ("test-park", "07:00", "09:00", ("test-market", "test-park", "jeep")),
        ("test-lodge", "10:00", "20:00", ("test-park", "test-lodge", "taxi")),
    ]),
    *P0_DAYS[1:],
]


def build_plan(outbound, out_date, ret, ret_date, days, spots, legs) -> dict:
    """The CLAUDE.md planner output shape, from ids looked up by slug and natural key."""
    return {
        "outbound": {"trip_id": str(outbound), "date": out_date.isoformat()},
        "return": {"trip_id": str(ret), "date": ret_date.isoformat()},
        "days": [
            {"day": n, "stops": [
                {"spot_id": str(spots[s]), "arrive": a, "leave": lv, "leg": {"last_mile_route_id": str(legs[leg])}}
                for s, a, lv, leg in stops
            ]}
            for n, stops in days
        ],
    }


def load_rows(dsn, folder: Path, trips: str = TRIPS, spots: str = SPOTS, last_mile: str = LAST_MILE) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    write_csvs(folder, trips=trips, spots=spots, last_mile=last_mile)
    assert load_data.run(dsn, folder, dry_run=False) == 0


def db_ids(dsn) -> tuple[dict, dict, dict]:
    """(trips by (origin slug, "HH:MM", class), spots by slug, legs by (from slug, to slug, mode))."""
    with psycopg.connect(dsn) as conn:
        trips = {
            (o, dep, cls): tid for tid, o, dep, cls in conn.execute(
                """select t.id, o.slug, to_char(t.departure_time, 'HH24:MI'), r.class::text
                   from trips t join routes r on r.id = t.route_id join terminals o on o.id = r.origin_terminal_id"""
            )
        }
        spots = dict(conn.execute("select slug, id from spots").fetchall())
        legs = {
            (f, t, m): lid for lid, f, t, m in conn.execute(
                """select l.id, coalesce(ft.slug, fs.slug), coalesce(tt.slug, ts.slug), l.mode::text
                   from last_mile_routes l
                   left join terminals ft on ft.id = l.from_terminal_id left join spots fs on fs.id = l.from_spot_id
                   left join terminals tt on tt.id = l.to_terminal_id left join spots ts on ts.id = l.to_spot_id"""
            )
        }
    return trips, spots, legs


def db_p0(dsn, days=P0_DAYS) -> dict:
    trips, spots, legs = db_ids(dsn)
    return build_plan(
        trips[("vl-cubao", "07:00", "regular_aircon")], FRI,
        trips[("vl-baguio", "21:00", "regular_aircon")], SUN,
        days, spots, legs,
    )


# --- authoring format (data/premade_itineraries.json) ------------------------------------------

def authored_days(days) -> list[dict]:
    return [
        {"day": n, "stops": [
            {"spot": s, "arrive": a, "leave": lv, "leg": {"from": f, "to": t, "mode": m}}
            for s, a, lv, (f, t, m) in stops
        ]}
        for n, stops in days
    ]


def chill_entry() -> dict:
    return {
        "key": "test-chill",
        "vibe": "Chill (made up)",
        "budget_php": 5000,
        "party": [{"type": "adult"}, {"type": "student"}],
        "outbound": {"operator": "victory-liner", "origin": "vl-cubao", "departure": "07:00", "date": "2026-11-06"},
        "return": {"operator": "victory-liner", "origin": "vl-baguio", "departure": "21:00", "date": "2026-11-08"},
        "days": authored_days(P0_DAYS),
    }


def night_entry() -> dict:
    return {
        "key": "test-night",
        "vibe": "Night bus (made up)",
        "party": [{"type": "senior"}],
        "outbound": {"operator": "victory-liner", "origin": "vl-cubao", "departure": "22:00", "date": "2026-11-05"},
        "return": {"operator": "victory-liner", "origin": "vl-baguio", "departure": "21:00", "date": "2026-11-08"},
        "days": authored_days(NIGHT_DAYS),
    }


def write_premade(folder: Path, entries, name: str = "premade.json") -> Path:
    path = folder / name
    path.write_text(json.dumps({"_readme": "made up for tests only", "itineraries": copy.deepcopy(entries)}), encoding="utf-8")
    return path
