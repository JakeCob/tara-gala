"""TG-24: the shared plan validator (plan.md 2.2) and its date and time helpers (2.3).

Fixture data below is made up for tests only, not real schedules, spots or legs. Most checks run on
hand-built Refs through check_plan (no rows needed); the validate_plan tests load rows with load_data.
"""

import ast
import copy
import dataclasses
import json
import logging
import subprocess
import sys
import time as time_mod
from datetime import date, time
from pathlib import Path
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg.rows import dict_row

from app import main, schedule
from app.plan_validation import (
    BAGUIO,
    ERROR_CODES,
    MODEL_PREMADE,
    RETURN_BUFFER_MINUTES,
    LegRef,
    Plan,
    PlanError,
    Refs,
    SpotRef,
    TripRef,
    ValidationResult,
    check_plan,
    load_refs,
    parse_plan,
    validate_plan,
)
from premade_data import FRI, P0_DAYS, SAT, SUN, TRIPS, build_plan, db_ids, db_p0, load_rows

API = Path(__file__).resolve().parents[1]
DAILY = [0, 1, 2, 3, 4, 5, 6]

# --- hand-built reference rows (made up for tests only) -----------------------------------------

TERMINALS = {slug: uuid4() for slug in ("vl-cubao", "vl-pasay", "vl-baguio", "gen-pasay", "gen-baguio")}
CITY = {"vl-cubao": "Quezon City", "vl-pasay": "Pasay", "vl-baguio": "Baguio", "gen-pasay": "Pasay", "gen-baguio": "Baguio"}


def trip_ref(origin, dest, dep, minutes=360, days=DAILY, active=True, valid_from=None, valid_to=None):
    return TripRef(
        trip_id=uuid4(), is_active=active, departure_time=time.fromisoformat(dep), travel_minutes=minutes,
        days_of_week=list(days), valid_from=valid_from, valid_to=valid_to,
        origin_terminal_id=TERMINALS[origin], origin_city=CITY[origin],
        destination_terminal_id=TERMINALS[dest], destination_city=CITY[dest],
    )


TRIP_REFS = {
    "out-day": trip_ref("vl-cubao", "vl-baguio", "07:00"),  # arrives 13:00 same day
    "out-night": trip_ref("vl-cubao", "vl-baguio", "22:00"),  # arrives 04:00 next day
    "out-inactive": trip_ref("vl-pasay", "vl-baguio", "07:00", active=False),
    "out-weekends": trip_ref("vl-cubao", "vl-baguio", "07:30", 330, days=[0, 6]),  # arrives 13:00, not on Fri
    "out-expired": trip_ref("vl-cubao", "vl-baguio", "08:00", 300, valid_to=date(2026, 11, 1)),
    "out-from-sat": trip_ref("vl-cubao", "vl-baguio", "08:00", 300, valid_from=SAT),
    "out-ends-fri": trip_ref("vl-cubao", "vl-baguio", "08:00", 300, valid_from=FRI, valid_to=FRI),
    "out-no-minutes": trip_ref("vl-cubao", "vl-baguio", "09:00", None),
    "out-baguio-loop": trip_ref("gen-baguio", "vl-baguio", "12:00", 60),  # Baguio to Baguio
    "ret": trip_ref("vl-baguio", "vl-cubao", "21:00"),
    "ret-early": trip_ref("vl-baguio", "vl-cubao", "06:00"),
    "ret-inactive": trip_ref("vl-baguio", "vl-cubao", "21:00", active=False),
    "ret-weekdays": trip_ref("vl-baguio", "vl-cubao", "21:00", days=[1, 2, 3, 4, 5]),  # not on Sun
    "ret-manila-loop": trip_ref("vl-cubao", "vl-pasay", "21:00", 60),
    "ret-baguio-loop": trip_ref("vl-baguio", "gen-baguio", "21:00", 30),
    "ret-genesis": trip_ref("gen-baguio", "gen-pasay", "18:00", 300),
    "ret-1329": trip_ref("vl-baguio", "vl-cubao", "13:29"),  # 29 min after out-day arrives
    "ret-1330": trip_ref("vl-baguio", "vl-cubao", "13:30"),
}

PARK_HOURS = {"sun": ["09:00", "17:00"], "fri": ["08:00", "18:00"], "sat": ["08:00", "18:00"]}
SPOT_REFS = {
    "test-park": SpotRef(spot_id=uuid4(), slug="test-park", name="Test Park (made up)", opening_hours=PARK_HOURS),
    "test-market": SpotRef(spot_id=uuid4(), slug="test-market", name="Test Market (made up)", opening_hours=None),
    "test-cafe": SpotRef(spot_id=uuid4(), slug="test-cafe", name="Test Cafe (made up)", opening_hours={"sat": ["10:00", "14:00"]}),
    "test-lodge": SpotRef(spot_id=uuid4(), slug="test-lodge", name="Test Lodge (made up)", opening_hours=None),
}


def place(slug):
    return ("terminal", TERMINALS[slug]) if slug in TERMINALS else ("spot", SPOT_REFS[slug].spot_id)


LEG_MINUTES = {
    ("vl-baguio", "test-market", "walk"): 10,
    ("test-market", "test-park", "jeep"): 15,
    ("test-park", "test-lodge", "taxi"): 20,
    ("test-lodge", "test-cafe", "taxi"): 15,
    ("test-cafe", "test-lodge", "taxi"): 15,
    ("test-lodge", "test-park", "taxi"): 20,
    ("gen-baguio", "test-market", "taxi"): 10,
    ("gen-baguio", "test-park", "taxi"): 10,
    ("test-market", "test-lodge", "taxi"): 15,
    ("vl-baguio", "test-cafe", "taxi"): 15,
    ("test-market", "test-park", "walk"): None,  # minutes unknown
    ("test-park", "test-cafe", "walk"): 10,
}
LEG_REFS = {
    key: LegRef(last_mile_route_id=uuid4(), start=place(key[0]), end=place(key[1]), minutes=minutes)
    for key, minutes in LEG_MINUTES.items()
}

SPOT_IDS = {slug: s.spot_id for slug, s in SPOT_REFS.items()}
LEG_IDS = {key: leg.last_mile_route_id for key, leg in LEG_REFS.items()}


def refs(spots=None) -> Refs:
    spots = spots or SPOT_REFS
    return Refs(
        trips={t.trip_id: t for t in TRIP_REFS.values()},
        spots={s.spot_id: s for s in spots.values()},
        legs={leg.last_mile_route_id: leg for leg in LEG_REFS.values()},
    )


def p0(outbound="out-day", out_date=FRI, ret="ret", ret_date=SUN, days=P0_DAYS) -> dict:
    return build_plan(TRIP_REFS[outbound].trip_id, out_date, TRIP_REFS[ret].trip_id, ret_date, days, SPOT_IDS, LEG_IDS)


NO_PARK_HOURS = {**SPOT_REFS, "test-park": dataclasses.replace(SPOT_REFS["test-park"], opening_hours=None)}


def stop(plan, d, s) -> dict:
    return plan["days"][d]["stops"][s]


def at(d, s, field=None) -> str:
    path = f"days[{d}].stops[{s}]"
    return f"{path}.{field}" if field else path


LEG_PATH = "leg.last_mile_route_id"


def check(raw, spots=None, **kw) -> list[PlanError]:
    plan, errors = parse_plan(raw)
    assert plan is not None and errors == [], errors
    return check_plan(plan, refs(spots), **kw)


def found(errors) -> list[tuple[str, str]]:
    return [(e.code, e.path) for e in errors]


# --- contract ------------------------------------------------------------------------------------

def test_contract_constants():
    assert ERROR_CODES == frozenset({
        "shape", "unknown_trip", "trip_inactive", "trip_not_running", "wrong_direction", "wrong_date",
        "dates_out_of_order", "arrival_unknown", "bad_days", "unknown_spot", "unknown_leg",
        "leg_wrong_end", "leg_wrong_start", "stop_times", "before_bus_arrival", "overlap",
        "not_enough_travel_time", "after_return", "closed",
    })
    assert RETURN_BUFFER_MINUTES == 30
    assert BAGUIO == "Baguio"
    assert MODEL_PREMADE == "premade"  # lives here, not in premade.py, so the loader needs no FastAPI (review 3)


def test_plan_error_str_and_result_ok():
    assert str(PlanError("overlap", "days[0].stops[1].arrive", "day 1, stop 2: too early")) == "days[0].stops[1].arrive: day 1, stop 2: too early"
    assert str(PlanError("shape", "", "not JSON")) == "not JSON"
    plan, _ = parse_plan(p0())
    assert ValidationResult(plan=plan, errors=[]).ok is True
    assert ValidationResult(plan=plan, errors=[PlanError("overlap", "x", "y")]).ok is False
    assert ValidationResult(plan=None, errors=[]).ok is False


def test_plan_round_trips_the_claude_md_shape():
    raw = p0()
    plan, errors = parse_plan(raw)
    assert errors == []
    assert plan.return_.trip_id == TRIP_REFS["ret"].trip_id
    assert plan.to_json() == raw  # "return", not "return_"; ids and dates as strings
    assert set(plan.to_json()) == {"outbound", "return", "days"}


# --- B1 baseline ---------------------------------------------------------------------------------

def test_valid_plan_has_no_errors():
    assert check(p0()) == []
    assert check(p0(), trip_date=FRI, return_date=SUN) == []


# --- B2 shape ------------------------------------------------------------------------------------

def _set(*keys_and_value):
    *keys, field, value = keys_and_value

    def edit(p):
        target = p
        for k in keys:
            target = target[k]
        target[field] = value
    return edit


def _pop(*keys):
    *parents, field = keys

    def edit(p):
        target = p
        for k in parents:
            target = target[k]
        target.pop(field)
    return edit


@pytest.mark.parametrize("edit, path", [
    (_pop("outbound"), "outbound"),
    (_pop("return"), "return"),
    (_set("outbound", "trip_id", "not-a-uuid"), "outbound.trip_id"),
    (_set("return", "date", "08/11/2026"), "return.date"),
    (_set("days", 0, "stops", 0, "arrive", "9:00"), "days[0].stops[0].arrive"),
    (_set("days", 0, "stops", 0, "arrive", "25:00"), "days[0].stops[0].arrive"),
    (_set("days", 0, "stops", 0, "arrive", "24:00"), "days[0].stops[0].arrive"),
    (_set("days", 0, "stops", 0, "leave", "9:5"), "days[0].stops[0].leave"),
    (_pop("days", 1, "stops", 0, "leg", "last_mile_route_id"), "days[1].stops[0].leg.last_mile_route_id"),
    (_set("days", 0, "day", "one"), "days[0].day"),
    (_set("days", {}), "days"),
    (_set("extra", 1), "extra"),  # extra keys are rejected (extra="forbid")
    (_set("days", 0, "stops", 0, "note", "x"), "days[0].stops[0].note"),
    (_set("days", 0, "stops", 0, "leg", "mode", "jeep"), "days[0].stops[0].leg.mode"),
])
def test_shape_errors(edit, path):
    raw = p0()
    edit(raw)
    plan, errors = parse_plan(raw)
    assert plan is None
    assert found(errors) == [("shape", path)]
    assert all(e.message for e in errors)


@pytest.mark.parametrize("text", ["{not json", b"{not json", "[]", ""])
def test_shape_error_for_text_that_is_not_a_plan_object(text):
    plan, errors = parse_plan(text)
    assert plan is None
    assert found(errors) == [("shape", "")]


class NoDB:
    def __getattr__(self, name):
        raise AssertionError(f"a shape error must not touch the database (conn.{name})")


def test_shape_error_runs_no_query_and_does_not_raise():
    raw = p0()
    raw["days"][0]["stops"][0]["arrive"] = "9:00"
    result = validate_plan(NoDB(), raw)
    assert result.plan is None
    assert result.ok is False
    assert found(result.errors) == [("shape", "days[0].stops[0].arrive")]
    result = validate_plan(NoDB(), "{not json")
    assert found(result.errors) == [("shape", "")]


def test_leave_before_arrive_and_day_numbers_are_not_shape_errors():
    # plan.md: these come from check_plan (stop_times, bad_days), so the shape still parses
    raw = p0()
    stop(raw, 0, 0)["leave"] = "13:00"
    raw["days"][2]["day"] = 4
    plan, errors = parse_plan(raw)
    assert plan is not None and errors == []


# --- B3 unknown ids --------------------------------------------------------------------------------

def test_unknown_outbound_trip_is_the_only_error():
    raw = p0()
    raw["outbound"]["trip_id"] = str(uuid4())
    assert found(check(raw)) == [("unknown_trip", "outbound.trip_id")]


def test_unknown_return_trip_is_the_only_error():
    raw = p0()
    raw["return"]["trip_id"] = str(uuid4())
    assert found(check(raw)) == [("unknown_trip", "return.trip_id")]


def test_unknown_spot():
    raw = p0()
    stop(raw, 1, 0)["spot_id"] = str(uuid4())
    errors = found(check(raw))
    assert ("unknown_spot", at(1, 0, "spot_id")) in errors
    assert [c for c, _ in errors].count("unknown_spot") == 1


@pytest.mark.parametrize("d, s", [(0, 0), (0, 1), (2, 0)])
def test_unknown_leg_is_the_only_error(d, s):
    raw = p0()
    stop(raw, d, s)["leg"]["last_mile_route_id"] = str(uuid4())
    assert found(check(raw)) == [("unknown_leg", at(d, s, LEG_PATH))]


# --- B4 trips that don't run -----------------------------------------------------------------------

@pytest.mark.parametrize("outbound, code", [
    ("out-inactive", "trip_inactive"),
    ("out-weekends", "trip_not_running"),  # Fri isn't a weekend day
    ("out-expired", "trip_not_running"),  # valid_to is before the date
    ("out-from-sat", "trip_not_running"),  # valid_from is after the date
])
def test_outbound_that_does_not_run(outbound, code):
    assert found(check(p0(outbound=outbound))) == [(code, "outbound.trip_id")]


def test_valid_range_edges_are_inclusive():
    assert check(p0(outbound="out-ends-fri")) == []


@pytest.mark.parametrize("ret, code", [("ret-inactive", "trip_inactive"), ("ret-weekdays", "trip_not_running")])
def test_return_that_does_not_run(ret, code):
    assert found(check(p0(ret=ret))) == [(code, "return.trip_id")]


# --- B5 direction ----------------------------------------------------------------------------------

def test_outbound_from_baguio_to_baguio_is_wrong_direction():
    assert found(check(p0(outbound="out-baguio-loop"))) == [("wrong_direction", "outbound.trip_id")]


def test_manila_bound_bus_as_outbound_is_wrong_direction():
    assert ("wrong_direction", "outbound.trip_id") in found(check(p0(outbound="ret")))


@pytest.mark.parametrize("ret", ["ret-manila-loop", "ret-baguio-loop"])
def test_return_not_from_baguio_to_elsewhere_is_wrong_direction(ret):
    assert found(check(p0(ret=ret))) == [("wrong_direction", "return.trip_id")]


def test_return_from_a_different_baguio_terminal_is_allowed():
    # On purpose (review nit 9): arrive on Victory Liner, go home on Genesis. 18:00 - 30 min >= 12:00.
    assert check(p0(ret="ret-genesis")) == []


# --- B6 dates --------------------------------------------------------------------------------------

def test_trip_date_argument_must_match_outbound_date():
    assert found(check(p0(), trip_date=SAT)) == [("wrong_date", "outbound.date")]


def test_return_date_argument_must_match_return_date():
    assert found(check(p0(), return_date=SAT)) == [("wrong_date", "return.date")]


def test_return_before_outbound_is_out_of_order():
    errors = found(check(p0(ret_date=date(2026, 11, 5))))
    assert ("dates_out_of_order", "return.date") in errors


# --- B7 unknown arrival ----------------------------------------------------------------------------

def test_no_travel_time_is_arrival_unknown():
    assert found(check(p0(outbound="out-no-minutes"))) == [("arrival_unknown", "outbound.trip_id")]


def test_arrival_unknown_skips_time_checks():
    raw = p0(outbound="out-no-minutes")
    stop(raw, 0, 1)["arrive"] = "14:00"  # would be an overlap
    stop(raw, 2, 0)["leave"] = "20:45"  # would be after_return
    assert found(check(raw)) == [("arrival_unknown", "outbound.trip_id")]


def test_arrival_unknown_still_reports_id_and_leg_errors():
    raw = p0(outbound="out-no-minutes")
    stop(raw, 0, 2)["leg"]["last_mile_route_id"] = str(uuid4())
    stop(raw, 1, 0)["leg"]["last_mile_route_id"] = str(LEG_IDS[("vl-baguio", "test-cafe", "taxi")])
    assert found(check(raw)) == [
        ("arrival_unknown", "outbound.trip_id"),
        ("unknown_leg", at(0, 2, LEG_PATH)),
        ("leg_wrong_start", at(1, 0, LEG_PATH)),
    ]


# --- B8 day numbering ------------------------------------------------------------------------------

@pytest.mark.parametrize("numbers", [[1, 2, 4], [2, 1, 3], [0, 1, 2], [1, 1, 2]])
def test_days_must_be_numbered_one_to_n(numbers):
    raw = p0()
    for day, n in zip(raw["days"], numbers):
        day["day"] = n
    assert found(check(raw)) == [("bad_days", "days")]


def test_one_day_per_calendar_day_until_the_return():
    raw = p0()
    raw["days"].pop()  # 2 days for Fri to Sun
    errors = check(raw)
    assert found(errors) == [("bad_days", "days")]
    msg = errors[0].message
    assert "1 to 3" in msg and "2026-11-06" in msg and "2026-11-08" in msg


def test_extra_day_after_the_return_is_bad_days():
    raw = p0()
    raw["days"].append({"day": 4, "stops": []})
    assert found(check(raw)) == [("bad_days", "days")]


def test_empty_stops_are_allowed():
    raw = p0()
    raw["days"][1]["stops"] = []  # day 3 still starts from the lodge, where day 1 ended
    assert check(raw) == []
    raw["days"][2]["stops"] = []  # an empty last day: nothing to check against the return
    assert check(raw) == []


NIGHT_SAT_DAYS = [
    (1, [
        ("test-market", "08:00", "09:00", ("vl-baguio", "test-market", "walk")),
        ("test-park", "09:30", "11:00", ("test-market", "test-park", "jeep")),
        ("test-lodge", "11:30", "20:00", ("test-park", "test-lodge", "taxi")),
    ]),
    (2, [("test-park", "10:00", "12:00", ("test-lodge", "test-park", "taxi"))]),
]


def test_overnight_bus_makes_day_one_the_arrival_day():
    # 22:00 Fri + 360 min arrives 04:00 Sat, so day 1 is Sat and Fri to Sun is 2 days
    assert check(p0(outbound="out-night", days=NIGHT_SAT_DAYS)) == []
    errors = check(p0(outbound="out-night"))  # P0's 3 days
    assert found(errors) == [("bad_days", "days")]
    assert "1 to 2" in errors[0].message and "2026-11-07" in errors[0].message


# --- B9 / B10 / B15 legs and where the party is ----------------------------------------------------

def test_leg_must_end_at_the_stop():
    raw = p0()
    stop(raw, 0, 1)["leg"]["last_mile_route_id"] = str(LEG_IDS[("test-market", "test-lodge", "taxi")])  # stop is test-park
    assert found(check(raw)) == [("leg_wrong_end", at(0, 1, LEG_PATH))]


def test_leg_must_start_at_the_previous_stop():
    raw = p0()
    stop(raw, 0, 1)["leg"]["last_mile_route_id"] = str(LEG_IDS[("gen-baguio", "test-park", "taxi")])
    assert found(check(raw)) == [("leg_wrong_start", at(0, 1, LEG_PATH))]


def test_day_one_starts_at_the_arrival_terminal():
    raw = p0()  # the bus arrives at vl-baguio
    stop(raw, 0, 0)["leg"]["last_mile_route_id"] = str(LEG_IDS[("gen-baguio", "test-market", "taxi")])
    assert found(check(raw)) == [("leg_wrong_start", at(0, 0, LEG_PATH))]


def test_later_day_starts_where_the_previous_day_ended():
    raw = p0()  # day 1 ended at the lodge
    stop(raw, 1, 0)["leg"]["last_mile_route_id"] = str(LEG_IDS[("vl-baguio", "test-cafe", "taxi")])
    assert found(check(raw)) == [("leg_wrong_start", at(1, 0, LEG_PATH))]


def test_any_spot_can_end_a_day_and_start_the_next():
    raw = p0()
    raw["days"][0]["stops"].pop()  # day 1 now ends at test-park, not the lodge
    stop(raw, 1, 0)["leg"]["last_mile_route_id"] = str(LEG_IDS[("test-park", "test-cafe", "walk")])
    assert check(raw) == []


# --- B11 / B12 / B13 times -------------------------------------------------------------------------

@pytest.mark.parametrize("arrive, ok", [("12:00", False), ("13:00", False), ("13:09", False), ("13:10", True)])
def test_first_stop_after_bus_arrival_plus_leg(arrive, ok):
    raw = p0()  # arrives 13:00; the first leg is a 10-minute walk
    stop(raw, 0, 0)["arrive"] = arrive
    assert found(check(raw)) == ([] if ok else [("before_bus_arrival", at(0, 0, "arrive"))])


@pytest.mark.parametrize("arrive, ok", [("03:30", False), ("04:05", False), ("04:10", True)])
def test_first_stop_after_overnight_arrival(arrive, ok):
    raw = p0(outbound="out-night", days=NIGHT_SAT_DAYS)  # arrives 04:00 Sat
    stop(raw, 0, 0)["arrive"] = arrive
    assert found(check(raw)) == ([] if ok else [("before_bus_arrival", at(0, 0, "arrive"))])


def test_leave_before_arrive_is_stop_times():
    raw = p0()
    stop(raw, 0, 0)["leave"] = "13:20"
    stop(raw, 0, 0)["arrive"] = "13:40"
    assert found(check(raw)) == [("stop_times", at(0, 0, "leave"))]


def test_overlap_with_previous_stop():
    raw = p0()
    stop(raw, 0, 1)["arrive"] = "14:00"  # stop 1 leaves 14:30
    errors = check(raw)
    assert found(errors) == [("overlap", at(0, 1, "arrive"))]
    assert "day 1, stop 2" in errors[0].message  # messages count from 1


def test_stops_out_of_time_order_are_an_overlap():
    raw = p0()
    stop(raw, 1, 1)["arrive"], stop(raw, 1, 1)["leave"] = "09:00", "09:30"  # before stop 1 (10:30 to 13:00)
    assert found(check(raw)) == [("overlap", at(1, 1, "arrive"))]


@pytest.mark.parametrize("arrive, ok", [("14:40", False), ("14:44", False), ("14:45", True)])
def test_gap_must_cover_the_leg_minutes(arrive, ok):
    raw = p0()  # stop 1 leaves 14:30; market to park is 15 minutes
    stop(raw, 0, 1)["arrive"] = arrive
    assert found(check(raw)) == ([] if ok else [("not_enough_travel_time", at(0, 1, "arrive"))])


def test_unknown_leg_minutes_only_need_no_overlap():
    raw = p0()
    stop(raw, 0, 1)["leg"]["last_mile_route_id"] = str(LEG_IDS[("test-market", "test-park", "walk")])
    stop(raw, 0, 1)["arrive"] = "14:30"
    assert check(raw) == []


@pytest.mark.parametrize("leave, ok", [("20:30", True), ("20:31", False)])
def test_last_stop_leaves_30_minutes_before_the_return(leave, ok):
    raw = p0()  # return departs 21:00
    stop(raw, 2, 0)["leave"] = leave
    assert found(check(raw, spots=NO_PARK_HOURS)) == ([] if ok else [("after_return", at(2, 0, "leave"))])


def test_return_before_the_last_day_stops():
    assert found(check(p0(ret="ret-early"))) == [("after_return", at(2, 0, "leave"))]
    raw = p0(ret="ret-early")
    raw["days"][2]["stops"] = []
    assert check(raw) == []


def test_late_stops_on_earlier_days_are_not_checked_against_the_return():
    raw = p0()
    stop(raw, 1, 1)["leave"] = "23:00"
    assert check(raw) == []


# --- B14 opening hours -----------------------------------------------------------------------------

@pytest.mark.parametrize("arrive, leave, ok", [
    ("08:00", "12:00", False),  # opens 09:00 on Sun (it opens 08:00 on Sat: the weekday matters)
    ("10:00", "17:30", False),  # closes 17:00 on Sun
    ("09:00", "17:00", True),  # the edges are inclusive
])
def test_stop_outside_opening_hours_is_closed(arrive, leave, ok):
    raw = p0()  # day 3 is Sun, at test-park
    stop(raw, 2, 0)["arrive"], stop(raw, 2, 0)["leave"] = arrive, leave
    assert found(check(raw)) == ([] if ok else [("closed", at(2, 0))])


@pytest.mark.parametrize("hours, ok", [
    ({"fri": []}, False),  # listed as closed
    ({"fri": ["14:00", "18:00"]}, False),
    ({"fri": ["13:30", "14:30"]}, True),
    ({"fri": ["06:00", "24:00"]}, True),  # 24:00 is a valid close
    ({"fri": ["15:00", "24:00"]}, False),
    ({"sat": ["10:00", "14:00"]}, True),  # no fri key: unknown, no check
    ({}, True),
    ({"fri": ["22:00", "02:00"]}, True),  # close before open (overnight): unknown
    ({"fri": ["8am", "6pm"]}, True),  # malformed: unknown
    ({"fri": "closed"}, True),  # malformed: unknown
    ({"fri": ["13:00"]}, True),  # malformed: unknown
])
def test_opening_hours_rules(hours, ok):
    spots = dict(SPOT_REFS)
    spots["test-market"] = dataclasses.replace(SPOT_REFS["test-market"], opening_hours=hours)
    raw = p0()  # day 1 is Fri; test-market 13:30 to 14:30
    assert found(check(raw, spots=spots)) == ([] if ok else [("closed", at(0, 0))])


@pytest.mark.parametrize("tz", ["America/Los_Angeles", "Pacific/Kiritimati"])
def test_weekday_comes_from_the_date_not_the_clock(monkeypatch, tz):
    monkeypatch.setenv("TZ", tz)
    time_mod.tzset()
    try:
        raw = p0()
        stop(raw, 2, 0)["arrive"] = "08:00"
        assert found(check(raw)) == [("closed", at(2, 0))]
        assert check(p0()) == []
    finally:
        monkeypatch.undo()
        time_mod.tzset()


# --- B16 all errors, in order, safe to send back ---------------------------------------------------

def messy_plan() -> dict:
    raw = p0(outbound="out-weekends", ret="ret-weekdays")
    stop(raw, 0, 1)["leg"]["last_mile_route_id"] = str(uuid4())
    stop(raw, 1, 1)["arrive"] = "12:00"
    return raw


def test_every_error_comes_back_in_plan_order():
    # Manager decision (ticket.md): plan position first (outbound, the days, then return)
    raw = messy_plan()
    errors = check(raw)
    assert found(errors) == [
        ("trip_not_running", "outbound.trip_id"),
        ("unknown_leg", at(0, 1, LEG_PATH)),
        ("overlap", at(1, 1, "arrive")),
        ("trip_not_running", "return.trip_id"),
    ]
    assert check(copy.deepcopy(raw)) == errors  # deterministic (messages may name the bad ids)


def test_errors_sort_by_plan_position_then_check_order():
    """An earlier stop's timing error comes before a later stop's id error. Within one stop the
    fixed check order holds (ids, then times, then the return, then hours), whatever the sub-path."""
    raw = p0(outbound="out-weekends", ret="ret-weekdays")
    stop(raw, 0, 1)["arrive"] = "14:00"  # timing (overlap) on day 1, stop 2
    stop(raw, 1, 0)["leg"]["last_mile_route_id"] = str(uuid4())  # id error on day 2, stop 1
    last = stop(raw, 2, 0)  # Sun at test-park, open 09:00 to 17:00; return bus at 21:00
    last["leg"]["last_mile_route_id"] = str(uuid4())
    last["arrive"], last["leave"] = "08:00", "20:45"
    assert found(check(raw)) == [
        ("trip_not_running", "outbound.trip_id"),
        ("overlap", at(0, 1, "arrive")),
        ("unknown_leg", at(1, 0, LEG_PATH)),
        ("unknown_leg", at(2, 0, LEG_PATH)),
        ("after_return", at(2, 0, "leave")),
        ("closed", at(2, 0)),
        ("trip_not_running", "return.trip_id"),
    ]


def test_day_list_errors_sit_between_outbound_and_the_stops():
    raw = p0(outbound="out-inactive")
    raw["days"].pop()  # bad_days, at "days"
    stop(raw, 0, 1)["leg"]["last_mile_route_id"] = str(uuid4())
    assert found(check(raw, return_date=SAT)) == [
        ("trip_inactive", "outbound.trip_id"),
        ("bad_days", "days"),
        ("unknown_leg", at(0, 1, LEG_PATH)),
        ("wrong_date", "return.date"),
    ]


def test_return_errors_keep_check_order_within_the_return():
    raw = p0(ret="ret-inactive", ret_date=date(2026, 11, 5))
    errors = found(check(raw, return_date=SUN))
    tail = [e for e in errors if e[1].startswith("return")]
    assert tail == [("trip_inactive", "return.trip_id"), ("wrong_date", "return.date"), ("dates_out_of_order", "return.date")]
    assert errors[-3:] == tail  # the return is last


def test_errors_are_safe_to_log_and_send_to_the_model():
    errors = check(messy_plan())
    assert {e.code for e in errors} <= ERROR_CODES
    for e in errors:
        assert isinstance(e.path, str) and isinstance(e.message, str) and e.message
        for banned in ("select ", "Traceback", "postgres", "psycopg"):
            assert banned not in e.message
    json.dumps([dataclasses.asdict(e) for e in errors])


# --- B17 / 2.3 schedule helpers --------------------------------------------------------------------

def test_main_arrival_is_the_shared_helper():
    assert main._arrival is schedule.arrival
    assert schedule.arrival(FRI, time(7, 0), 360) == ("13:00", 0)
    assert schedule.arrival(FRI, time(22, 0), 360) == ("04:00", 1)
    assert schedule.arrival(FRI, time(9, 0), None) == (None, None)


def test_postgres_dow():
    assert [schedule.postgres_dow(d) for d in (FRI, SAT, SUN)] == [5, 6, 0]


@pytest.mark.parametrize("days, vfrom, vto, d, expected", [
    (DAILY, None, None, SUN, True),
    ([0, 6], None, None, FRI, False),
    ([0, 6], None, None, SAT, True),
    ([1, 2, 3, 4, 5], None, None, SUN, False),
    (DAILY, SAT, None, SAT, True),
    (DAILY, SAT, None, FRI, False),
    (DAILY, None, SAT, SAT, True),
    (DAILY, None, SAT, SUN, False),
])
def test_runs_on(days, vfrom, vto, d, expected):
    assert schedule.runs_on(days, vfrom, vto, d) is expected


def test_to_minutes():
    assert [schedule.to_minutes(t) for t in ("00:00", "13:05", "23:59", "24:00")] == [0, 785, 1439, 1440]


@pytest.mark.parametrize("hours, d, expected", [
    (None, FRI, None),
    ({}, FRI, None),
    ({"fri": ["08:00", "18:00"]}, FRI, (480, 1080)),
    ({"sun": ["09:00", "17:00"]}, SUN, (540, 1020)),
    ({"sun": ["09:00", "17:00"]}, SAT, None),
    ({"fri": []}, FRI, "closed"),
    ({"fri": ["18:00", "24:00"]}, FRI, (1080, 1440)),
    ({"fri": ["22:00", "02:00"]}, FRI, None),
    ({"fri": ["8am", "6pm"]}, FRI, None),
    ({"fri": "closed"}, FRI, None),
])
def test_hours_on(hours, d, expected):
    assert schedule.hours_on(hours, d) == expected


def test_validator_imports_no_web_or_db_modules():
    """V20: TG-20's spike and the loader can import the validator without FastAPI, the pool or app.main."""
    for name in ("plan_validation.py", "schedule.py"):
        tree = ast.parse((API / "app" / name).read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                mods = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                mods = [("." * node.level) + (node.module or "")] + [f".{a.name}" for a in node.names if node.level and not node.module]
            else:
                continue
            for m in mods:
                assert m.split(".")[0] not in {"fastapi", "starlette", "psycopg_pool"}, (name, m)
                assert m not in {".main", ".db", ".premade", ".last_mile"}, (name, m)
    code = (
        "import sys, app.plan_validation; "
        "print([m for m in ('fastapi', 'starlette', 'psycopg_pool', 'app.main', 'app.db') if m in sys.modules])"
    )
    out = subprocess.run([sys.executable, "-c", code], cwd=API, capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == "[]"


# --- validate_plan against loaded rows -------------------------------------------------------------

@pytest.fixture()
def rows(dsn, tmp_path):
    load_rows(dsn, tmp_path / "csv")
    return dsn


def counts(dsn):
    with psycopg.connect(dsn) as conn:
        return [conn.execute(f"select count(*) from {t}").fetchone()[0] for t in ("itineraries", "trips", "spots", "last_mile_routes")]


def test_validate_plan_against_loaded_rows(rows):
    before = counts(rows)
    raw = db_p0(rows)
    with psycopg.connect(rows) as conn:  # plain tuple rows, as the loader uses
        result = validate_plan(conn, raw, trip_date=FRI, return_date=SUN)
    assert result.errors == [] and result.ok
    assert result.plan.to_json() == raw
    with psycopg.connect(rows, row_factory=dict_row) as conn:  # dict rows, as the API pool uses
        assert validate_plan(conn, raw).ok
    assert counts(rows) == before  # it only reads


def test_validate_plan_accepts_text_bytes_and_a_plan(rows):
    raw = db_p0(rows)
    plan = Plan.model_validate(raw)
    with psycopg.connect(rows) as conn:
        assert validate_plan(conn, json.dumps(raw)).ok
        assert validate_plan(conn, json.dumps(raw).encode()).ok
        result = validate_plan(conn, plan)  # review nit 5: no re-parse
        assert result.ok
        assert result.plan is plan


def test_validate_plan_ids_are_case_insensitive(rows):
    raw = db_p0(rows)
    upper = copy.deepcopy(raw)
    upper["outbound"]["trip_id"] = upper["outbound"]["trip_id"].upper()
    upper["return"]["trip_id"] = upper["return"]["trip_id"].upper()
    for day in upper["days"]:
        for s in day["stops"]:
            s["spot_id"] = s["spot_id"].upper()
            s["leg"]["last_mile_route_id"] = s["leg"]["last_mile_route_id"].upper()
    with psycopg.connect(rows) as conn:
        assert validate_plan(conn, upper).errors == []
        assert validate_plan(conn, json.dumps(upper)).errors == []


def test_validate_plan_unknown_ids_from_db(rows):
    raw = db_p0(rows)
    raw["return"]["trip_id"] = str(uuid4())
    stop(raw, 0, 1)["leg"]["last_mile_route_id"] = str(uuid4())
    stop(raw, 2, 0)["spot_id"] = str(uuid4())
    with psycopg.connect(rows) as conn:
        errors = found(validate_plan(conn, raw).errors)
    assert ("unknown_trip", "return.trip_id") in errors
    assert ("unknown_leg", at(0, 1, LEG_PATH)) in errors
    assert ("unknown_spot", at(2, 0, "spot_id")) in errors


def test_validate_plan_inactive_trip_from_db(rows):
    raw = db_p0(rows)
    with psycopg.connect(rows, autocommit=True) as conn:
        conn.execute("update trips set is_active = false where id = %s", (raw["outbound"]["trip_id"],))
        assert found(validate_plan(conn, raw).errors) == [("trip_inactive", "outbound.trip_id")]


def test_validate_plan_null_travel_minutes_from_db(rows):
    trips, _, _ = db_ids(rows)
    raw = db_p0(rows)
    raw["outbound"]["trip_id"] = str(trips[("vl-cubao", "09:00", "deluxe")])
    with psycopg.connect(rows) as conn:
        assert found(validate_plan(conn, raw).errors) == [("arrival_unknown", "outbound.trip_id")]


def test_validate_plan_opening_hours_from_db(rows):
    raw = db_p0(rows)
    stop(raw, 2, 0)["arrive"] = "08:00"  # Sun at test-park
    with psycopg.connect(rows, autocommit=True) as conn:
        assert validate_plan(conn, raw).ok  # no hours yet: no check
        conn.execute("update spots set opening_hours = %s::jsonb where slug = 'test-park'", [json.dumps(PARK_HOURS)])
        assert found(validate_plan(conn, raw).errors) == [("closed", at(2, 0))]


def test_load_refs_reads_what_the_checks_need(rows):
    trips, spots, legs = db_ids(rows)
    plan = Plan.model_validate(db_p0(rows))
    with psycopg.connect(rows) as conn:
        r = load_refs(conn, plan)
        terminal = dict(conn.execute("select slug, id from terminals").fetchall())
    out = r.trips[trips[("vl-cubao", "07:00", "regular_aircon")]]
    assert out.is_active is True
    assert out.departure_time == time(7, 0)
    assert out.travel_minutes == 360
    assert out.days_of_week == DAILY
    assert (out.valid_from, out.valid_to) == (None, None)
    assert (out.origin_terminal_id, out.origin_city) == (terminal["vl-cubao"], "Quezon City")
    assert (out.destination_terminal_id, out.destination_city) == (terminal["vl-baguio"], "Baguio")
    assert r.spots[spots["test-park"]].name == "Test Park (made up)"
    assert r.spots[spots["test-park"]].slug == "test-park"
    leg = r.legs[legs[("vl-baguio", "test-market", "walk")]]
    assert leg.start == ("terminal", terminal["vl-baguio"])
    assert leg.end == ("spot", spots["test-market"])
    assert leg.minutes == 10
    assert all(isinstance(k, UUID) for k in [*r.trips, *r.spots, *r.legs])
    assert set(r.spots) == {spots[s] for s in ("test-park", "test-market", "test-cafe", "test-lodge")}


def test_validate_plan_logs_one_debug_line(rows, caplog):
    caplog.set_level(logging.DEBUG, logger="tara_gala.api")
    raw = db_p0(rows)
    stop(raw, 0, 1)["leg"]["last_mile_route_id"] = str(uuid4())
    with psycopg.connect(rows) as conn:
        validate_plan(conn, raw)
    lines = [r.getMessage() for r in caplog.records if r.name == "tara_gala.api" and r.getMessage().startswith("plan validation")]
    assert len(lines) == 1
    assert lines[0].startswith("plan validation errors=1 codes=") and "unknown_leg" in lines[0]


EDGE_TRIPS = TRIPS + (
    "solid-north,sn-cubao,sn-baguio,,luxury,1000,300,,,08:00,daily,2026-11-07,2026-11-08,"
    "https://example.test/schedule,2026-10-24,made up for tests only\n"
)


def test_runs_on_agrees_with_trip_search(client, dsn, tmp_path):
    """plan.md 2.3: the Python twin of /trips' SQL date filter (Sun, Sat, both valid_* edges, and after)."""
    load_rows(dsn, tmp_path / "csv", trips=EDGE_TRIPS)
    with psycopg.connect(dsn) as conn:
        rows_ = conn.execute("select id, days_of_week, valid_from, valid_to from trips where is_active").fetchall()
    for d in (date(2026, 11, 1), FRI, SAT, SUN, date(2026, 11, 9)):
        r = client.get("/trips", params={"date": d.isoformat()})
        assert r.status_code == 200, r.text
        api = {UUID(t["trip_id"]) for t in r.json()}
        py = {tid for tid, days, vf, vt in rows_ if schedule.runs_on(days, vf, vt, d)}
        assert api == py, d


def test_dates_at_the_end_of_the_calendar_do_not_raise():
    """Security pass: validate_plan never raises for bad input, even when the arrival overflows the calendar."""
    end = date.max.isoformat()
    raw = p0(outbound="out-night", days=[])
    raw["outbound"]["date"] = raw["return"]["date"] = end
    errors = found(check(raw))
    assert ("bad_days", "days") in errors
    assert validate_plan(NoDBRows(), raw).ok is False


class NoDBRows:
    """A connection whose queries return no rows (every id unknown)."""

    def cursor(self, **kw):
        class Cur:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def execute(self, *a, **k):
                pass

            def fetchall(self):
                return []
        return Cur()


@pytest.mark.parametrize("hours, warns", [
    ({"fri": ["8am", "6pm"]}, True),  # present but unreadable: skipped, so say so
    ({"fri": ["22:00", "02:00"]}, True),
    (["06:00", "18:00"], True),  # not a dict at all
    ({"sat": ["10:00", "14:00"]}, False),  # no fri key: unknown, not broken
    (None, False),
    ({"fri": ["06:00", "18:00"]}, False),
])
def test_unreadable_opening_hours_log_a_warning(caplog, hours, warns):
    """Log pass: a malformed hours value is skipped like unknown hours, but not silently."""
    caplog.set_level(logging.WARNING, logger="tara_gala.api")
    spots = dict(SPOT_REFS)
    spots["test-market"] = dataclasses.replace(SPOT_REFS["test-market"], opening_hours=hours)
    assert check(p0(), spots=spots) == []  # day 1 (Fri) at test-market
    lines = [r.getMessage() for r in caplog.records if r.name == "tara_gala.api" and r.levelno == logging.WARNING]
    expected = [f"spot opening_hours unreadable spot_id={SPOT_IDS['test-market']} day=fri"] if warns else []
    assert lines == expected


# --- audit F1: a return that leaves before the party can arrive ------------------------------------

def test_return_before_the_bus_arrives_with_no_days_is_bad_days():
    """Probe A: 22:00 Fri arrives 04:00 Sat, but the return is the 21:00 Fri bus and days is []."""
    errors = check(p0(outbound="out-night", ret="ret", ret_date=FRI, days=[]))
    assert found(errors) == [("bad_days", "days")]
    assert "before the bus arrives" in errors[0].message


def test_return_before_the_bus_arrives_with_days_listed_is_bad_days():
    errors = check(p0(outbound="out-night", ret="ret", ret_date=FRI, days=[(1, [])]))
    assert found(errors) == [("bad_days", "days")]


@pytest.mark.parametrize("ret, ok", [
    ("ret-early", False),  # Probe B: 06:00 Fri, before the 13:00 Fri arrival
    ("ret-1329", False),  # inside the 30-minute buffer
    ("ret-1330", True),
    ("ret", True),
])
def test_return_after_arrival_when_the_last_day_has_no_stops(ret, ok):
    errors = check(p0(ret=ret, ret_date=FRI, days=[(1, [])]))
    assert found(errors) == ([] if ok else [("after_return", "return.trip_id")])


def test_return_check_without_stops_ignores_earlier_days():
    """Only an empty last day needs the trip-level check; stops on it are checked as before."""
    raw = p0(ret="ret-early")
    raw["days"][2]["stops"] = []
    assert check(raw) == []  # Sun 06:00 is long after the Fri arrival
