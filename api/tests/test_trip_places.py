"""TG-61 builder B's routes: POST /sessions/{slug}/places (trip-only places from a Google Maps link, B31, B48) and
S10, POST /sessions/{slug}/plan/suggest (options.md §5), on a throwaway trip with made-up spots, a made-up plan and
synthetic links. No test reaches Google: maps_link.make_client is swapped for a MockTransport.

Builder A wires these routers into main.py behind PLAN_EDITING (plan.md §6), so the tests mount them on an app of
their own, with the same request-log middleware.
"""

import logging
import uuid

import httpx
import psycopg
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from app import db, maps_link, plan_suggest, sessions, trip_places
from app.limits import RateLimiter
from app.logging_setup import RequestLogMiddleware
from test_maps_link import Net, page, redirect

TRIP = {"name": "Made-up trip", "start_date": "2026-11-06", "return_date": "2026-11-08"}
HOST = "https://maps.app.goo.gl"
CAFE_PIN, PARK_PIN, LODGE_PIN, TERMINAL_PIN = (16.4100, 120.5950), (16.4150, 120.6000), (16.4082, 120.5903), (16.4140, 120.5990)


@pytest.fixture()
def net(monkeypatch) -> Net:
    """Every link fetch goes here. Tests add answers to net.table."""
    n = Net()
    monkeypatch.setattr(maps_link, "make_client", n.client)
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


# ---------------------------------------------------------------- trip places (B31)

def test_a_place_is_pinned_from_the_link_on_the_server(api, dsn, net):  # B31
    slug = new_trip(api)
    link = link_for(net, "A1", 16.41234, 120.59321)
    net.table[f"{link}?g_st=ic"] = net.table[link]
    r = add_place(api, slug, f"Kapihan sa Ulap\n{link}?g_st=ic", name="  Kapihan sa Ulap  ")
    assert r.status_code == 201, r.text
    p = r.json()
    assert set(p) == {"id", "name", "lat", "lng", "maps_url", "created_at"}
    assert (p["name"], p["lat"], p["lng"], p["maps_url"]) == ("Kapihan sa Ulap", 16.41234, 120.59321, link)
    assert r.headers["cache-control"] == "private, no-cache"
    stored = sql(dsn, "select s.share_slug, p.name, p.lat, p.lng, p.maps_url from trip_places p join trip_sessions s on s.id = p.session_id")
    assert stored == [{"share_slug": slug, "name": "Kapihan sa Ulap", "lat": 16.41234, "lng": 120.59321, "maps_url": link}]
    assert net.asked == [f"{link}?g_st=ic"]


def test_the_phone_cannot_send_a_pin(api, dsn, net):  # B31
    slug = new_trip(api)
    link = link_for(net, "A2", 16.41234, 120.59321)
    r = add_place(api, slug, link, lat=1.0, lng=2.0)
    assert r.status_code == 422, "the body has no lat or lng: the pin only ever comes from the link"
    assert sql(dsn, "select * from trip_places") == [] and net.asked == []


def test_the_same_place_twice_is_the_same_row(api, dsn, net):  # B31
    slug = new_trip(api)
    first = add_place(api, slug, link_for(net, "B1", 16.41234, 120.59321)).json()
    again = add_place(api, slug, link_for(net, "B2", 16.41244, 120.59321), name="KAPIHAN SA ULAP")  # about 11 m away
    assert again.status_code == 200 and again.json()["id"] == first["id"]
    other_name = add_place(api, slug, link_for(net, "B3", 16.41234, 120.59321), name="Another cafe")
    far_off = add_place(api, slug, link_for(net, "B4", 16.41334, 120.59321))  # about 110 m away
    assert other_name.status_code == 201 and far_off.status_code == 201
    assert len(sql(dsn, "select id from trip_places")) == 3


def test_a_trip_holds_100_places(api, dsn, net):  # B31
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
def test_the_name_is_1_to_80_printable_letters(api, dsn, net, name):  # B31
    slug = new_trip(api)
    assert add_place(api, slug, link_for(net, "D1", 16.41234, 120.59321), name=name).status_code == 422
    assert net.asked == [] and sql(dsn, "select * from trip_places") == []


def test_link_problems_are_codes_and_store_nothing(api, dsn, net):  # B28, B30
    slug = new_trip(api)
    assert add_place(api, slug, "https://evil.io/maps/place/x").json()["detail"] == "link_not_maps"
    net.table[f"{HOST}/E1"] = redirect("https://www.google.com/maps/place/Kapihan/")
    net.table["https://www.google.com/maps/place/Kapihan/"] = page("<html></html>")
    assert add_place(api, slug, f"{HOST}/E1").json()["detail"] == "link_no_pin"
    net.table[f"{HOST}/E2"] = redirect("https://evil.io/x")
    r = add_place(api, slug, f"{HOST}/E2")
    assert (r.status_code, r.json()["detail"]) == (422, "link_unreadable")
    assert sql(dsn, "select * from trip_places") == []
    assert [httpx.URL(u).host for u in net.asked] == ["maps.app.goo.gl", "www.google.com", "maps.app.goo.gl"]


def test_an_unknown_trip_is_404_before_any_fetch(api, net):
    link = link_for(net, "F1", 16.41234, 120.59321)
    assert add_place(api, "0" * 32, link).status_code == 404
    assert add_place(api, "not-a-slug", link).status_code == 404
    assert net.asked == []


def test_places_belong_to_their_trip(api, dsn, net):  # B32, review S5
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


def test_link_fetches_share_30_an_hour_per_ip(api, net, monkeypatch):  # options.md §5.4
    monkeypatch.setattr(trip_places, "LINK_LIMITER", RateLimiter(2))
    slug = new_trip(api)
    link = link_for(net, "H1", 16.41234, 120.59321)
    assert add_place(api, slug, link).status_code == 201
    assert add_place(api, slug, link).status_code == 200
    r = api.post(f"/sessions/{slug}/places", content=b"not json", headers={"content-type": "application/json"})
    assert r.status_code == 429 and int(r.headers["retry-after"]) >= 1, "limited ahead of the body's validation"
    assert trip_places.LINK_PER_HOUR == 30 and plan_suggest.SUGGEST_PER_HOUR == 120


# ---------------------------------------------------------------- B48: codes and counts only in the logs (review M3)

def test_failures_log_codes_and_counts_only_tracebacks_included(api, dsn, net, caplog, monkeypatch):  # B48
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

    text = caplog.text + "".join(caplog.handler.format(rec) for rec in caplog.records)
    assert "trip place add share_slug=%s places=1 existing=False" % slug in text
    assert "trip place rejected share_slug=%s code=bad_place constraint=trip_places_maps_url_check" % slug in text
    for leak in ("Kapihan", "Lihim", "J1", "J2", "J3", "goo.gl", "16.41", "120.59", "Failing row"):
        assert leak not in text, leak


# ---------------------------------------------------------------- S10: the suggest route

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


SUGGESTION_KEYS = {"name", "lat", "lng", "maps_url", "km_from_baguio", "far", "time", "leg", "ripple", "notes", "changes"}


def test_after_a_stop_with_a_route_on_file(api, planned):  # S10, B21
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
    assert s["km_from_baguio"] == plan_suggest.about_km(plan_suggest.haversine_km(LODGE_PIN, PARK_PIN))
    assert r.headers["cache-control"] == "private, no-cache"


def test_replace_keeps_the_slot_and_walks_back_to_the_last_place(api, planned):  # S10, B21
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


def test_a_link_with_a_bus_in_the_way(api, planned, net):  # S10, B22, B23
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


def test_far_away_is_flagged_and_rounded(api, planned, net):  # S10, B24
    slug, _ = planned
    s = suggest(api, slug, {"after": "d1-04"}, {"link": link_for(net, "K2", 15.0, 120.6, name="Roadside stop")}).json()
    km = plan_suggest.haversine_km(LODGE_PIN, (15.0, 120.6))
    assert s["far"] is True and s["km_from_baguio"] == plan_suggest.about_km(km) == 160
    assert s["leg"] is None and s["notes"] == [plan_suggest.NO_LEG_NOTE], "past 600 minutes there's no estimate"


def test_first_of_the_day_and_a_trip_place(api, planned, net):  # S10
    slug, _ = planned
    s = suggest(api, slug, {"first_of_day": 2}, {"spot_id": str(PARK_ID)}).json()
    assert (s["time"], s["leg"], s["ripple"], s["notes"]) == ("12:45", None, [], [])
    pid = add_place(api, slug, link_for(net, "K3", 16.4110, 120.5950)).json()["id"]
    s = suggest(api, slug, {"after": "d1-02"}, {"trip_place_id": pid}).json()
    assert (s["name"], s["lat"], s["maps_url"]) == ("Kapihan sa Ulap", 16.411, f"{HOST}/K3")
    assert s["leg"]["kind"] == "estimate" and s["time"] == "10:15"


def test_refusals(api, planned, dsn, net):  # S10, B16
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


def test_a_stale_base_is_the_clash(api, planned, dsn):  # S10, B3
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


def test_suggest_logs_kinds_and_counts_only(api, planned, net, caplog):  # S10, plan.md §8
    caplog.set_level(logging.INFO, logger="tara_gala.api")
    slug, _ = planned
    suggest(api, slug, {"after": "d1-01"}, {"spot_id": str(PARK_ID)})
    suggest(api, slug, {"after": "d2-01"}, {"link": link_for(net, "M1", 16.4100, 120.5960)})
    lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("plan suggest ")]
    assert lines == [f"plan suggest share_slug={slug} place=spot at=after leg=route far=False ripple=0",
                     f"plan suggest share_slug={slug} place=link at=after leg=estimate far=False ripple=1"]
    for leak in ("Made-up", "Kapihan", "M1", "goo.gl", "16.41", "120.59", "Snack", "Coffee"):
        assert leak not in caplog.text, leak


def test_suggest_is_limited_ahead_of_its_body(api, planned, monkeypatch):  # options.md §5.4
    monkeypatch.setattr(plan_suggest, "SUGGEST_LIMITER", RateLimiter(1))
    slug, _ = planned
    assert suggest(api, slug, {"after": "d1-01"}, {"spot_id": str(PARK_ID)}).status_code == 200
    r = api.post(f"/sessions/{slug}/plan/suggest", content=b"{", headers={"content-type": "application/json"})
    assert r.status_code == 429


def test_a_link_in_suggest_counts_against_the_link_limit(api, planned, net, monkeypatch):  # options.md §5.4
    monkeypatch.setattr(trip_places, "LINK_LIMITER", RateLimiter(1))
    slug, _ = planned
    link = link_for(net, "N1", 16.4100, 120.5960)
    assert suggest(api, slug, {"after": "d2-01"}, {"link": link}).status_code == 200
    assert suggest(api, slug, {"after": "d1-01"}, {"spot_id": str(PARK_ID)}).status_code == 200, "a spot costs no fetch"
    assert suggest(api, slug, {"after": "d2-01"}, {"link": link}).status_code == 429
    assert add_place(api, slug, link).status_code == 429, "suggest and places share it"
