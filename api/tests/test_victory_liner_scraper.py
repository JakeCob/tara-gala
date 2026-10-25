"""Victory Liner scraper tests. HTTP is mocked: nothing here touches the live site.

The fixture is a real response (CUBAO to BAGUIO on 2026-11-06) with seatLayout removed.
"""

import json
from datetime import date, datetime, time
from pathlib import Path

import httpx
import psycopg
import pytest

import victory_liner as vl
from conftest import ROOT

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "victory_liner_cubao_baguio_2026-11-06.json").read_text())
FRIDAY = date(2026, 11, 6)
NOW = datetime(2026, 11, 1, 4, 0, tzinfo=vl.MANILA)


def observations(payload=FIXTURE, origin="vl-cubao", day=FRIDAY):
    return vl.parse_response(payload, origin, day)


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
    assert routes[("vl-cubao", "royal_class")].trips[time(0, 15)] == {5, 6, 0}


def test_route_takes_longest_running_time_and_lists_brandings():
    spec = vl.aggregate(observations())[("vl-cubao", "regular_aircon")]
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
    vl.run(dsn, observations(), dry_run=True, verified_at=NOW)
    assert query(dsn, "select count(*) from trips") == [(0,)]
    assert query(dsn, "select count(*) from routes") == [(0,)]
    assert query(dsn, "select booking_url from operators where slug = 'victory-liner'") == [(None,)]


def test_first_run_loads_routes_and_trips(dsn):
    res = vl.run(dsn, observations(), dry_run=False, verified_at=NOW)
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
    vl.run(dsn, observations(), dry_run=False, verified_at=NOW)
    assert query(dsn, "select booking_url from operators where slug = 'victory-liner'") == [("https://example.test/book",)]


def test_rerun_is_idempotent(dsn):
    vl.run(dsn, observations(), dry_run=False, verified_at=NOW)
    before = vl_trips(dsn)
    res = vl.run(dsn, observations(), dry_run=False, verified_at=NOW)
    assert (res.routes_new, res.trips_new, res.trips_deactivated) == (0, 0, 0)
    assert vl_trips(dsn) == before
    assert query(dsn, "select count(*) from routes") == [(4,)]


def test_days_of_week_updates_on_rerun(dsn):
    vl.run(dsn, observations(), dry_run=False, verified_at=NOW)
    vl.run(dsn, observations(day=date(2026, 11, 7)) + observations(), dry_run=False, verified_at=NOW)
    assert {tuple(row[2]) for row in vl_trips(dsn)} == {(5, 6)}


def test_trips_that_disappear_are_deactivated_and_come_back(dsn):
    vl.run(dsn, observations(), dry_run=False, verified_at=NOW)
    gone = [t for t in FIXTURE if t["departureTime"] != "00:15:00"]
    res = vl.run(dsn, observations(gone), dry_run=False, verified_at=NOW)
    assert res.trips_deactivated == 1
    assert query(dsn, "select is_active from trips where departure_time = '00:15' and source = 'scraped'") == [(False,)]
    assert query(dsn, "select count(*) from trips where is_active") == [(len(vl_trips(dsn)) - 1,)]

    vl.run(dsn, observations(), dry_run=False, verified_at=NOW)
    assert query(dsn, "select count(*) from trips where not is_active") == [(0,)]


def test_manual_trips_are_never_touched(dsn):
    vl.run(dsn, observations(), dry_run=False, verified_at=NOW)
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
    res = vl.run(dsn, observations([t for t in FIXTURE if t["busType"] != "ROYAL CLASS"]), dry_run=False, verified_at=NOW)
    assert query(dsn, "select id, departure_time, days_of_week, is_active, source_url, last_verified_at, notes from trips where source = 'manual' order by 2") == snapshot

    # And with royal class back, the clashing time is skipped rather than duplicated
    res = vl.run(dsn, observations(), dry_run=False, verified_at=NOW)
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
    vl.run(dsn, observations(), dry_run=False, verified_at=NOW)
    assert query(dsn, "select is_active from trips where route_id = %s", route_id) == [(True,)]


def test_empty_scrape_refuses_to_run(dsn):
    with pytest.raises(vl.ScrapeError):
        vl.run(dsn, [], dry_run=False)
