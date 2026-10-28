"""TG-17: /spots and /last-mile. Fixture data below is made up for tests only, not real routes."""

import logging
from datetime import datetime, timezone
from pathlib import Path

import psycopg
import pytest

import load_data
from conftest import write_csvs

APP = Path(__file__).resolve().parents[1] / "app"
LAST_MILE_NOTE = "Fares and routes change. Confirm with the driver or a local before you ride."

SPOTS = (
    "test-park,Test Park (made up),park,16.41,120.59,made up for tests only,60,\n"
    "test-market,Test Market (made up),market,16.42,120.60,made up for tests only,45,20\n"
    "test-cafe,Test Cafe (made up),cafe,,,made up for tests only,30,\n"
)
# from_terminal,from_spot,to_terminal,to_spot,mode,signboard,boarding_point,alighting_point,fare_min,fare_max,minutes,verified_on,notes
LAST_MILE = (
    "vl-baguio,,,test-park,jeep,Test Signboard (made up),Gov Pack Rd stop (made up),Park gate (made up),13,15,15,2026-10-24,made up for tests only\n"
    "vl-baguio,,,test-market,walk,,,,,,,2026-10-24,\n"
    "gen-baguio,,,test-park,taxi,,,,150,200,10,2026-10-24,\n"
    ",test-park,,test-cafe,walk,,,,,,8,2026-10-24,\n"
    ",test-cafe,vl-baguio,,jeep,Test Terminal (made up),,,13,13,20,2026-10-20,\n"
)
OPENING_HOURS = {"mon": ["06:00", "18:00"]}

SPOT_FIELDS = {
    "spot_id", "slug", "name", "city", "category", "lat", "lng", "description",
    "visit_minutes", "opening_hours", "entrance_fee_php",
}
LEG_FIELDS = {
    "last_mile_route_id", "origin", "destination", "mode", "signboard", "boarding_point",
    "alighting_point", "fare_min_php", "fare_max_php", "minutes", "notes", "source",
    "last_verified_at", "confirm_note",
}
PLACE_FIELDS = {"kind", "id", "slug", "name", "lat", "lng"}


@pytest.fixture()
def data(dsn, tmp_path):
    write_csvs(tmp_path, spots=SPOTS, last_mile=LAST_MILE)
    assert load_data.run(dsn, tmp_path, dry_run=False) == 0
    # The CSV loader has no opening_hours column; set one directly so the passthrough is tested.
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute("update spots set opening_hours = %s::jsonb where slug = 'test-park'", ['{"mon": ["06:00", "18:00"]}'])
    return dsn


def last_mile(client, **params):
    r = client.get("/last-mile", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def pairs(legs):
    return [(leg["origin"]["slug"], leg["destination"]["slug"]) for leg in legs]


# --- /spots ------------------------------------------------------------------------------------

def test_spots_lists_all_spots_with_schema_fields(client, data):
    r = client.get("/spots")
    assert r.status_code == 200, r.text
    spots = r.json()
    assert [s["slug"] for s in spots] == ["test-cafe", "test-market", "test-park"]  # by name
    for s in spots:
        assert set(s) == SPOT_FIELDS
        assert s["city"] == "Baguio"
    by_slug = {s["slug"]: s for s in spots}
    assert by_slug["test-market"]["entrance_fee_php"] == 20.0
    assert by_slug["test-park"]["entrance_fee_php"] is None
    assert by_slug["test-cafe"]["lat"] is None and by_slug["test-cafe"]["lng"] is None
    assert by_slug["test-park"]["category"] == "park"
    assert by_slug["test-park"]["visit_minutes"] == 60
    assert by_slug["test-park"]["opening_hours"] == OPENING_HOURS  # passed through, not parsed
    assert by_slug["test-cafe"]["opening_hours"] is None


def test_spots_empty_when_no_data(client):
    r = client.get("/spots")
    assert r.status_code == 200, r.text
    assert r.json() == []


# --- /last-mile filters ------------------------------------------------------------------------

def test_last_mile_by_terminal(client, data):
    # Sorted by destination name: Test Market (made up) before Test Park (made up)
    assert pairs(last_mile(client, terminal="vl-baguio")) == [("vl-baguio", "test-market"), ("vl-baguio", "test-park")]
    assert pairs(last_mile(client, terminal="gen-baguio")) == [("gen-baguio", "test-park")]
    assert last_mile(client, terminal="sn-baguio") == []


def test_last_mile_by_spot(client, data):
    # Legs to or from the spot
    assert set(pairs(last_mile(client, spot="test-cafe"))) == {("test-park", "test-cafe"), ("test-cafe", "vl-baguio")}
    assert set(pairs(last_mile(client, spot="test-park"))) == {
        ("vl-baguio", "test-park"), ("gen-baguio", "test-park"), ("test-park", "test-cafe"),
    }


def test_last_mile_filters_combine(client, data):
    assert pairs(last_mile(client, terminal="vl-baguio", spot="test-park")) == [("vl-baguio", "test-park")]
    assert last_mile(client, terminal="gen-baguio", spot="test-cafe") == []


def test_last_mile_no_filter_returns_every_leg(client, data):
    assert len(last_mile(client)) == 5


def test_last_mile_empty_filter_value_means_no_filter(client, data):
    assert len(last_mile(client, terminal="")) == 5
    assert len(last_mile(client, spot="")) == 5
    assert set(pairs(last_mile(client, terminal="", spot="test-cafe"))) == {("test-park", "test-cafe"), ("test-cafe", "vl-baguio")}


def test_last_mile_unknown_slug_is_empty_not_404(client, data):
    assert last_mile(client, terminal="nope") == []
    assert last_mile(client, spot="nope") == []
    assert last_mile(client, terminal="vl-cubao") == []  # real terminal, but no legs in Baguio


def test_last_mile_slug_is_a_parameter_not_sql(client, data):
    assert last_mile(client, terminal="vl-baguio' or '1'='1") == []
    assert last_mile(client, spot="test-park' or '1'='1") == []
    assert last_mile(client, terminal="x" * 300) == []


# --- /last-mile shape --------------------------------------------------------------------------

def test_leg_shape(client, data):
    legs = last_mile(client)
    for leg in legs:
        assert set(leg) == LEG_FIELDS
        assert set(leg["origin"]) == PLACE_FIELDS
        assert set(leg["destination"]) == PLACE_FIELDS
        assert leg["source"] == "manual"
        assert leg["confirm_note"] == LAST_MILE_NOTE
        assert leg["last_verified_at"] is not None
    by_pair = {(leg["origin"]["slug"], leg["destination"]["slug"]): leg for leg in legs}

    jeep = by_pair[("vl-baguio", "test-park")]
    assert jeep["origin"]["kind"] == "terminal"
    assert jeep["origin"]["name"] == "Victory Liner Baguio"
    assert jeep["destination"]["kind"] == "spot"
    assert jeep["destination"]["name"] == "Test Park (made up)"
    assert (jeep["destination"]["lat"], jeep["destination"]["lng"]) == (16.41, 120.59)
    assert jeep["mode"] == "jeep"
    assert jeep["signboard"] == "Test Signboard (made up)"
    assert jeep["boarding_point"] == "Gov Pack Rd stop (made up)"
    assert jeep["alighting_point"] == "Park gate (made up)"
    assert (jeep["fare_min_php"], jeep["fare_max_php"], jeep["minutes"]) == (13.0, 15.0, 15)
    assert jeep["notes"] == "made up for tests only"
    assert datetime.fromisoformat(jeep["last_verified_at"]) == datetime(2026, 10, 24, 4, tzinfo=timezone.utc)  # noon Manila

    walk = by_pair[("vl-baguio", "test-market")]
    assert walk["mode"] == "walk"
    for key in ("signboard", "boarding_point", "alighting_point", "fare_min_php", "fare_max_php", "minutes", "notes"):
        assert walk[key] is None, key  # nulls stay null, never 0 or ""

    back = by_pair[("test-cafe", "vl-baguio")]
    assert back["origin"]["kind"] == "spot"
    assert back["origin"]["lat"] is None  # test-cafe has no coordinates
    assert back["destination"]["kind"] == "terminal"
    assert datetime.fromisoformat(back["last_verified_at"]) == datetime(2026, 10, 20, 4, tzinfo=timezone.utc)


# --- logging and OpenAPI -----------------------------------------------------------------------

def test_last_mile_and_spots_log_one_line(client, data, caplog):
    caplog.set_level(logging.INFO, logger="tara_gala.api")
    last_mile(client, terminal="vl-baguio")
    client.get("/spots")
    lines = [r.getMessage() for r in caplog.records if r.name == "tara_gala.api"]
    searches = [m for m in lines if m.startswith("last-mile search")]
    assert searches == ["last-mile search terminal='vl-baguio' spot=None results=2"]
    assert [m for m in lines if m.startswith("spots list")] == ["spots list results=3"]


def test_last_mile_module_adds_no_logging_config():
    src = (APP / "last_mile.py").read_text(encoding="utf-8")
    for banned in ("basicConfig", "dictConfig", "addHandler"):
        assert banned not in src, banned


def test_openapi_documents_spots_and_last_mile(client):
    spec = client.get("/openapi.json").json()
    paths = spec["paths"]
    assert "/spots" in paths and "/last-mile" in paths

    def item_ref(path):
        schema = paths[path]["get"]["responses"]["200"]["content"]["application/json"]["schema"]
        return schema["items"]["$ref"]

    assert item_ref("/spots").endswith("/Spot")
    assert item_ref("/last-mile").endswith("/LastMileLeg")
    assert {p["name"] for p in paths["/last-mile"]["get"]["parameters"]} == {"terminal", "spot"}
    assert {"Spot", "LastMileLeg", "Place"} <= set(spec["components"]["schemas"])
