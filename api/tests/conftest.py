"""Tests run against a throwaway Postgres given by TEST_DATABASE_URL.

Each test gets a fresh `public` schema built from supabase/schema.sql.
Never point TEST_DATABASE_URL at Supabase: the fixture drops the schema.
"""

import os
import sys
from pathlib import Path

import psycopg
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "data"))  # for load_data
sys.path.insert(0, str(ROOT / "scraper"))  # for victory_liner

TEST_DSN = os.environ.get("TEST_DATABASE_URL")

if not TEST_DSN:
    pytest.skip("TEST_DATABASE_URL not set; skipping database tests", allow_module_level=True)


LOCAL_HOSTS = {"127.0.0.1", "localhost"}


@pytest.fixture(autouse=True)
def no_real_llm_calls(monkeypatch):
    """Block any request the Anthropic SDK sends to a non-local host (TG-20).

    Guards the send, not client construction, so adapter tests can still point a real
    client at a 127.0.0.1 stub. Blocked hosts are recorded, and the test fails at teardown
    even if the SDK turned the error into something the code under test swallowed.
    """
    import httpx2

    blocked: list[str] = []

    def guard(original):
        def send(self, request, *args, **kwargs):
            if request.url.host not in LOCAL_HOSTS:
                blocked.append(request.url.host)
                raise RuntimeError(f"tests must not call the network: {request.url.host}")
            return original(self, request, *args, **kwargs)
        return send

    def aguard(original):
        async def send(self, request, *args, **kwargs):
            if request.url.host not in LOCAL_HOSTS:
                blocked.append(request.url.host)
                raise RuntimeError(f"tests must not call the network: {request.url.host}")
            return await original(self, request, *args, **kwargs)
        return send

    monkeypatch.setattr(httpx2.Client, "send", guard(httpx2.Client.send))
    monkeypatch.setattr(httpx2.AsyncClient, "send", aguard(httpx2.AsyncClient.send))
    yield blocked
    assert not blocked, f"a test tried to reach {blocked}"


@pytest.fixture()
def dsn():
    schema = (ROOT / "supabase" / "schema.sql").read_text(encoding="utf-8")
    with psycopg.connect(TEST_DSN, autocommit=True) as conn:
        conn.execute("drop schema if exists public cascade")
        conn.execute("create schema public")
        for t in ("service_class", "data_source", "trip_report_status", "last_mile_mode", "spot_category", "passenger_type"):
            conn.execute(f"drop type if exists {t} cascade")
        conn.execute(schema)
    return TEST_DSN


@pytest.fixture()
def client(dsn, monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setenv("DATABASE_URL", dsn)
    from app.main import app

    with TestClient(app) as c:
        yield c


def write_csvs(folder: Path, trips: str = "", spots: str = "", last_mile: str = "") -> Path:
    headers = {
        "routes_trips.csv": "operator,origin,destination,via,class,fare_php,travel_minutes,seat_layout,has_restroom,departure_time,days,valid_from,valid_to,source_url,verified_on,notes\n",
        "spots.csv": "slug,name,category,lat,lng,description,visit_minutes,entrance_fee_php\n",
        "last_mile_routes.csv": "from_terminal,from_spot,to_terminal,to_spot,mode,signboard,boarding_point,alighting_point,fare_min_php,fare_max_php,minutes,verified_on,notes\n",
    }
    bodies = {"routes_trips.csv": trips, "spots.csv": spots, "last_mile_routes.csv": last_mile}
    for name, header in headers.items():
        (folder / name).write_text(header + bodies[name], encoding="utf-8")
    return folder
