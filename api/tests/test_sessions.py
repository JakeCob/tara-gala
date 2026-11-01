"""TG-52 trip sessions: one secret link holding the itinerary, the wallet and the hotel. Names here are made up.

A session is private by link like a wallet: its tables have RLS on with no policy, and the API reads and writes them
through DATABASE_URL.
"""

import logging

import psycopg
import pytest

from app import sessions as s
from app.limits import RateLimiter
from conftest import ROOT

MIGRATION = ROOT / "supabase" / "migrations" / "2026-11-01_tg52_trip_sessions.sql"
TABLES = ["trip_sessions", "session_hotels"]
ORIGIN = "http://localhost:3000"
TRIP = {"name": "Baguio Nov 6", "start_date": "2026-11-06", "return_date": "2026-11-08"}
HOTEL = {
    "name": "Pine Hill Inn",
    "address": "12 Session Road, Baguio",
    "check_in": "2026-11-06T14:00:00",
    "check_out": "2026-11-08T11:00:00",
    "booking_ref": "ABC123",
    "notes": "Ask for the room with the view",
}


@pytest.fixture(autouse=True)
def fresh_limiters(monkeypatch):
    monkeypatch.setattr(s, "CREATE_LIMITER", RateLimiter(s.CREATE_PER_HOUR))
    monkeypatch.setattr(s, "WRITE_LIMITER", RateLimiter(s.WRITES_PER_HOUR))
    from app import wallets

    monkeypatch.setattr(wallets, "CREATE_LIMITER", RateLimiter(wallets.CREATE_PER_HOUR))  # trips here make wallets too


def create(client, **change):
    r = client.post("/sessions", json={**TRIP, **change})
    assert r.status_code == 201, r.text
    return r.json()


def add_itinerary(dsn, share_slug="abc123def456"):
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(
            "insert into itineraries (share_slug, trip_date, party, plan) values (%s, '2026-11-06', '[]', '{}')",
            (share_slug,),
        )
    return share_slug


def test_create_returns_a_long_secret_slug_and_an_empty_trip(client):
    trip = create(client)
    assert s.SLUG.fullmatch(trip["share_slug"])
    assert trip["name"] == "Baguio Nov 6"
    assert (trip["start_date"], trip["return_date"]) == ("2026-11-06", "2026-11-08")
    assert trip["itinerary_slug"] is None and trip["wallet"] is None and trip["hotel"] is None
    got = client.get(f"/sessions/{trip['share_slug']}")
    assert got.status_code == 200
    assert got.json() == trip
    assert got.headers["cache-control"] == "private, no-cache"
    assert got.headers["x-robots-tag"] == "noindex"


@pytest.mark.parametrize(
    "change",
    [
        {"name": ""},
        {"name": "x" * 41},
        {"return_date": "2026-11-05"},  # before the start
        {"return_date": "2026-12-07"},  # more than 30 days
        {"extra": "field"},
    ],
)
def test_create_rejects_bad_trips(client, change):
    assert client.post("/sessions", json={**TRIP, **change}).status_code == 422


@pytest.mark.parametrize("slug", ["nope", "0" * 32, "Z" * 32, "0" * 31])
def test_unknown_or_malformed_slugs_are_404(client, slug):
    r = client.get(f"/sessions/{slug}")
    assert r.status_code == 404
    assert r.json()["detail"] == s.NOT_FOUND


def test_create_is_rate_limited_per_ip(client, monkeypatch):
    monkeypatch.setattr(s, "CREATE_LIMITER", RateLimiter(2))
    create(client)
    create(client)
    r = client.post("/sessions", json=TRIP)
    assert r.status_code == 429
    assert int(r.headers["retry-after"]) >= 1


def test_rename_and_move_dates_checks_them_against_the_stored_ones(client):
    slug = create(client)["share_slug"]
    r = client.patch(f"/sessions/{slug}", json={"name": "  Baguio barkada  "})
    assert r.status_code == 200 and r.json()["name"] == "Baguio barkada"
    assert r.json()["start_date"] == "2026-11-06"
    assert client.patch(f"/sessions/{slug}", json={"start_date": "2026-11-09"}).status_code == 422  # after the return
    r = client.patch(f"/sessions/{slug}", json={"start_date": "2026-11-07", "return_date": "2026-11-09"})
    assert (r.json()["start_date"], r.json()["return_date"]) == ("2026-11-07", "2026-11-09")


def test_attach_and_detach_an_itinerary_by_its_share_slug(client, dsn):
    slug = create(client)["share_slug"]
    plan = add_itinerary(dsn)
    r = client.put(f"/sessions/{slug}/itinerary", json={"share_slug": plan})
    assert r.status_code == 200 and r.json()["itinerary_slug"] == plan
    assert client.get(f"/sessions/{slug}").json()["itinerary_slug"] == plan
    for bad in ("not-there", "bad slug!"):
        r = client.put(f"/sessions/{slug}/itinerary", json={"share_slug": bad})
        assert r.status_code == 422 and r.json()["detail"] == "itinerary_not_found"
    assert client.get(f"/sessions/{slug}").json()["itinerary_slug"] == plan, "a bad link leaves the plan alone"
    assert client.delete(f"/sessions/{slug}/itinerary").json()["itinerary_slug"] is None


def test_attach_and_detach_a_wallet_by_its_share_slug(client):
    slug = create(client)["share_slug"]
    wallet = client.post("/wallets", json={"name": "Baguio", "members": ["Jacob", "Ana"]}).json()
    r = client.put(f"/sessions/{slug}/wallet", json={"share_slug": wallet["share_slug"]})
    assert r.status_code == 200
    assert r.json()["wallet"] == {"share_slug": wallet["share_slug"], "name": "Baguio"}
    r = client.put(f"/sessions/{slug}/wallet", json={"share_slug": "0" * 32})
    assert r.status_code == 422 and r.json()["detail"] == "wallet_not_found"
    assert client.delete(f"/sessions/{slug}/wallet").json()["wallet"] is None
    assert client.get(f"/wallets/{wallet['share_slug']}").status_code == 200, "detaching never deletes the wallet"


def test_hotel_is_set_replaced_and_removed(client):
    slug = create(client)["share_slug"]
    r = client.put(f"/sessions/{slug}/hotel", json=HOTEL)
    assert r.status_code == 200
    assert r.json()["hotel"] == HOTEL
    r = client.put(f"/sessions/{slug}/hotel", json={"name": "  Other Inn  "})
    assert r.json()["hotel"] == {"name": "Other Inn", "address": "", "check_in": None, "check_out": None, "booking_ref": "", "notes": ""}
    assert client.delete(f"/sessions/{slug}/hotel").json()["hotel"] is None


@pytest.mark.parametrize(
    "change",
    [
        {"name": ""},
        {"name": "x" * 81},
        {"address": "x" * 201},
        {"booking_ref": "x" * 41},
        {"notes": "x" * 301},
        {"check_out": "2026-11-06T13:00:00"},  # before check-in
        {"check_in": "2026-11-06T14:00:00+08:00"},  # Manila wall time only
    ],
)
def test_hotel_validation(client, change):
    slug = create(client)["share_slug"]
    assert client.put(f"/sessions/{slug}/hotel", json={**HOTEL, **change}).status_code == 422


def test_delete_needs_the_trip_name_and_keeps_the_wallet_and_plan(client, dsn):
    trip = create(client)
    slug = trip["share_slug"]
    wallet = client.post("/wallets", json={"name": "Baguio", "members": ["Jacob"]}).json()
    client.put(f"/sessions/{slug}/wallet", json={"share_slug": wallet["share_slug"]})
    client.put(f"/sessions/{slug}/itinerary", json={"share_slug": add_itinerary(dsn)})
    client.put(f"/sessions/{slug}/hotel", json=HOTEL)
    r = client.request("DELETE", f"/sessions/{slug}", json={"name": "Wrong trip"})
    assert r.status_code == 422 and r.json()["detail"] == "name_mismatch"
    r = client.request("DELETE", f"/sessions/{slug}", json={"name": "  baguio NOV 6 "})
    assert r.status_code == 204
    assert client.get(f"/sessions/{slug}").status_code == 404
    with psycopg.connect(dsn) as conn:
        assert conn.execute("select count(*) from session_hotels").fetchone()[0] == 0, "the hotel goes with it"
    assert client.get(f"/wallets/{wallet['share_slug']}").status_code == 200


def test_writes_to_an_unknown_session_are_404(client):
    for method, path, body in [
        ("PATCH", "", {"name": "x"}),
        ("PUT", "/hotel", HOTEL),
        ("PUT", "/wallet", {"share_slug": "0" * 32}),
        ("DELETE", "/hotel", None),
    ]:
        assert client.request(method, f"/sessions/{'0' * 32}{path}", json=body).status_code == 404


def test_writes_are_rate_limited_per_ip(client, monkeypatch):
    slug = create(client)["share_slug"]
    monkeypatch.setattr(s, "WRITE_LIMITER", RateLimiter(1))
    assert client.put(f"/sessions/{slug}/hotel", json=HOTEL).status_code == 200
    assert client.put(f"/sessions/{slug}/hotel", json=HOTEL).status_code == 429


def test_logs_carry_the_slug_and_shape_never_names_or_hotel_details(client, caplog):
    caplog.set_level(logging.INFO, logger="tara_gala.api")
    slug = create(client)["share_slug"]
    client.put(f"/sessions/{slug}/hotel", json=HOTEL)
    client.get(f"/sessions/{slug}")
    text = caplog.text
    assert f"session hotel-set share_slug={slug}" in text
    assert "hotel=yes" in text
    for secret in ("Baguio Nov 6", "Pine Hill", "Session Road", "ABC123", "room with the view"):
        assert secret not in text


def test_cors_allows_put_and_patch_from_the_app(client):
    r = client.options(
        "/sessions/" + "0" * 32 + "/hotel",
        headers={"Origin": ORIGIN, "Access-Control-Request-Method": "PUT"},
    )
    assert r.status_code == 200
    methods = r.headers["access-control-allow-methods"]
    assert "PUT" in methods and "PATCH" in methods


def test_tables_are_private_by_link(dsn):
    with psycopg.connect(dsn) as conn:
        for t in TABLES:
            rls = conn.execute("select relrowsecurity from pg_class where relname = %s", (t,)).fetchone()[0]
            assert rls, f"{t}: RLS on"
            policies = conn.execute("select count(*) from pg_policies where tablename = %s", (t,)).fetchone()[0]
            assert policies == 0, f"{t}: no public policy"


def test_the_migration_is_safe_to_rerun_on_a_current_database(dsn):
    sql = MIGRATION.read_text(encoding="utf-8")
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(sql)
        conn.execute(sql)
        cols = {r[0] for r in conn.execute("select column_name from information_schema.columns where table_name = 'trip_sessions'")}
    assert {"share_slug", "name", "start_date", "return_date", "itinerary_id", "wallet_id"} <= cols


def test_the_migration_builds_the_tables_on_a_database_from_before_tg52(dsn):
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute("drop table session_hotels, trip_sessions cascade")
        conn.execute(MIGRATION.read_text(encoding="utf-8"))
        assert conn.execute("select count(*) from pg_class where relname = any(%s) and relrowsecurity", (TABLES,)).fetchone()[0] == 2
