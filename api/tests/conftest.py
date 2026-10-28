"""Tests run against a throwaway Postgres given by TEST_DATABASE_URL.

Each test gets a fresh `public` schema built from supabase/schema.sql.
Never point TEST_DATABASE_URL at Supabase: the fixture drops the schema.
"""

import os
import sys
from datetime import datetime
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
    """Block real network requests to non-local hosts (TG-20): httpx2 (Anthropic SDK) and httpx (OpenRouter).

    Patches the network transports, not client construction or Client.send, so adapter tests can
    point a real client at a 127.0.0.1 stub, and MockTransport and Starlette's TestClient are untouched.
    A blocked request raises the library's ConnectError, as a real network failure would. Blocked hosts
    are recorded, and the test fails at teardown even if the code under test swallowed the error.
    """
    import httpx
    import httpx2

    blocked: list[str] = []

    def guard(module, original):
        def handle_request(self, request):
            if request.url.host not in LOCAL_HOSTS:
                blocked.append(request.url.host)
                raise module.ConnectError(f"tests must not call the network: {request.url.host}", request=request)
            return original(self, request)
        return handle_request

    def aguard(module, original):
        async def handle_async_request(self, request):
            if request.url.host not in LOCAL_HOSTS:
                blocked.append(request.url.host)
                raise module.ConnectError(f"tests must not call the network: {request.url.host}", request=request)
            return await original(self, request)
        return handle_async_request

    for module in (httpx, httpx2):
        monkeypatch.setattr(module.HTTPTransport, "handle_request",
                            guard(module, module.HTTPTransport.handle_request))
        monkeypatch.setattr(module.AsyncHTTPTransport, "handle_async_request",
                            aguard(module, module.AsyncHTTPTransport.handle_async_request))
    yield blocked
    assert not blocked, f"a test tried to reach {blocked}"


@pytest.fixture(autouse=True)
def _frozen_scraper_clock(monkeypatch):
    """victory_liner.main() reads the time only through manila_now(); freeze it so the suite never depends on the
    real date (TG-9). Tests that need another 'now' monkeypatch it again."""
    import victory_liner as vl  # scraper/ is on sys.path above
    from load_data import MANILA

    monkeypatch.setattr(vl, "manila_now", lambda: datetime(2026, 11, 1, 4, 0, tzinfo=MANILA))


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
