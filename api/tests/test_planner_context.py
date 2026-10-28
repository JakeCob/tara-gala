"""TG-20: planner context built only from DB rows (planner_context.py). Fixture data is made up for tests only."""

import logging

import psycopg
import pytest
from psycopg.rows import dict_row

from planner_data import D, RD, SPOTS, LAST_MILE, TRIPS, load_planner_data

SRC = "https://example.test/schedule"


def get(row, key):
    return row[key] if isinstance(row, dict) else getattr(row, key)


def ids(rows, key):
    return {str(get(r, key)) for r in rows}


def context(dsn, d=D, rd=RD):
    from app.planner_context import load_context

    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        return load_context(conn, d, rd)


def test_context_has_only_trips_running_on_the_dates(dsn, tmp_path):
    data = load_planner_data(dsn, tmp_path)
    ctx = context(dsn)
    # inactive, expired, weekend-only (D is a Friday) and no-travel-time trips are left out
    assert ids(ctx.outbound, "trip_id") == {data.trips["out_day"], data.trips["out_night"]}
    # the weekdays-only return doesn't run on RD (a Sunday)
    assert ids(ctx.returns, "trip_id") == {data.trips["ret"]}
    assert ctx.empty_reason is None


def test_context_outbound_rows_carry_arrival(dsn, tmp_path):
    data = load_planner_data(dsn, tmp_path)
    by_id = {str(get(r, "trip_id")): r for r in context(dsn).outbound}
    night = by_id[data.trips["out_night"]]
    assert (get(night, "arrives"), get(night, "arrives_day_offset")) == ("04:00", 1)
    day = by_id[data.trips["out_day"]]
    assert (get(day, "arrives"), get(day, "arrives_day_offset")) == ("13:00", 0)


def test_context_spots_and_legs_are_baguio_only(dsn, tmp_path):
    data = load_planner_data(dsn, tmp_path)
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute("insert into spots (slug, name, city) values ('elsewhere-spot', 'Elsewhere (made up)', 'La Trinidad')")
        conn.execute("update last_mile_routes set city = 'La Trinidad' where id = %s", [data.legs["test-lodge>test-park"]])
    ctx = context(dsn)
    assert ids(ctx.spots, "spot_id") == set(data.spots.values())
    assert ids(ctx.legs, "last_mile_route_id") == set(data.legs.values()) - {data.legs["test-lodge>test-park"]}


def test_context_leg_rows_use_slugs(dsn, tmp_path):
    load_planner_data(dsn, tmp_path)
    pairs = {(get(r, "from"), get(r, "to")) for r in context(dsn).legs}
    assert ("vl-baguio", "test-park") in pairs
    assert ("test-park", "test-market") in pairs


@pytest.mark.parametrize("trips, spots, last_mile, reason", [
    ("", "", "", "no outbound buses with a travel time on file"),
    (f"genesis,gen-cubao,gen-baguio,,regular_aircon,650,,2x2,yes,08:00,daily,,,{SRC},2026-10-24,\n", "", "",
     "no outbound buses with a travel time on file"),
    (TRIPS.split("\n")[0] + "\n", SPOTS, LAST_MILE, "no return buses"),
    (TRIPS, "", "", "no spots"),
    (TRIPS, SPOTS, "", "no last-mile legs"),
], ids=["nothing", "outbound without travel time", "no return", "no spots", "no legs"])
def test_context_empty_reason(dsn, tmp_path, trips, spots, last_mile, reason):
    load_planner_data(dsn, tmp_path, trips=trips, spots=spots, last_mile=last_mile)
    assert context(dsn).empty_reason == reason


def test_context_is_capped_with_a_warning(dsn, tmp_path, caplog):
    many_trips = "".join(
        f"victory-liner,vl-cubao,vl-baguio,,regular_aircon,700,360,2x2,yes,{i // 3:02d}:{(i % 3) * 20:02d},daily,,,{SRC},2026-10-24,\n"
        for i in range(62)  # 62, not 61: i=30 is 10:00, which load_planner_data marks inactive
    )
    many_trips += TRIPS.split("\n")[6] + "\n"  # one return bus
    many_spots = "".join(f"cap-spot-{i},Cap Spot {i} (made up),other,,,made up,,\n" for i in range(81))
    load_planner_data(dsn, tmp_path, trips=many_trips, spots=many_spots, last_mile="")
    with psycopg.connect(dsn, autocommit=True) as conn:
        # 401 made-up legs from the terminal to the spots
        conn.execute(
            """
            insert into last_mile_routes (from_terminal_id, to_spot_id, mode, minutes)
            select (select id from terminals where slug = 'vl-baguio'), s.id, 'walk', g
            from spots s cross join generate_series(1, 5) g
            order by s.slug, g limit 401
            """
        )
    with caplog.at_level(logging.WARNING):
        ctx = context(dsn)
    assert len(ctx.outbound) == 60
    assert len(ctx.spots) == 80
    assert len(ctx.legs) == 400
    truncated = [r.getMessage() for r in caplog.records if "planner context truncated" in r.getMessage()]
    assert any("cap=60" in m for m in truncated)
    assert any("cap=80" in m for m in truncated)
    assert any("cap=400" in m for m in truncated)
