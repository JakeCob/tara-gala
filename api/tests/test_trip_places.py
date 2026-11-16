"""TG-61 builder B's routes: T1 to T9, POST /sessions/{slug}/places (trip-only places from a Google Maps link), and
S7, S9 and S11 to S13, POST /sessions/{slug}/plan/suggest (options.md §5). The IDs are test-plan.md §3.3 and §3.4's;
T10 on are cases it doesn't number. Everything runs on a throwaway trip with made-up spots, a made-up plan and synthetic
links. No test reaches Google: maps_link.make_client is swapped for a MockTransport.

Builder A wires these routers into main.py behind PLAN_EDITING (plan.md §6), so the tests mount them on an app of
their own, with the same request-log middleware.
"""

import csv
import json
import logging
import re
import uuid
from datetime import datetime

import httpx
import psycopg
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from app import db, maps_link, plan_suggest, sessions, trip_places
from app.limits import MANILA_TZ, RateLimiter
from app.logging_setup import RequestLogMiddleware, configure_logging
from conftest import ROOT
from test_maps_link import Net, redirect

TRIP = {"name": "Made-up trip", "start_date": "2026-11-06", "return_date": "2026-11-08"}
HOST = "https://maps.app.goo.gl"
CAFE_PIN, PARK_PIN, LODGE_PIN, TERMINAL_PIN = (16.4100, 120.5950), (16.4150, 120.6000), (16.4082, 120.5903), (16.4140, 120.5990)


@pytest.fixture()
def net(monkeypatch) -> Net:
    """Every link fetch goes here. Tests add answers to net.table."""
    n = Net()
    monkeypatch.setattr(maps_link, "make_client", n.client)
    monkeypatch.setattr(maps_link.time, "sleep", lambda s: None)  # the geocoder's one-a-second wait, on the real clock
    maps_link.clear_cache()
    yield n
    maps_link.clear_cache()


@pytest.fixture(autouse=True)
def fresh_limits(monkeypatch):
    monkeypatch.setattr(trip_places, "LINK_LIMITER", RateLimiter(trip_places.LINK_PER_HOUR))
    monkeypatch.setattr(plan_suggest, "SUGGEST_LIMITER", RateLimiter(plan_suggest.SUGGEST_PER_HOUR))
    monkeypatch.setattr(sessions, "WRITE_LIMITER", RateLimiter(sessions.WRITES_PER_HOUR))
    monkeypatch.setattr(sessions, "CREATE_LIMITER", RateLimiter(sessions.CREATE_PER_HOUR))


@pytest.fixture()
def api(dsn):
    configure_logging({})  # as main.py does at import: the httpx logger at WARNING, so no URL is logged
    app = FastAPI()
    app.add_middleware(RequestLogMiddleware)
    for r in (sessions.router, trip_places.router, plan_suggest.router):
        app.include_router(r)
    db.open_pool(dsn)
    try:
        with TestClient(app) as c:
            yield c
    finally:
        db.close_pool()


def sql(dsn, query, *args) -> list[dict]:
    with psycopg.connect(dsn, row_factory=dict_row, autocommit=True) as conn:
        cur = conn.execute(query, args)
        return cur.fetchall() if cur.description else []


def new_trip(api) -> str:
    r = api.post("/sessions", json=TRIP)
    assert r.status_code == 201, r.text
    return r.json()["share_slug"]


def link_for(net: Net, code: str, lat: float, lng: float, name: str = "Kapihan sa Ulap") -> str:
    """A synthetic short link that redirects to a place URL with this pin and name."""
    url = f"{HOST}/{code}"
    net.table[url] = redirect(f"https://www.google.com/maps/place/{name.replace(' ', '+')}/data=!3d{lat}!4d{lng}")
    return url


def add_place(api, slug, link, name="Kapihan sa Ulap", **extra):
    return api.post(f"/sessions/{slug}/places", json={"link": link, "name": name, **extra})


# ---------------------------------------------------------------- trip places (T)

def test_a_place_is_pinned_from_the_link_on_the_server(api, dsn, net):  # T1, B31
    slug = new_trip(api)
    link = link_for(net, "A1", 16.41234, 120.59321)
    net.table[f"{link}?g_st=ic"] = net.table[link]
    r = add_place(api, slug, f"Kapihan sa Ulap\n{link}?g_st=ic", name="  Kapihan sa Ulap  ")
    assert r.status_code == 201, r.text
    p = r.json()
    assert set(p) == {"id", "name", "lat", "lng", "maps_url", "created_at", "pin_source"}
    assert (p["name"], p["lat"], p["lng"], p["maps_url"], p["pin_source"]) == ("Kapihan sa Ulap", 16.41234, 120.59321, link, "link")
    assert r.headers["cache-control"] == "private, no-cache"
    stored = sql(dsn, "select s.share_slug, p.name, p.lat, p.lng, p.maps_url from trip_places p join trip_sessions s on s.id = p.session_id")
    assert stored == [{"share_slug": slug, "name": "Kapihan sa Ulap", "lat": 16.41234, "lng": 120.59321, "maps_url": link}]
    assert net.asked == [f"{link}?g_st=ic"]


def test_the_phone_cannot_send_a_pin(api, dsn, net):  # T1, B31
    slug = new_trip(api)
    link = link_for(net, "A2", 16.41234, 120.59321)
    r = add_place(api, slug, link, lat=1.0, lng=2.0)
    assert r.status_code == 422, "the body has no lat or lng: the pin only ever comes from the link"
    assert sql(dsn, "select * from trip_places") == [] and net.asked == []


def test_the_same_place_twice_is_the_same_row(api, dsn, net):  # T3, B31
    slug = new_trip(api)
    here, near, past = (16.41234, 120.59321), (16.41256, 120.59321), (16.41258, 120.59321)
    assert 0.024 < plan_suggest.haversine_km(here, near) < 0.025 < plan_suggest.haversine_km(here, past) < 0.027
    first = add_place(api, slug, link_for(net, "B1", *here)).json()
    again = add_place(api, slug, link_for(net, "B2", *near), name="KAPIHAN SA ULAP")  # 24.5 m away
    assert again.status_code == 200 and again.json()["id"] == first["id"]
    other_name = add_place(api, slug, link_for(net, "B3", *here), name="Another cafe")
    far_off = add_place(api, slug, link_for(net, "B4", *past))  # 26.7 m away
    assert other_name.status_code == 201 and far_off.status_code == 201
    assert len(sql(dsn, "select id from trip_places")) == 3


def test_a_trip_holds_100_places(api, dsn, net):  # T4, B31
    slug = new_trip(api)
    sid = sql(dsn, "select id from trip_sessions where share_slug = %s", slug)[0]["id"]
    with psycopg.connect(dsn, autocommit=True) as conn:
        for i in range(100):
            conn.execute("insert into trip_places (session_id, name, lat, lng, maps_url) values (%s, %s, 16.4, 120.5, 'https://maps.app.goo.gl/x')",
                         (sid, f"Made-up {i}"))
    r = add_place(api, slug, link_for(net, "C1", 16.41234, 120.59321))
    assert (r.status_code, r.json()["detail"]) == (409, "too_many_places")
    again = add_place(api, slug, link_for(net, "C2", 16.4, 120.5), name="made-up 7")
    assert again.status_code == 200, "an existing place is still found at the cap"
    assert len(sql(dsn, "select id from trip_places")) == 100


@pytest.mark.parametrize("name", ["", "   ", "x" * 81, "Tab\there", "New\nline", "nul\x00"])
def test_the_name_is_1_to_80_printable_letters(api, dsn, net, name):  # T2, B31
    slug = new_trip(api)
    assert add_place(api, slug, link_for(net, "D1", 16.41234, 120.59321), name=name).status_code == 422
    assert net.asked == [] and sql(dsn, "select * from trip_places") == []


def test_link_problems_are_codes_and_store_nothing(api, dsn, net):  # T5, B28, B30
    slug = new_trip(api)
    assert add_place(api, slug, "https://evil.io/maps/place/x").json()["detail"] == "link_not_maps"
    net.table[f"{HOST}/E1"] = redirect("https://www.google.com/maps/place/Kapihan/")
    r = add_place(api, slug, f"{HOST}/E1")
    assert (r.status_code, r.json()) == (422, {"detail": "need_pin", "name": "Kapihan", "address": "Kapihan"}), "geocoded, and nothing found"
    net.table[f"{HOST}/E2"] = redirect("https://evil.io/x")
    r = add_place(api, slug, f"{HOST}/E2")
    assert (r.status_code, r.json()["detail"]) == (422, "link_unreadable")
    assert sql(dsn, "select * from trip_places") == []
    assert [httpx.URL(u).host for u in net.asked] == ["maps.app.goo.gl", "nominatim.openstreetmap.org", "maps.app.goo.gl"]


def test_an_unknown_trip_is_404_before_any_fetch(api, net):  # T10
    link = link_for(net, "F1", 16.41234, 120.59321)
    assert add_place(api, "0" * 32, link).status_code == 404
    assert add_place(api, "not-a-slug", link).status_code == 404
    assert net.asked == []


def test_places_belong_to_their_trip(api, dsn, net):  # T6, B32, review S5
    """The helpers builder A's SessionOut.places and guide build read through. The routes' own answers are A's E30."""
    a, b = new_trip(api), new_trip(api)
    pid = add_place(api, a, link_for(net, "G1", 16.41234, 120.59321)).json()["id"]
    ids = {r["share_slug"]: r["id"] for r in sql(dsn, "select share_slug, id from trip_sessions")}
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        assert [p.name for p in trip_places.load_places(conn, ids[a])] == ["Kapihan sa Ulap"]
        assert trip_places.load_places(conn, ids[b]) == []
        assert set(trip_places.places_by_id(conn, ids[a], [uuid.UUID(pid)])) == {uuid.UUID(pid)}
        assert trip_places.places_by_id(conn, ids[b], [uuid.UUID(pid)]) == {}, "another trip's place resolves to nothing"
    sql(dsn, "delete from trip_sessions where share_slug = %s", a)
    assert sql(dsn, "select * from trip_places") == [], "deleted with the trip"


def test_link_fetches_share_30_an_hour_per_ip(api, net, monkeypatch):  # S13, options.md §5.4
    monkeypatch.setattr(trip_places, "LINK_LIMITER", RateLimiter(2))
    slug = new_trip(api)
    link = link_for(net, "H1", 16.41234, 120.59321)
    assert add_place(api, slug, link).status_code == 201
    assert add_place(api, slug, link).status_code == 200
    r = api.post(f"/sessions/{slug}/places", json={"lat": 1})
    assert r.status_code == 429 and int(r.headers["retry-after"]) >= 1, "limited ahead of the body's validation"
    assert trip_places.LINK_PER_HOUR == 30 and plan_suggest.SUGGEST_PER_HOUR == 120


def test_the_bounds_are_checked_in_python_before_the_insert(api, dsn, net, monkeypatch, caplog):  # T2, review M3
    caplog.set_level(logging.INFO)
    slug = new_trip(api)
    for got in (maps_link.Resolved(16.41, 120.59, None, "http://maps.app.goo.gl/x", "path"),
                maps_link.Resolved(16.41, 120.59, None, "https://maps.app.goo.gl/" + "x" * 480, "path"),
                maps_link.Resolved(float("nan"), 120.59, None, "https://maps.app.goo.gl/x", "path"),
                maps_link.Resolved(91.0, 120.59, None, "https://maps.app.goo.gl/x", "path")):
        monkeypatch.setattr(maps_link, "resolve", lambda link, got=got: got)
        r = add_place(api, slug, f"{HOST}/P1")
        assert (r.status_code, r.json()["detail"]) == (422, "bad_place")
    assert sql(dsn, "select * from trip_places") == []
    assert "constraint=" not in caplog.text, "refused in Python: the table's checks never saw it"


# ---------------------------------------------------------------- T7, T9: codes and counts only in the logs (review M3)

def test_failures_log_codes_and_counts_only_tracebacks_included(api, dsn, net, caplog, monkeypatch):  # T7, T9, B48
    caplog.set_level(logging.INFO)
    slug = new_trip(api)
    ok = link_for(net, "J1", 16.41234, 120.59321)
    assert add_place(api, slug, ok).status_code == 201
    net.table[f"{HOST}/J2"] = httpx.ConnectError(f"cannot reach {HOST}/J2 for Kapihan sa Ulap")
    assert add_place(api, slug, f"{HOST}/J2").json()["detail"] == "link_unreadable"

    # The Python bounds switched off, so the database's own check fires on the insert
    monkeypatch.setattr(trip_places, "_bounded", lambda name, got: True)
    monkeypatch.setattr(maps_link, "resolve", lambda link: maps_link.Resolved(16.41234, 120.59321, None, "http://maps.app.goo.gl/J3", "path"))
    r = add_place(api, slug, f"{HOST}/J3", name="Lihim na Kainan")
    assert (r.status_code, r.json()["detail"]) == (422, "bad_place")
    assert sql(dsn, "select count(*) as n from trip_places")[0]["n"] == 1

    assert logging.getLogger("httpx").level == logging.WARNING  # review nit 5
    text = caplog.text + "".join(caplog.handler.format(rec) for rec in caplog.records)
    assert "trip place add share_slug=%s places=1 existing=False" % slug in text
    assert caplog.text.count("constraint=") == 1, "only the forced insert reached the table's check"
    assert "trip place rejected share_slug=%s code=bad_place constraint=trip_places_maps_url_check" % slug in text
    for leak in ("Kapihan", "Lihim", "J1", "J2", "J3", "goo.gl", "16.41", "120.59", "Failing row"):
        assert leak not in text, leak


# ---------------------------------------------------------------- S7, S9, S11 to S13: the suggest route

PARK_ID, CAFE_ID, LODGE_ID, BARE_ID, TERMINAL_ID, ROUTE_ID = (uuid.uuid4() for _ in range(6))


def row(key, time, plan, place=None, **extra) -> dict:
    return {"key": key, "time": time, "plan": plan, "place": place, **extra}


GUIDE = {
    "title": "Made-up plan",
    "lodging": {"spot_id": str(LODGE_ID)},
    "getting_there": {"title": "Up", "buses": []},
    "getting_home": {"title": "Home", "buses": []},
    "budget": {},
    "days": [
        {"day": 1, "title": "Day one", "rows": [
            row("d1-01", "06:00", "Arrive", {"terminal_id": str(TERMINAL_ID)}),
            row("d1-02", "09:00", "Coffee", {"spot_id": str(CAFE_ID)}),
            row("d1-03", "12:00", "Lunch somewhere"),
            row("d1-04", "15:00", "Park walk", {"spot_id": str(PARK_ID)}),
        ]},
        {"day": 2, "title": "Day two", "rows": [
            row("d2-01", "14:00", "Pasalubong", {"spot_id": str(CAFE_ID)}),
            row("d2-02", "15:00", "Snack"),
            row("d2-03", "16:15", "Bus home", {"terminal_id": str(TERMINAL_ID)}, bus="return"),
        ]},
    ],
}


@pytest.fixture()
def planned(api, dsn) -> tuple[str, str]:
    """A trip on a made-up shared plan: (trip slug, plan slug). Every spot, terminal and route here is made up."""
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute("insert into terminals (id, slug, name, city, lat, lng) values (%s, 'made-up-terminal', 'Made-up Terminal', 'Baguio', %s, %s)",
                     (TERMINAL_ID, *TERMINAL_PIN))
        for sid, slug, name, pin in ((PARK_ID, "made-up-park", "Made-up Park", PARK_PIN), (CAFE_ID, "made-up-cafe", "Made-up Cafe", CAFE_PIN),
                                     (LODGE_ID, "made-up-lodge", "Made-up Lodge", LODGE_PIN), (BARE_ID, "made-up-bare", "Made-up Unpinned", (None, None))):
            conn.execute("insert into spots (id, slug, name, lat, lng) values (%s, %s, %s, %s, %s)", (sid, slug, name, *pin))
        conn.execute("""insert into last_mile_routes (id, from_terminal_id, to_spot_id, mode, signboard, fare_min_php, fare_max_php, minutes, last_verified_at)
                        values (%s, %s, %s, 'jeep', 'Made-up signboard', 13, 15, 12, '2026-10-26T09:00:00+08:00'),
                               (gen_random_uuid(), %s, %s, 'taxi', null, 150, 200, 20, null)""",
                     (ROUTE_ID, TERMINAL_ID, PARK_ID, TERMINAL_ID, PARK_ID))
        plan = {"outbound": {"trip_id": str(uuid.uuid4()), "date": "2026-11-06"}, "return": {"trip_id": str(uuid.uuid4()), "date": "2026-11-08"},
                "days": [], "guide": GUIDE}
        conn.execute("insert into itineraries (share_slug, trip_date, return_date, party, plan, model) values ('made-up-plan', '2026-11-06', '2026-11-08', '[]', %s, 'premade')",
                     (Jsonb(plan),))
    slug = new_trip(api)
    assert api.put(f"/sessions/{slug}/itinerary", json={"share_slug": "made-up-plan"}).status_code == 200
    return slug, "made-up-plan"


def suggest(api, slug, at, place, base=("made-up-plan", 0)):
    return api.post(f"/sessions/{slug}/plan/suggest", json={"base": {"itinerary_slug": base[0], "seq": base[1]}, "at": at, "place": place})


SUGGESTION_KEYS = {"name", "lat", "lng", "maps_url", "km_from_baguio", "far", "time", "leg", "ripple", "notes", "changes", "pin_source", "fits", "address"}


def test_after_a_stop_with_a_route_on_file(api, planned):  # S11, S4, B21
    slug, _ = planned
    r = suggest(api, slug, {"after": "d1-01"}, {"spot_id": str(PARK_ID)})
    assert r.status_code == 200, r.text
    s = r.json()
    assert set(s) == SUGGESTION_KEYS
    assert (s["name"], s["lat"], s["lng"], s["maps_url"], s["far"]) == ("Made-up Park", *PARK_PIN, None, False)
    assert s["leg"] == {"kind": "route", "last_mile_route_id": str(ROUTE_ID), "mode": "jeep", "minutes": 12, "fare_min_php": 13.0,
                        "fare_max_php": 15.0, "signboard": "Made-up signboard", "last_verified_at": "2026-10-26T01:00:00Z"}
    assert s["time"] == "07:15", "6:00 plus an hour there plus 12 min on the jeep, up to the quarter hour"
    assert s["ripple"] == [] and s["notes"] == []
    assert s["changes"] == [{"word": "New", "day": 1, "text": "Made-up Park at 7:15 AM", "part": "stop"}]
    assert s["fits"] is None, "only {anywhere: true} ranks the slots (options.md §5.5)"
    assert s["km_from_baguio"] == plan_suggest.about_km(plan_suggest.haversine_km(LODGE_PIN, PARK_PIN))
    assert r.headers["cache-control"] == "private, no-cache"


def test_replace_keeps_the_slot_and_walks_back_to_the_last_place(api, planned):  # S11, S5, B21
    slug, _ = planned
    s = suggest(api, slug, {"replace": "d1-04"}, {"spot_id": str(BARE_ID)}).json()
    assert s["time"] == "15:00" and s["ripple"] == [], "Replace keeps its time slot"
    assert (s["lat"], s["km_from_baguio"], s["far"], s["leg"]) == (None, None, False, None), "no pin, so no leg and no distance"
    assert s["notes"] == [plan_suggest.NO_LEG_NOTE]
    assert s["changes"] == [{"word": "Out", "day": 1, "text": "Park walk", "part": "stop"},
                            {"word": "In", "day": 1, "text": "Made-up Unpinned at 3:00 PM", "part": "stop"}]
    s = suggest(api, slug, {"replace": "d1-04"}, {"spot_id": str(CAFE_ID)}).json()
    assert s["leg"] == {"kind": "estimate", "mode": "walk", "minutes": 5, "km": 0.0}, "from d1-02's cafe, past the placeless lunch"
    assert s["notes"] == [plan_suggest.ESTIMATE_NOTE]
    s = suggest(api, slug, {"after": "d1-02"}, {"spot_id": str(PARK_ID)}).json()
    assert s["leg"]["kind"] == "estimate", "the routes to the park start at the terminal, not at the cafe"


def test_a_link_with_a_bus_in_the_way(api, planned, net):  # S11, S6, B22, B23
    slug, _ = planned
    link = link_for(net, "K1", 16.4100, 120.5960)  # about 110 m from the made-up cafe
    s = suggest(api, slug, {"after": "d2-01"}, {"link": link}).json()
    assert (s["name"], s["lat"], s["lng"], s["maps_url"]) == ("Kapihan sa Ulap", 16.41, 120.596, link)
    assert s["leg"] == {"kind": "estimate", "mode": "walk", "minutes": 5, "km": 0.1}
    assert s["time"] == "15:15"
    assert s["ripple"] == [{"key": "d2-02", "drop": True}], "the bus row never moves; the snack before it goes"
    assert s["notes"] == [plan_suggest.ESTIMATE_NOTE, "The 4:15 PM bus can't move."]
    assert s["changes"] == [{"word": "New", "day": 2, "text": "Kapihan sa Ulap at 3:15 PM", "part": "stop"},
                            {"word": "Dropped", "day": 2, "text": "Snack", "part": "ripple"}]
    suggest(api, slug, {"after": "d2-01"}, {"link": link})
    assert net.asked == [link], "the second read comes from the cache"


def test_far_away_is_flagged_and_rounded(api, planned, net):  # S9, S10, B24
    slug, _ = planned
    s = suggest(api, slug, {"after": "d1-04"}, {"link": link_for(net, "K2", 15.0, 120.6, name="Roadside stop")}).json()
    km = plan_suggest.haversine_km(LODGE_PIN, (15.0, 120.6))
    assert s["far"] is True and s["km_from_baguio"] == plan_suggest.about_km(km) == 160
    assert s["leg"] is None and s["notes"] == [plan_suggest.NO_LEG_NOTE], "past 600 minutes there's no estimate"


def test_first_of_the_day_and_a_trip_place(api, planned, net):  # S11, S5
    slug, _ = planned
    s = suggest(api, slug, {"first_of_day": 2}, {"spot_id": str(PARK_ID)}).json()
    assert (s["time"], s["leg"], s["ripple"], s["notes"]) == ("12:45", None, [], [])
    pid = add_place(api, slug, link_for(net, "K3", 16.4110, 120.5950)).json()["id"]
    s = suggest(api, slug, {"after": "d1-02"}, {"trip_place_id": pid}).json()
    assert (s["name"], s["lat"], s["maps_url"]) == ("Kapihan sa Ulap", 16.411, f"{HOST}/K3")
    assert s["leg"]["kind"] == "estimate" and s["time"] == "10:15"


def test_refusals(api, planned, dsn, net):  # S12, B16
    slug, _ = planned
    other = new_trip(api)
    theirs = add_place(api, other, link_for(net, "L1", 16.4110, 120.5950)).json()["id"]
    cases = [
        ({"after": "d9-99"}, {"spot_id": str(PARK_ID)}, 422, "unknown_key"),
        ({"replace": "d2-03"}, {"spot_id": str(PARK_ID)}, 422, "bus_row"),
        ({"first_of_day": 5}, {"spot_id": str(PARK_ID)}, 422, "unknown_day"),
        ({"after": "d1-01"}, {"spot_id": str(uuid.uuid4())}, 422, "unknown_place"),
        ({"after": "d1-01"}, {"trip_place_id": theirs}, 422, "unknown_place"),
        ({"after": "d1-01"}, {"link": "https://evil.io/maps"}, 422, "link_not_maps"),
    ]
    for at, place, status, code in cases:
        r = suggest(api, slug, at, place)
        assert (r.status_code, r.json()["detail"]) == (status, code), (at, place)
    for body in ({"after": "d1-01", "replace": "d1-02"}, {}), ({"after": "d1-01"}, {"spot_id": str(PARK_ID), "link": "x"}):
        assert suggest(api, slug, *body).status_code == 422, "exactly one of each"
    assert suggest(api, new_trip(api), {"after": "d1-01"}, {"spot_id": str(PARK_ID)}).json()["detail"] == "no_guide"
    assert suggest(api, "0" * 32, {"after": "d1-01"}, {"spot_id": str(PARK_ID)}).status_code == 404


def test_a_stale_base_is_the_clash(api, planned, dsn):  # S12, B3
    slug, plan_slug = planned
    r = suggest(api, slug, {"after": "d1-01"}, {"spot_id": str(PARK_ID)}, base=(plan_slug, 2))
    assert r.status_code == 409 and r.json() == {"detail": "plan_changed", "itinerary_slug": plan_slug, "seq": 0}
    # This trip's own copy at version 1, planted as plan_edit.save would leave it
    sid = sql(dsn, "select id from trip_sessions where share_slug = %s", slug)[0]["id"]
    shared = sql(dsn, "select id, plan from itineraries where share_slug = %s", plan_slug)[0]
    copy = sql(dsn, """insert into itineraries (share_slug, trip_date, return_date, party, plan, model)
                       values (%s, '2026-11-06', '2026-11-08', '[]', %s, 'trip-edit') returning id, share_slug""", "c" * 32, Jsonb(shared["plan"]))[0]
    for seq in (0, 1):
        sql(dsn, """insert into itinerary_versions (itinerary_id, session_id, based_on, seq, source, plan, changes)
                    values (%s, %s, %s, %s, %s, %s, '[{"word": "Copied", "day": null, "text": "the plan"}]')""",
            copy["id"], sid, shared["id"] if seq == 0 else None, seq, "copy" if seq == 0 else "hand", Jsonb(shared["plan"]))
    sql(dsn, "update trip_sessions set itinerary_id = %s where id = %s", copy["id"], sid)
    assert suggest(api, slug, {"after": "d1-01"}, {"spot_id": str(PARK_ID)}, base=("c" * 32, 1)).status_code == 200
    r = suggest(api, slug, {"after": "d1-01"}, {"spot_id": str(PARK_ID)}, base=(plan_slug, 0))
    assert r.status_code == 409 and r.json() == {"detail": "plan_changed", "itinerary_slug": "c" * 32, "seq": 1}


def test_suggest_logs_kinds_and_counts_only(api, planned, net, caplog):  # T11, plan.md §8
    caplog.set_level(logging.INFO, logger="tara_gala.api")
    slug, _ = planned
    suggest(api, slug, {"after": "d1-01"}, {"spot_id": str(PARK_ID)})
    suggest(api, slug, {"after": "d2-01"}, {"link": link_for(net, "M1", 16.4100, 120.5960)})
    lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("plan suggest ")]
    assert lines == [f"plan suggest share_slug={slug} place=spot at=after leg=route far=False ripple=0",
                     f"plan suggest share_slug={slug} place=link at=after leg=estimate far=False ripple=1"]
    for leak in ("Made-up", "Kapihan", "M1", "goo.gl", "16.41", "120.59", "Snack", "Coffee"):
        assert leak not in caplog.text, leak


def test_suggest_is_limited_ahead_of_its_body(api, planned, monkeypatch):  # S13, options.md §5.4
    monkeypatch.setattr(plan_suggest, "SUGGEST_LIMITER", RateLimiter(1))
    slug, _ = planned
    assert suggest(api, slug, {"after": "d1-01"}, {"spot_id": str(PARK_ID)}).status_code == 200
    r = api.post(f"/sessions/{slug}/plan/suggest", json={"base": None})
    assert r.status_code == 429, "limited ahead of the body's validation"


def test_a_link_in_suggest_counts_against_the_link_limit(api, planned, net, monkeypatch):  # S13, options.md §5.4
    monkeypatch.setattr(trip_places, "LINK_LIMITER", RateLimiter(1))
    slug, _ = planned
    link = link_for(net, "N1", 16.4100, 120.5960)
    assert suggest(api, slug, {"after": "d2-01"}, {"link": link}).status_code == 200
    assert suggest(api, slug, {"after": "d1-01"}, {"spot_id": str(PARK_ID)}).status_code == 200, "a spot costs no fetch"
    assert suggest(api, slug, {"after": "d2-01"}, {"link": link}).status_code == 429
    assert add_place(api, slug, link).status_code == 429, "suggest and places share it"


TABLES = ("trip_sessions", "itineraries", "itinerary_versions", "trip_places", "spots", "terminals", "last_mile_routes",
          "session_marks", "session_files")


def counts(dsn) -> dict:
    return {t: sql(dsn, f"select count(*) as n from {t}")[0]["n"] for t in TABLES}


def test_suggest_writes_nothing_and_reads_a_long_link_with_no_request(api, planned, dsn, net):  # S11
    slug, _ = planned
    pid = add_place(api, slug, link_for(net, "Q1", 16.4110, 120.5950)).json()["id"]
    net.asked.clear()
    before = counts(dsn)
    long_link = "https://www.google.com/maps/place/Bahay+Kubo/@16.41,120.59,17z/data=!3d16.4105!4d120.5952?entry=ttu"
    for place in ({"spot_id": str(PARK_ID)}, {"trip_place_id": pid}, {"link": long_link}):
        r = suggest(api, slug, {"after": "d1-02"}, place)
        assert r.status_code == 200, r.text
        assert set(r.json()) == SUGGESTION_KEYS
    assert suggest(api, slug, {"after": "d1-02"}, {"link": long_link}).json()["maps_url"] == long_link.split("?")[0]
    assert counts(dsn) == before, "nothing is written"
    assert net.asked == [], "a long link costs no request"


def test_a_spots_visit_minutes_is_its_stay(api, planned, dsn):  # S7
    slug, _ = planned
    s = suggest(api, slug, {"after": "d1-02"}, {"spot_id": str(PARK_ID)}).json()
    assert s["leg"] == {"kind": "estimate", "mode": "walk", "minutes": 20, "km": 1.1}
    assert s["time"] == "10:30", "the cafe's stay is 60 when visit_minutes is null: 9:00 + 60 + 20 min, up to 10:30"
    sql(dsn, "update spots set visit_minutes = 90 where id = %s", CAFE_ID)
    s = suggest(api, slug, {"after": "d1-02"}, {"spot_id": str(PARK_ID)}).json()
    assert s["time"] == "11:00", "90 min at the cafe: 9:00 + 90 + 20, up to 11:00"
    s = suggest(api, slug, {"after": "d1-03"}, {"spot_id": str(PARK_ID)}).json()
    assert s["time"] == "13:30" and s["leg"]["minutes"] == 20, "lunch has no place: 60 there, and the leg is from the cafe"


def test_the_distance_is_from_the_lodging_or_session_road(api, planned, dsn, net):  # S9
    slug, _ = planned
    pin = (16.4300, 120.6100)
    link = link_for(net, "R1", *pin)
    s = suggest(api, slug, {"after": "d1-04"}, {"link": link}).json()
    assert s["km_from_baguio"] == plan_suggest.about_km(plan_suggest.haversine_km(LODGE_PIN, pin)) == 3
    sql(dsn, "update spots set lat = null, lng = null where id = %s", LODGE_ID)
    s = suggest(api, slug, {"after": "d1-04"}, {"link": link}).json()
    assert s["km_from_baguio"] == plan_suggest.about_km(plan_suggest.haversine_km(plan_suggest.BAGUIO_CENTRE, pin)) == 2


def test_apply_after_suggest_reads_the_link_once(api, planned, net):  # T8
    slug, _ = planned
    link = link_for(net, "S1", 16.4100, 120.5960)
    s = suggest(api, slug, {"after": "d2-01"}, {"link": link}).json()
    p = add_place(api, slug, link, name=s["name"]).json()
    assert (p["lat"], p["lng"], p["maps_url"]) == (s["lat"], s["lng"], s["maps_url"])
    assert net.asked == [link], "the Apply's POST /places reads the cache"


# ---------------------------------------------------------------- N: owner round 5, links with no pin

ADDRESS = "Unit 2, Made-up Bakery, Made-up St, Baguio, 2600 Benguet"


def no_pin_link(net: Net, code: str, found: list | None = None) -> str:
    """A synthetic short link to an address with no pin; the stand-in Nominatim finds `found` for the whole address."""
    url = f"{HOST}/{code}"
    net.table[url] = redirect("https://www.google.com/maps/place/" + ADDRESS.replace(" ", "+") + "/data=!4m2!3m1!1s0x0:0x1")
    if found is not None:
        net.geo[ADDRESS] = found
    return url


def test_a_place_from_an_address(api, dsn, net):  # N14
    slug = new_trip(api)
    r = add_place(api, slug, no_pin_link(net, "U1", [{"lat": "16.4101", "lon": "120.5999"}]), name="Made-up Bakery")
    assert r.status_code == 201, r.text
    assert (r.json()["lat"], r.json()["lng"], r.json()["pin_source"]) == (16.4101, 120.5999, "address")
    assert sql(dsn, "select lat, lng from trip_places") == [{"lat": 16.4101, "lng": 120.5999}]


def test_need_pin_then_a_typed_pin(api, dsn, net):  # N15
    slug = new_trip(api)
    link = no_pin_link(net, "U2")
    r = add_place(api, slug, link, name="Made-up Bakery")
    assert (r.status_code, r.json()) == (422, {"detail": "need_pin", "name": "Made-up Bakery", "address": ADDRESS})
    net.asked.clear()
    r = add_place(api, slug, link, name="Made-up Bakery", pin="16.4138, 120.5964")
    assert r.status_code == 201, r.text
    assert (r.json()["lat"], r.json()["lng"], r.json()["pin_source"], r.json()["maps_url"]) == (16.4138, 120.5964, "typed", link)
    assert net.asked == [], "a typed pin costs no request"
    for bad in ("16.4", "0, 0", "91, 120"):
        r = add_place(api, slug, link, name="Made-up Bakery", pin=bad)
        assert (r.status_code, r.json()["detail"]) == (422, "bad_pin"), bad
    assert add_place(api, slug, link, name="Made-up Bakery", pin="1" * 61).status_code == 422, "at most 60 characters"
    assert api.post(f"/sessions/{slug}/places", json={"name": "Made-up Bakery", "pin": "16.4138, 120.5964"}).status_code == 422, \
        "a pin goes with its link"
    assert len(sql(dsn, "select id from trip_places")) == 1


def test_suggest_says_where_the_pin_came_from(api, planned, net):  # N16
    slug, _ = planned
    s = suggest(api, slug, {"after": "d1-01"}, {"spot_id": str(PARK_ID)}).json()
    assert s["pin_source"] is None, "a spot's pin is ours"
    s = suggest(api, slug, {"after": "d2-01"}, {"link": link_for(net, "V1", 16.4100, 120.5960)}).json()
    assert s["pin_source"] == "link"
    link = no_pin_link(net, "V2", [{"lat": "16.4101", "lon": "120.5999"}])
    s = suggest(api, slug, {"after": "d2-01"}, {"link": link}).json()
    assert (s["pin_source"], s["lat"], s["name"], s["address"]) == ("address", 16.4101, "Made-up Bakery", ADDRESS)
    net.geo.clear()
    maps_link.clear_cache()
    r = suggest(api, slug, {"after": "d2-01"}, {"link": link})
    assert (r.status_code, r.json()) == (422, {"detail": "need_pin", "name": "Made-up Bakery", "address": ADDRESS})
    net.asked.clear()
    r = suggest(api, slug, {"after": "d2-01"}, {"link": link, "pin": "16.4138, 120.5964"})
    assert (r.status_code, r.json()["pin_source"], r.json()["lat"], r.json()["maps_url"]) == (200, "typed", 16.4138, link)
    assert net.asked == []
    assert suggest(api, slug, {"after": "d2-01"}, {"link": link, "pin": "nope"}).json()["detail"] == "bad_pin"
    assert suggest(api, slug, {"after": "d2-01"}, {"spot_id": str(PARK_ID), "pin": "16.4, 120.5"}).status_code == 422


def test_no_pin_logs_carry_no_address_or_pin(api, planned, net, caplog):  # N17
    caplog.set_level(logging.INFO)
    slug, _ = planned
    add_place(api, slug, no_pin_link(net, "W1"), name="Made-up Bakery")
    add_place(api, slug, no_pin_link(net, "W1"), name="Made-up Bakery", pin="16.4138, 120.5964")
    add_place(api, slug, no_pin_link(net, "W1"), name="Made-up Bakery", pin="nope")
    assert f"trip place refused share_slug={slug} code=need_pin" in caplog.text
    assert f"trip place refused share_slug={slug} code=bad_pin" in caplog.text
    assert f"trip place add share_slug={slug} places=1 existing=False pin=typed" in caplog.text
    for leak in ("Made-up", "Bakery", "Unit 2", "Benguet", "16.41", "120.59", "W1", "goo.gl", "nominatim"):
        assert leak not in caplog.text, leak


# ---------------------------------------------------------------- BF13 and BF14: where does it fit? (options.md §5.5)

NS = uuid.UUID("00000000-0000-4000-8000-000000000061")  # tg61_fixture.py's: made-up ids for the plan file's natural keys
SHOP_PIN = (16.4095, 120.5985)  # made up for this test, near Session Road; never stored data
OUT_WINDOW, HOME_WINDOW = (10 * 60 + 15, 14 * 60 + 15), (16 * 60 + 15 - 30, 24 * 60)  # days 1 and 3


def fake(kind: str, key: str) -> uuid.UUID:
    return uuid.uuid5(NS, f"{kind}:{key}")


def owner_copy() -> tuple[dict, dict]:
    """The owner's plan file's guide with made-up ids, as tg61_fixture.py makes it, and its booked trips' refs."""
    raw = json.loads((ROOT / "data" / "itineraries" / "baguio-barkada-2026-11-06.json").read_text(encoding="utf-8"))["guide"]
    g = json.loads(json.dumps(raw))

    def place(p):
        if not p:
            return p
        return {"spot_id": str(fake("spot", p["spot"]))} if "spot" in p else {"terminal_id": str(fake("terminal", p["terminal"]))}

    g["lodging"] = place(g.get("lodging"))
    for d in g["days"]:
        for r in d["rows"]:
            if "place" in r:
                r["place"] = place(r["place"])
        for o in (d.get("pick") or {}).get("options", []):
            if "place" in o:
                o["place"] = place(o["place"])
    booked = {}
    for table in ("getting_there", "getting_home"):
        for b in g[table]["buses"]:
            ref = b.pop("trip")
            b["trip_id"], b["date"] = str(fake("trip", json.dumps(ref, sort_keys=True))), ref["date"]
            if b.get("booked"):
                booked[table] = (b["trip_id"], ref)
    return g, booked


def csv_pins() -> dict[str, tuple]:
    lines = [ln for ln in (ROOT / "data" / "spots.csv").read_text(encoding="utf-8").splitlines() if not ln.startswith("#")]
    return {r["slug"]: (float(r["lat"]) if r["lat"] else None, float(r["lng"]) if r["lng"] else None) for r in csv.DictReader(lines)}


@pytest.fixture()
def owner_planned(api, dsn, monkeypatch) -> tuple[str, str]:
    """A trip on a copy of the owner's plan file: made-up ids, spot names and terminals; the spots' pins from
    data/spots.csv. The clock is before the trip, so no slot is in the past. Never the owner's real trip."""
    monkeypatch.setattr(plan_suggest, "_manila_now", lambda: datetime(2026, 11, 1, 8, 0, tzinfo=MANILA_TZ))
    g, booked = owner_copy()
    pins = csv_pins()
    with psycopg.connect(dsn, autocommit=True) as conn:
        for slug, pin in (("vl-cubao", (14.6197, 121.0531)), ("vl-baguio", (16.4105, 120.5968))):
            conn.execute("insert into terminals (id, slug, name, city, lat, lng) values (%s, %s, 'Made-up Terminal', 'Made-up', %s, %s)",
                         (fake("terminal", slug), f"made-up-{slug}", *pin))
        slugs = {r["place"]["spot"] for d in json.loads((ROOT / "data" / "itineraries" / "baguio-barkada-2026-11-06.json").read_text())["guide"]["days"]
                 for r in d["rows"] if "spot" in (r.get("place") or {})}
        for i, slug in enumerate(sorted(slugs)):
            conn.execute("insert into spots (id, slug, name, lat, lng) values (%s, %s, %s, %s, %s)",
                         (fake("spot", slug), f"made-up-spot-{i}", f"Made-up Spot {i}", *pins.get(slug, (None, None))))
        op = conn.execute("select id from operators where slug = 'victory-liner'").fetchone()[0]
        for table, (trip_id, ref) in booked.items():
            route = conn.execute("""insert into routes (operator_id, origin_terminal_id, destination_terminal_id, class, travel_minutes)
                                    values (%s, %s, %s, %s, 240) returning id""",
                                 (op, fake("terminal", ref["origin"]), fake("terminal", ref["destination"]), ref["class"])).fetchone()[0]
            conn.execute("insert into trips (id, route_id, departure_time, source) values (%s, %s, %s, 'manual')", (trip_id, route, ref["departure"]))
        plan = {"outbound": {"trip_id": booked["getting_there"][0], "date": "2026-11-06"},
                "return": {"trip_id": booked["getting_home"][0], "date": "2026-11-08"}, "days": [], "guide": g}
        conn.execute("insert into itineraries (share_slug, trip_date, return_date, party, plan, model) values ('made-up-owner', '2026-11-06', '2026-11-08', '[]', %s, 'premade')",
                     (Jsonb(plan),))
    slug = new_trip(api)
    assert api.put(f"/sessions/{slug}/itinerary", json={"share_slug": "made-up-owner"}).status_code == 200
    return slug, "made-up-owner"


def no_pin_rows() -> int:
    """Rows of the owner's plan file at a spot that data/spots.csv has no pin for."""
    pins = csv_pins()
    raw = json.loads((ROOT / "data" / "itineraries" / "baguio-barkada-2026-11-06.json").read_text(encoding="utf-8"))["guide"]
    return sum(1 for d in raw["days"] for r in d["rows"] if "spot" in (r.get("place") or {}) and pins.get(r["place"]["spot"], (None,))[0] is None)


def anywhere(api, slug, place, base=("made-up-owner", 0)):
    return suggest(api, slug, {"anywhere": True}, place, base=base)


def test_bf13_anywhere_gives_up_to_three_fits_and_keeps_the_rules(api, owner_planned, net):  # BF13, B51 to B54
    slug, plan_slug = owner_planned
    shop = link_for(net, "F1", *SHOP_PIN, name="Made-up Shop")
    r = anywhere(api, slug, {"link": shop})
    assert r.status_code == 200, r.text
    s = r.json()
    assert set(s) == SUGGESTION_KEYS and 1 <= len(s["fits"]) <= 3
    assert s["pin_source"] == "link", "anywhere says where the pin came from, as the tap flow does (manager merge)"
    top = s["fits"][0]
    assert {k: s[k] for k in ("time", "leg", "ripple", "notes", "changes")} == {k: top[k] for k in ("time", "leg", "ripple", "notes", "changes")}
    assert set(top) == {"day", "after", "time", "leg", "ripple", "notes", "changes", "condition", "reason"}
    for f in s["fits"]:
        start = plan_suggest.minutes(f["time"])
        for day, (a, b) in ((1, OUT_WINDOW), (3, HOME_WINDOW)):
            assert f["day"] != day or not (start < b and start + 60 > a), f
        assert f["after"] not in ("d1-07", "d2-09", "d1-01", "d1-02", "d3-10"), f
        assert "d1-04" not in {m["key"] for m in f["ripple"]}, f
    assert len({f["day"] for f in s["fits"]}) == len(s["fits"]), "one a day while other days have room"
    for at in ({"after": "d1-05"}, {"replace": "d1-05"}, {"first_of_day": 2}):
        assert suggest(api, slug, at, {"link": shop}, base=(plan_slug, 0)).json()["fits"] is None, at
    for at in ({"after": "d1-05", "anywhere": True}, {"anywhere": False}, {"anywhere": None}):
        assert suggest(api, slug, at, {"link": shop}, base=(plan_slug, 0)).status_code == 422, at
    r = anywhere(api, slug, {"link": shop}, base=(plan_slug, 3))
    assert r.status_code == 409 and r.json() == {"detail": "plan_changed", "itinerary_slug": plan_slug, "seq": 0}


def test_bf13_the_tap_flow_never_moves_the_check_in_row(api, owner_planned, net):  # B53
    slug, _ = owner_planned
    s = suggest(api, slug, {"after": "d1-03"}, {"link": link_for(net, "F2", *SHOP_PIN)}, base=("made-up-owner", 0)).json()
    assert "d1-04" not in {m["key"] for m in s["ripple"]}
    assert "The 3:00 PM check-in can't move." in s["notes"]


def test_bf13_no_free_slot_is_an_empty_list_with_the_note(api, owner_planned, net, monkeypatch):  # B56
    slug, _ = owner_planned
    monkeypatch.setattr(plan_suggest, "_manila_now", lambda: datetime(2026, 11, 8, 15, 0, tzinfo=MANILA_TZ))
    s = anywhere(api, slug, {"link": link_for(net, "F3", *SHOP_PIN)}).json()
    assert (s["fits"], s["time"], s["leg"], s["ripple"], s["changes"]) == ([], "", None, [], [])
    assert s["notes"] == ["No free slot found. Tap a stop and use Add after."]


def test_bf14_the_fit_log_line_has_counts_only(api, owner_planned, net, caplog, dsn):  # BF14, E25
    caplog.set_level(logging.INFO, logger="tara_gala.api")
    slug, _ = owner_planned
    anywhere(api, slug, {"link": link_for(net, "F4", *SHOP_PIN, name="Made-up Shop")})
    [line] = [r.getMessage() for r in caplog.records if r.getMessage().startswith("plan suggest ")]
    assert re.fullmatch(rf"plan suggest share_slug={slug} place=link at=anywhere leg=(route|estimate|none) far=False ripple=\d+ "
                        r"fits=[1-3] candidates=\d+ excluded=\d+ best_day=[1-3] no_pin=(\d+) bus_gone=0", line), line
    assert line.endswith(f" no_pin={no_pin_rows()} bus_gone=0"), "rows ranked without a pin are counted"
    _, booked = owner_copy()
    sql(dsn, "delete from trips where id = %s", booked["getting_there"][0])
    caplog.clear()
    anywhere(api, slug, {"link": link_for(net, "F5", *SHOP_PIN)})
    assert [r.getMessage() for r in caplog.records if r.getMessage().startswith("plan suggest ")][0].endswith(" bus_gone=1"), \
        "a booked trip that's gone leaves only its bus row's minute blocked: counted"
    for leak in ("Made-up", "Shop", "F4", "F5", "goo.gl", "16.409", "120.598", "Session", "check-in", "d1-", "d2-", "d3-"):
        assert leak not in caplog.text, leak



OWNER = "Ground Floor, Neko-ya Novelty Shop, Olympian Lane Bldg, Mabini St, Baguio, 2600 Benguet"


def test_the_owners_link_prefills_a_name_that_passes_its_own_check(api, planned, dsn, net):  # F10, test-plan T10
    slug, _ = planned
    link = f"{HOST}/X1"
    net.table[link] = redirect("https://www.google.com/maps/place/" + OWNER.replace(" ", "+") + "/data=!4m2!3m1!1s0x0:0x1")
    net.geo[OWNER] = [{"lat": "16.41388", "lon": "120.59642"}]
    s = suggest(api, slug, {"after": "d2-01"}, {"link": link}).json()
    assert (s["name"], s["address"], s["pin_source"]) == ("Neko-ya Novelty Shop", OWNER, "address")
    assert s["changes"][0]["text"].startswith("Neko-ya Novelty Shop at ")
    r = add_place(api, slug, link, name=s["name"])
    assert r.status_code == 201, r.text
    assert sql(dsn, "select name, lat, lng, maps_url from trip_places") == [
        {"name": "Neko-ya Novelty Shop", "lat": 16.41388, "lng": 120.59642, "maps_url": link}]
    assert add_place(api, slug, link, name="x" * 81).status_code == 422, "a name over 80 is still refused"


def test_a_spots_suggestion_has_no_address(api, planned):  # F10
    slug, _ = planned
    assert suggest(api, slug, {"after": "d1-01"}, {"spot_id": str(PARK_ID)}).json()["address"] is None
