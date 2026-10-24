"""Loader + /trips tests. Fixture data below is made up for tests only, not real schedules."""

import psycopg

import load_data
from conftest import write_csvs

SRC = "https://example.test/schedule"

TRIPS = (
    f"victory-liner,vl-cubao,vl-baguio,Luisita,regular_aircon,700,360,2x2,yes,9:30 AM,daily,,,{SRC},2026-10-24,\n"
    f"victory-liner,vl-cubao,vl-baguio,Luisita,regular_aircon,700,360,2x2,yes,07:00,daily,,,{SRC},2026-10-24,\n"
    f"genesis,gen-pasay,gen-baguio,,premiere,900,300,2x1,yes,1:00 AM,weekends,,,{SRC},2026-10-24,\n"
    f"solid-north,pitx,sn-baguio,TPLEX,luxury,1000,300,,,3:00 PM,daily,2026-11-01,2026-11-30,{SRC},2026-10-24,holiday run\n"
)
SPOTS = "burnham-park,Burnham Park,park,16.41,120.59,,90,\n"
LAST_MILE = "vl-baguio,,,burnham-park,walk,,,,,,15,2026-10-24,\n"


def count(dsn, table):
    with psycopg.connect(dsn) as conn:
        return conn.execute(f"select count(*) from {table}").fetchone()[0]


def test_dry_run_saves_nothing(dsn, tmp_path):
    write_csvs(tmp_path, TRIPS, SPOTS, LAST_MILE)
    assert load_data.run(dsn, tmp_path, dry_run=True) == 0
    assert count(dsn, "trips") == 0
    assert count(dsn, "spots") == 0


def test_load_is_idempotent(dsn, tmp_path):
    write_csvs(tmp_path, TRIPS, SPOTS, LAST_MILE)
    assert load_data.run(dsn, tmp_path, dry_run=False) == 0
    assert load_data.run(dsn, tmp_path, dry_run=False) == 0
    assert count(dsn, "routes") == 3
    assert count(dsn, "trips") == 4
    assert count(dsn, "spots") == 1
    assert count(dsn, "last_mile_routes") == 1


def test_bad_rows_abort_whole_load(dsn, tmp_path):
    bad = (
        f"victory-liner,vl-nowhere,vl-baguio,,regular_aircon,,,,,09:00,daily,,,{SRC},2026-10-24,\n"
        f"victory-liner,vl-cubao,vl-baguio,,regular_aircon,,,,,10:00,daily,,,{SRC},,\n"
    )
    write_csvs(tmp_path, TRIPS + bad)
    assert load_data.run(dsn, tmp_path, dry_run=False) == 1
    assert count(dsn, "trips") == 0


def test_last_mile_needs_exactly_one_origin(dsn, tmp_path):
    write_csvs(tmp_path, spots=SPOTS, last_mile="vl-baguio,burnham-park,,burnham-park,walk,,,,,,5,2026-10-24,\n")
    assert load_data.run(dsn, tmp_path, dry_run=False) == 1


def test_trips_metro_manila_to_baguio_on_a_friday(dsn, client, tmp_path):
    write_csvs(tmp_path, TRIPS, SPOTS, LAST_MILE)
    load_data.run(dsn, tmp_path, dry_run=False)

    # 2026-11-06 is a Friday: weekend-only Genesis trip excluded, Solid North holiday run included
    r = client.get("/trips", params={"origin_city": "Metro Manila", "destination_city": "Baguio", "date": "2026-11-06"})
    assert r.status_code == 200
    trips = r.json()
    assert [t["departure_time"] for t in trips] == ["07:00", "09:30", "15:00"]
    first = trips[0]
    assert first["operator_name"] == "Victory Liner"
    assert first["arrives_around"] == "13:00"
    assert first["last_verified_at"] is not None
    assert "Confirm with the operator" in first["confirm_note"]


def test_trips_respects_weekend_days_and_valid_range(dsn, client, tmp_path):
    write_csvs(tmp_path, TRIPS)
    load_data.run(dsn, tmp_path, dry_run=False)

    # Saturday in October: Genesis weekend trip runs, Solid North (from Nov 1) does not
    r = client.get("/trips", params={"origin_city": "Metro Manila", "destination_city": "Baguio", "date": "2026-10-31"})
    ops = {t["operator_slug"] for t in r.json()}
    assert ops == {"victory-liner", "genesis"}


def test_terminals_and_health(client):
    assert client.get("/health").json() == {"status": "ok"}
    baguio = client.get("/terminals", params={"city": "Baguio"}).json()
    assert {t["slug"] for t in baguio} == {"vl-baguio", "gen-baguio", "sn-baguio"}
