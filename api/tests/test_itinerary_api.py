"""TG-23: GET /itineraries/{share_slug}, the share-link read (plan.md B1 to B7).

Fixture data below is made up for tests only, not real trips, spots, legs or people. Party names are
marker strings so leak and log checks have something unique to look for.
"""

import json
import logging
import re
from pathlib import Path

import psycopg
import pytest

import load_premade
from app.flags import get_flags
from conftest import ROOT
from premade_data import (
    FRI, NIGHT_DAYS, P0_DAYS, SUN, THU, build_plan, chill_entry, db_ids, db_p0, load_rows, write_premade,
)
from test_itineraries_rls import CLIENT_ROLES, ensure_role, scalar_as

APP = Path(__file__).resolve().parents[1] / "app"
NAME = "Testname-Marker-23 (made up)"
PHONE = "PHONE-MARKER-23"
PLANNER_PARTY = [{"type": "adult", "name": NAME, "phone": PHONE}, {"type": "student"}]
NOT_FOUND = b'{"detail":"Itinerary not found"}'
TOP_FIELDS = {
    "share_slug", "premade", "trip_date", "return_date", "party", "budget_php", "vibe", "created_at",
    "outbound", "return", "days", "plan", "issues",
}
OUT = ("vl-cubao", "07:00", "regular_aircon")
NIGHT = ("vl-cubao", "22:00", "regular_aircon")
NO_MINUTES = ("vl-cubao", "09:00", "deluxe")
RET = ("vl-baguio", "21:00", "regular_aircon")


@pytest.fixture(autouse=True)
def fresh_flags(monkeypatch):
    for name in ("PREMADE_ITINERARIES", "PLANNER_LIVE", "REAL_MAP"):
        monkeypatch.delenv(name, raising=False)
    get_flags.cache_clear()
    yield
    get_flags.cache_clear()


@pytest.fixture()
def rows(dsn, tmp_path):
    load_rows(dsn, tmp_path / "csv")
    return dsn


def insert_row(dsn, plan, *, party=PLANNER_PARTY, trip_date=FRI, return_date=SUN, budget=6000,
               vibe="Chill (made up)", model="claude-haiku-5-5", share_slug=None) -> str:
    """A planner-style row, inserted the way TG-20 saves one (DB-default slug unless given)."""
    cols = "trip_date, return_date, party, budget_php, vibe, plan, model"
    vals = [trip_date, return_date, json.dumps(party), budget, vibe, json.dumps(plan), model]
    if share_slug is not None:
        cols += ", share_slug"
        vals.append(share_slug)
    marks = ", ".join(["%s"] * len(vals))
    with psycopg.connect(dsn, autocommit=True) as conn:
        return conn.execute(f"insert into itineraries ({cols}) values ({marks}) returning share_slug", vals).fetchone()[0]


@pytest.fixture()
def planner(rows):
    plan = db_p0(rows)
    return rows, insert_row(rows, plan), plan


def get(client, slug):
    return client.get(f"/itineraries/{slug}")


def found(body):
    return [(i["code"], i["path"]) for i in body["issues"]]


@pytest.fixture()
def make_client(dsn, monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setenv("DATABASE_URL", dsn)
    from app.main import app

    return lambda: TestClient(app)


# --- B1 the joined plan --------------------------------------------------------------------------

def test_planner_itinerary_joins_trips_spots_and_legs(client, planner):
    """T23-A1"""
    dsn, slug, plan = planner
    r = get(client, slug)
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == TOP_FIELDS
    assert body["share_slug"] == slug and body["premade"] is False
    assert (body["trip_date"], body["return_date"]) == ("2026-11-06", "2026-11-08")
    assert body["budget_php"] == 6000 and isinstance(body["budget_php"], (int, float))
    assert body["vibe"] == "Chill (made up)" and body["created_at"]
    assert body["plan"] == plan  # stored verbatim
    assert body["issues"] == []

    # Buses: identical to /trips' cards for the same trip on that leg's date (one shared builder)
    out_cards = client.get("/trips", params={"origin_city": "Metro Manila", "destination_city": "Baguio", "date": "2026-11-06"}).json()
    ret_cards = client.get("/trips", params={"origin_city": "Baguio", "destination_city": "Metro Manila", "date": "2026-11-08"}).json()
    by_id = {t["trip_id"]: t for t in out_cards + ret_cards}
    for leg in ("outbound", "return"):
        assert body[leg]["trip_id"] == plan[leg]["trip_id"]
        assert body[leg]["date"] == plan[leg]["date"]
        assert body[leg]["trip"] == by_id[plan[leg]["trip_id"]]
        assert body[leg]["trip"]["last_verified_at"] is not None and body[leg]["trip"]["confirm_note"]

    # Stops: the TG-17 shapes, identical to /spots and /last-mile
    spots = {s["spot_id"]: s for s in client.get("/spots").json()}
    legs = {leg["last_mile_route_id"]: leg for leg in client.get("/last-mile").json()}
    assert [d["day"] for d in body["days"]] == [1, 2, 3]
    assert [d["date"] for d in body["days"]] == ["2026-11-06", "2026-11-07", "2026-11-08"]
    for day, stored in zip(body["days"], plan["days"]):
        assert [s["spot_id"] for s in day["stops"]] == [s["spot_id"] for s in stored["stops"]]
        for stop, want in zip(day["stops"], stored["stops"]):
            assert set(stop) == {"spot_id", "arrive", "leave", "spot", "last_mile_route_id", "leg"}
            assert (stop["arrive"], stop["leave"]) == (want["arrive"], want["leave"])
            assert stop["last_mile_route_id"] == want["leg"]["last_mile_route_id"]
            assert stop["spot"] == spots[stop["spot_id"]]
            assert stop["leg"] == legs[stop["last_mile_route_id"]]
            assert stop["leg"]["last_verified_at"] is not None and stop["leg"]["confirm_note"]


def test_premade_itinerary_joins_and_has_no_names(make_client, rows, tmp_path, monkeypatch):
    """T23-A2: and a shared pre-made link keeps working with the list flag off."""
    assert load_premade.run(rows, write_premade(tmp_path, [chill_entry()]), dry_run=False, prune=False) == 0
    monkeypatch.setenv("PREMADE_ITINERARIES", "false")
    with make_client() as c:
        assert c.get("/premade-itineraries").status_code == 404  # the list is off...
        r = get(c, "premade-test-chill")  # ...the link still works
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["premade"] is True
    assert body["party"] == [{"type": "adult", "name": None}, {"type": "student", "name": None}]
    assert body["plan"] == db_p0(rows) and body["issues"] == []
    assert all(s["spot"] and s["leg"] for d in body["days"] for s in d["stops"])
    assert body["outbound"]["trip"]["trip_id"] == body["plan"]["outbound"]["trip_id"]


# --- B1 day dates and arrivals -------------------------------------------------------------------

def test_day_dates_follow_outbound_arrival(client, rows):
    """T23-A3"""
    trips, spots, legs = db_ids(rows)
    night = build_plan(trips[NIGHT], THU, trips[RET], SUN, NIGHT_DAYS, spots, legs)
    body = get(client, insert_row(rows, night, trip_date=THU)).json()
    assert body["outbound"]["trip"]["arrives_around"] == "04:00"
    assert body["outbound"]["trip"]["arrives_day_offset"] == 1
    assert [d["date"] for d in body["days"]] == ["2026-11-06", "2026-11-07", "2026-11-08"]  # day 1 = Thu + 1
    assert body["issues"] == []

    unknown = build_plan(trips[NO_MINUTES], FRI, trips[RET], SUN, P0_DAYS, spots, legs)
    body = get(client, insert_row(rows, unknown)).json()
    assert [d["date"] for d in body["days"]] == [None, None, None]  # never a guessed date
    assert ("arrival_unknown", "outbound.trip_id") in found(body)
    assert body["outbound"]["trip"]["arrives_around"] is None


def test_return_trip_uses_return_date(client, planner):
    """T23-A18: 21:00 + 360 min arrives 03:00 the next day, computed from return.date."""
    dsn, slug, _ = planner
    trip = get(client, slug).json()["return"]["trip"]
    assert (trip["arrives_around"], trip["arrives_day_offset"]) == ("03:00", 1)


# --- B3 changed data: reported, never substituted or invented -------------------------------------

@pytest.mark.parametrize("leg", ["outbound", "return"])
def test_inactive_trip_is_returned_with_an_issue(client, planner, leg):
    """T23-A4"""
    dsn, slug, plan = planner
    before = get(client, slug).json()[leg]["trip"]
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute("update trips set is_active = false where id = %s", (plan[leg]["trip_id"],))
    body = get(client, slug).json()
    assert body[leg]["trip"] == before  # the stored trip, all fields, never a substitute
    assert (("trip_inactive", f"{leg}.trip_id")) in found(body)
    issue = next(i for i in body["issues"] if i["code"] == "trip_inactive")
    assert set(issue) == {"code", "path", "message"} and issue["message"]


def walk_strings(value):
    if isinstance(value, dict):
        for v in value.values():
            yield from walk_strings(v)
    elif isinstance(value, list):
        for v in value:
            yield from walk_strings(v)
    elif isinstance(value, str):
        yield value


def test_missing_leg_is_null_never_invented(client, planner):
    """T23-A5 (a)"""
    dsn, slug, plan = planner
    leg_id = plan["days"][0]["stops"][0]["leg"]["last_mile_route_id"]
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute("delete from last_mile_routes where id = %s", (leg_id,))
    body = get(client, slug).json()
    stop = body["days"][0]["stops"][0]
    assert stop["leg"] is None and stop["last_mile_route_id"] == leg_id
    assert stop["spot"] is not None
    assert ("unknown_leg", "days[0].stops[0].leg.last_mile_route_id") in found(body)


def test_missing_spot_is_null_never_invented(client, planner):
    """T23-A5 (b)"""
    dsn, slug, plan = planner
    spot_id = plan["days"][1]["stops"][0]["spot_id"]  # test-cafe
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute("delete from last_mile_routes where from_spot_id = %s or to_spot_id = %s", (spot_id, spot_id))
        conn.execute("delete from spots where id = %s", (spot_id,))
    body = get(client, slug).json()
    stop = body["days"][1]["stops"][0]
    assert stop["spot"] is None and stop["spot_id"] == spot_id
    assert ("unknown_spot", "days[1].stops[0].spot_id") in found(body)
    assert not any("Test Cafe" in s for s in walk_strings(body))  # no stale or made-up name anywhere


def test_missing_trip_is_null_never_invented(client, planner):
    """T23-A5 (c)"""
    dsn, slug, plan = planner
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute("delete from trips where id = %s", (plan["outbound"]["trip_id"],))
    body = get(client, slug).json()
    assert body["outbound"]["trip"] is None
    assert body["outbound"]["trip_id"] == plan["outbound"]["trip_id"]
    assert ("unknown_trip", "outbound.trip_id") in found(body)
    assert [d["date"] for d in body["days"]] == [None, None, None]  # no arrival to count from
    assert body["return"]["trip"] is not None


# --- B4 / B5 exact slug only, no listing, read-only ----------------------------------------------

SLUG_CASES = {
    "unknown hex": lambda s: "0123456789ab",
    "upper-cased": lambda s: s.upper(),
    "prefix": lambda s: s[:-1],
    "longer": lambda s: s + "x",
    "LIKE wildcard": lambda s: s[:-1] + "_",
    "premade- alone": lambda s: "premade-",
    "percent": lambda s: "%25",
    "leading space": lambda s: "%20abc",
    "script": lambda s: "%3Cscript%3E",
    "unicode": lambda s: "%C3%B1",
    "101 chars": lambda s: "a" * 101,
    "100 chars": lambda s: "a" * 100,
    "trailing newline": lambda s: "abc%0A",
}


KNOWN = "abc123def456"  # fixed so upper-casing and the "_" wildcard always change it


@pytest.mark.parametrize("case", sorted(SLUG_CASES))
def test_unknown_or_malformed_slug_is_404(client, rows, case):
    """T23-A6: one body for every input that reaches the handler; never echoes the slug."""
    insert_row(rows, db_p0(rows), share_slug=KNOWN)
    assert get(client, KNOWN).status_code == 200
    r = get(client, SLUG_CASES[case](KNOWN))
    assert r.status_code == 404
    assert r.content == NOT_FOUND


@pytest.mark.parametrize("path", ["/itineraries/a%2Fb", "/itineraries/.."])
def test_paths_the_router_answers_itself(client, planner, caplog, path):
    """Review finding 1: these never reach the handler; 404, no echo, no handler log line."""
    caplog.set_level(logging.INFO, logger="tara_gala.api")
    r = client.get(path)
    assert r.status_code == 404
    assert b"a/b" not in r.content and b".." not in r.content
    assert not [m for m in (rec.getMessage() for rec in caplog.records) if m.startswith("itinerary ")]


def test_no_listing_and_read_only(client, planner):
    """T23-A7"""
    dsn, slug, _ = planner
    for path in ("/itineraries", "/itineraries/"):
        r = client.get(path, follow_redirects=False)
        assert r.status_code == 404, path
    for method in ("POST", "PUT", "PATCH", "DELETE"):
        assert client.request(method, f"/itineraries/{slug}").status_code == 405, method
    paths = {p for p in client.get("/openapi.json").json()["paths"] if "itinerar" in p}
    assert paths == {"/itineraries/{share_slug}", "/premade-itineraries"}


# Every GET route the API serves, including include_in_schema=False ones. A new read route must be added
# here on purpose, after checking it can't list or enumerate itineraries (TG-23 RED audit gap 1).
GET_ROUTES = {
    "/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc",  # FastAPI's own
    "/health", "/terminals", "/trips", "/spots", "/last-mile",
    "/premade-itineraries",  # TG-24: model = 'premade' rows only
    "/itineraries/{share_slug}",  # TG-23: one row by exact slug
}


def test_no_hidden_or_renamed_listing_route():
    """RED audit gap 1: walk app.routes, so a list route at any path, or hidden from OpenAPI, fails."""
    from app.main import app

    served = {r.path for r in app.routes if "GET" in (getattr(r, "methods", None) or set())}
    assert served == GET_ROUTES
    takes_slug = [r.path for r in app.routes if "{" in getattr(r, "path", "")]
    assert takes_slug == ["/itineraries/{share_slug}"]  # the only parameterised path is the exact-slug read


def test_only_exact_slug_and_premade_reads_touch_itineraries():
    """RED audit gap 1: no other module reads the itineraries table, whatever its route is called."""
    readers = {}
    for p in sorted(APP.glob("*.py")):
        n = len(re.findall(r"\b(?:from|join)\s+(?:public\.)?itineraries\b", p.read_text(encoding="utf-8"), re.I))
        if n:
            readers[p.name] = n
    assert readers == {"itineraries.py": 1, "premade.py": 1}
    assert "where model = %s" in (APP / "premade.py").read_text(encoding="utf-8")


def test_premade_list_never_includes_planner_rows(client, planner, tmp_path):
    """T23-A8 (guard)"""
    dsn, slug, _ = planner
    assert load_premade.run(dsn, write_premade(tmp_path, [chill_entry()]), dry_run=False, prune=False) == 0
    r = client.get("/premade-itineraries")
    assert [i["share_slug"] for i in r.json()] == ["premade-test-chill"]
    assert slug not in r.text and NAME not in r.text


# --- B6 headers -------------------------------------------------------------------------------------

def test_share_response_headers(client, planner):
    """T23-A9 (404 also noindex: review nit 5)"""
    dsn, slug, _ = planner
    ok = get(client, slug)
    assert ok.headers["cache-control"] == "private, no-cache"
    assert ok.headers["x-robots-tag"] == "noindex"
    missing = get(client, "0123456789ab")
    assert missing.status_code == 404
    assert missing.headers["x-robots-tag"] == "noindex"


# --- party exposure (security note) ------------------------------------------------------------------

def test_party_exposure_is_exactly_type_and_name(client, planner):
    """T23-A10"""
    dsn, slug, _ = planner
    r = get(client, slug)
    assert r.json()["party"] == [{"type": "adult", "name": NAME}, {"type": "student", "name": None}]
    assert PHONE not in r.text


@pytest.mark.parametrize("party, expected", [
    ("x", []),
    ({"type": "adult"}, []),
    ([{"type": "adult"}, {"name": "No type (made up)"}, 7, {"type": "senior", "name": 5}, {"type": 3}],
     [{"type": "adult", "name": None}]),
])
def test_malformed_party_entries_are_skipped_with_a_warning(client, rows, caplog, party, expected):
    """Review finding 2: the plan is still useful; skip what doesn't fit, warn with the slug only."""
    caplog.set_level(logging.WARNING, logger="tara_gala.api")
    slug = insert_row(rows, db_p0(rows), party=party)
    r = get(client, slug)
    assert r.status_code == 200, r.text
    assert r.json()["party"] == expected
    warnings = [rec.getMessage() for rec in caplog.records if rec.name == "tara_gala.api" and rec.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert warnings[0].startswith(f"itinerary party entries skipped share_slug={slug} skipped=")
    assert "No type" not in warnings[0]


# --- B7 / logging -------------------------------------------------------------------------------------

def test_logs_never_carry_party_budget_or_plan(client, planner, caplog):
    """T23-A11"""
    dsn, slug, plan = planner
    caplog.set_level(logging.DEBUG)
    get(client, slug)
    lines = [r.getMessage() for r in caplog.records if r.name == "tara_gala.api" and r.getMessage().startswith("itinerary ")]
    assert lines == [f"itinerary get share_slug={slug} premade=False days=3 stops=6 issues=0 codes=-"]
    first_spot = plan["days"][0]["stops"][0]["spot_id"]
    for rec in caplog.records:
        msg = rec.getMessage()
        assert NAME not in msg and PHONE not in msg and "6000" not in msg and first_spot not in msg, rec.name


def test_not_found_log_lines(client, planner, caplog):
    caplog.set_level(logging.INFO, logger="tara_gala.api")
    get(client, "0123456789ab")
    get(client, "abc%0A")
    get(client, "%3Cscript%3E")
    lines = [r.getMessage() for r in caplog.records if r.name == "tara_gala.api" and r.getMessage().startswith("itinerary ")]
    assert lines == [
        "itinerary not found share_slug=0123456789ab",
        "itinerary not found share_slug=<invalid>",
        "itinerary not found share_slug=<invalid>",
    ]


def test_unreadable_plan_is_generic_500(client, rows, caplog):
    """T23-A12"""
    caplog.set_level(logging.INFO, logger="tara_gala.api")
    slug = insert_row(rows, {"made_up": "PLAN-MARKER-23"})
    r = get(client, slug)
    assert r.status_code == 500
    assert r.content == b'{"detail":"Itinerary is unreadable"}'
    errors = [rec.getMessage() for rec in caplog.records if rec.name == "tara_gala.api" and rec.levelno == logging.ERROR]
    assert len(errors) == 1
    assert errors[0].startswith(f"itinerary unreadable share_slug={slug} codes=") and "shape" in errors[0]
    assert not any("PLAN-MARKER-23" in rec.getMessage() for rec in caplog.records)


# --- RLS, schema pins, static checks -------------------------------------------------------------------

def test_itineraries_still_not_publicly_readable(client, planner):
    """T23-A13: the endpoint reads through DATABASE_URL; anon and authenticated still see nothing."""
    dsn, slug, _ = planner
    assert get(client, slug).status_code == 200
    with psycopg.connect(dsn, autocommit=True) as conn:
        for role in CLIENT_ROLES:
            ensure_role(conn, role)
        conn.execute("grant usage on schema public to anon, authenticated")
        conn.execute("grant all on all tables in schema public to anon, authenticated")
        for role in CLIENT_ROLES:
            assert scalar_as(conn, role, "select count(*) from itineraries where share_slug = %s", (slug,)) == 0


def test_trip_rows_columns_match_trip_search_view(rows):
    """T23-A14: trip_rows reads the base tables (no is_active filter) with the view's columns plus is_active."""
    from app import trip_rows

    with psycopg.connect(rows) as conn:
        view = [c.name for c in conn.execute("select * from trip_search limit 0").description]
        cur = conn.execute(trip_rows.TRIP_ROWS_SQL, ([],))
        assert cur.fetchall() == []
        assert [c.name for c in cur.description] == view + ["is_active"]


def test_confirm_note_has_one_home():
    from app import main, trip_rows

    assert main.CONFIRM_NOTE == trip_rows.CONFIRM_NOTE
    assert 'CONFIRM_NOTE = "' not in (APP / "main.py").read_text(encoding="utf-8")


def test_openapi_documents_itinerary(client):
    """T23-A16"""
    spec = client.get("/openapi.json").json()
    get_op = spec["paths"]["/itineraries/{share_slug}"]["get"]
    assert get_op["responses"]["200"]["content"]["application/json"]["schema"]["$ref"].endswith("/ItineraryOut")
    assert [p["name"] for p in get_op["parameters"] if p["in"] == "path"] == ["share_slug"]
    props = spec["components"]["schemas"]["ItineraryOut"]["properties"]
    assert "return" in props and "return_" not in props


def test_slug_lookup_is_parameterised():
    """T23-A17"""
    src = (APP / "itineraries.py").read_text(encoding="utf-8")
    assert "where share_slug = %s" in src
    lowered = src.lower()
    for banned in (" like ", "ilike", "lower(", " ~ ", "similar to"):
        assert banned not in lowered, banned
    assert not re.search(r"f[\"'][^\"']*\{share_slug", src)
    assert ".fullmatch(" in src  # review finding 1: re.match's $ lets a trailing newline through


def test_itinerary_modules_add_no_logging_config():
    """T23-A19"""
    for name in ("itineraries.py", "trip_rows.py"):
        src = (APP / name).read_text(encoding="utf-8")
        for banned in ("basicConfig", "dictConfig", "addHandler"):
            assert banned not in src, (name, banned)


def test_readme_lists_the_endpoint():
    """Review nit 6"""
    text = (ROOT / "README.md").read_text(encoding="utf-8")
    section5 = text.split("## 5.", 1)[1].split("## 6.", 1)[0]
    assert "GET /itineraries/{share_slug}" in section5
