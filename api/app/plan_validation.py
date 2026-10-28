"""The shared plan validator (TG-24 plan.md 2.2), used by the pre-made loader and TG-20's planner.

validate_plan() parses the CLAUDE.md "Planner output shape", loads the rows it references and
returns every problem as a PlanError(code, path, message). It never raises for bad input; DB
errors propagate. No FastAPI, pool or app.main import, so scripts and spikes can use it as is.
"""

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date as Date
from datetime import time, timedelta
from typing import Annotated, Any, Literal
from uuid import UUID

from psycopg.rows import dict_row
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError

from . import schedule

logger = logging.getLogger("tara_gala.api")

ERROR_CODES = frozenset({
    "shape", "unknown_trip", "trip_inactive", "trip_not_running", "wrong_direction", "wrong_date",
    "dates_out_of_order", "arrival_unknown", "bad_days", "unknown_spot", "unknown_leg",
    "leg_wrong_end", "leg_wrong_start", "stop_times", "before_bus_arrival", "overlap",
    "not_enough_travel_time", "after_return", "closed",
})
RETURN_BUFFER_MINUTES = 30  # last stop must leave this long before the return bus departs
BAGUIO = "Baguio"
MODEL_PREMADE = "premade"  # itineraries.model for hand-made plans; here so the loader needs no FastAPI

# Structured outputs may not enforce this pattern; validate_plan stays the authority.
HHMM = Annotated[str, StringConstraints(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")]


class BusLeg(BaseModel):
    model_config = ConfigDict(extra="forbid")
    trip_id: UUID
    date: Date


class StopLeg(BaseModel):
    model_config = ConfigDict(extra="forbid")
    last_mile_route_id: UUID


class Stop(BaseModel):
    model_config = ConfigDict(extra="forbid")
    spot_id: UUID
    arrive: HHMM
    leave: HHMM
    leg: StopLeg


class Day(BaseModel):
    model_config = ConfigDict(extra="forbid")
    day: int
    stops: list[Stop]


class Plan(BaseModel):
    """The CLAUDE.md "Planner output shape", exactly."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    outbound: BusLeg
    return_: BusLeg = Field(alias="return")
    days: list[Day]

    def to_json(self) -> dict:
        """What gets stored in itineraries.plan and returned by APIs."""
        return self.model_dump(mode="json", by_alias=True)


@dataclass(frozen=True)
class PlanError:
    code: str  # stable, from ERROR_CODES
    path: str  # "outbound.trip_id", "days[1].stops[0].leg.last_mile_route_id", "" for the whole plan
    message: str  # one plain sentence: ids, times, day and stop numbers, spot names; never party data

    def __str__(self) -> str:
        return f"{self.path}: {self.message}" if self.path else self.message


@dataclass(frozen=True)
class ValidationResult:
    plan: Plan | None  # None only when the shape is invalid
    errors: list[PlanError]

    @property
    def ok(self) -> bool:
        return self.plan is not None and not self.errors


Place = tuple[Literal["terminal", "spot"], UUID]


@dataclass(frozen=True)
class TripRef:
    trip_id: UUID
    is_active: bool
    departure_time: time
    travel_minutes: int | None
    days_of_week: list[int]
    valid_from: Date | None
    valid_to: Date | None
    origin_terminal_id: UUID
    origin_city: str
    destination_terminal_id: UUID
    destination_city: str


@dataclass(frozen=True)
class SpotRef:
    spot_id: UUID
    slug: str
    name: str
    opening_hours: dict | None


@dataclass(frozen=True)
class LegRef:
    last_mile_route_id: UUID
    start: Place
    end: Place
    minutes: int | None


@dataclass(frozen=True)
class Refs:
    trips: dict[UUID, TripRef]
    spots: dict[UUID, SpotRef]
    legs: dict[UUID, LegRef]


# --- parsing -------------------------------------------------------------------------------------

def loc_path(loc) -> str:
    """A Pydantic error loc as a path: ("days", 0, "stops", 1, "arrive") -> "days[0].stops[1].arrive"."""
    path = ""
    for part in loc:
        path += f"[{part}]" if isinstance(part, int) else (f".{part}" if path else str(part))
    return path


def parse_plan(raw: Mapping[str, Any] | str | bytes) -> tuple[Plan | None, list[PlanError]]:
    try:
        if isinstance(raw, (str, bytes)):
            return Plan.model_validate_json(raw), []
        return Plan.model_validate(raw), []
    except ValidationError as e:
        details = e.errors(include_url=False, include_input=False)
        if any(d["type"] == "json_invalid" for d in details):
            return None, [PlanError("shape", "", "the plan is not valid JSON")]
        return None, [PlanError("shape", loc_path(d["loc"]), d["msg"]) for d in details]


# --- loading -------------------------------------------------------------------------------------

def load_refs(conn, plan: Plan) -> Refs:
    """The rows the plan references, in three queries. Trips are read from the tables, not the
    trip_search view, so an inactive trip can be told apart from an unknown one."""
    trip_ids = [plan.outbound.trip_id, plan.return_.trip_id]
    stops = [s for day in plan.days for s in day.stops]
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            """
            select t.id, t.is_active, t.departure_time, r.travel_minutes, t.days_of_week, t.valid_from, t.valid_to,
                   r.origin_terminal_id, o.city as origin_city, r.destination_terminal_id, d.city as destination_city
            from trips t
            join routes r on r.id = t.route_id
            join terminals o on o.id = r.origin_terminal_id
            join terminals d on d.id = r.destination_terminal_id
            where t.id = any(%s)
            """,
            (trip_ids,),
        )
        trips = {
            r["id"]: TripRef(
                trip_id=r["id"], is_active=r["is_active"], departure_time=r["departure_time"],
                travel_minutes=r["travel_minutes"], days_of_week=list(r["days_of_week"]),
                valid_from=r["valid_from"], valid_to=r["valid_to"],
                origin_terminal_id=r["origin_terminal_id"], origin_city=r["origin_city"],
                destination_terminal_id=r["destination_terminal_id"], destination_city=r["destination_city"],
            )
            for r in cur.fetchall()
        }
        cur.execute("select id, slug, name, opening_hours from spots where id = any(%s)", ([s.spot_id for s in stops],))
        spots = {
            r["id"]: SpotRef(spot_id=r["id"], slug=r["slug"], name=r["name"], opening_hours=r["opening_hours"])
            for r in cur.fetchall()
        }
        cur.execute(
            """
            select id, from_terminal_id, from_spot_id, to_terminal_id, to_spot_id, minutes
            from last_mile_routes where id = any(%s)
            """,
            ([s.leg.last_mile_route_id for s in stops],),
        )
        legs = {
            r["id"]: LegRef(
                last_mile_route_id=r["id"],
                start=("terminal", r["from_terminal_id"]) if r["from_terminal_id"] else ("spot", r["from_spot_id"]),
                end=("terminal", r["to_terminal_id"]) if r["to_terminal_id"] else ("spot", r["to_spot_id"]),
                minutes=r["minutes"],
            )
            for r in cur.fetchall()
        }
    return Refs(trips=trips, spots=spots, legs=legs)


# --- checks --------------------------------------------------------------------------------------

def _clock(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


class _Errors:
    """Collects errors with their plan position: outbound, the days list, each stop in order, then
    return. Sorting by position is stable, so the check order holds within a position."""

    OUTBOUND, DAYS, RETURN = (0,), (1,), (2,)

    def __init__(self) -> None:
        self._items: list[tuple[tuple, PlanError]] = []

    def add(self, position: tuple, code: str, path: str, message: str) -> None:
        self._items.append((position, PlanError(code, path, message)))

    def sorted(self) -> list[PlanError]:
        return [e for _, e in sorted(self._items, key=lambda item: item[0])]


def _check_trip(errors: _Errors, name: str, leg: BusLeg, trip: TripRef | None, expected_date: Date | None) -> None:
    position = _Errors.OUTBOUND if name == "outbound" else _Errors.RETURN
    path = f"{name}.trip_id"
    if trip is None:
        errors.add(position, "unknown_trip", path, f"{name} trip {leg.trip_id} does not exist")
        return
    if not trip.is_active:
        errors.add(position, "trip_inactive", path, f"{name} trip {leg.trip_id} is no longer active")
    if not schedule.runs_on(trip.days_of_week, trip.valid_from, trip.valid_to, leg.date):
        errors.add(position, "trip_not_running", path, f"{name} trip {leg.trip_id} does not run on {leg.date}")
    # Every non-Baguio terminal in the seed is in Metro Manila; this avoids importing main's city list.
    if name == "outbound":
        right_way = trip.destination_city == BAGUIO != trip.origin_city
        want = "go to Baguio"
    else:
        right_way = trip.origin_city == BAGUIO != trip.destination_city
        want = "leave from Baguio"
    if not right_way:
        errors.add(position, "wrong_direction", path, f"the {name} trip must {want}")
    if expected_date is not None and leg.date != expected_date:
        errors.add(position, "wrong_date", f"{name}.date", f"the {name} date must be {expected_date}, not {leg.date}")


def check_plan(plan: Plan, refs: Refs, *, trip_date: Date | None = None, return_date: Date | None = None) -> list[PlanError]:
    """Every problem with the plan against refs, sorted by plan position, then check order."""
    errors = _Errors()
    outbound = refs.trips.get(plan.outbound.trip_id)
    ret = refs.trips.get(plan.return_.trip_id)

    # 1. Trips
    _check_trip(errors, "outbound", plan.outbound, outbound, trip_date)
    _check_trip(errors, "return", plan.return_, ret, return_date)
    if plan.return_.date < plan.outbound.date:
        errors.add(_Errors.RETURN, "dates_out_of_order", "return.date",
                   f"the return date {plan.return_.date} is before the outbound date {plan.outbound.date}")

    # 2. Arrival and 3. days: day 1 is the day the bus arrives, so an overnight bus makes it the next day
    arrive_at: int | None = None
    day_dates: list[Date] | None = None
    if outbound is not None:
        try:
            hhmm, offset = schedule.arrival(plan.outbound.date, outbound.departure_time, outbound.travel_minutes)
            day1 = plan.outbound.date + timedelta(days=offset or 0)
        except OverflowError:  # arrives after 9999-12-31; bad input must not raise
            errors.add(_Errors.DAYS, "bad_days", "days", "the dates are out of range")
        else:
            if hhmm is None:
                errors.add(_Errors.OUTBOUND, "arrival_unknown", "outbound.trip_id",
                           f"outbound trip {plan.outbound.trip_id} has no travel time, so its arrival is unknown")
            else:
                arrive_at = schedule.to_minutes(hhmm)
                n = (plan.return_.date - day1).days + 1
                if [d.day for d in plan.days] == list(range(1, n + 1)):
                    day_dates = [day1 + timedelta(days=i) for i in range(n)]
                elif n >= 1:
                    errors.add(_Errors.DAYS, "bad_days", "days",
                               f"days must be numbered 1 to {n} ({day1} to {plan.return_.date}), one per day")
                else:
                    errors.add(_Errors.DAYS, "bad_days", "days",
                               f"the return on {plan.return_.date} is before the bus arrives on {day1}")

    numbered = [(di, si, s) for di, day in enumerate(plan.days) for si, s in enumerate(day.stops)]

    def where(di, si) -> tuple[tuple, str, str]:
        return (1, di, si), f"days[{di}].stops[{si}]", f"day {di + 1}, stop {si + 1}"

    # 4. Ids
    for di, si, s in numbered:
        pos, path, label = where(di, si)
        if s.spot_id not in refs.spots:
            errors.add(pos, "unknown_spot", f"{path}.spot_id", f"{label}: spot {s.spot_id} does not exist")
        if s.leg.last_mile_route_id not in refs.legs:
            errors.add(pos, "unknown_leg", f"{path}.leg.last_mile_route_id",
                       f"{label}: last-mile route {s.leg.last_mile_route_id} does not exist")

    # 5. Continuity: the party starts at the arrival terminal and is wherever the last stop was,
    # across days, so day 2 starts at the lodging if day 1 ended there. The return bus may leave
    # from a different Baguio terminal than the one they arrived at; that's allowed on purpose.
    position: Place | None = ("terminal", outbound.destination_terminal_id) if outbound is not None else None
    for di, si, s in numbered:
        pos, path, label = where(di, si)
        leg = refs.legs.get(s.leg.last_mile_route_id)
        if leg is not None:
            if leg.end != ("spot", s.spot_id):
                errors.add(pos, "leg_wrong_end", f"{path}.leg.last_mile_route_id",
                           f"{label}: the last-mile route does not end at this stop's spot")
            if position is not None and leg.start != position:
                errors.add(pos, "leg_wrong_start", f"{path}.leg.last_mile_route_id",
                           f"{label}: the last-mile route does not start where the party is (the previous stop, or the arrival terminal on day 1)")
        position = ("spot", s.spot_id)

    if day_dates is None:  # 6 to 8 need the day dates
        return errors.sorted()

    def leg_minutes(s: Stop) -> int:
        leg = refs.legs.get(s.leg.last_mile_route_id)
        return leg.minutes if leg is not None and leg.minutes else 0

    # 6. Times within each day; a plan never crosses midnight within a day
    for di, day in enumerate(plan.days):
        previous_leave: int | None = None
        for si, s in enumerate(day.stops):
            pos, path, label = where(di, si)
            arrive, leave = schedule.to_minutes(s.arrive), schedule.to_minutes(s.leave)
            if leave < arrive:
                errors.add(pos, "stop_times", f"{path}.leave", f"{label}: leaves at {s.leave}, before it arrives at {s.arrive}")
            if di == 0 and si == 0:
                earliest = arrive_at + leg_minutes(s)
                if arrive < earliest:
                    errors.add(pos, "before_bus_arrival", f"{path}.arrive",
                               f"{label}: the bus arrives around {_clock(arrive_at)}, so arrive at {_clock(earliest)} or later")
            elif previous_leave is not None:
                if arrive < previous_leave:
                    errors.add(pos, "overlap", f"{path}.arrive",
                               f"{label}: arrives at {s.arrive}, before the previous stop ends at {_clock(previous_leave)}")
                elif arrive < previous_leave + (travel := leg_minutes(s)):
                    errors.add(pos, "not_enough_travel_time", f"{path}.arrive",
                               f"{label}: the trip here takes {travel} minutes, so arrive at {_clock(previous_leave + travel)} or later")
            previous_leave = leave

    # 7. Return: no final leg in the shape, so a fixed buffer stands in for the ride to the terminal
    if ret is not None and plan.days and plan.days[-1].stops:
        di, si = len(plan.days) - 1, len(plan.days[-1].stops) - 1
        last = plan.days[-1].stops[-1]
        latest = ret.departure_time.hour * 60 + ret.departure_time.minute - RETURN_BUFFER_MINUTES
        if schedule.to_minutes(last.leave) > latest:
            pos, path, label = where(di, si)
            errors.add(pos, "after_return", f"{path}.leave",
                       f"{label}: the return bus leaves at {ret.departure_time:%H:%M}, so leave by {_clock(latest)}")

    # 8. Opening hours, when known
    for di, si, s in numbered:
        spot = refs.spots.get(s.spot_id)
        if spot is None:
            continue
        hours = schedule.hours_on(spot.opening_hours, day_dates[di])
        if hours is None:
            day_key = schedule.DAY_KEYS[schedule.postgres_dow(day_dates[di])]
            raw_hours = spot.opening_hours
            if raw_hours is not None and (not isinstance(raw_hours, dict) or raw_hours.get(day_key) is not None):
                # present but unreadable, so it's skipped like unknown hours; fix the spot row
                logger.warning("spot opening_hours unreadable spot_id=%s day=%s", s.spot_id, day_key)
            continue
        pos, path, label = where(di, si)
        if hours == "closed":
            errors.add(pos, "closed", path, f"{label}: {spot.name} is closed on {day_dates[di]:%a %Y-%m-%d}")
        elif not (hours[0] <= schedule.to_minutes(s.arrive) and schedule.to_minutes(s.leave) <= hours[1]):
            errors.add(pos, "closed", path,
                       f"{label}: {spot.name} is open {_clock(hours[0])} to {_clock(hours[1])} on {day_dates[di]:%a}; visit within those hours")

    return errors.sorted()


def validate_plan(conn, raw: Plan | Mapping[str, Any] | str | bytes, *,
                  trip_date: Date | None = None, return_date: Date | None = None) -> ValidationResult:
    """Parse, load the referenced rows, check. Never raises for bad input; DB errors propagate."""
    if isinstance(raw, Plan):
        plan, errors = raw, []
    else:
        plan, errors = parse_plan(raw)
    if plan is not None:
        errors = check_plan(plan, load_refs(conn, plan), trip_date=trip_date, return_date=return_date)
    logger.debug("plan validation errors=%d codes=%s", len(errors), ",".join(sorted({e.code for e in errors})) or "-")
    return ValidationResult(plan=plan, errors=errors)
