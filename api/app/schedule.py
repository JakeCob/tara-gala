"""Pure date and time helpers shared by main.py and the plan validator. No I/O, stdlib only."""

from datetime import date as Date
from datetime import datetime, time, timedelta
from typing import Literal

# opening_hours keys by Postgres dow (0 = Sunday), the numbering trips.days_of_week uses
DAY_KEYS = ("sun", "mon", "tue", "wed", "thu", "fri", "sat")


def arrival(travel_date: Date, departure: time, minutes: int | None) -> tuple[str | None, int | None]:
    """Rough arrival as ("HH:MM", days after travel_date). Manila has no DST, so naive maths is fine."""
    if not minutes:
        return None, None
    at = datetime.combine(travel_date, departure) + timedelta(minutes=minutes)
    return at.strftime("%H:%M"), (at.date() - travel_date).days


def postgres_dow(d: Date) -> int:
    return d.isoweekday() % 7


def runs_on(days_of_week, valid_from: Date | None, valid_to: Date | None, d: Date) -> bool:
    """The Python twin of the date filter in main.search_trips. Keep the two in step."""
    return (
        postgres_dow(d) in (days_of_week or [])
        and (valid_from is None or valid_from <= d)
        and (valid_to is None or valid_to >= d)
    )


def to_minutes(hhmm: str) -> int:
    """'HH:MM' to minutes since midnight; '24:00' gives 1440."""
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def _clock(value, *, allow_midnight_end: bool) -> int | None:
    if not isinstance(value, str) or len(value) != 5 or value[2] != ":" or not (value[:2] + value[3:]).isdigit():
        return None
    h, m = int(value[:2]), int(value[3:])
    if m > 59 or h > 24 or (h == 24 and (m or not allow_midnight_end)):
        return None
    return h * 60 + m


def hours_on(opening_hours: dict | None, d: Date) -> tuple[int, int] | Literal["closed"] | None:
    """Opening hours on d as (open, close) minutes, "closed", or None when unknown.

    Format as in schema.sql: {"mon": ["06:00", "18:00"], ...}. [] means closed. A missing key,
    a malformed value or close before open (overnight hours) counts as unknown.
    """
    if not isinstance(opening_hours, dict):
        return None
    value = opening_hours.get(DAY_KEYS[postgres_dow(d)])
    if value == []:
        return "closed"
    if not isinstance(value, list) or len(value) != 2:
        return None
    start = _clock(value[0], allow_midnight_end=False)
    end = _clock(value[1], allow_midnight_end=True)
    if start is None or end is None or end < start:
        return None
    return start, end
