"""TG-60 audit (tg-test3): six guards the rest of the suite didn't catch a fault in. Rows and helpers are those of
test_scraper_stable_rows.py."""

from datetime import date, timedelta

import psycopg

from test_scraper_one_off import ALL_WEEK, TO_LEG, add_manual, route_id
from test_scraper_stable_rows import FC, SAT, fc, later, one_off_first_class, only_out, shows, window


def test_a1_a_retired_row_returns_with_what_is_listed_not_its_old_days(dsn):
    """Inactive weekly row: its saved days are history. Sat has one date listed of two, so it's dated, not weekly."""
    only_out(dsn)
    only_out(dsn, 3, window(later(3)))
    assert fc(dsn, "10:15", TO_LEG)[0][4] is False
    fridays = {date(2026, 11, 13), date(2026, 11, 20)}
    listed = fridays | {date(2026, 11, 14)}
    only_out(dsn, 4, [d for d in window(later(4)) if d not in listed])
    weekly = next(r for r in fc(dsn, "10:15", TO_LEG) if r[2] is None)
    assert sorted(weekly[1]) == [5]
    assert [r[2] for r in fc(dsn, "10:15", TO_LEG) if r[2] is not None and r[4]] == [date(2026, 11, 14)]


def test_a2_a_dated_row_for_today_stays_when_today_isnt_listed(dsn):
    """The morning of the trip itself: today's bus sold out or gone from the list, the row still stands."""
    one_off_first_class(dsn)
    only_out(dsn, 4, [SAT, SAT + timedelta(days=7)])
    assert [r[4] for r in fc(dsn, "10:15", TO_LEG) if r[2] == SAT] == [True]


def test_a3_an_unlisted_row_never_verified_doesnt_crash_the_run(dsn):
    only_out(dsn)
    with psycopg.connect(dsn) as conn:
        conn.execute("update trips set last_verified_at = null")
    only_out(dsn, 1, window(later(1)))
    assert [r[4] for r in fc(dsn, "10:15", TO_LEG)] == [False]


def test_a4_a_dated_row_on_a_manual_date_goes_at_once_when_the_whole_departure_is_unlisted(dsn, client):
    """t60_17 with 10:15 missing from the whole window: no grace, or the date shows twice for three days."""
    one_off_first_class(dsn)
    add_manual(dsn, route_id(dsn, TO_LEG, FC), "10:15", [6], date(2026, 11, 1), date(2026, 11, 30))
    only_out(dsn, 1, window(later(1)))
    assert [r[4] for r in fc(dsn, "10:15", TO_LEG) if r[5] == "scraped" and r[2] == SAT] == [False]
    assert shows(client, SAT, "10:15") == 1


def test_a5_a_manual_date_range_takes_only_its_own_days(dsn):
    only_out(dsn)
    add_manual(dsn, route_id(dsn, TO_LEG, FC), "10:15", [5], date(2026, 11, 6), date(2026, 11, 30))
    only_out(dsn, 1)
    weekly = next(r for r in fc(dsn, "10:15", TO_LEG) if r[5] == "scraped" and r[2] is None)
    assert sorted(weekly[1]) == sorted(ALL_WEEK - {5})


def test_a6_a_manual_row_switched_off_by_hand_still_wins_its_days(dsn, client):
    """_manual_rows' docstring: "a row someone switched off by hand stays their decision"."""
    only_out(dsn)
    add_manual(dsn, route_id(dsn, TO_LEG, FC), "10:15", [6])
    with psycopg.connect(dsn) as conn:
        conn.execute("update trips set is_active = false where source = 'manual'")
    only_out(dsn, 1)
    weekly = next(r for r in fc(dsn, "10:15", TO_LEG) if r[5] == "scraped" and r[2] is None)
    assert sorted(weekly[1]) == sorted(ALL_WEEK - {6})
    assert shows(client, SAT, "10:15") == 0
