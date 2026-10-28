"""TG-24: GET /premade-itineraries (plan.md 2.4 and 2.5, B25 to B29).

Fixture data and itineraries below are made up for tests only, not real trips, spots or plans.
"""

import json
import logging
from pathlib import Path

import psycopg
import pytest

import load_premade
from app.flags import Flags, get_flags
from conftest import ROOT
from premade_data import chill_entry, db_p0, load_rows, night_entry, write_premade

APP = Path(__file__).resolve().parents[1] / "app"
SUMMARY_FIELDS = {"share_slug", "vibe", "trip_date", "return_date", "budget_php", "day_count", "stop_count", "spot_names"}
USER_NAME = "Secret Person (made up)"


@pytest.fixture(autouse=True)
def fresh_flags(monkeypatch):
    """Every test starts and ends with an uncached get_flags() and no flag env vars set."""
    for name in ("PREMADE_ITINERARIES", "PLANNER_LIVE", "REAL_MAP"):
        monkeypatch.delenv(name, raising=False)
    get_flags.cache_clear()
    yield
    get_flags.cache_clear()


@pytest.fixture()
def loaded(dsn, tmp_path):
    load_rows(dsn, tmp_path / "csv")
    path = write_premade(tmp_path, [chill_entry(), night_entry()])
    assert load_premade.run(dsn, path, dry_run=False, prune=False) == 0
    with psycopg.connect(dsn, autocommit=True) as conn:  # a user plan (TG-20 style), never listed
        conn.execute(
            """insert into itineraries (trip_date, return_date, party, vibe, plan, model)
               values ('2026-11-06', '2026-11-08', %s::jsonb, 'user plan (made up)', %s::jsonb, 'claude-haiku-5-5')""",
            [json.dumps([{"type": "adult", "name": USER_NAME}]), json.dumps(db_p0(dsn))],
        )
    return dsn


@pytest.fixture()
def make_client(dsn, monkeypatch):
    """For tests that set env before the lifespan runs (conftest's client can't take env)."""
    from fastapi.testclient import TestClient

    monkeypatch.setenv("DATABASE_URL", dsn)
    from app.main import app

    return lambda: TestClient(app)


def listing(client) -> list[dict]:
    r = client.get("/premade-itineraries")
    assert r.status_code == 200, r.text
    return r.json()


# --- B25 / B28 the list ----------------------------------------------------------------------------

def test_lists_premade_summaries(client, loaded):
    items = listing(client)
    # by trip_date, then share_slug: the night bus leaves Thu, the chill plan Fri
    assert [i["share_slug"] for i in items] == ["premade-test-night", "premade-test-chill"]
    for item in items:
        assert set(item) == SUMMARY_FIELDS
    night, chill = items
    assert chill == {
        "share_slug": "premade-test-chill",
        "vibe": "Chill (made up)",
        "trip_date": "2026-11-06",
        "return_date": "2026-11-08",
        "budget_php": 5000.0,
        "day_count": 3,
        "stop_count": 6,
        # visit order, each spot once
        "spot_names": ["Test Market (made up)", "Test Park (made up)", "Test Lodge (made up)", "Test Cafe (made up)"],
    }
    assert night["trip_date"] == "2026-11-05"
    assert night["budget_php"] is None
    assert (night["day_count"], night["stop_count"]) == (3, 6)


def test_never_lists_user_plans_or_party_data(client, loaded):
    r = client.get("/premade-itineraries")
    assert r.status_code == 200, r.text
    assert len(r.json()) == 2
    assert USER_NAME not in r.text
    assert "claude-haiku-5-5" not in r.text and "user plan" not in r.text
    for item in r.json():
        assert not {"party", "id", "plan", "model"} & set(item)


def test_empty_list(client):
    assert listing(client) == []


# --- B27 a stored plan that no longer validates ---------------------------------------------------

def test_plan_that_no_longer_validates_is_dropped_with_a_warning(client, loaded, caplog):
    caplog.set_level(logging.INFO, logger="tara_gala.api")
    with psycopg.connect(loaded, autocommit=True) as conn:
        conn.execute(
            """update trips set is_active = false
               where id = (select (plan -> 'outbound' ->> 'trip_id')::uuid from itineraries where share_slug = 'premade-test-chill')"""
        )
    assert [i["share_slug"] for i in listing(client)] == ["premade-test-night"]
    records = [r for r in caplog.records if r.name == "tara_gala.api"]
    warnings = [r.getMessage() for r in records if r.levelno == logging.WARNING and "premade itinerary dropped" in r.getMessage()]
    assert len(warnings) == 1
    assert warnings[0].startswith("premade itinerary dropped share_slug=premade-test-chill codes=")
    assert "trip_inactive" in warnings[0]
    infos = [r.getMessage() for r in records if r.levelno == logging.INFO and r.getMessage().startswith("premade list")]
    assert infos == ["premade list results=1 dropped=1"]


# --- logging ---------------------------------------------------------------------------------------

def test_logs_one_info_line_and_no_party_data(client, loaded, caplog):
    caplog.set_level(logging.DEBUG)
    listing(client)
    lines = [r.getMessage() for r in caplog.records if r.name == "tara_gala.api" and r.getMessage().startswith("premade list")]
    assert lines == ["premade list results=2 dropped=0"]
    assert not any(USER_NAME in r.getMessage() for r in caplog.records)


def test_premade_module_adds_no_logging_config():
    src = (APP / "premade.py").read_text(encoding="utf-8")
    for banned in ("basicConfig", "dictConfig", "addHandler"):
        assert banned not in src, banned


# --- B26 / B29 the flag ----------------------------------------------------------------------------

def test_flag_off_is_404_like_an_unknown_route(make_client, loaded, monkeypatch):
    monkeypatch.setenv("PREMADE_ITINERARIES", "false")
    with make_client() as c:
        r = c.get("/premade-itineraries")
        unknown = c.get("/no-such-route")
        assert r.status_code == 404
        assert r.json() == {"detail": "Not Found"} == unknown.json()
        assert c.get("/trips", params={"date": "2026-11-06"}).status_code == 200  # only this endpoint is gated


@pytest.mark.parametrize("value", ["true", "1", ""])
def test_flag_on_or_unset_lists(make_client, loaded, monkeypatch, value):
    monkeypatch.setenv("PREMADE_ITINERARIES", value)
    with make_client() as c:
        assert len(listing(c)) == 2


def test_flags_read_once_in_the_lifespan(make_client, caplog):
    caplog.set_level(logging.INFO, logger="tara_gala.flags")
    with make_client() as c:
        for _ in range(3):
            listing(c)
        assert c.app.state.flags == Flags()
    lines = [r.getMessage() for r in caplog.records if r.name == "tara_gala.flags" and r.getMessage().startswith("feature flags:")]
    assert len(lines) == 1
    # TG-20 reads app.state.flags too; there is exactly one get_flags() call in main.py
    assert (APP / "main.py").read_text(encoding="utf-8").count("get_flags()") == 1


# --- docs ------------------------------------------------------------------------------------------

def test_openapi_documents_the_endpoint(client):
    spec = client.get("/openapi.json").json()
    get = spec["paths"]["/premade-itineraries"]["get"]
    assert get["responses"]["200"]["content"]["application/json"]["schema"]["items"]["$ref"].endswith("/PremadeSummary")
    assert set(spec["components"]["schemas"]["PremadeSummary"]["properties"]) == SUMMARY_FIELDS


def test_readme_lists_the_endpoint_and_the_loader():
    text = (ROOT / "README.md").read_text(encoding="utf-8")
    section3 = text.split("## 3.", 1)[1].split("## 4.", 1)[0]
    section5 = text.split("## 5.", 1)[1].split("## 6.", 1)[0]
    assert "load_premade.py" in section3
    assert "/premade-itineraries" in section5
