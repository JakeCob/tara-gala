"""TG-61 S1 to S9: the suggestion's pure parts (api/app/plan_suggest.py, options.md §5). S10, the route, is in
test_trip_places.py, next to the trip places it reads. No database here.
"""

import math

import pytest

from app import plan_suggest as ps
from app.plan_suggest import Stop


def t(hhmm: str) -> int:
    return ps.minutes(hhmm)


def stop(key: str, hhmm: str, stay: int = 60, bus: bool = False, plan: str | None = None) -> Stop:
    return Stop(key=key, time=t(hhmm), stay=stay, bus=bus, plan=plan or f"Stop {key}")


# ---------------------------------------------------------------- S1: distance

def test_haversine_against_known_pairs():  # S1
    assert math.isclose(ps.haversine_km((0.0, 0.0), (0.0, 1.0)), 111.195, abs_tol=0.01), "one degree on the equator, R = 6371 km"
    assert math.isclose(ps.haversine_km((48.8566, 2.3522), (51.5074, -0.1278)), 343.5, abs_tol=0.5), "Paris to London"
    assert ps.haversine_km((16.41, 120.59), (16.41, 120.59)) == 0
    burnham, session_road = (16.408010, 120.595985), (16.409260, 120.598831)
    assert 0.3 < ps.haversine_km(burnham, session_road) < 0.4


# ---------------------------------------------------------------- S2: walk and taxi (owner D1)

@pytest.mark.parametrize("straight, mode, minutes, km", [
    (0.0, "walk", 5, 0.0),  # never 0 minutes
    (0.5, "walk", 15, 0.7),  # 0.7 km road at 4 km/h = 10.5 min, up to 15
    (0.857, "walk", 20, 1.2),  # 1.2 km road: the last walk, 18 min up to 20
    (0.9, "taxi", 10, 1.3),  # 1.26 km road: 5 + 3.8 min, up to 10
    (2.2, "taxi", 15, 3.1),  # 3.08 km: 5 + 9.2, up to 15
    (10.0, "taxi", 50, 14.0),  # 14 km: 5 + 42, up to 50
])
def test_the_estimate_bands_and_rounding(straight, mode, minutes, km):  # S2, B22
    leg = ps.estimate(straight)
    assert leg == {"kind": "estimate", "mode": mode, "minutes": minutes, "km": km}
    assert "fare" not in str(leg) and "jeep" not in str(leg), "no fare and no jeep in an estimate"


def test_an_estimate_stays_inside_the_saved_legs_bounds():  # S2
    assert ps.estimate(140.0)["minutes"] == 595, "196 km by road: 5 + 588 min, up to 595"
    assert ps.estimate(400.0) is None, "over 600 minutes is no estimate: the plan check allows 1 to 600"
    for km in (0.0, 0.3, 1.0, 5.0, 50.0, 140.0):
        leg = ps.estimate(km)
        assert 1 <= leg["minutes"] <= 600 and 0 <= leg["km"] <= 1000 and leg["minutes"] % 5 == 0


# ---------------------------------------------------------------- S3 and S4: which leg

def test_no_pin_at_either_end_gives_no_leg():  # S3
    assert ps.pick_leg([], None, (16.41, 120.59)) is None
    assert ps.pick_leg([], (16.41, 120.59), None) is None
    assert ps.pick_leg([], (16.41, 120.59), (16.42, 120.60))["kind"] == "estimate"


def route(rid: str, minutes: int | None, mode: str = "jeepney") -> dict:
    return {"id": rid, "mode": mode, "minutes": minutes, "fare_min_php": 13, "fare_max_php": 15, "signboard": "Synthetic",
            "last_verified_at": "2026-10-26T00:00:00+08:00"}


def test_a_route_on_file_wins_with_the_lowest_minutes():  # S4, B21
    routes = [route("b", 25), route("a", 12, "taxi"), route("c", None), route("d", 12)]
    leg = ps.pick_leg(routes, (16.41, 120.59), (16.42, 120.60))
    assert leg == {"kind": "route", "last_mile_route_id": "a", "mode": "taxi", "minutes": 12, "fare_min_php": 13, "fare_max_php": 15,
                   "signboard": "Synthetic", "last_verified_at": "2026-10-26T00:00:00+08:00"}, "a tie on minutes goes to the lower id"
    assert ps.pick_leg([route("c", None)], None, None)["last_mile_route_id"] == "c", "a route needs no pins"
    assert ps.travel(None) == 15 and ps.travel(leg) == 12 and ps.travel(ps.pick_leg([route("c", None)], None, None)) == 15


# ---------------------------------------------------------------- S5: the slot

def test_the_slot_after_a_stop():  # S5
    prev = stop("d1-03", "14:00")
    assert ps.slot_after(prev, t("14:30"), 10) == t("14:45"), "30 min there (the gap), 10 to travel, up to the quarter hour"
    assert ps.slot_after(prev, t("17:00"), 10) == t("15:15"), "an hour there (its stay), not the whole gap"
    assert ps.slot_after(prev, None, 15) == t("15:15"), "the last stop of the day: its stay"
    assert ps.slot_after(stop("d1-03", "14:00", stay=90), None, 0) == t("15:30")
    assert ps.slot_after(stop("d1-09", "23:30"), None, 15) == t("23:45"), "never past 23:45"
    assert ps.slot_after(prev, t("13:00"), 0) == t("14:00"), "out of order: no negative stay"


def test_the_slot_first_of_the_day():  # S5
    assert ps.slot_first(None, 60) == t("09:00"), "an empty day"
    assert ps.slot_first(stop("d2-01", "10:00"), 60) == t("08:45"), "its stay and 15 min of travel before the first row"
    assert ps.slot_first(stop("d2-01", "10:10"), 60) == t("08:45"), "down to the quarter hour"
    assert ps.slot_first(stop("d2-01", "00:30"), 60) == 0


# ---------------------------------------------------------------- S6 to S8: the ripple

def test_no_ripple_when_it_fits():  # S6
    assert ps.ripple([stop("d1-05", "17:00")], t("16:00")) == ([], [])
    assert ps.ripple([], t("23:00")) == ([], [])


def test_the_ripple_shifts_until_a_gap_absorbs_it():  # S6, B23
    after = [stop("d1-05", "15:00"), stop("d1-06", "16:15"), stop("d1-07", "18:30"), stop("d1-08", "19:45")]
    shifts, notes = ps.ripple(after, t("15:45"))  # 45 min over
    # d1-05 had 75 min: 60 there + 15 to travel, no slack, so d1-06 moves 45 too. d1-06 had 135 - 75 = 60 slack: absorbed.
    assert shifts == [{"key": "d1-05", "time": "15:45"}, {"key": "d1-06", "time": "17:00"}]
    assert notes == []


def test_a_tight_day_carries_the_shift_but_never_grows_it():  # S6
    after = [stop("d1-05", "15:00"), stop("d1-06", "15:30"), stop("d1-07", "16:00")]
    shifts, _ = ps.ripple(after, t("15:20"))
    assert [s["time"] for s in shifts] == ["15:20", "15:50", "16:20"], "rows 30 min apart keep their spacing, shifted by 20"


def test_a_bus_row_never_moves_and_the_last_stops_before_it_are_dropped():  # S7, B23
    after = [stop("d3-08", "14:00", plan="Pasalubong"), stop("d3-09", "15:00", plan="Snack"), stop("d3-10", "16:15", bus=True, plan="Bus home")]
    shifts, notes = ps.ripple(after, t("15:00"))  # 60 min over: d3-08 to 15:00, d3-09 to 16:00, which runs into the 4:15 PM bus
    assert {"key": "d3-10", "drop": True} not in shifts and all(s["key"] != "d3-10" for s in shifts), "the bus row is never touched"
    assert shifts == [{"key": "d3-08", "time": "15:00"}, {"key": "d3-09", "drop": True}]
    assert notes == ["The 4:15 PM bus can't move."]


def test_when_nothing_fits_before_the_bus_every_movable_row_is_dropped():  # S7
    after = [stop("d3-08", "14:00"), stop("d3-09", "14:30"), stop("d3-10", "15:00", bus=True)]
    shifts, notes = ps.ripple(after, t("16:00"))
    assert shifts == [{"key": "d3-08", "drop": True}, {"key": "d3-09", "drop": True}]
    assert notes == ["The 3:00 PM bus can't move."]
    assert ps.ripple([stop("d3-10", "15:00", bus=True)], t("16:00")) == ([], ["The 3:00 PM bus can't move."])


def test_the_ripple_stops_at_a_bus_row_and_never_reaches_past_it():  # S7
    after = [stop("d1-02", "08:00", bus=True), stop("d1-03", "08:30")]
    shifts, notes = ps.ripple(after, t("07:00"))
    assert (shifts, notes) == ([], []), "fits before the bus; the rows after it are another part of the day"


def test_the_day_never_runs_past_23_00():  # S8, B23
    after = [stop("d1-07", "21:00", plan="Night market"), stop("d1-08", "22:00", plan="Ukay"), stop("d1-09", "22:15", plan="Late snack")]
    shifts, notes = ps.ripple(after, t("22:00"))  # 60 over: 22:00, 23:00, and 23:15 is past 23:00
    assert shifts == [{"key": "d1-07", "time": "22:00"}, {"key": "d1-08", "time": "23:00"}, {"key": "d1-09", "drop": True}]
    assert notes == ["The day can't run past 11:00 PM."]


# ---------------------------------------------------------------- S9: far, and the change lines

def test_far_is_over_25_km_and_the_distance_is_rounded():  # S9, B24
    assert ps.far(26) and not ps.far(25) and not ps.far(3)
    assert ps.about_km(240.4) == 240 and ps.about_km(123) == 120 and ps.about_km(125) == 130, "to 10 km over 100 km"
    assert ps.about_km(87.4) == 87 and ps.about_km(99.6) == 100 and ps.about_km(0.4) == 0
    manila = (14.6091, 121.0223)
    km = ps.haversine_km(ps.BAGUIO_CENTRE, manila)
    assert 190 < km < 220 and ps.far(km)


def test_the_change_lines_name_the_stop_and_the_rows_it_moves():  # S9
    rows = {"d1-04": stop("d1-04", "13:00", plan="Lunch at the market"), "d1-05": stop("d1-05", "15:00", plan="Burnham Park"),
            "d1-06": stop("d1-06", "16:00", plan="Session Road")}
    lines = ps.change_lines(1, "after", "Kapihan sa Ulap", t("14:15"), rows["d1-04"], [{"key": "d1-05", "time": "15:30"}, {"key": "d1-06", "drop": True}], rows)
    assert lines == [
        {"word": "New", "day": 1, "text": "Kapihan sa Ulap at 2:15 PM", "part": "stop"},
        {"word": "Later", "day": 1, "text": "Burnham Park to 3:30 PM", "part": "ripple"},
        {"word": "Dropped", "day": 1, "text": "Session Road", "part": "ripple"},
    ]
    lines = ps.change_lines(2, "replace", None, t("09:00"), rows["d1-04"], [], rows)
    assert lines == [{"word": "Out", "day": 2, "text": "Lunch at the market", "part": "stop"},
                     {"word": "In", "day": 2, "text": "New stop at 9:00 AM", "part": "stop"}]


def test_more_than_three_ripple_lines_end_with_more():  # S9, options §3.5
    rows = {f"d1-0{i}": stop(f"d1-0{i}", f"1{i}:00", plan=f"Stop {i}") for i in range(1, 7)}
    ripple = [{"key": k, "time": "23:00"} for k in rows]
    lines = ps.change_lines(1, "after", "X" * 80, t("12:00"), None, ripple, rows)
    assert [l["word"] for l in lines] == ["New", "Later", "Later", "Later", "More"]
    assert lines[-1] == {"word": "More", "day": None, "text": "and 3 more changes", "part": "ripple"}
    assert all(len(l["text"]) <= 120 for l in lines)
    long = ps.change_lines(1, "after", "Y" * 80, t("12:00"), None, [{"key": "d1-01", "time": "23:00"}],
                           {"d1-01": stop("d1-01", "11:00", plan="Z" * 120)})
    assert all(len(l["text"]) <= 120 for l in long)


def test_times_read_as_the_app_writes_them():
    assert [ps.clock12(t(x)) for x in ("00:05", "09:00", "12:00", "12:30", "16:15", "23:45")] == \
        ["12:05 AM", "9:00 AM", "12:00 PM", "12:30 PM", "4:15 PM", "11:45 PM"]
    assert ps.hhmm(t("07:05")) == "07:05" and ps.minutes("23:59") == 1439
