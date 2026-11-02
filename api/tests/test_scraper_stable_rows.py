"""TG-60: trip rows stay stable across scrapes, "not listed" isn't "cancelled", and manual rows win only their dates.

Saved plans hold trip ids, so a daily scrape must not re-shape rows. HTTP is never used. Observations come from the
recorded Victory Liner fixtures; ..._2026-11-08_sold_out_1615.json is the recorded Nov 8 list without the First Class
16:15, the shape prod saw when that bus sold out (TG-59). Re-using one date's list for other dates is for tests only.
"""

import json
import shutil
from datetime import date, datetime, timedelta
from pathlib import Path

import psycopg
import pytest

import load_data
import load_itinerary
import load_premade
import victory_liner as vl
from app.plan_validation import validate_plan
from conftest import ROOT
from test_scraper_one_off import (
    ALL_WEEK, FROM, FROM_LEG, TO, TO_LEG, add_manual, keys, manual_snapshot, query, route_id, rows, run, search,
)

FIXTURES = Path(__file__).parent / "fixtures"
OUT = json.loads((FIXTURES / "victory_liner_cubao_baguio_2026-11-06.json").read_text())
BACK = json.loads((FIXTURES / "victory_liner_baguio_cubao_2026-11-08.json").read_text())
BACK_SOLD_OUT = json.loads((FIXTURES / "victory_liner_baguio_cubao_2026-11-08_sold_out_1615.json").read_text())

NOW = datetime(2026, 11, 3, 4, 0, tzinfo=vl.MANILA)  # Tue: the first real cron run was this morning
FC = "first_class"
BOTH = ["to-baguio", "from-baguio"]
FRI, SAT, SUN = date(2026, 11, 6), date(2026, 11, 7), date(2026, 11, 8)
NEXT_FRI, NEXT_SUN = date(2026, 11, 13), date(2026, 11, 15)
ITINERARY = ROOT / "data" / "itineraries" / "baguio-barkada-2026-11-06.json"
OWNER_SLUG = "baguio-barkada-nov6"


def window(now=NOW):
    return [now.date() + timedelta(days=i) for i in range(14)]


def later(days):
    return NOW + timedelta(days=days)


def drop(payload, hhmm, bus="FIRST CLASS"):
    return [x for x in payload if not (x["departureTime"].startswith(hhmm) and x["busType"] == bus)]


def out_obs(days, missing=(), hhmm="10:15"):
    """Cubao to Baguio on each date; on `missing` dates the API doesn't list `hhmm` First Class."""
    return [o for d in days for o in vl.parse_response(drop(OUT, hhmm) if d in missing else OUT, *TO_LEG, d)]


def back_obs(days, sold_out=()):
    return [o for d in days for o in vl.parse_response(BACK_SOLD_OUT if d in sold_out else BACK, *FROM_LEG, d)]


def scrape(dsn, now=NOW, out_missing=(), back_sold_out=(), log=None):
    days = window(now)
    return run(dsn, out_obs(days, out_missing) + back_obs(days, back_sold_out), window=days, now=now, directions=BOTH, log=log)


def only_out(dsn, days_shift=0, missing=(), hhmm="10:15", log=None):
    now = later(days_shift)
    days = window(now)
    return run(dsn, out_obs(days, missing, hhmm), window=days, now=now, directions=TO, log=log)


def row_ids(dsn):
    return query(dsn, "select id, days_of_week, valid_from, valid_to, is_active from trips order by id")


def fc(dsn, hhmm, leg):
    return rows(dsn, hhmm, leg, FC)


def active(found):
    return [r for r in found if r[4]]


def shows(client, d, hhmm, direction="to", cls=FC):
    """How many rows /trips shows for that departure on that date."""
    return keys(search(client, d, direction)).count((cls, hhmm))


# ---------------------------------------------------------------- 1. stable rows

def test_t60_1_sold_out_date_keeps_the_weekly_row_and_its_id(dsn, client):
    """The TG-59 return bus: VL stops listing 16:15 First Class on Sun Nov 8, and lists Sun Nov 15."""
    scrape(dsn)
    [(row_id, days, *_)] = fc(dsn, "16:15", FROM_LEG)
    scrape(dsn, later(1), back_sold_out=[SUN])
    [(again, days_after, vf, vt, is_active, *_)] = fc(dsn, "16:15", FROM_LEG)
    assert (again, sorted(days_after), vf, vt, is_active) == (row_id, sorted(days), None, None, True)
    assert shows(client, SUN, "16:15", "from") == 1


def test_t60_2_a_weekly_row_is_not_narrowed_or_split(dsn, client):
    """The TG-59 outbound bus: [0..6] became [3,4]. Here 10:15 is missing on one date of every weekday but Wed and Thu."""
    only_out(dsn)
    [(row_id, *_)] = fc(dsn, "10:15", TO_LEG)
    missing = [d for d in window(later(1))[:7] if d.weekday() not in (2, 3)]
    only_out(dsn, 1, missing)
    assert [(r[0], sorted(r[1]), r[2], r[4]) for r in fc(dsn, "10:15", TO_LEG)] == [(row_id, sorted(ALL_WEEK), None, True)]
    for d in window(later(1)):
        assert shows(client, d, "10:15") == 1


def test_t60_3_daily_churn_changes_no_rows(dsn):
    """Different dates sell out each morning; no row is added, split or switched off, whatever the order."""
    scrape(dsn)
    before = row_ids(dsn)
    for shift, out_gone, back_gone in ((1, [FRI], [SUN]), (2, [SAT], []), (3, [NEXT_FRI], [NEXT_SUN]), (4, [], [SUN])):
        res = scrape(dsn, later(shift), out_gone, back_gone)
        assert (res.trips_new, res.trips_deactivated, res.trips_one_off) == (0, 0, 0)
        assert row_ids(dsn) == before, f"rows changed on day +{shift}"


def test_t60_4_the_owners_plan_and_premades_stay_valid_without_a_reload(dsn, client, tmp_path):
    shutil.copy(ROOT / "data" / "spots.csv", tmp_path / "spots.csv")
    shutil.copy(ROOT / "data" / "last_mile_routes.csv", tmp_path / "last_mile_routes.csv")
    (tmp_path / "routes_trips.csv").write_text("", encoding="utf-8")
    assert load_data.run(dsn, tmp_path, dry_run=False) == 0
    scrape(dsn)
    assert load_itinerary.run(dsn, ITINERARY, dry_run=False) == 0
    assert load_premade.run(dsn, load_premade.DEFAULT_FILE, dry_run=False, prune=False) == 0
    scrape(dsn, later(1), out_missing=[FRI], back_sold_out=[SUN])
    with psycopg.connect(dsn) as conn:
        stored = conn.execute("select plan, trip_date, return_date from itineraries where share_slug = %s", (OWNER_SLUG,)).fetchone()
        plan = {k: v for k, v in stored[0].items() if k != "guide"}
        result = validate_plan(conn, plan, trip_date=stored[1], return_date=stored[2])
    assert result.ok, [str(e) for e in result.errors]
    assert len(client.get("/premade-itineraries").json()) == 3


# ---------------------------------------------------------------- when a weekday really goes

def test_t60_5_a_weekday_goes_only_when_every_date_of_it_is_missing(dsn, client):
    only_out(dsn)
    [(row_id, *_)] = fc(dsn, "10:15", TO_LEG)
    lines = []
    days = window(later(1))
    saturdays = [d for d in days if d.weekday() == 5]
    assert len(saturdays) == 2
    only_out(dsn, 1, saturdays, log=lines.append)
    [(again, days_after, *_)] = fc(dsn, "10:15", TO_LEG)
    assert (again, sorted(days_after)) == (row_id, sorted(ALL_WEEK - {6}))
    assert shows(client, SAT, "10:15") == 0
    assert any(line.startswith("  weekly: vl-cubao->vl-baguio first_class 10:15") for line in lines)


def test_t60_6_one_required_date_is_not_enough_to_drop_a_weekday():
    """Today is exempt for an early bus, so its weekday has one required date left: one miss proves nothing."""
    days = window()
    tuesday_next = days[7]
    early = [o for d in days if d not in (days[0], tuesday_next) for o in vl.parse_response(OUT[:1], *TO_LEG, d)]
    dep = early[0].departure
    assert dep < (NOW + vl.TODAY_MARGIN).time()
    every_day = [o for d in days for o in vl.parse_response(OUT[-1:], *TO_LEG, d)]  # so the leg answered on both dates
    spec = vl.aggregate(early + every_day, days, verified_at=NOW)[(*TO_LEG, early[0].service_class)]
    assert 2 not in spec.absent.get(dep, set())
    assert tuesday_next in spec.not_listed[dep]


def test_t60_7_aggregate_reports_absent_weekdays_and_not_listed_dates():
    days = window()
    gone = [d for d in days if d.weekday() == 5]
    obs = out_obs(days, gone + [FRI])
    spec = vl.aggregate(obs, days, verified_at=NOW)[(*TO_LEG, FC)]
    dep = next(o.departure for o in obs if o.departure.strftime("%H:%M") == "10:15")
    assert spec.absent[dep] == {6}  # both Saturdays missing; Friday was listed on Nov 13
    assert spec.not_listed[dep] == {*gone, FRI}
    assert spec.dates[dep] == set(days) - {*gone, FRI}


# ---------------------------------------------------------------- 2. "not listed" isn't "cancelled"

def one_off_first_class(dsn):
    """A 10:15 row dated Sat Nov 7 only, as today's prod has after the first cron: weekly on other days plus a one-off."""
    only_out(dsn)
    with psycopg.connect(dsn) as conn:
        conn.execute(
            "update trips set days_of_week = '{0,1,2,3,4,5}' where id = %s", (fc(dsn, "10:15", TO_LEG)[0][0],))
        conn.execute(
            """insert into trips (route_id, departure_time, days_of_week, valid_from, valid_to, source, source_url, last_verified_at)
               values (%s, '10:15', '{6}', %s, %s, 'scraped', %s, %s)""",
            (route_id(dsn, TO_LEG, FC), SAT, SAT, vl.SOURCE_URL, NOW),
        )


def test_t60_8_a_dated_row_stays_until_its_date_while_the_departure_is_still_listed(dsn, client):
    one_off_first_class(dsn)
    weekly, dated = fc(dsn, "10:15", TO_LEG)
    res = only_out(dsn, 1, [SAT, SAT + timedelta(days=7)])  # sold out; the departure is listed on every other date
    after = {r[0]: r for r in fc(dsn, "10:15", TO_LEG)}
    assert after[dated[0]][4] is True
    assert after[dated[0]][7] == NOW, "a row the API didn't list keeps its old last_verified_at"
    assert after[weekly[0]][7] == later(1)
    assert res.trips_deactivated == 0
    assert shows(client, SAT, "10:15") == 1


def test_t60_9_a_dated_row_goes_once_its_date_has_passed(dsn):
    one_off_first_class(dsn)
    [dated] = [r for r in fc(dsn, "10:15", TO_LEG) if r[2] == SAT]
    only_out(dsn, 5)  # Sun Nov 8 run: Sat Nov 7 is over
    assert [r[4] for r in fc(dsn, "10:15", TO_LEG) if r[0] == dated[0]] == [False]


@pytest.mark.parametrize("missed,gone", [(1, False), (2, False), (3, True)])
def test_t60_10_a_departure_missing_from_the_whole_window_goes_after_three_days(dsn, missed, gone):
    only_out(dsn)
    [(row_id, *_)] = fc(dsn, "10:15", TO_LEG)
    gone_all = window(later(missed))
    res = only_out(dsn, missed, gone_all)
    [(again, _, _, _, is_active, *_)] = fc(dsn, "10:15", TO_LEG)
    assert (again, is_active) == (row_id, not gone)
    assert res.trips_deactivated == (1 if gone else 0)


def test_t60_11_a_retired_departure_comes_back_on_the_same_row(dsn):
    only_out(dsn)
    [(row_id, *_)] = fc(dsn, "10:15", TO_LEG)
    only_out(dsn, 3, window(later(3)))
    assert fc(dsn, "10:15", TO_LEG)[0][4] is False
    only_out(dsn, 4)
    [(again, days, _, _, is_active, *_)] = fc(dsn, "10:15", TO_LEG)
    assert (again, sorted(days), is_active) == (row_id, sorted(ALL_WEEK), True)


def test_t60_12_kept_rows_are_logged_and_counted(dsn):
    only_out(dsn)
    lines = []
    res = only_out(dsn, 1, [FRI], log=lines.append)
    assert "  not listed: vl-cubao->vl-baguio first_class 10:15 on 2026-11-06 (kept)" in lines
    assert res.trips_kept == 1
    again = []
    res = only_out(dsn, 2, window(later(2)), log=again.append)
    assert "  not listed: vl-cubao->vl-baguio first_class 10:15 anywhere in the window, last seen 2026-11-04 (kept)" in again
    assert res.trips_kept == 1


def test_t60_12b_the_log_says_when_a_manual_row_took_the_weekday(dsn):
    only_out(dsn)
    booked(dsn)
    lines = []
    only_out(dsn, 1, log=lines.append)
    assert "  weekly: vl-cubao->vl-baguio first_class 10:15 days [0, 1, 2, 3, 4, 5, 6] -> [0, 1, 2, 3, 4, 6] (manual rows)" in lines


def test_t60_12c_an_unchanged_one_off_prints_once(dsn):
    only_out(dsn)
    booked(dsn)
    first = []
    only_out(dsn, 1, log=first.append)
    assert "  one-off: vl-cubao->vl-baguio first_class 10:15 on 2026-11-13 (Fri)" in first
    again = []
    res = only_out(dsn, 2, log=again.append)
    assert res.trips_one_off == 1, "still counted"
    assert not [line for line in again if "one-off:" in line], "a stable rerun is quiet"


def test_t60_13_a_dry_run_writes_nothing(dsn):
    only_out(dsn)
    before = query(dsn, "select * from trips order by id")
    days = window(later(1))
    res = vl.run(dsn, out_obs(days, [FRI]), True, directions=TO, verified_at=later(1), window=days, log=lambda *_: None)
    assert res.trips_kept == 1
    assert query(dsn, "select * from trips order by id") == before


# ---------------------------------------------------------------- manual rows win only their own dates

def booked(dsn, hhmm="10:15", leg=TO_LEG, d=FRI):
    dow = (d.weekday() + 1) % 7
    add_manual(dsn, route_id(dsn, leg, FC), hhmm, [dow], d, d)


def test_t60_14_a_dated_manual_row_wins_only_its_date(dsn, client):
    """TG-59's booked buses: First Class 10:15 and 16:15 must stay searchable on every other date."""
    scrape(dsn)
    booked(dsn)
    booked(dsn, "16:15", FROM_LEG, SUN)
    before = manual_snapshot(dsn)
    res = scrape(dsn, later(1))
    assert manual_snapshot(dsn) == before
    assert res.trips_skipped_manual == 2
    for d, direction, hhmm in ((FRI, "to", "10:15"), (SUN, "from", "16:15")):
        found = [x for x in search(client, d, direction) if x["departure_time"] == hhmm and x["service_class"] == FC]
        assert [x["source"] for x in found] == ["manual"], "only the manual row on its own date"
    for d in window(later(1)):
        if d != FRI:
            assert shows(client, d, "10:15") == 1, d
        if d != SUN:
            assert shows(client, d, "16:15", "from") == 1, d


def test_t60_15_other_dates_of_the_manual_weekday_are_dated_and_stable(dsn, client):
    only_out(dsn)
    booked(dsn)
    only_out(dsn, 1)
    weekly = next(r for r in fc(dsn, "10:15", TO_LEG) if r[2] is None)
    assert sorted(weekly[1]) == sorted(ALL_WEEK - {5})
    assert weekly[4] is True
    dated = [r for r in fc(dsn, "10:15", TO_LEG) if r[5] == "scraped" and r[2] is not None]
    assert [(r[1], r[2], r[3]) for r in dated] == [([5], NEXT_FRI, NEXT_FRI)]
    before = row_ids(dsn)
    res = only_out(dsn, 2)
    assert (res.trips_new, res.trips_deactivated) == (0, 0)
    assert row_ids(dsn) == before


def test_t60_16_the_weekday_comes_back_once_the_manual_date_has_passed(dsn, client):
    only_out(dsn)
    booked(dsn)
    only_out(dsn, 1)
    only_out(dsn, 4)  # Sat Nov 7: the booked Friday is over
    weekly = next(r for r in fc(dsn, "10:15", TO_LEG) if r[2] is None)
    assert sorted(weekly[1]) == sorted(ALL_WEEK)
    assert shows(client, NEXT_FRI, "10:15") == 1
    assert [r[2] for r in active(fc(dsn, "10:15", TO_LEG)) if r[5] == "manual"] == [FRI]


def test_t60_17_a_scraped_one_off_on_a_manual_date_goes_at_once(dsn, client):
    one_off_first_class(dsn)
    start = date(2026, 11, 1)  # a hand-entered Saturday run over a date range that covers the scraped one-off
    add_manual(dsn, route_id(dsn, TO_LEG, FC), "10:15", [6], start, date(2026, 11, 30))
    only_out(dsn, 1)
    assert [r[4] for r in fc(dsn, "10:15", TO_LEG) if r[2] == SAT] == [False]
    assert [x["source"] for x in search(client, SAT, "to") if (x["service_class"], x["departure_time"]) == (FC, "10:15")] == ["manual"]


def test_t60_18_an_open_ended_manual_row_blocks_only_its_weekdays(dsn, client):
    only_out(dsn)
    add_manual(dsn, route_id(dsn, TO_LEG, FC), "10:15", [6])  # every Saturday, hand-entered
    only_out(dsn, 1)
    weekly = next(r for r in fc(dsn, "10:15", TO_LEG) if r[5] == "scraped" and r[2] is None)
    assert sorted(weekly[1]) == sorted(ALL_WEEK - {6})
    assert [r for r in fc(dsn, "10:15", TO_LEG) if r[5] == "scraped" and r[2] is not None] == []
    assert shows(client, SAT, "10:15") == 1
    assert shows(client, FRI, "10:15") == 1


def test_t60_19_a_manual_row_covering_every_date_still_retires_the_scraped_row(dsn):
    only_out(dsn)
    add_manual(dsn, route_id(dsn, TO_LEG, FC), "10:15", sorted(ALL_WEEK))
    res = only_out(dsn, 1)
    assert sorted((r[5], r[4]) for r in fc(dsn, "10:15", TO_LEG)) == [("manual", True), ("scraped", False)]
    assert res.trips_skipped_manual == 1


def test_t60_20_a_manual_row_does_not_shorten_the_grace_for_other_dates(dsn):
    """10:15 missing from the whole window for a day, with one booked date: the scraped row isn't dropped early."""
    only_out(dsn)
    booked(dsn)
    only_out(dsn, 1, window(later(1)))
    assert next(r for r in fc(dsn, "10:15", TO_LEG) if r[5] == "scraped")[4] is True


# ---------------------------------------------------------------- loaders: manual wins a natural key

def trip_key(**kw):
    return load_premade.TripKey.model_validate({
        "operator": "victory-liner", "origin": "vl-cubao", "destination": "vl-baguio", "departure": "10:15",
        "date": "2026-11-06", "class": "first_class", **kw,
    })


def resolve(dsn, ref):
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        return load_premade._resolve_trip(cur, ref, load_data.slug_map(cur, "operators"), load_data.slug_map(cur, "terminals"))


def test_t60_21_a_natural_key_prefers_the_single_manual_row(dsn):
    """Between TG-59's load_data and the next scrape, the weekly row and the booked row both run on Nov 6."""
    only_out(dsn)
    booked(dsn)
    manual_id = next(r[0] for r in fc(dsn, "10:15", TO_LEG) if r[5] == "manual")
    assert resolve(dsn, trip_key()) == (str(manual_id), [])


def test_t60_22_two_manual_rows_stay_ambiguous(dsn):
    only_out(dsn)
    booked(dsn)
    with psycopg.connect(dsn) as conn:
        conn.execute(
            """insert into trips (route_id, departure_time, days_of_week, valid_from, source)
               values (%s, '10:15', '{5}', '2026-11-01', 'manual')""", (route_id(dsn, TO_LEG, FC),))
    found, problems = resolve(dsn, trip_key())
    assert found is None
    assert "3 trips match" in problems[0]


# ---------------------------------------------------------------- 3. plans re-point after a scrape (the loaders cron.sh runs)

def test_t60_23_plans_re_point_and_sessions_stay_untouched(dsn, client, tmp_path):
    """Prod's morning: the plan holds a row the scraper has moved on from. The loaders re-point it, in place."""
    shutil.copy(ROOT / "data" / "spots.csv", tmp_path / "spots.csv")
    shutil.copy(ROOT / "data" / "last_mile_routes.csv", tmp_path / "last_mile_routes.csv")
    (tmp_path / "routes_trips.csv").write_text("", encoding="utf-8")
    assert load_data.run(dsn, tmp_path, dry_run=False) == 0
    scrape(dsn)
    assert load_itinerary.run(dsn, ITINERARY, dry_run=False) == 0
    with psycopg.connect(dsn) as conn:
        itinerary_id = conn.execute("select id from itineraries where share_slug = %s", (OWNER_SLUG,)).fetchone()[0]
        conn.execute(
            "insert into trip_sessions (name, start_date, return_date, itinerary_id) values ('Baguio', %s, %s, %s)",
            (FRI, SUN, itinerary_id),
        )
    sessions = query(dsn, "select * from trip_sessions")
    booked(dsn)  # the weekly row stops running on Nov 6 at the next scrape
    scrape(dsn, later(1))
    assert load_itinerary.run(dsn, ITINERARY, dry_run=False) == 0
    with psycopg.connect(dsn) as conn:
        again, plan = conn.execute("select id, plan from itineraries where share_slug = %s", (OWNER_SLUG,)).fetchone()
    manual_id = next(r[0] for r in fc(dsn, "10:15", TO_LEG) if r[5] == "manual")
    assert again == itinerary_id, "updated in place, so the session still points at it"
    assert plan["outbound"]["trip_id"] == str(manual_id)
    assert query(dsn, "select * from trip_sessions") == sessions


def test_t60_24_prods_shredded_rows_heal_on_the_first_run(dsn, client):
    """What the first cron left: 10:15 weekly {3,4}, one-offs on other dates. Fri Nov 6 is sold out, so it isn't listed."""
    only_out(dsn)
    weekly_id = fc(dsn, "10:15", TO_LEG)[0][0]
    with psycopg.connect(dsn) as conn:
        conn.execute("update trips set days_of_week = '{3,4}' where id = %s", (weekly_id,))
        for d in window()[1:]:
            if (d.weekday() + 1) % 7 not in (3, 4):
                conn.execute(
                    """insert into trips (route_id, departure_time, days_of_week, valid_from, valid_to, source, source_url, last_verified_at)
                       values (%s, '10:15', %s, %s, %s, 'scraped', %s, %s)""",
                    (route_id(dsn, TO_LEG, FC), [(d.weekday() + 1) % 7], d, d, vl.SOURCE_URL, NOW),
                )
    friday_row = next(r[0] for r in fc(dsn, "10:15", TO_LEG) if r[2] == FRI)
    only_out(dsn, 1, [FRI])
    now_active = active(fc(dsn, "10:15", TO_LEG))
    weekly = next(r for r in now_active if r[2] is None)
    assert (weekly[0], sorted(weekly[1])) == (weekly_id, sorted(ALL_WEEK - {5}))
    assert {r[2] for r in now_active if r[2] is not None} == {FRI, NEXT_FRI}
    assert friday_row in {r[0] for r in now_active}, "the sold-out Friday keeps its row"
    for d in window(later(1)):
        assert shows(client, d, "10:15") == 1, d


def test_t60_25_tg59s_real_booked_rows_keep_every_other_date(dsn, client, tmp_path):
    """The repo's data/routes_trips.csv as merged by TG-59, then a scrape: manual on the booked dates, scraped elsewhere."""
    shutil.copy(ROOT / "data" / "routes_trips.csv", tmp_path / "routes_trips.csv")
    (tmp_path / "spots.csv").write_text("slug,name,category,lat,lng,description,visit_minutes,entrance_fee_php\n", encoding="utf-8")
    assert load_data.run(dsn, tmp_path, dry_run=False) == 0
    scrape(dsn, later(1))
    scrape(dsn, later(2), back_sold_out=[SUN])
    for d in window(later(2)):
        out = [x["source"] for x in search(client, d, "to") if (x["service_class"], x["departure_time"]) == (FC, "10:15")]
        back = [x["source"] for x in search(client, d, "from") if (x["service_class"], x["departure_time"]) == (FC, "16:15")]
        assert out == (["manual"] if d == FRI else ["scraped"]), d
        assert back == (["manual"] if d == SUN else ["scraped"]), d


def test_t60_r1_the_rule_is_written_down():
    section = (ROOT / "README.md").read_text(encoding="utf-8").split("## 4.")[1].split("## 5.")[0]
    assert "**Stable rows.**" in section
    assert "**Manual rows win only their own dates.**" in section
    for words in ("not listed", "3 days", "last_verified_at", "load_itinerary.py", "load_premade.py"):
        assert words in section, words
    assert vl.RETIRE_AFTER_DAYS == 3
    assert vl.MIN_ABSENT_DATES == 2
