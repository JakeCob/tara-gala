"""TG-61 BF1 to BF12, BF15 and BF16: "Where does it fit?" (options.md §5.5, plan.md §15), on small hand-made days.
best_fit is pure, so no database here. BF13 and BF14 need the route and are in test_trip_places.py.

Pins sit on one meridian, so each estimate is easy to check: 0.01° of latitude is 1.112 km, 1.557 km by road, a
10-minute taxi; 0.0005° is a 5-minute walk; 0.02° is 15 minutes, 0.03° is 20.
"""

from datetime import time
from uuid import uuid4

import pytest

from app import guide as guides
from app import plan_suggest as ps


def t(hhmm: str) -> int:
    return ps.minutes(hhmm)


def at(dlat: float) -> tuple[float, float]:
    return (round(16.4 + dlat, 6), 120.6)


LODGE = at(0)


def row(key, hhmm, pin=None, *, place=None, stay=60, bus=None, lodging=False, fixed=False, cond=None, plan=None):
    return ps.FitRow(key=key, time=t(hhmm), stay=stay, bus=bus is not None, plan=plan or f"Stop {key}", fixed=fixed,
                     pin=pin, place_id=place or (uuid4() if pin else None), lodging=lodging, cond=cond, bus_kind=bus)


def bed(key, hhmm="20:30", pin=LODGE):
    return row(key, hhmm, pin, lodging=True)


def day(n, *rows):
    return ps.FitDay(day=n, rows=list(rows))


def fits(days, pin, *, stay=60, far=False, legs_from=None, blocked=None, picked=None, lodging_pin=LODGE, today=None,
         now_min=None, name="Made-up Shop"):
    out, _ = ps.best_fit(days, pin, stay, name=name, far=far, legs_from=legs_from or {}, blocked=blocked or {},
                         picked=picked or {}, lodging_pin=lodging_pin, today=today, now_min=now_min)
    return out


def where(found) -> list[tuple[int, str]]:
    return [(f.day, f.after) for f in found]


def ripple_keys(found) -> set[str]:
    return {m["key"] for f in found for m in f.ripple}


# ---------------------------------------------------------------- BF1: the best fit

def test_bf1_the_best_fit_is_after_the_nearest_stop_with_a_time_a_leg_and_no_ripple():  # B51
    days = [
        day(1, row("d1-01", "09:00", at(0.03)), row("d1-02", "13:00", at(0.04)), bed("d1-03")),
        day(2, row("d2-01", "09:00", at(0.10)), row("d2-02", "13:00", at(0.12)), bed("d2-03")),
    ]
    best = fits(days, at(0.1005))[0]
    assert (best.day, best.after, best.time) == (2, "d2-01", "10:15"), "an hour at d2-01, a 5-minute walk, up to the quarter hour"
    assert best.leg.model_dump() == {"kind": "estimate", "mode": "walk", "minutes": 5, "km": 0.1}
    assert best.ripple == [] and best.notes == [ps.ESTIMATE_NOTE]
    assert best.reason.model_dump() == {"kind": "near_stops", "near_key": "d2-01", "near_km": 0.1, "free_min": 90, "dropped": 0}
    assert [c.model_dump() for c in best.changes] == [{"word": "New", "day": 2, "text": "Made-up Shop at 10:15 AM", "part": "stop"}]
    assert best.condition is None


# ---------------------------------------------------------------- BF2: the buses

def test_bf2_nothing_on_the_bus_up():  # B52
    days = [day(1, row("d1-01", "10:15", at(-1.8), bus="outbound"), row("d1-02", "12:00", plan="Stopover"),
                row("d1-03", "14:15", at(0.01)), row("d1-04", "16:00", at(0.02)), bed("d1-05"))]
    got = fits(days, at(0.0105), blocked={1: [(t("10:15"), t("14:15"))]})
    assert got and not {"d1-01", "d1-02"} & {f.after for f in got}, "the bus row, and the stopover at 1:15 PM is still on the bus"
    for f in got:
        assert t(f.time) >= t("14:15")


def test_bf2_nothing_before_the_bus_up_unless_the_place_is_far():  # B52
    manila = at(-1.8)
    days = [day(1, row("d1-01", "07:00", manila), row("d1-02", "10:15", manila, bus="outbound"),
                row("d1-03", "14:15", at(0.01)), row("d1-04", "16:00", at(0.02)), bed("d1-05"))]
    blocked = {1: [(t("10:15"), t("14:15"))]}
    near_manila = (manila[0] + 0.0005, manila[1])
    assert "d1-01" not in {f.after for f in fits(days, near_manila, blocked=blocked)}
    best = fits(days, near_manila, blocked=blocked, far=True)[0]
    assert (best.after, best.time) == ("d1-01", "08:15"), "a stop in Manila, well before the bus"


def test_bf2_nothing_within_30_minutes_of_the_bus_home_or_after_it():  # B52
    days = [day(1, row("d1-01", "09:00", at(0.03)), row("d1-02", "14:00", at(0.01)), row("d1-03", "15:45", at(0.01)),
                row("d1-04", "16:15", at(0.01), bus="return"), row("d1-05", "20:00", at(0.01), plan="After the bus"))]
    got = fits(days, at(0.0105), blocked={1: [(t("16:15") - 30, 24 * 60)]})
    assert where(got) == [(1, "d1-01")], "after d1-02 the stop runs to 4:15 PM, into the 30 minutes before the bus"


# ---------------------------------------------------------------- BF3: the check-in row

def test_bf3_no_fit_moves_or_drops_the_check_in_row():  # B53
    days = [day(1, row("d1-01", "12:00", at(0.03)), row("d1-02", "13:30", plan="Snack"),
                row("d1-03", "15:00", LODGE, lodging=True, fixed=True), row("d1-04", "16:30", at(0.02)), bed("d1-05"))]
    got = fits(days, at(0.0305))
    assert "d1-03" not in ripple_keys(got)
    first = next(f for f in got if f.after == "d1-01")
    assert first.ripple == [{"key": "d1-02", "drop": True}]
    assert first.notes == [ps.ESTIMATE_NOTE, "The 3:00 PM check-in can't move."]
    assert first.reason.dropped == 1
    assert "d1-02" not in {f.after for f in got}, "after the snack it would run into the check-in"


def test_bf3_the_tap_flows_ripple_walls_on_the_check_in_row_too():  # B53
    snack = ps.Stop(key="d1-02", time=t("13:30"), stay=60, bus=False, plan="Snack")
    check_in = ps.Stop(key="d1-03", time=t("15:00"), stay=60, bus=False, plan="Check in", fixed=True)
    later = ps.Stop(key="d1-04", time=t("16:30"), stay=60, bus=False, plan="Park")
    assert ps.ripple([snack, check_in, later], t("14:30")) == ([{"key": "d1-02", "drop": True}], ["The 3:00 PM check-in can't move."])
    assert ps.Stop(key="d1-01", time=0, stay=60, bus=False, plan="x").fixed is False, "a stop isn't fixed unless it's the check-in"


# ---------------------------------------------------------------- BF4: bedtime

def test_bf4_the_last_row_of_a_day_at_the_lodging_is_never_an_anchor():  # B54
    days = [day(1, row("d1-01", "13:00", LODGE, lodging=True, plan="Rest"), bed("d1-02", "20:00"))]
    assert where(fits(days, at(0.0005))) == [(1, "d1-01")], "a lodging row mid-day is ordinary; bedtime isn't an anchor"
    days = [day(1, row("d1-01", "20:00", at(0.0005), plan="Night market"))]
    assert where(fits(days, at(0.0005))) == [(1, "d1-01")], "the last row is an anchor when it isn't at the lodging"


# ---------------------------------------------------------------- BF5: the pick

SUNRISE_A, SUNRISE_B = ("sunrise", "A", "show_if"), ("sunrise", "B", "show_if")


def sunrise_day():
    return day(2, row("d2-01", "04:45", at(0.05), cond=SUNRISE_A), row("d2-02", "05:15", at(0.02), cond=SUNRISE_B),
               row("d2-03", "07:30", plan="Breakfast"), row("d2-04", "10:00", at(0.02)), bed("d2-05"))


def test_bf5_once_b_is_picked_option_a_rows_are_never_anchors_or_neighbours():  # B55
    got = fits([sunrise_day()], at(0.0505), picked={"sunrise": "B"})
    assert got and "d2-01" not in {f.after for f in got} | ripple_keys(got) | {f.reason.near_key for f in got}
    after_b = next(f for f in got if f.after == "d2-02")
    assert after_b.condition.model_dump(by_alias=True) == {"pick": "sunrise", "is": "B", "kind": "show_if"}, "the anchor's own condition"


def test_bf5_before_the_pick_a_fit_after_an_a_row_carries_a():  # B55
    got = fits([sunrise_day()], at(0.0505))
    best = got[0]
    assert (best.after, best.condition.model_dump(by_alias=True)) == ("d2-01", {"pick": "sunrise", "is": "A", "kind": "show_if"})
    assert "d2-02" not in ripple_keys([best]), "its neighbours are the rows that show with A"
    assert best.time == "06:00", "4:45 plus an hour (the next row with A is 7:30), plus a 5-minute walk, up to 6:00"


def test_bf5_no_fit_at_the_fork():  # B55
    fork = day(3, row("d3-01", "06:00", at(0.01)), row("d3-02", "07:00", at(0.06), cond=("sunrise", "B", "hide_if")),
               row("d3-03", "09:00", at(0.02)), bed("d3-04"))
    assert "d3-01" not in {f.after for f in fits([fork], at(0.0105))}, "its next stop would depend on the pick"
    assert "d3-01" in {f.after for f in fits([fork], at(0.0105), picked={"sunrise": "A"})}, "the pick is made: no fork"


# ---------------------------------------------------------------- BF6: picking 3

def roomy(n):
    return day(n, row(f"d{n}-01", "09:00"), row(f"d{n}-02", "13:00"), bed(f"d{n}-03", pin=None))


def test_bf6_three_days_give_three_days():  # B56
    assert sorted(f.day for f in fits([roomy(1), roomy(2), roomy(3)], None)) == [1, 2, 3]


def test_bf6_one_day_gives_anchors_that_arent_neighbours():  # B56
    one = day(1, *(row(f"d1-0{i + 1}", f"{6 + 3 * i:02d}:00") for i in range(5)), bed("d1-06", "22:00", pin=None))
    got = fits([one], None)
    assert [f.after for f in got] == ["d1-01", "d1-03", "d1-05"]


def test_bf6_no_candidate_is_an_empty_list():  # B56
    out, stats = ps.best_fit([day(1, bed("d1-01"))], at(0.01), 60, name="x", far=False, legs_from={}, blocked={}, picked={},
                             lodging_pin=LODGE, today=None, now_min=None)
    assert out == [] and stats == {"candidates": 1, "excluded": 1, "best_day": None}


# ---------------------------------------------------------------- BF7: no pin

def test_bf7_a_place_with_no_pin_ranks_by_free_time_alone():  # B57
    tight = day(1, row("d1-01", "09:00", at(0.0005)), row("d1-02", "10:30", at(0.0005)), bed("d1-03", "12:00"))
    got = fits([tight, roomy(2)], None)
    assert got[0].day == 2, "the tight day's slots run over; the roomy day's don't"
    for f in got:
        assert (f.reason.kind, f.reason.near_key, f.reason.near_km, f.leg) == ("free_time", None, None, None)


# ---------------------------------------------------------------- BF8: the score

def test_bf8_the_detour_and_the_score_in_fixed_numbers():
    assert ps.detour(at(0), at(0.01), at(0.02)) == 10 + 10 - 15, "on the way: only the rounding"
    assert ps.detour(at(0), at(0.03), at(0)) == 20 + 20 - 5, "out and back"
    assert ps.detour(None, at(0.01), at(0.03)) == 15 and ps.detour(at(0.01), None, at(0.03)) == 0
    assert ps.score(5, 0, 0, False) == 5 and ps.score(0, 30, 0, False) == 30
    assert ps.score(0, 0, 1, False) == 90 and ps.score(0, 0, 0, True) == 15 and ps.score(10, 20, 2, True) == 225


def test_bf8_detour_beats_overflow_beats_a_drop():
    n = at(0.01)
    days = [
        day(1, row("d1-01", "09:00", n), row("d1-02", "10:30", n, lodging=True, plan="Late check")),  # 5 + 60 over
        day(2, row("d2-01", "09:00", at(0.03)), row("d2-02", "20:30", lodging=True)),  # a 15-minute detour
        day(3, row("d3-01", "09:00", n), row("d3-02", "10:30", plan="Snack"), row("d3-03", "11:45", n, bus="return")),  # 5 + 60 + a drop
    ]
    got = fits(days, n, lodging_pin=None)
    assert where(got) == [(2, "d2-01"), (1, "d1-01"), (3, "d3-01")]
    assert [(f.reason.free_min, f.reason.dropped) for f in got] == [(540, 0), (-60, 0), (-60, 1)]
    assert got[1].ripple == [{"key": "d1-02", "time": "11:30"}] and got[2].ripple == [{"key": "d3-02", "drop": True}]


# ---------------------------------------------------------------- BF9: ties

def test_bf9_ties_go_to_the_earlier_day_then_the_earlier_time():
    got = fits([roomy(1), roomy(2)], None)
    assert where(got) == [(1, "d1-01"), (2, "d2-01")], "d1-02 and d2-02 tie too, but sit next to a chosen anchor"


# ---------------------------------------------------------------- BF10: the lodging's pin

def test_bf10_a_day_with_no_pinned_rows_falls_back_to_the_lodging():
    plain = day(1, row("d1-01", "09:00", plan="Breakfast"), row("d1-02", "13:00", plan="Lunch"))
    best = fits([plain], at(0.0005))[0]
    assert best.reason.model_dump() == {"kind": "near_hotel", "near_key": None, "near_km": 0.1, "free_min": 90, "dropped": 0}
    best = fits([plain], at(0.0005), lodging_pin=None)[0]
    assert (best.reason.kind, best.reason.near_key, best.reason.near_km) == ("free_time", None, None)


def test_bf10_the_lodging_row_is_the_neighbour_by_name():
    days = [day(1, row("d1-01", "09:00", at(0.05)), row("d1-02", "13:00", LODGE, lodging=True, plan="Rest"), bed("d1-03", "20:00"))]
    best = fits(days, at(0.0005))[0]
    assert (best.reason.kind, best.reason.near_key) == ("near_hotel", "d1-02")


# ---------------------------------------------------------------- BF11: a route on file

def test_bf11_a_known_route_is_preferred_for_the_leg_in():
    park = uuid4()
    days = [day(1, row("d1-01", "09:00", at(0.02), place=park), bed("d1-02")), day(2, row("d2-01", "09:00", at(0.02)), bed("d2-02"))]
    route = {"id": uuid4(), "mode": "jeepney", "minutes": 25, "fare_min_php": 13, "fare_max_php": 15, "signboard": "Made-up",
             "last_verified_at": None}
    got = fits(days, at(0.0205), legs_from={park: [route]})
    best = next(f for f in got if f.after == "d1-01")
    assert (best.leg.kind, best.leg.last_mile_route_id, best.leg.minutes) == ("route", route["id"], 25)
    assert best.time == "10:30" and best.notes == [], "9:00 plus an hour plus 25 on the jeep, up to 10:30"
    other = next(f for f in got if f.after == "d2-01")
    assert other.leg.kind == "estimate", "the route starts at the park, not at d2-01's place"


# ---------------------------------------------------------------- BF12: the bus windows

def guide_with(booked: bool) -> guides.Guide:
    out_id, home_id = uuid4(), uuid4()
    raw = {
        "title": "Made-up", "budget": {},
        "getting_there": {"title": "Up", "buses": [{"trip_id": str(out_id), "date": "2026-11-06", "booked": booked}]},
        "getting_home": {"title": "Home", "buses": [{"trip_id": str(home_id), "date": "2026-11-08", "booked": booked}]},
        "days": [
            {"day": 1, "title": "One", "rows": [{"key": "d1-01", "time": "10:15", "plan": "Bus", "bus": "outbound"},
                                                {"key": "d1-02", "time": "14:30", "plan": "Arrive"}]},
            {"day": 2, "title": "Two", "rows": [{"key": "d2-01", "time": "09:00", "plan": "Walk"}]},
            {"day": 3, "title": "Three", "rows": [{"key": "d3-01", "time": "16:00", "plan": "Bus home", "bus": "return"}]},
        ],
    }
    g, problems = guides.parse_guide(raw)
    assert not problems, problems
    return g


def test_bf12_the_booked_trips_give_the_windows():
    g = guide_with(booked=True)
    trips = {g.getting_there.buses[0].trip_id: {"departure_time": time(10, 15), "travel_minutes": 240},
             g.getting_home.buses[0].trip_id: {"departure_time": time(16, 15), "travel_minutes": 240}}
    assert ps._windows(trips, g) == {1: [(t("10:15"), t("14:15"))], 3: [(t("16:15") - 30, 24 * 60)]}


def test_bf12_a_table_with_no_booked_bus_blocks_only_the_departure_minute():
    g = guide_with(booked=False)
    assert ps._windows({}, g) == {1: [(t("10:15"), t("10:15"))], 3: [(t("16:00") - 30, 24 * 60)]}, "the bus rows' own times"
    days = [day(1, row("d1-01", "10:15", at(-1.8), bus="outbound"), row("d1-02", "12:00", plan="Stopover"),
                row("d1-03", "16:00", at(0.01)), bed("d1-04"))]
    got = fits(days, at(0.0105), blocked=ps._windows({}, g))
    assert "d1-02" in {f.after for f in got}, "no arrival is known, so 1:15 PM isn't blocked"
    assert "d1-01" not in {f.after for f in got}, "but never after the bus row itself"


# ---------------------------------------------------------------- BF15: during the trip

def test_bf15_no_past_day_and_nothing_within_15_minutes_of_now():  # B59
    days = [roomy(1), day(2, *(row(f"d2-0{i + 1}", f"{9 + 2 * i:02d}:00") for i in range(4)), bed("d2-05", pin=None)), roomy(3)]
    got = fits(days, None, today=2, now_min=t("13:00"))
    assert got and all(f.day >= 2 for f in got)
    assert all(t(f.time) >= t("13:15") for f in got if f.day == 2)
    assert (2, "d2-04") in where(got)
    assert where(fits(days, None))[0] == (1, "d1-01"), "outside the trip, every day counts"


# ---------------------------------------------------------------- BF16: the reason

@pytest.mark.parametrize("new, kind, near_key", [
    (at(0.0605), "near_stops", "d1-01"),
    (at(0.0005), "near_hotel", "d1-02"),
    (at(0.20), "free_time", "d1-01"),  # 15.6 km from the nearest pin: past 3 km
    (None, "free_time", None),
])
def test_bf16_the_reasons_kind(new, kind, near_key):
    [best] = fits([day(1, row("d1-01", "13:00", at(0.06)), bed("d1-02"))], new)
    assert (best.reason.kind, best.reason.near_key) == (kind, near_key)
    near_km = None if new is None else round(min(ps.haversine_km(new, at(0.06)), ps.haversine_km(new, LODGE)), 1)
    assert best.reason.near_km == near_km
