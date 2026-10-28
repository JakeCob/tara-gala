"""Victory Liner scraper tests. HTTP is mocked: nothing here touches the live site.

The fixtures are real responses (CUBAO to BAGUIO on 2026-11-06, BAGUIO to CUBAO on 2026-11-08) with seatLayout removed.
"""

import functools
import json
import sys
from datetime import date, datetime, time
from pathlib import Path

import httpx
import psycopg
import pytest

import victory_liner as vl
from conftest import ROOT

FIXTURES = Path(__file__).parent / "fixtures"
FIXTURE = json.loads((FIXTURES / "victory_liner_cubao_baguio_2026-11-06.json").read_text())
REVERSE = json.loads((FIXTURES / "victory_liner_baguio_cubao_2026-11-08.json").read_text())
FRIDAY = date(2026, 11, 6)
SUNDAY = date(2026, 11, 8)
NOW = datetime(2026, 11, 1, 4, 0, tzinfo=vl.MANILA)
LATER = datetime(2026, 11, 2, 4, 0, tzinfo=vl.MANILA)
TO = ["to-baguio"]
FROM = ["from-baguio"]
BOTH = ["to-baguio", "from-baguio"]
MANILA_CODES = ["CUBAO", "PASAY", "CALOOCAN", "SAMPALOC"]
MANILA_SLUGS = {"vl-cubao", "vl-pasay", "vl-caloocan", "vl-sampaloc"}


def observations(payload=FIXTURE, origin="vl-cubao", day=FRIDAY, destination="vl-baguio"):
    return vl.parse_response(payload, origin, destination, day)


def reverse_obs(payload=REVERSE, day=SUNDAY, destination="vl-cubao"):
    return vl.parse_response(payload, "vl-baguio", destination, day)


def query(dsn, sql, *args):
    with psycopg.connect(dsn) as conn:
        return conn.execute(sql, args).fetchall()


def vl_trips(dsn):
    return query(
        dsn,
        """
        select r.class::text, t.departure_time, t.days_of_week, t.is_active, t.source::text
        from trips t join routes r on r.id = t.route_id order by 1, 2
        """,
    )


# Pure tests (no database needed beyond the conftest skip)
def test_class_mapping():
    assert vl.service_class("REGULAR AIRCON") == "regular_aircon"
    assert vl.service_class("DELUXE") == "deluxe"
    assert vl.service_class("FIRST CLASS") == "first_class"
    assert vl.service_class("ROYAL CLASS") == "royal_class"
    assert {o.service_class for o in observations()} == {"regular_aircon", "deluxe", "first_class", "royal_class"}


def test_unknown_bus_type_fails_loudly():
    bad = [{**FIXTURE[0], "busType": "SUPER DELUXE"}]
    with pytest.raises(vl.ScrapeError, match="unknown busType 'SUPER DELUXE'"):
        observations(bad)


def test_unexpected_shape_fails():
    with pytest.raises(vl.ScrapeError):
        observations({"trips": []})
    with pytest.raises(vl.ScrapeError, match="fareAmount"):
        observations([{k: v for k, v in FIXTURE[0].items() if k != "fareAmount"}])


def test_fields_are_mapped():
    first = observations()[0]
    assert (first.departure, first.service_class, first.fare, first.minutes) == (time(0, 15), "royal_class", 1677.0, 240)


def test_days_of_week_from_weekdays_seen():
    # 2026-11-06 is a Friday (5), 11-07 Saturday (6), 11-08 Sunday (0, as in the schema)
    one = [FIXTURE[0]]
    obs = []
    for d in (date(2026, 11, 6), date(2026, 11, 7), date(2026, 11, 8), date(2026, 11, 13)):
        obs += observations(one, day=d)
    routes = vl.aggregate(obs)
    assert routes[("vl-cubao", "vl-baguio", "royal_class")].trips[time(0, 15)] == {5, 6, 0}


def test_route_takes_longest_running_time_and_lists_brandings():
    spec = vl.aggregate(observations())[("vl-cubao", "vl-baguio", "regular_aircon")]
    assert spec.minutes == 420  # Inner Cities 7h beats Express 6h
    assert spec.notes == "Branding: Express 6h, Inner Cities 7h"


def test_fetch_fails_on_http_error_and_waits_between_requests(monkeypatch):
    sleeps = []
    monkeypatch.setattr(vl.clock, "sleep", sleeps.append)
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200 if len(calls) < 3 else 500, json=[])

    client = httpx.Client(transport=httpx.MockTransport(handler), headers={"User-Agent": vl.USER_AGENT})
    with pytest.raises(vl.ScrapeError, match="request 3/"):
        vl.fetch_all(client, [date(2026, 11, 6), date(2026, 11, 7)], delay=2.0, log=lambda *_: None)
    assert sleeps == [2.0, 2.0]
    assert calls[0].headers["user-agent"] == vl.USER_AGENT
    assert calls[0].url.params["origin"] == "CUBAO" and calls[0].url.params["destination"] == "BAGUIO"


# Database tests
def test_dry_run_writes_nothing(dsn):
    vl.run(dsn, observations(), dry_run=True, directions=TO, verified_at=NOW)
    assert query(dsn, "select count(*) from trips") == [(0,)]
    assert query(dsn, "select count(*) from routes") == [(0,)]
    assert query(dsn, "select booking_url from operators where slug = 'victory-liner'") == [(None,)]


def test_first_run_loads_routes_and_trips(dsn):
    res = vl.run(dsn, observations(), dry_run=False, directions=TO, verified_at=NOW)
    assert (res.routes_new, res.trips_new) == (4, len({(o.service_class, o.departure) for o in observations()}))
    assert query(dsn, "select booking_url from operators where slug = 'victory-liner'") == [(vl.SOURCE_URL,)]
    rows = query(
        dsn,
        """
        select r.via, r.class::text, r.fare_php, r.travel_minutes, t.source::text, t.source_url, t.last_verified_at, t.days_of_week
        from trips t join routes r on r.id = t.route_id where r.class = 'royal_class' and t.departure_time = '00:15'
        """,
    )
    assert rows == [(None, "royal_class", 1677, 240, "scraped", vl.SOURCE_URL, NOW, [5])]


def test_existing_booking_url_is_kept(dsn):
    with psycopg.connect(dsn) as conn:
        conn.execute("update operators set booking_url = 'https://example.test/book' where slug = 'victory-liner'")
    vl.run(dsn, observations(), dry_run=False, directions=TO, verified_at=NOW)
    assert query(dsn, "select booking_url from operators where slug = 'victory-liner'") == [("https://example.test/book",)]


def test_rerun_is_idempotent(dsn):
    vl.run(dsn, observations(), dry_run=False, directions=TO, verified_at=NOW)
    before = vl_trips(dsn)
    res = vl.run(dsn, observations(), dry_run=False, directions=TO, verified_at=NOW)
    assert (res.routes_new, res.trips_new, res.trips_deactivated) == (0, 0, 0)
    assert vl_trips(dsn) == before
    assert query(dsn, "select count(*) from routes") == [(4,)]


def test_days_of_week_updates_on_rerun(dsn):
    vl.run(dsn, observations(), dry_run=False, directions=TO, verified_at=NOW)
    vl.run(dsn, observations(day=date(2026, 11, 7)) + observations(), dry_run=False, directions=TO, verified_at=NOW)
    assert {tuple(row[2]) for row in vl_trips(dsn)} == {(5, 6)}


def test_trips_that_disappear_are_deactivated_and_come_back(dsn):
    vl.run(dsn, observations(), dry_run=False, directions=TO, verified_at=NOW)
    gone = [t for t in FIXTURE if t["departureTime"] != "00:15:00"]
    res = vl.run(dsn, observations(gone), dry_run=False, directions=TO, verified_at=NOW)
    assert res.trips_deactivated == 1
    assert query(dsn, "select is_active from trips where departure_time = '00:15' and source = 'scraped'") == [(False,)]
    assert query(dsn, "select count(*) from trips where is_active") == [(len(vl_trips(dsn)) - 1,)]

    vl.run(dsn, observations(), dry_run=False, directions=TO, verified_at=NOW)
    assert query(dsn, "select count(*) from trips where not is_active") == [(0,)]


def test_manual_trips_are_never_touched(dsn):
    vl.run(dsn, observations(), dry_run=False, directions=TO, verified_at=NOW)
    manual_time = "23:59"
    clash_time = "00:15"  # same route and time as a scraped royal class trip
    with psycopg.connect(dsn) as conn:
        route_id = conn.execute("select id from routes where class = 'royal_class'").fetchone()[0]
        conn.execute("delete from trips where route_id = %s and departure_time = %s", (route_id, clash_time))
        conn.execute(
            """
            insert into trips (route_id, departure_time, days_of_week, source, source_url, last_verified_at, notes)
            values (%s, %s, '{1}', 'manual', 'https://example.test/fb', '2026-10-01', 'hand entered'),
                   (%s, %s, '{2}', 'manual', 'https://example.test/fb', '2026-10-01', 'clashes with scraped')
            """,
            (route_id, manual_time, route_id, clash_time),
        )
    snapshot = query(dsn, "select id, departure_time, days_of_week, is_active, source_url, last_verified_at, notes from trips where source = 'manual' order by 2")

    # The scraper no longer sees anything for royal class: scraped rows go, manual rows stay as they were
    res = vl.run(dsn, observations([t for t in FIXTURE if t["busType"] != "ROYAL CLASS"]), dry_run=False, directions=TO, verified_at=NOW)
    assert query(dsn, "select id, departure_time, days_of_week, is_active, source_url, last_verified_at, notes from trips where source = 'manual' order by 2") == snapshot

    # And with royal class back, the clashing time is skipped rather than duplicated
    res = vl.run(dsn, observations(), dry_run=False, directions=TO, verified_at=NOW)
    assert res.trips_skipped_manual == 1
    assert query(dsn, "select count(*) from trips where departure_time = '00:15' and route_id = %s", route_id) == [(1,)]
    assert query(dsn, "select count(*) from trips where source = 'manual'") == [(2,)]


def test_other_operators_scraped_trips_are_not_deactivated(dsn):
    with psycopg.connect(dsn) as conn:
        route_id = conn.execute(
            """
            insert into routes (operator_id, origin_terminal_id, destination_terminal_id, class)
            select o.id, a.id, b.id, 'luxury' from operators o, terminals a, terminals b
            where o.slug = 'genesis' and a.slug = 'gen-pasay' and b.slug = 'gen-baguio' returning id
            """
        ).fetchone()[0]
        conn.execute("insert into trips (route_id, departure_time, source) values (%s, '01:00', 'scraped')", (route_id,))
    vl.run(dsn, observations(), dry_run=False, directions=TO, verified_at=NOW)
    assert query(dsn, "select is_active from trips where route_id = %s", route_id) == [(True,)]


def test_empty_scrape_refuses_to_run(dsn):
    with pytest.raises(vl.ScrapeError):
        vl.run(dsn, [], dry_run=False, directions=TO)


# Both directions (TG-30): Manila terminals to Baguio, and Baguio back to each Manila terminal
def trips_on(dsn, origin):
    """Every column of the trips whose route starts at `origin`, for before/after snapshots."""
    return query(
        dsn,
        """
        select t.* from trips t join routes r on r.id = t.route_id
        join terminals a on a.id = r.origin_terminal_id where a.slug = %s order by t.id
        """,
        origin,
    )


def inactive(dsn):
    return query(
        dsn,
        """
        select a.slug, b.slug, r.class::text, t.departure_time from trips t join routes r on r.id = t.route_id
        join terminals a on a.id = r.origin_terminal_id join terminals b on b.id = r.destination_terminal_id
        where not t.is_active order by 1, 2, 3, 4
        """,
    )


def tables(dsn):
    return query(dsn, "select * from trips order by id"), query(dsn, "select * from routes order by id")


def load_both(dsn):
    return vl.run(dsn, observations() + reverse_obs(), dry_run=False, directions=BOTH, verified_at=NOW)


def test_fetch_requests_both_directions(monkeypatch):
    sleeps = []
    monkeypatch.setattr(vl.clock, "sleep", sleeps.append)
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json=[])

    client = httpx.Client(transport=httpx.MockTransport(handler), headers={"User-Agent": vl.USER_AGENT})
    days = [FRIDAY, date(2026, 11, 7)]
    assert vl.fetch_all(client, days, log=lambda *_: None) == []
    expected = [(c, "BAGUIO", d.isoformat()) for c in MANILA_CODES for d in days]
    expected += [("BAGUIO", c, d.isoformat()) for c in MANILA_CODES for d in days]
    assert [(r.url.params["origin"], r.url.params["destination"], r.url.params["date"]) for r in calls] == expected
    assert all(r.headers["user-agent"] == vl.USER_AGENT for r in calls)
    assert sleeps == [2.0] * 15


def test_fetch_one_direction_only(monkeypatch):
    monkeypatch.setattr(vl.clock, "sleep", lambda _: None)
    days = [FRIDAY, date(2026, 11, 7)]
    for direction, baguio_end, manila_end in (("from-baguio", "origin", "destination"), ("to-baguio", "destination", "origin")):
        calls = []

        def handler(request):
            calls.append(request)
            return httpx.Response(200, json=[])

        client = httpx.Client(transport=httpx.MockTransport(handler), headers={"User-Agent": vl.USER_AGENT})
        vl.fetch_all(client, days, directions=[direction], log=lambda *_: None)
        assert len(calls) == 8, direction
        assert all(r.url.params[baguio_end] == "BAGUIO" for r in calls), direction
        assert sorted((r.url.params[manila_end], r.url.params["date"]) for r in calls) == sorted(
            (c, d.isoformat()) for c in MANILA_CODES for d in days
        ), direction


def test_reverse_observations_have_baguio_origin_and_manila_destination(monkeypatch):
    monkeypatch.setattr(vl.clock, "sleep", lambda _: None)

    def handler(request):
        return httpx.Response(200, json=REVERSE if request.url.params["origin"] == "BAGUIO" else [])

    client = httpx.Client(transport=httpx.MockTransport(handler), headers={"User-Agent": vl.USER_AGENT})
    obs = vl.fetch_all(client, [SUNDAY], log=lambda *_: None)
    assert len(obs) == 4 * len(REVERSE)
    assert {o.origin for o in obs} == {"vl-baguio"}
    assert {o.destination for o in obs} == MANILA_SLUGS
    assert {vl.direction_of(o) for o in obs} == {"from-baguio"}


def test_reverse_fixture_parses():
    obs = reverse_obs()
    assert len(obs) == len(REVERSE) == 44
    assert {o.service_class for o in obs} == {"regular_aircon", "deluxe", "first_class", "royal_class"}
    first = obs[0]
    assert (first.origin, first.destination, first.departure, first.service_class, first.fare, first.minutes) == (
        "vl-baguio", "vl-cubao", time(0, 40), "deluxe", 880.0, 300,
    )
    assert {t["routeDescription"] for t in REVERSE} == {"BAGUIO_CUBAO"}
    assert not any("seatLayout" in t for t in REVERSE)
    # 23:30 on a Sunday stays a Sunday departure (0); late-night trips are not shifted to the next day
    late = [o for o in obs if o.departure >= time(23, 0)]
    assert late and {o.day for o in late} == {SUNDAY}
    assert vl.aggregate(obs)[("vl-baguio", "vl-cubao", "royal_class")].trips[time(23, 30)] == {0}


def test_reverse_routes_per_manila_terminal_are_not_merged():
    routes = vl.aggregate(reverse_obs() + reverse_obs(destination="vl-pasay") + observations())
    rev_classes = {o.service_class for o in reverse_obs()}
    out_classes = {o.service_class for o in observations()}
    assert set(routes) == (
        {("vl-baguio", "vl-cubao", c) for c in rev_classes}
        | {("vl-baguio", "vl-pasay", c) for c in rev_classes}
        | {("vl-cubao", "vl-baguio", c) for c in out_classes}
    )
    regular = sum(t["busType"] == "REGULAR AIRCON" for t in REVERSE)
    for dest in ("vl-cubao", "vl-pasay"):
        spec = routes[("vl-baguio", dest, "regular_aircon")]
        assert spec.minutes == 420  # Inner Cities 7h beats Express 6h
        assert spec.notes == "Branding: Express 6h, Inner Cities 7h"
        assert spec.fare == 762
        assert len(spec.trips) == regular
        assert routes[("vl-baguio", dest, "deluxe")].notes == "Branding: Express 5h"


def test_direction_of():
    assert {vl.direction_of(o) for o in observations()} == {"to-baguio"}
    assert {vl.direction_of(o) for o in reverse_obs()} == {"from-baguio"}
    # A leg with no Baguio end belongs to neither direction; run() rejects it
    assert vl.direction_of(observations(destination="vl-pasay")[0]) is None


def test_documented_request_count_matches_jobs():
    n = sum(len(legs) for legs in vl.DIRECTIONS.values()) * vl.DAYS
    assert n == 112
    assert f"{n} requests" in vl.__doc__
    assert f"{n} requests" in vl.USER_AGENT
    section = (ROOT / "README.md").read_text(encoding="utf-8").split("## 4.")[1].split("## 5.")[0]
    assert f"{n} requests" in section
    assert vl.DELAY_SECONDS == 2.0
    assert "2s" in section or "2 seconds" in section
    assert "--direction" in section
    assert "--direction to-baguio" in section  # the remedy when the reverse direction keeps failing


def test_reverse_request_failure_fails_whole_fetch(monkeypatch):
    monkeypatch.setattr(vl.clock, "sleep", lambda _: None)
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(500 if request.url.params["origin"] == "BAGUIO" else 200, json=[])

    client = httpx.Client(transport=httpx.MockTransport(handler), headers={"User-Agent": vl.USER_AGENT})
    fail_at = len(vl.DIRECTIONS["to-baguio"]) + 1  # outbound legs come first, one day each
    total = sum(len(legs) for legs in vl.DIRECTIONS.values())
    with pytest.raises(vl.ScrapeError, match=f"request {fail_at}/{total} ") as err:
        vl.fetch_all(client, [SUNDAY], log=lambda *_: None)
    assert "BAGUIO" in str(err.value)
    assert len(calls) == fail_at  # stops at the first failure


def test_first_run_loads_both_directions(dsn):
    res = load_both(dsn)
    out_classes = {o.service_class for o in observations()}
    rev_classes = {o.service_class for o in reverse_obs()}
    assert res.routes_new == len(out_classes) + len(rev_classes)
    assert res.trips_new == len({(o.service_class, o.departure) for o in observations()}) + len(
        {(o.service_class, o.departure) for o in reverse_obs()}
    )
    assert query(
        dsn,
        """
        select r.via, r.class::text, r.fare_php, r.travel_minutes from routes r
        join terminals a on a.id = r.origin_terminal_id join terminals b on b.id = r.destination_terminal_id
        where a.slug = 'vl-baguio' and b.slug = 'vl-cubao' order by 2
        """,
    ) == [
        (None, "deluxe", 880, 300),
        (None, "first_class", 1151, 240),
        (None, "regular_aircon", 762, 420),
        (None, "royal_class", 1677, 240),
    ]
    reverse = trips_on(dsn, "vl-baguio")
    assert len(reverse) == len(REVERSE)
    assert query(
        dsn,
        """
        select distinct t.source::text, t.source_url, t.last_verified_at, t.days_of_week, t.is_active
        from trips t join routes r on r.id = t.route_id join terminals a on a.id = r.origin_terminal_id
        where a.slug = 'vl-baguio'
        """,
    ) == [("scraped", vl.SOURCE_URL, NOW, [0], True)]
    # Outbound rows are as test_first_run_loads_routes_and_trips expects
    assert query(
        dsn,
        """
        select r.via, r.class::text, r.fare_php, r.travel_minutes, t.source::text, t.source_url, t.last_verified_at, t.days_of_week
        from trips t join routes r on r.id = t.route_id join terminals a on a.id = r.origin_terminal_id
        where a.slug = 'vl-cubao' and r.class = 'royal_class' and t.departure_time = '00:15'
        """,
    ) == [(None, "royal_class", 1677, 240, "scraped", vl.SOURCE_URL, NOW, [5])]
    # First class leaves at 08:15 in both directions: two routes, two rows
    assert query(
        dsn,
        """
        select a.slug from trips t join routes r on r.id = t.route_id join terminals a on a.id = r.origin_terminal_id
        where r.class = 'first_class' and t.departure_time = '08:15' order by 1
        """,
    ) == [("vl-baguio",), ("vl-cubao",)]


def test_rerun_both_directions_is_idempotent(dsn):
    snapshot = "select id, route_id, departure_time, days_of_week, is_active, source::text, source_url, last_verified_at from trips order by id"
    load_both(dsn)
    before = query(dsn, snapshot)
    res = load_both(dsn)
    assert (res.routes_new, res.trips_new, res.trips_deactivated) == (0, 0, 0)
    assert res.deactivated_by_direction == {"to-baguio": 0, "from-baguio": 0}
    assert query(dsn, snapshot) == before
    assert query(dsn, "select count(*) from routes") == [(8,)]


def test_dry_run_both_directions_writes_nothing(dsn):
    vl.run(dsn, observations() + reverse_obs(), dry_run=True, directions=BOTH, verified_at=NOW)
    assert query(dsn, "select count(*) from trips") == [(0,)]
    assert query(dsn, "select count(*) from routes") == [(0,)]
    assert query(dsn, "select booking_url from operators where slug = 'victory-liner'") == [(None,)]


def test_from_baguio_only_run_deactivates_only_reverse(dsn):
    load_both(dsn)
    outbound = trips_on(dsn, "vl-cubao")
    gone = [t for t in REVERSE if t["departureTime"] != "00:40:00"]
    res = vl.run(dsn, reverse_obs(gone), dry_run=False, directions=FROM, verified_at=LATER)
    assert res.trips_deactivated == 1
    assert res.deactivated_by_direction == {"from-baguio": 1}
    assert inactive(dsn) == [("vl-baguio", "vl-cubao", "deluxe", time(0, 40))]
    assert trips_on(dsn, "vl-cubao") == outbound  # untouched: still active, still verified at NOW


def test_to_baguio_only_run_leaves_reverse_active(dsn):
    load_both(dsn)
    reverse = trips_on(dsn, "vl-baguio")
    res = vl.run(dsn, observations(), dry_run=False, directions=TO, verified_at=LATER)
    assert res.trips_deactivated == 0
    assert res.deactivated_by_direction == {"to-baguio": 0}
    assert inactive(dsn) == []
    assert trips_on(dsn, "vl-baguio") == reverse


def test_both_direction_run_deactivates_missing_departure_per_direction(dsn):
    load_both(dsn)
    out_gone = [t for t in FIXTURE if t["departureTime"] != "00:15:00"]
    rev_gone = [t for t in REVERSE if t["departureTime"] != "00:40:00"]
    res = vl.run(dsn, observations(out_gone) + reverse_obs(rev_gone), dry_run=False, directions=BOTH, verified_at=LATER)
    assert res.deactivated_by_direction == {"to-baguio": 1, "from-baguio": 1}
    assert res.trips_deactivated == 2
    assert inactive(dsn) == [
        ("vl-baguio", "vl-cubao", "deluxe", time(0, 40)),
        ("vl-cubao", "vl-baguio", "royal_class", time(0, 15)),
    ]
    load_both(dsn)
    assert inactive(dsn) == []


def test_empty_reverse_direction_refuses_and_writes_nothing(dsn):
    load_both(dsn)
    before = tables(dsn)
    with pytest.raises(vl.ScrapeError, match="from-baguio"):
        vl.run(dsn, observations(), dry_run=False, directions=BOTH, verified_at=LATER)
    assert tables(dsn) == before  # outbound was not upserted either


def test_empty_forward_direction_refuses_and_writes_nothing(dsn):
    load_both(dsn)
    before = tables(dsn)
    with pytest.raises(vl.ScrapeError, match="to-baguio"):
        vl.run(dsn, reverse_obs(), dry_run=False, directions=BOTH, verified_at=LATER)
    assert tables(dsn) == before


def test_observation_outside_fetched_directions_is_rejected(dsn):
    load_both(dsn)
    before = tables(dsn)
    with pytest.raises(vl.ScrapeError):
        vl.run(dsn, observations() + reverse_obs(), dry_run=False, directions=TO, verified_at=LATER)
    assert tables(dsn) == before


def test_main_exits_nonzero_when_reverse_direction_is_empty(dsn, monkeypatch, capsys):
    # Cron only notices a refusal through the exit code. fetch_all is faked and the client cannot reach the network.
    def no_network(request):
        raise AssertionError(f"test tried the network: {request.url}")

    monkeypatch.setattr(vl.httpx, "Client", functools.partial(httpx.Client, transport=httpx.MockTransport(no_network)))
    monkeypatch.setattr(vl, "fetch_all", lambda *args, **kwargs: observations())  # outbound only, reverse empty
    monkeypatch.setattr(sys, "argv", ["victory_liner.py", "--database-url", dsn])
    assert vl.main() == 1
    err = capsys.readouterr().err
    assert "from-baguio" in err and "nothing was written" in err
    assert query(dsn, "select count(*) from trips") == [(0,)]


def test_manual_reverse_trips_are_never_touched(dsn):
    load_both(dsn)
    manual_time = "23:59"
    clash_time = "11:15"  # same route and time as a scraped Baguio to Cubao royal class trip
    with psycopg.connect(dsn) as conn:
        route_id = conn.execute(
            """
            select r.id from routes r join terminals a on a.id = r.origin_terminal_id
            join terminals b on b.id = r.destination_terminal_id
            where a.slug = 'vl-baguio' and b.slug = 'vl-cubao' and r.class = 'royal_class'
            """
        ).fetchone()[0]
        conn.execute("delete from trips where route_id = %s and departure_time = %s", (route_id, clash_time))
        conn.execute(
            """
            insert into trips (route_id, departure_time, days_of_week, source, source_url, last_verified_at, notes)
            values (%s, %s, '{1}', 'manual', 'https://example.test/fb', '2026-10-01', 'hand entered'),
                   (%s, %s, '{2}', 'manual', 'https://example.test/fb', '2026-10-01', 'clashes with scraped')
            """,
            (route_id, manual_time, route_id, clash_time),
        )
    manual = "select id, departure_time, days_of_week, is_active, source_url, last_verified_at, notes from trips where source = 'manual' order by 2"
    snapshot = query(dsn, manual)

    res = load_both(dsn)
    assert res.trips_skipped_manual == 1
    assert query(dsn, "select count(*) from trips where departure_time = %s and route_id = %s", clash_time, route_id) == [(1,)]
    assert query(dsn, manual) == snapshot

    # The scraper no longer sees royal class from Baguio: scraped rows go, manual rows stay as they were
    no_royal = [t for t in REVERSE if t["busType"] != "ROYAL CLASS"]
    vl.run(dsn, observations() + reverse_obs(no_royal), dry_run=False, directions=BOTH, verified_at=NOW)
    assert query(dsn, manual) == snapshot


def test_other_operators_reverse_scraped_trips_are_not_deactivated(dsn):
    with psycopg.connect(dsn) as conn:
        route_id = conn.execute(
            """
            insert into routes (operator_id, origin_terminal_id, destination_terminal_id, class)
            select o.id, a.id, b.id, 'luxury' from operators o, terminals a, terminals b
            where o.slug = 'genesis' and a.slug = 'gen-baguio' and b.slug = 'gen-pasay' returning id
            """
        ).fetchone()[0]
        conn.execute("insert into trips (route_id, departure_time, source) values (%s, '01:00', 'scraped')", (route_id,))
    load_both(dsn)
    assert query(dsn, "select is_active from trips where route_id = %s", route_id) == [(True,)]


def test_reverse_trips_show_in_trip_search(dsn, client):
    load_both(dsn)
    r = client.get("/trips", params={"origin_city": "Baguio", "destination_city": "Metro Manila", "date": "2026-11-08"})
    assert r.status_code == 200
    trips = r.json()
    assert trips
    for t in trips:
        assert (t["operator_slug"], t["origin_slug"], t["destination_slug"]) == ("victory-liner", "vl-baguio", "vl-cubao")
        assert t["last_verified_at"] is not None
        assert isinstance(t["fare_php"], (int, float))
        assert "Confirm with the operator" in t["confirm_note"]
