"""TG-61 PR 1: the two new tables and the guide's new fields (a row's leg, a trip's own place). The ids (G1 and so on)
are plan.md §5's.
"""

import copy
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg.rows import dict_row

from app import guide as guides
from conftest import ROOT, build_schema
from test_guide import guide_dict
from test_trip_people import schema_shape

MIGRATION = ROOT / "supabase" / "migrations" / "2026-11-09_tg61_plan_edits.sql"
TABLES = ("itinerary_versions", "trip_places")


def test_migration_over_mains_schema_matches_schema_sql(dsn):  # G1
    # main's schema.sql from before TG-61 (290c54b), byte for byte
    build_schema((Path(__file__).parent / "fixtures" / "schema_290c54b.sql").read_text(encoding="utf-8"))
    sql = MIGRATION.read_text(encoding="utf-8")
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(sql)
        conn.execute(sql)
    upgraded = schema_shape(dsn)
    build_schema((ROOT / "supabase" / "schema.sql").read_text(encoding="utf-8"))
    assert upgraded == schema_shape(dsn)


def test_migration_is_a_no_op_on_schema_sql(dsn):
    before = schema_shape(dsn)
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(MIGRATION.read_text(encoding="utf-8"))
    assert schema_shape(dsn) == before


def test_tables_are_api_only(dsn):
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        rls = conn.execute(
            "select c.relname, c.relrowsecurity, count(p.policyname) as policies from pg_class c"
            " left join pg_policies p on p.tablename = c.relname where c.relname = any(%s) group by 1, 2 order by 1", (list(TABLES),),
        ).fetchall()
    assert rls == [{"relname": t, "relrowsecurity": True, "policies": 0} for t in TABLES]


def test_constraints_refuse_bad_rows(dsn):
    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        sid = conn.execute("insert into trip_sessions (name, start_date, return_date) values ('T', '2026-11-06', '2026-11-08') returning id").fetchone()["id"]
        iid = conn.execute("insert into itineraries (trip_date, party, plan, model) values ('2026-11-06', '[]', '{}', 'trip-edit') returning id").fetchone()["id"]
        version = "insert into itinerary_versions (itinerary_id, session_id, based_on, seq, source, plan, changes) values (%s, %s, %s, %s, %s, '{}', %s)"
        line = '[{"word": "Copied", "day": null, "text": "the plan"}]'
        conn.execute(version, (iid, sid, iid, 0, "copy", line))
        place = "insert into trip_places (session_id, name, lat, lng, maps_url) values (%s, %s, %s, %s, %s)"
        bad = [
            (psycopg.errors.UniqueViolation, version, (iid, sid, None, 0, "hand", line)),
            (psycopg.errors.CheckViolation, version, (iid, sid, None, 1, "auto", line)),
            (psycopg.errors.CheckViolation, version, (iid, sid, iid, 1, "hand", line)),  # based_on only on version 0
            (psycopg.errors.CheckViolation, version, (iid, sid, None, 1, "hand", "[]")),
            (psycopg.errors.CheckViolation, version, (iid, sid, None, 10000, "hand", line)),
            (psycopg.errors.CheckViolation, place, (sid, "", 16.4, 120.6, "https://maps.app.goo.gl/x")),
            (psycopg.errors.CheckViolation, place, (sid, "x" * 81, 16.4, 120.6, "https://maps.app.goo.gl/x")),
            (psycopg.errors.CheckViolation, place, (sid, "Cafe", 91, 120.6, "https://maps.app.goo.gl/x")),
            (psycopg.errors.CheckViolation, place, (sid, "Cafe", 16.4, 181, "https://maps.app.goo.gl/x")),
            (psycopg.errors.CheckViolation, place, (sid, "Cafe", 16.4, 120.6, "http://maps.app.goo.gl/x")),
            (psycopg.errors.CheckViolation, place, (sid, "Cafe", 16.4, 120.6, "https://" + "x" * 493)),
        ]
        for error, sql, args in bad:
            with pytest.raises(error):
                conn.execute(sql, args)
        conn.execute(place, (sid, "Cafe", 16.4, 120.6, "https://" + "x" * 492))
        conn.execute("delete from trip_sessions where id = %s", (sid,))
        assert conn.execute("select (select count(*) from itinerary_versions) + (select count(*) from trip_places) as n").fetchone()["n"] == 0


# ---------------------------------------------------------------- the guide's new fields

def with_row(**extra) -> dict:
    g = guide_dict()
    g["days"][0]["rows"][0] |= extra
    return g


def test_a_row_may_carry_a_leg_and_a_place_may_be_the_trips_own():
    route, place = uuid4(), uuid4()
    g, problems = guides.parse_guide(with_row(leg={"last_mile_route_id": str(route)}, place={"trip_place_id": str(place)}))
    assert problems == []
    assert guides.leg_ids(g) == {route} and guides.trip_place_ids(g) == {place}
    g, problems = guides.parse_guide(with_row(leg={"estimate": {"mode": "walk", "minutes": 10, "km": 0.6}}))
    assert problems == [] and g.days[0].rows[0].leg.estimate.mode == "walk"
    assert guides.leg_ids(g) == set()


@pytest.mark.parametrize("extra", [
    {"leg": {}},
    {"leg": {"last_mile_route_id": str(uuid4()), "estimate": {"mode": "walk", "minutes": 10, "km": 0.6}}},
    {"leg": {"estimate": {"mode": "jeep", "minutes": 10, "km": 0.6}}},  # D1: walk or taxi only
    {"leg": {"estimate": {"mode": "taxi", "minutes": 0, "km": 3}}},
    {"leg": {"estimate": {"mode": "taxi", "minutes": 601, "km": 3}}},
    {"leg": {"estimate": {"mode": "taxi", "minutes": 20, "km": 1001}}},
    {"leg": {"estimate": {"mode": "taxi", "minutes": 20, "km": float("nan")}}},
    {"leg": {"estimate": {"mode": "taxi", "minutes": 20, "km": 3, "fare_php": 200}}},  # never a fare
    {"place": {"spot_id": str(uuid4()), "trip_place_id": str(uuid4())}},
    {"place": {"trip_place_id": str(uuid4()), "lat": 16.4, "lng": 120.6}},  # a pin is the place's, never the row's
])
def test_bad_legs_and_places_are_refused(extra):
    g, problems = guides.parse_guide(with_row(**copy.deepcopy(extra)))
    assert g is None and problems
