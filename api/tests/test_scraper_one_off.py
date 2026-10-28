"""TG-9: one-off scraped trips are saved for their own date, not as weekly trips with no end date.

Every trip below is made up for tests only: copies of a real fixture row with the departure time and trip id
changed. HTTP is never used; main() runs with fetch_all faked. The rule under test is in plan.md (revision 2):
a weekday is regular only when the departure was seen on every required date with that weekday; today is required
only for departures at least TODAY_MARGIN after the scrape; a (leg, date) with no trips at all is no evidence.
"""

import functools
import json
import os
import sys
import time as tz_clock
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

import httpx
import psycopg
import pytest

import victory_liner as vl
from conftest import ROOT

FIXTURES = Path(__file__).parent / "fixtures"
FIXTURE = json.loads((FIXTURES / "victory_liner_cubao_baguio_2026-11-06.json").read_text())
BASE = next(t for t in FIXTURE if t["busType"] == "REGULAR AIRCON")
BUS = {"regular_aircon": "REGULAR AIRCON", "deluxe": "DELUXE", "royal_class": "ROYAL CLASS"}

WINDOW = [date(2026, 10, 28) + timedelta(days=i) for i in range(14)]  # Wed Oct 28 .. Tue Nov 10
TODAY = WINDOW[0]
NOW = datetime(2026, 10, 28, 4, 0, tzinfo=vl.MANILA)
LATER = NOW + timedelta(days=1)
SAT1, SAT2 = date(2026, 10, 31), date(2026, 11, 7)
SUN1, MON1 = date(2026, 11, 1), date(2026, 11, 2)
WED2 = date(2026, 11, 4)  # window[7], today's weekday one week out
TUE1, TUE2 = date(2026, 11, 3), date(2026, 11, 10)
FRIDAYS = [d for d in WINDOW if d.weekday() == 4]
ALL_WEEK = {0, 1, 2, 3, 4, 5, 6}

TO_LEG = ("vl-cubao", "vl-baguio")
FROM_LEG = ("vl-baguio", "vl-cubao")
KEY = (*TO_LEG, "regular_aircon")
FROM_KEY = (*FROM_LEG, "regular_aircon")
TO, FROM, BOTH = ["to-baguio"], ["from-baguio"], ["to-baguio", "from-baguio"]

# Departures (Cubao -> Baguio, regular aircon unless stated)
A = "07:00"  # every day
B = "13:00"  # Sat Oct 31 only (Undas eve extra)
C = "15:00"  # every Friday plus Sat Oct 31
D = "13:30"  # Sun Nov 1 and Mon Nov 2 only (Undas)
E = "08:00"  # every day except today (required today: 4 h after the scrape)
E2 = "05:00"  # every day except today (inside the 3 h margin)
F = "09:00"  # today only
G = "14:00"  # Wed Nov 4 only (window[7]; the Q2 hole)
G2 = "05:30"  # Wed Nov 4 only, missing today, inside the margin
A_FROM = "08:00"  # Baguio -> Cubao every day
U_FROM = "20:00"  # Baguio -> Cubao Sun Nov 1 only


def t(hhmm: str) -> time:
    return time.fromisoformat(hhmm)


def row(hhmm: str, cls: str = "regular_aircon") -> dict:
    return {**BASE, "tripId": f"MADEUP-{cls}-{hhmm}", "departureTime": f"{hhmm}:00", "busType": BUS[cls]}


def seen(hhmm: str, days, cls: str = "regular_aircon", leg=TO_LEG) -> list:
    return [o for d in days for o in vl.parse_response([row(hhmm, cls)], *leg, d)]


def daily(hhmm=A, leg=TO_LEG, days=WINDOW):
    return seen(hhmm, days, leg=leg)


def agg(obs, window=WINDOW, verified_at=NOW):
    return vl.aggregate(obs, window, verified_at=verified_at)


def run(dsn, obs, *, window=WINDOW, now=NOW, directions=TO, log=None):
    return vl.run(dsn, obs, False, directions=directions, verified_at=now, window=window, log=log or (lambda *_: None))


def query(dsn, sql, *args):
    with psycopg.connect(dsn) as conn:
        return conn.execute(sql, args).fetchall()


def rows(dsn, hhmm, leg=TO_LEG, cls="regular_aircon"):
    """(id, days_of_week, valid_from, valid_to, is_active, source, source_url, last_verified_at), recurring first."""
    return query(
        dsn,
        """
        select t.id, t.days_of_week, t.valid_from, t.valid_to, t.is_active, t.source::text, t.source_url, t.last_verified_at
        from trips t join routes r on r.id = t.route_id
        join terminals o on o.id = r.origin_terminal_id join terminals d on d.id = r.destination_terminal_id
        where o.slug = %s and d.slug = %s and r.class = %s and t.departure_time = %s
        order by t.valid_from nulls first
        """,
        *leg, cls, t(hhmm),
    )


def route_id(dsn, leg=TO_LEG, cls="regular_aircon"):
    return query(
        dsn,
        """
        select r.id from routes r join terminals o on o.id = r.origin_terminal_id
        join terminals d on d.id = r.destination_terminal_id where o.slug = %s and d.slug = %s and r.class = %s
        """,
        *leg, cls,
    )[0][0]


def add_manual(dsn, rid, hhmm, days, valid_from=None, valid_to=None):
    with psycopg.connect(dsn) as conn:
        conn.execute(
            """
            insert into trips (route_id, departure_time, days_of_week, valid_from, valid_to, source, source_url,
                               last_verified_at, notes)
            values (%s, %s, %s, %s, %s, 'manual', 'https://example.test/fb', '2026-10-01', 'hand entered')
            """,
            (rid, t(hhmm), days, valid_from, valid_to),
        )


def manual_snapshot(dsn):
    return query(dsn, "select * from trips where source = 'manual' order by departure_time, valid_from nulls first")


def search(client, d, direction="to"):
    """(class, HH:MM) for every trip /trips returns on date d."""
    cities = ("Metro Manila", "Baguio") if direction == "to" else ("Baguio", "Metro Manila")
    r = client.get("/trips", params={"origin_city": cities[0], "destination_city": cities[1], "date": d.isoformat()})
    assert r.status_code == 200, r.text
    return r.json()


def keys(trips):
    return [(x["service_class"], x["departure_time"]) for x in trips]


# ---------------------------------------------------------------- T9-1: the reproduction (no window, runs on main)

def test_t9_1_one_off_saturday_extra_does_not_repeat_next_saturday(dsn, client):
    """B1. A seen every day, B seen only on Sat Oct 31. Called without window, so it runs against main too."""
    obs = daily() + seen(B, [SAT1])
    vl.run(dsn, obs, dry_run=False, directions=TO, verified_at=NOW)
    nov7 = keys(search(client, SAT2))
    assert ("regular_aircon", A) in nov7
    assert ("regular_aircon", B) not in nov7, "a one-off Oct 31 extra shows up on Sat Nov 7"
    oct31 = keys(search(client, SAT1))
    assert ("regular_aircon", A) in oct31
    assert oct31.count(("regular_aircon", B)) == 1


# ---------------------------------------------------------------- pure aggregate (window given)

def test_t9_2a_one_off_is_dated_not_weekly():
    spec = agg(daily() + seen(B, [SAT1]))[KEY]
    assert spec.trips[t(A)] == ALL_WEEK
    assert t(B) not in spec.trips
    assert spec.one_off[t(B)] == {SAT1}


def test_t9_3a_mixed_departure_has_recurring_and_dated():
    spec = agg(daily() + seen(C, [*FRIDAYS, SAT1]))[KEY]
    assert spec.trips[t(C)] == {5}
    assert spec.one_off[t(C)] == {SAT1}


def test_t9_4a_undas_pair_is_two_dated_days():
    spec = agg(daily() + seen(D, [SUN1, MON1]))[KEY]
    assert t(D) not in spec.trips
    assert spec.one_off[t(D)] == {SUN1, MON1}


def test_t9_5a_today_is_required_only_outside_the_margin():
    """B5 [r2]: E (08:00, 4 h after the 04:00 scrape) missing today loses Wednesday; E2 (05:00) doesn't."""
    not_today = WINDOW[1:]
    spec = agg(daily() + seen(E, not_today) + seen(E2, not_today) + seen(F, [TODAY]))[KEY]
    assert spec.trips[t(E)] == ALL_WEEK - {3}
    assert spec.one_off[t(E)] == {WED2}
    assert spec.trips[t(E2)] == ALL_WEEK
    assert t(E2) not in spec.one_off
    assert spec.one_off[t(F)] == {TODAY}
    assert t(F) not in spec.trips


def test_t9_5b_seen_today_and_next_week_is_regular_once():
    spec = agg(daily() + seen("10:00", [TODAY, WED2]))[KEY]
    assert spec.trips[t("10:00")] == {3}
    assert t("10:00") not in spec.one_off


def test_t9_q2_window7_only_is_dated_when_today_is_required():
    """Q2 / B17: G at 14:00, seen only on Wed Nov 4, is a one-off (today is required for 14:00 and it wasn't seen)."""
    spec = agg(daily() + seen(G, [WED2]))[KEY]
    assert t(G) not in spec.trips
    assert spec.one_off[t(G)] == {WED2}


def test_t9_q2b_early_departure_missing_today_stays_regular():
    """G2 at 05:30 is within 3 h of the 04:00 scrape: today isn't required, so Nov 4 alone makes Wednesday regular."""
    spec = agg(daily() + seen(G2, [WED2]))[KEY]
    assert spec.trips[t(G2)] == {3}
    assert t(G2) not in spec.one_off


def test_today_margin_is_three_hours():
    assert vl.TODAY_MARGIN == timedelta(hours=3)


def test_margin_boundary_is_inclusive():
    """Exactly TODAY_MARGIN after the scrape counts as required (plan: >=)."""
    at_margin = (NOW + vl.TODAY_MARGIN).strftime("%H:%M")  # 07:00
    spec = agg(daily("06:00") + seen(at_margin, [WED2]))[KEY]
    assert t(at_margin) not in spec.trips
    assert spec.one_off[t(at_margin)] == {WED2}


def test_t9_b17_saturday_run_and_a_next_saturday_extra():
    """B17: a Sat Nov 7 04:00 run; a 14:00 extra seen only on Sat Nov 14 never becomes weekly."""
    window = [SAT2 + timedelta(days=i) for i in range(14)]
    now = datetime(2026, 11, 7, 4, 0, tzinfo=vl.MANILA)
    spec = agg(daily(days=window) + seen("14:00", [date(2026, 11, 14)]), window, now)[KEY]
    assert t("14:00") not in spec.trips
    assert spec.one_off[t("14:00")] == {date(2026, 11, 14)}


def test_no_weekday_from_a_single_exempt_sighting():
    """An early departure seen only today, with today's weekday otherwise empty for the leg, has no required date
    for Wednesday: it is a one-off, never 'weekly from one sighting'."""
    days_without_wed2 = [d for d in WINDOW if d != WED2]
    spec = agg(daily(days=days_without_wed2) + seen("05:15", [TODAY]))[KEY]
    assert t("05:15") not in spec.trips
    assert spec.one_off[t("05:15")] == {TODAY}


def test_t9_e1_empty_leg_date_is_no_evidence():
    """B18: Cubao->Baguio returns nothing on Tue Nov 10; A stays regular on all 7 weekdays."""
    spec = agg(daily(days=[d for d in WINDOW if d != TUE2]))[KEY]
    assert spec.trips[t(A)] == ALL_WEEK
    assert t(A) not in spec.one_off


def test_t9_e2_weekday_judged_on_the_dates_the_leg_returned():
    obs = daily(days=[d for d in WINDOW if d != TUE2]) + seen("10:00", [TUE1])
    spec = agg(obs)[KEY]
    assert spec.trips[t("10:00")] == {2}
    assert t("10:00") not in spec.one_off


def test_empty_leg_on_one_side_does_not_affect_the_other_leg():
    """Per-leg evidence: the reverse leg being empty on Nov 10 doesn't excuse a missing Nov 10 on the forward leg."""
    obs = daily() + seen("10:00", [TUE1]) + daily(A_FROM, FROM_LEG, [d for d in WINDOW if d != TUE2])
    spec = agg(obs)[KEY]
    assert t("10:00") not in spec.trips
    assert spec.one_off[t("10:00")] == {TUE1}


def test_empty_leg_dates_lists_only_gaps_on_legs_with_data():
    legs = vl.DIRECTIONS["to-baguio"]
    obs = daily(days=[d for d in WINDOW if d != TUE2])
    cubao = next(leg for leg in legs if leg.origin == "vl-cubao")
    assert vl.empty_leg_dates(obs, legs, WINDOW) == [(cubao, TUE2)]  # Pasay, Caloocan, Sampaloc: empty all window
    assert vl.empty_leg_dates(daily(), legs, WINDOW) == []


def test_t9_x1_no_date_is_both_recurring_and_dated():
    obs = (daily() + seen(B, [SAT1]) + seen(C, [*FRIDAYS, SAT1]) + seen(D, [SUN1, MON1]) + seen(E, WINDOW[1:])
           + seen(E2, WINDOW[1:]) + seen(F, [TODAY]) + seen(G, [WED2]) + seen(G2, [WED2]))
    for spec in agg(obs).values():
        for dep, days in spec.one_off.items():
            for d in days:
                assert (d.weekday() + 1) % 7 not in spec.trips.get(dep, set()), (dep, d)


def test_t9_x2_departures_is_the_union():
    spec = agg(daily() + seen(B, [SAT1]) + seen(C, [*FRIDAYS, SAT1]))[KEY]
    assert spec.departures() == spec.trips.keys() | spec.one_off.keys() == {t(A), t(B), t(C)}


def test_t9_12a_default_window_keeps_existing_results():
    """No window: every observed date is required, per leg, and nothing is dated for the existing fixtures."""
    one = [FIXTURE[0]]
    obs = []
    for d in (date(2026, 11, 6), date(2026, 11, 7), date(2026, 11, 8), date(2026, 11, 13)):
        obs += vl.parse_response(one, *TO_LEG, d)
    spec = vl.aggregate(obs)[(*TO_LEG, "royal_class")]
    assert spec.trips[time(0, 15)] == {5, 6, 0}
    assert spec.one_off == {}
    friday = vl.aggregate(vl.parse_response(FIXTURE, *TO_LEG, date(2026, 11, 6)))
    for s in friday.values():
        assert set(map(frozenset, s.trips.values())) == {frozenset({5})}
        assert s.one_off == {}


def test_t9_13_observation_outside_window_raises():
    with pytest.raises(vl.ScrapeError, match=r"2026-11-11.*outside the scrape window 2026-10-28\.\.2026-11-10"):
        agg(daily() + seen(B, [date(2026, 11, 11)]))


def test_t9_13b_run_with_outside_observation_writes_nothing(dsn):
    with pytest.raises(vl.ScrapeError, match="outside the scrape window"):
        run(dsn, daily() + seen(B, [date(2026, 11, 11)]))
    assert query(dsn, "select count(*) from trips") == [(0,)]
    assert query(dsn, "select count(*) from routes") == [(0,)]


def test_t9_b15_window_without_verified_at_is_an_error():
    with pytest.raises(TypeError, match="verified_at"):
        vl.aggregate(daily(), WINDOW)


# ---------------------------------------------------------------- DB rows (window given)

def test_t9_2_dated_row_for_the_one_off(dsn):
    run(dsn, daily() + seen(B, [SAT1]))
    [(_, days, vf, vt, active, source, url, verified)] = rows(dsn, B)
    assert (days, vf, vt, active, source) == ([6], SAT1, SAT1, True, "scraped")
    assert url == vl.SOURCE_URL
    assert verified == NOW


def test_t9_3_mixed_rows_and_search(dsn, client):
    run(dsn, daily() + seen(C, [*FRIDAYS, SAT1]))
    recurring, dated = rows(dsn, C)
    assert (recurring[1], recurring[2], recurring[3], recurring[4]) == ([5], None, None, True)
    assert (dated[1], dated[2], dated[3], dated[4]) == ([6], SAT1, SAT1, True)
    assert keys(search(client, date(2026, 11, 6))).count(("regular_aircon", C)) == 1
    assert keys(search(client, SAT1)).count(("regular_aircon", C)) == 1
    assert ("regular_aircon", C) not in keys(search(client, SAT2))


def test_t9_4_undas_rows_and_search(dsn, client):
    run(dsn, daily() + seen(D, [SUN1, MON1]))
    sun, mon = rows(dsn, D)
    assert (sun[1], sun[2], sun[3]) == ([0], SUN1, SUN1)  # T9-X3: Sunday is 0
    assert (mon[1], mon[2], mon[3]) == ([1], MON1, MON1)
    assert keys(search(client, SUN1)).count(("regular_aircon", D)) == 1
    assert keys(search(client, MON1)).count(("regular_aircon", D)) == 1
    for d in (date(2026, 11, 8), date(2026, 11, 9)):
        assert ("regular_aircon", D) not in keys(search(client, d))


def test_t9_5_today_rule_rows(dsn):
    not_today = WINDOW[1:]
    run(dsn, daily() + seen(E, not_today) + seen(E2, not_today) + seen(F, [TODAY]))
    e_rec, e_wed = rows(dsn, E)
    assert (sorted(e_rec[1]), e_rec[2]) == (sorted(ALL_WEEK - {3}), None)
    assert (e_wed[1], e_wed[2], e_wed[3]) == ([3], WED2, WED2)
    [(_, days, vf, vt, *_)] = rows(dsn, E2)
    assert (sorted(days), vf, vt) == (sorted(ALL_WEEK), None, None)
    [(_, days, vf, vt, *_)] = rows(dsn, F)
    assert (days, vf, vt) == ([3], TODAY, TODAY)


def test_t9_6_old_weekly_row_is_replaced(dsn, client):
    run(dsn, daily())
    with psycopg.connect(dsn) as conn:  # what main writes today: B weekly on Saturdays, no dates
        conn.execute(
            "insert into trips (route_id, departure_time, days_of_week, source, source_url, last_verified_at) "
            "values (%s, %s, '{6}', 'scraped', %s, %s)",
            (route_id(dsn), t(B), vl.SOURCE_URL, NOW - timedelta(days=1)),
        )
    res = run(dsn, daily() + seen(B, [SAT1]))
    old, dated = rows(dsn, B)
    assert (old[2], old[4]) == (None, False)
    assert (dated[2], dated[3], dated[4]) == (SAT1, SAT1, True)
    assert res.deactivated_by_direction["to-baguio"] == 1
    assert ("regular_aircon", B) not in keys(search(client, SAT2))


def test_t9_7_rerun_is_idempotent(dsn):
    obs = daily() + seen(B, [SAT1]) + seen(C, [*FRIDAYS, SAT1]) + seen(D, [SUN1, MON1])
    run(dsn, obs)
    cols = "id, route_id, departure_time, days_of_week, valid_from, valid_to, is_active, source, source_url"
    before = query(dsn, f"select {cols} from trips order by id")
    res = run(dsn, obs, now=LATER)
    assert res.trips_new == 0
    assert res.trips_deactivated == 0
    assert res.trips_updated == len(before)
    assert query(dsn, f"select {cols} from trips order by id") == before
    assert query(dsn, "select distinct last_verified_at from trips") == [(LATER,)]


def test_t9_8_dated_rows_age_out_in_their_own_direction(dsn):
    run(dsn, daily() + seen(B, [SAT1]) + daily(A_FROM, FROM_LEG) + seen(U_FROM, [SUN1], leg=FROM_LEG), directions=BOTH)
    shifted = [d + timedelta(days=4) for d in WINDOW]  # Nov 1 .. Nov 14: Oct 31 has passed
    res = run(dsn, daily(days=shifted), window=shifted, now=datetime(2026, 11, 1, 4, 0, tzinfo=vl.MANILA))
    [(_, _, vf, _, active, *_)] = rows(dsn, B)
    assert (vf, active) == (SAT1, False)
    assert res.deactivated_by_direction == {"to-baguio": 1}
    [(_, _, vf, _, active, *_)] = rows(dsn, U_FROM, FROM_LEG)
    assert (vf, active) == (SUN1, True), "a to-Baguio run must not touch from-Baguio dated rows"


def test_t9_9_one_off_becomes_regular_without_double_booking(dsn, client):
    run(dsn, daily() + seen(B, [SAT1]))
    run(dsn, daily() + seen(B, [SAT1, SAT2]))
    recurring, dated = rows(dsn, B)
    assert (recurring[1], recurring[2], recurring[4]) == ([6], None, True)
    assert (dated[2], dated[4]) == (SAT1, False)
    for d in (SAT1, SAT2):
        assert keys(search(client, d)).count(("regular_aircon", B)) == 1


def test_t9_9b_regular_becomes_one_off(dsn):
    run(dsn, daily() + seen(B, [SAT1, SAT2]))
    run(dsn, daily() + seen(B, [SAT1]))
    recurring, dated = rows(dsn, B)
    assert (recurring[2], recurring[4]) == (None, False)
    assert (dated[2], dated[4]) == (SAT1, True)


def test_t9_14_one_off_log_lines_and_count(dsn):
    lines = []
    res = run(dsn, daily() + seen(B, [SAT1]) + seen(C, [*FRIDAYS, SAT1]) + seen(D, [SUN1, MON1]), log=lines.append)
    assert sorted(line for line in lines if "one-off:" in line) == sorted([
        "  one-off: vl-cubao->vl-baguio regular_aircon 13:00 on 2026-10-31 (Sat)",
        "  one-off: vl-cubao->vl-baguio regular_aircon 15:00 on 2026-10-31 (Sat)",
        "  one-off: vl-cubao->vl-baguio regular_aircon 13:30 on 2026-11-01 (Sun)",
        "  one-off: vl-cubao->vl-baguio regular_aircon 13:30 on 2026-11-02 (Mon)",
    ])
    assert res.trips_one_off == 4
    assert not any("http" in line or "postgres" in line for line in lines)


def test_t9_14b_summary_counts_dated_only_departures(capsys):
    obs = daily() + seen(B, [SAT1]) + seen(D, [SUN1, MON1])
    vl.print_summary(obs, agg(obs), TO)
    out = capsys.readouterr().out
    assert "-> 1 routes, 3 distinct departures" in out


def test_t9_r1_rule_is_written_down():
    section = (ROOT / "README.md").read_text(encoding="utf-8").split("## 4.")[1].split("## 5.")[0]
    assert "**One-off trips.**" in section
    for words in ("every* time in the 14-day window", "3 hours", "valid_from = valid_to", "Sat Oct 31", "Sat Nov 7", "WARNING"):
        assert words in section, words
    doc = (vl.aggregate.__doc__ or "").lower()
    for words in ("every", "today", "one-off", "valid_from = valid_to"):
        assert words in doc, words
    assert "departures()" in (vl.RouteSpec.__doc__ or "")


# ---------------------------------------------------------------- the unique constraint and matching

def test_t9_u1_recurring_and_dated_rows_coexist(dsn):
    run(dsn, daily() + seen(C, [*FRIDAYS, SAT1]))
    assert [(r[2], r[4]) for r in rows(dsn, C)] == [(None, True), (SAT1, True)]


def test_t9_u2_inactive_dated_row_is_reused_even_when_months_old(dsn):
    run(dsn, daily() + seen(B, [SAT1]))
    [(row_id, *_)] = rows(dsn, B)
    run(dsn, daily())
    with psycopg.connect(dsn) as conn:
        conn.execute("update trips set updated_at = '2026-03-01', last_verified_at = '2026-03-01' where id = %s", (row_id,))
    assert rows(dsn, B)[0][4] is False
    res = run(dsn, daily() + seen(B, [SAT1]))
    [(again, _, vf, _, active, *_)] = rows(dsn, B)
    assert (again, vf, active) == (row_id, SAT1, True)
    assert res.trips_new == 0


def test_t9_u3_manual_dated_row_skips_the_departure(dsn):
    run(dsn, daily())
    add_manual(dsn, route_id(dsn), B, [6], SAT1, SAT1)
    before = manual_snapshot(dsn)
    res = run(dsn, daily() + seen(B, [SAT1, SAT2]))
    assert res.trips_skipped_manual == 1
    assert manual_snapshot(dsn) == before
    assert [r[5] for r in rows(dsn, B)] == ["manual"]


def test_t9_u4_manual_recurring_row_skips_dated_rows(dsn):
    run(dsn, daily())
    add_manual(dsn, route_id(dsn), B, [6])
    res = run(dsn, daily() + seen(B, [SAT1]))
    assert res.trips_skipped_manual == 1
    assert [r[5] for r in rows(dsn, B)] == ["manual"]


def test_t9_u5_existing_null_row_from_main_is_updated_in_place(dsn):
    run(dsn, daily())
    [(row_id, *_)] = rows(dsn, A)
    with psycopg.connect(dsn) as conn:
        conn.execute("update trips set days_of_week = '{1}' where id = %s", (row_id,))
    res = run(dsn, daily())
    [(again, days, vf, vt, active, *_)] = rows(dsn, A)
    assert (again, sorted(days), vf, vt, active) == (row_id, sorted(ALL_WEEK), None, None, True)
    assert res.trips_new == 0


def test_t9_u6_same_date_and_time_on_two_classes(dsn):
    run(dsn, daily() + seen(B, [SAT1]) + seen(B, [SAT1], cls="deluxe"))
    assert [(r[2], r[4]) for r in rows(dsn, B)] == [(SAT1, True)]
    assert [(r[2], r[4]) for r in rows(dsn, B, cls="deluxe")] == [(SAT1, True)]


# ---------------------------------------------------------------- manual rows win (B10)

def test_t9_10a_manual_row_is_byte_for_byte_unchanged(dsn):
    run(dsn, daily())
    add_manual(dsn, route_id(dsn), B, [6])
    before = manual_snapshot(dsn)
    res = run(dsn, daily() + seen(B, [SAT1]))
    assert manual_snapshot(dsn) == before
    assert res.trips_skipped_manual == 1
    assert [r[5] for r in rows(dsn, B)] == ["manual"]


def test_t9_10b_manual_skip_counts_once_per_departure(dsn):
    run(dsn, daily())
    add_manual(dsn, route_id(dsn), C, [5])
    res = run(dsn, daily() + seen(C, [*FRIDAYS, SAT1]))
    assert res.trips_skipped_manual == 1
    assert res.trips_one_off == 0
    assert [r[5] for r in rows(dsn, C)] == ["manual"]


def test_t9_10c_hand_entered_undas_extra_wins_whole_departure(dsn, client):
    run(dsn, daily())
    add_manual(dsn, route_id(dsn), D, [0], SUN1, SUN1)
    before = manual_snapshot(dsn)
    run(dsn, daily() + seen(D, [SUN1, MON1]))
    assert manual_snapshot(dsn) == before
    sun = [x for x in search(client, SUN1) if x["departure_time"] == D]
    assert [x["source"] for x in sun] == ["manual"]
    assert ("regular_aircon", D) not in keys(search(client, MON1))


def test_t9_10d_scraped_dated_rows_go_when_a_manual_row_arrives(dsn, client):
    run(dsn, daily() + seen(B, [SAT1]))
    add_manual(dsn, route_id(dsn), B, [6])  # hand-entered weekly Saturday row for the same departure
    before = manual_snapshot(dsn)
    res = run(dsn, daily() + seen(B, [SAT1]))
    assert manual_snapshot(dsn) == before
    assert res.trips_skipped_manual == 1
    scraped = [r for r in rows(dsn, B) if r[5] == "scraped"]
    assert [(r[2], r[4]) for r in scraped] == [(SAT1, False)], "our dated row is no longer seen, so it goes"
    assert [x["source"] for x in search(client, SAT1) if x["departure_time"] == B] == ["manual"]


# ---------------------------------------------------------------- per-direction deactivation (TG-30 rule)

def both_sides(b=True, u=True):
    return (daily() + (seen(B, [SAT1]) if b else []) + daily(A_FROM, FROM_LEG)
            + (seen(U_FROM, [SUN1], leg=FROM_LEG) if u else []))


def to_side_state(dsn):
    return query(dsn, """
        select t.id, t.days_of_week, t.valid_from, t.valid_to, t.is_active from trips t join routes r on r.id = t.route_id
        join terminals d on d.id = r.destination_terminal_id where d.slug = 'vl-baguio' order by t.id""")


def test_t9_11a_from_run_leaves_to_baguio_dated_rows(dsn):
    run(dsn, both_sides(), directions=BOTH)
    before = to_side_state(dsn)
    res = run(dsn, daily(A_FROM, FROM_LEG), directions=FROM)
    assert rows(dsn, U_FROM, FROM_LEG)[0][4] is False
    assert to_side_state(dsn) == before
    assert res.deactivated_by_direction == {"from-baguio": 1}


def test_t9_11b_to_run_leaves_from_baguio_dated_rows(dsn):
    run(dsn, both_sides(), directions=BOTH)
    res = run(dsn, daily(), directions=TO)
    assert rows(dsn, B)[0][4] is False
    assert rows(dsn, U_FROM, FROM_LEG)[0][4] is True
    assert rows(dsn, A_FROM, FROM_LEG)[0][4] is True
    assert res.deactivated_by_direction == {"to-baguio": 1}


def test_t9_11c_both_run_counts_each_direction(dsn):
    run(dsn, both_sides(), directions=BOTH)
    res = run(dsn, both_sides(b=False, u=False), directions=BOTH)
    assert res.deactivated_by_direction == {"to-baguio": 1, "from-baguio": 1}


def test_t9_11d_direction_whose_departures_all_clash_with_manual_rows(dsn):
    """TG-30 tech debt: the run doesn't refuse; U' and the scraped A' go (manual wins); to-Baguio is unaffected."""
    run(dsn, both_sides(), directions=BOTH)
    add_manual(dsn, route_id(dsn, FROM_LEG), A_FROM, sorted(ALL_WEEK))
    before_manual, before_to = manual_snapshot(dsn), to_side_state(dsn)
    res = run(dsn, both_sides(u=False), directions=BOTH)
    assert rows(dsn, U_FROM, FROM_LEG)[0][4] is False
    assert manual_snapshot(dsn) == before_manual
    assert to_side_state(dsn) == before_to
    assert res.deactivated_by_direction["to-baguio"] == 0
    assert res.trips_skipped_manual == 1


# ---------------------------------------------------------------- main(): the clock seam (B16) and output

def run_main(monkeypatch, capsys, dsn, obs, *args):
    """victory_liner.main() with fetch_all faked and no network. Returns (rc, stdout, stderr, fetched days)."""
    calls = []

    def no_network(request):
        raise AssertionError(f"test tried the network: {request.url}")

    def fake_fetch(client, days, directions=tuple(vl.DIRECTIONS), *a, **k):
        calls.append(list(days))
        return list(obs)

    monkeypatch.setattr(vl.httpx, "Client", functools.partial(httpx.Client, transport=httpx.MockTransport(no_network)))
    monkeypatch.setattr(vl, "fetch_all", fake_fetch)
    monkeypatch.setattr(sys, "argv", ["victory_liner.py", *args])
    monkeypatch.setenv("DATABASE_URL", dsn)
    rc = vl.main()
    out = capsys.readouterr()
    return rc, out.out, out.err, calls[0] if calls else None


FROZEN = [date(2026, 11, 1) + timedelta(days=i) for i in range(14)]  # the conftest seam: Nov 1, 04:00 Manila


def test_t9_d1_main_takes_today_from_the_seam(dsn, monkeypatch, capsys):
    obs = daily(days=FROZEN) + seen(B, [SAT2]) + daily(A_FROM, FROM_LEG, FROZEN)
    rc, out, err, days = run_main(monkeypatch, capsys, dsn, obs)
    assert rc == 0, err
    assert "(2026-11-01 to 2026-11-14)" in out
    assert days == FROZEN
    assert "  one-off: vl-cubao->vl-baguio regular_aircon 13:00 on 2026-11-07 (Sat)" in out
    assert ", 1 one-off" in out
    assert {r[7] for r in rows(dsn, A)} == {datetime(2026, 11, 1, 4, 0, tzinfo=vl.MANILA)}, "verified_at comes from the seam"


def test_t9_d2_manila_now_is_the_manila_date_in_any_device_tz(dsn, monkeypatch, capsys):
    monkeypatch.undo()  # drop the conftest freeze: this test checks the real manila_now()

    class FrozenUTC(datetime):
        @classmethod
        def now(cls, tz=None):
            utc = datetime(2026, 10, 30, 17, 30, tzinfo=timezone.utc)  # Oct 31 01:30 in Manila
            return utc.astimezone(tz) if tz else utc.astimezone().replace(tzinfo=None)

    old_tz = os.environ.get("TZ")
    os.environ["TZ"] = "America/Los_Angeles"
    tz_clock.tzset()
    try:
        monkeypatch.setattr(vl, "datetime", FrozenUTC)
        now = vl.manila_now()
        assert now.utcoffset() == timedelta(hours=8)
        assert (now.date(), now.hour, now.minute) == (date(2026, 10, 31), 1, 30)
        window = [date(2026, 10, 31) + timedelta(days=i) for i in range(14)]
        rc, out, err, days = run_main(monkeypatch, capsys, dsn, daily(days=window) + daily(A_FROM, FROM_LEG, window))
        assert rc == 0, err
        assert days[0] == date(2026, 10, 31)
    finally:
        if old_tz is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = old_tz
        tz_clock.tzset()


def test_t9_d3_main_refuses_observations_outside_its_window(dsn, monkeypatch, capsys):
    obs = daily(days=FROZEN) + seen(B, [date(2026, 10, 31)]) + daily(A_FROM, FROM_LEG, FROZEN)
    rc, out, err, _ = run_main(monkeypatch, capsys, dsn, obs)
    assert rc == 1
    assert "outside the scrape window" in err and "nothing was written" in err
    assert query(dsn, "select count(*) from trips") == [(0,)]


def test_t9_e3_one_warning_per_empty_leg_date_on_stdout(dsn, monkeypatch, capsys):
    """B18 + re-review R2: per-date WARNINGs go to stdout; stderr is unchanged (empty)."""
    gap = date(2026, 11, 10)
    obs = daily(days=[d for d in FROZEN if d != gap]) + daily(A_FROM, FROM_LEG, FROZEN)
    rc, out, err, _ = run_main(monkeypatch, capsys, dsn, obs)
    assert rc == 0, err
    per_date = [line.strip() for line in out.splitlines() if "WARNING: no trips at all for" in line and " on 20" in line]
    assert per_date == ["WARNING: no trips at all for CUBAO->BAGUIO on 2026-11-10"]
    whole = [line for line in out.splitlines() if "in the whole window" in line]
    assert len(whole) == 6, "the 6 empty legs keep one whole-window line each, not 14"
    assert err == ""


# ---------------------------------------------------------------- nothing wrong or stale on Nov 6 to 8 (T9-S1, S2)

def every_day(d):
    return True


TRUTH = {  # (leg, class, HH:MM) -> runs on date d? Made up for tests only.
    (TO_LEG, "regular_aircon", "07:00"): every_day,
    (TO_LEG, "royal_class", "00:15"): every_day,
    (TO_LEG, "regular_aircon", "05:30"): every_day,  # early regular bus, inside the margin of a 04:00 run
    (TO_LEG, "regular_aircon", "18:00"): lambda d: d.weekday() == 4,
    (TO_LEG, "regular_aircon", "15:00"): lambda d: d.weekday() == 4 or d == SAT1,
    (TO_LEG, "regular_aircon", "16:00"): lambda d: d != SAT2,  # cancelled on Sat Nov 7
    (TO_LEG, "regular_aircon", "13:00"): lambda d: d in (SAT1, SUN1, MON1),  # Undas extras U1, U2, U3
    (TO_LEG, "regular_aircon", "14:00"): lambda d: d == date(2026, 11, 14),  # K: the Q2 case for the Nov 7 run
    (TO_LEG, "regular_aircon", "14:30"): lambda d: d == date(2026, 11, 13),  # H: the Q2 case for the Nov 6 run
    (FROM_LEG, "regular_aircon", "08:00"): every_day,
    (FROM_LEG, "regular_aircon", "20:00"): lambda d: d == SUN1,  # U'
}
ONE_OFFS = {k for k in TRUTH if k[2] in ("13:00", "14:00", "14:30", "20:00")}


def truth_obs(run_day, cutoff):
    window = [run_day + timedelta(days=i) for i in range(14)]
    obs = []
    for d in window:
        for (leg, cls, hhmm), runs in TRUTH.items():
            if runs(d) and not (d == run_day and t(hhmm) < cutoff):  # today's early buses may already be gone
                obs += seen(hhmm, [d], cls, leg)
    return window, obs


def truth_on(d, leg):
    return {(cls, hhmm) for (lg, cls, hhmm), runs in TRUTH.items() if lg == leg and runs(d)}


@pytest.mark.parametrize("cutoff", [time(4, 0), time(7, 0)], ids=["missing-before-04", "missing-before-07"])
def test_t9_s1_rolling_runs_never_show_wrong_or_stale_trips(dsn, client, cutoff):
    trip_days = [date(2026, 11, 6), SAT2, date(2026, 11, 8)]
    nov7_by_run = {}
    run_day = date(2026, 10, 26)
    while run_day <= date(2026, 11, 8):
        verified = datetime.combine(run_day, time(4, 0), vl.MANILA)
        window, obs = truth_obs(run_day, cutoff)
        run(dsn, obs, window=window, now=verified, directions=BOTH)
        for d in [x for x in trip_days if x >= run_day]:
            for direction, leg in (("to", TO_LEG), ("from", FROM_LEG)):
                got = search(client, d, direction)
                got_keys = keys(got)
                assert len(got_keys) == len(set(got_keys)), f"run {run_day}: a trip shows twice on {d}"
                expected = truth_on(d, leg)
                maybe = {k for k in expected if d == run_day and t(k[1]) < cutoff}
                assert set(got_keys) - expected == set(), f"run {run_day}: wrong trips on {d}"
                assert expected - set(got_keys) <= maybe, f"run {run_day}: missing trips on {d}"
                for x in got:
                    assert datetime.fromisoformat(x["last_verified_at"]) == verified, f"run {run_day}: stale trip on {d}"
                    assert x["fare_php"] is not None and "Confirm with the operator" in x["confirm_note"]
            if d == SAT2 and run_day <= date(2026, 11, 6):
                nov7_by_run[run_day] = sorted(keys(search(client, SAT2)))
        assert query(dsn, "select count(*) from trips where source = 'scraped' and is_active and valid_to < %s", run_day) == [(0,)]
        for i in range(21):  # a one-off never shows on another date, inside or beyond the window
            d = run_day + timedelta(days=i)
            for direction, leg in (("to", TO_LEG), ("from", FROM_LEG)):
                for cls, hhmm in keys(search(client, d, direction)):
                    if (leg, cls, hhmm) in ONE_OFFS:
                        assert TRUTH[(leg, cls, hhmm)](d), f"run {run_day}: one-off {hhmm} leaks onto {d}"
        run_day += timedelta(days=1)
    stable = [v for r, v in nov7_by_run.items() if r >= SAT1]
    assert stable and all(v == stable[0] for v in stable), "Nov 7 results change between runs as the trip nears"


def test_t9_s2_trip_day_check_after_the_nov_6_run(dsn, client):
    run_day = date(2026, 11, 6)
    window, obs = truth_obs(run_day, time(4, 0))
    run(dsn, obs, window=window, now=datetime(2026, 11, 6, 4, 0, tzinfo=vl.MANILA), directions=BOTH)
    for d in (SAT2, date(2026, 11, 8)):
        got = set(keys(search(client, d)))
        assert {("regular_aircon", "07:00"), ("royal_class", "00:15"), ("regular_aircon", "05:30")} <= got
        assert ("regular_aircon", "13:00") not in got
    back = set(keys(search(client, date(2026, 11, 8), "from")))
    assert ("regular_aircon", "08:00") in back
    assert ("regular_aircon", "20:00") not in back
