"""An itinerary's guide (TG-52): the day tables, bus tables, sunrise pick, budget, to-do list and sources around the
checked plan. The owner's real trip is the first one (data/itineraries/, loaded by data/load_itinerary.py).

The guide sits next to the CLAUDE.md plan in itineraries.plan, under "guide". The plan stays the planner's strict shape
(plan_validation.py); the guide is checked here. It never carries a bus time or fare: bus rows name a trip by id, and
the API fills in the trip row (time, class, fare, last checked) from the schedule data. Places name a spot or a
terminal by id, and get their names here. Day rows have stable keys, which the trip's checklist ticks point at.
"""

import logging
from datetime import date as Date
from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError, model_validator

from .models import Trip
from .schedule import runs_on
from .trip_rows import trip_from_row

logger = logging.getLogger("tara_gala.api")

ROW_KEY = r"^d[1-9]-\d{2}$"
TODO_KEY = r"^todo-\d{2}$"
HHMM = r"^([01]\d|2[0-3]):[0-5]\d$"
Text = Annotated[str, StringConstraints(max_length=300)]
Short = Annotated[str, StringConstraints(min_length=1, max_length=120)]


class _M(BaseModel):
    model_config = ConfigDict(extra="forbid")


class GuidePlace(_M):
    spot_id: UUID | None = None
    terminal_id: UUID | None = None
    trip_place_id: UUID | None = None  # TG-61: a place this trip added from a Google Maps link (trip_places)

    @model_validator(mode="after")
    def _one(self):
        if sum(x is not None for x in (self.spot_id, self.terminal_id, self.trip_place_id)) > 1:
            raise ValueError("a place names one spot, terminal or trip place")
        return self


Place = GuidePlace  # TG-61: named GuidePlace so its schema doesn't clash with last_mile.Place in the OpenAPI spec


class Estimate(_M):
    """TG-61: how to get to a row's place when no route is on file, from the distance. Walk or taxi only, never a fare."""
    mode: Literal["walk", "taxi"]
    minutes: int = Field(ge=1, le=600)
    km: float = Field(ge=0, le=1000, allow_inf_nan=False)


class LegRef(_M):
    """TG-61: how to get to a row's place from the row before: a last_mile_routes row, or an estimate."""
    last_mile_route_id: UUID | None = None
    estimate: Estimate | None = None

    @model_validator(mode="after")
    def _one(self):
        if (self.last_mile_route_id is None) == (self.estimate is None):
            raise ValueError("a leg is a route or an estimate")
        return self


class Condition(_M):
    pick: Annotated[str, StringConstraints(pattern=r"^[a-z]+$")]
    is_: Annotated[str, StringConstraints(pattern=r"^[A-Z]$")] = Field(alias="is")


class Row(_M):
    key: Annotated[str, StringConstraints(pattern=ROW_KEY)]
    time: Annotated[str, StringConstraints(pattern=HHMM)]
    plan: Short
    note: Text = ""
    place: Place | None = None
    bus: Literal["outbound", "return"] | None = None
    show_if: Condition | None = None
    hide_if: Condition | None = None
    leg: LegRef | None = None  # TG-61: set when a stop is added or replaced with a suggestion


class Option(_M):
    id: Annotated[str, StringConstraints(pattern=r"^[A-Z]$")]
    label: Short
    leave: Annotated[str, StringConstraints(pattern=HHMM)]
    what: Text = ""
    place: Place | None = None


class Pick(_M):
    key: Annotated[str, StringConstraints(pattern=r"^[a-z]+$")]
    title: Short
    options: list[Option] = Field(min_length=2, max_length=6)


class Day(_M):
    day: int = Field(ge=1, le=31)
    title: Short
    intro: Text = ""
    pick: Pick | None = None
    rows: list[Row] = Field(max_length=40)
    tips: list[Text] = []


class BusRow(_M):
    trip_id: UUID
    date: Date
    note: Annotated[str, StringConstraints(max_length=80)] = ""
    booked: bool = False


class BusTable(_M):
    title: Short
    intro: Text = ""
    buses: list[BusRow] = Field(max_length=40)
    tips: list[Text] = []


class BudgetRow(_M):
    item: Short
    estimate: Annotated[str, StringConstraints(min_length=1, max_length=40)]


class Budget(_M):
    summary: Text = ""
    rows: list[BudgetRow] = []
    excluded: Text = ""


class Todo(_M):
    key: Annotated[str, StringConstraints(pattern=TODO_KEY)]
    text: Short
    done: bool = False  # done in the file (already booked); the trip's ticks are on top


class Source(_M):
    label: Short
    url: Annotated[str, StringConstraints(pattern=r"^https://\S+$", max_length=300)] | None = None


class Guide(_M):
    title: Short
    summary: Text = ""
    lodging: Place | None = None  # where the party sleeps: drawn as the hotel on the progress map
    getting_there: BusTable
    days: list[Day] = Field(min_length=1, max_length=31)
    getting_home: BusTable
    budget: Budget
    todo: list[Todo] = []
    sources: list[Source] = []


def parse_guide(raw, *, keys_follow_days: bool = False) -> tuple[Guide | None, list[str]]:
    """The guide, or the problems ("<path>: <message>"). Keys must be unique, so a tick can't land on two rows.

    TG-61: a row's key is an id once it's made, and it stays when the row moves to another day, so its ticks and
    photos follow it. Only the owner's plan files (load_itinerary.py) still want each key on its own day.
    """
    try:
        g = Guide.model_validate(raw)
    except ValidationError as e:
        return None, [f"{'.'.join(str(x) for x in d['loc'])}: {d['msg']}" for d in e.errors(include_url=False, include_input=False)]
    keys = [r.key for d in g.days for r in d.rows] + [t.key for t in g.todo]
    dupes = sorted({k for k in keys if keys.count(k) > 1})
    problems = [f"key {k}: used more than once" for k in dupes]
    for d in g.days if keys_follow_days else []:
        wrong = [r.key for r in d.rows if not r.key.startswith(f"d{d.day}-")]
        problems += [f"days[{d.day}]: row {k} belongs to another day" for k in wrong]
    picks = {d.pick.key: {o.id for o in d.pick.options} for d in g.days if d.pick}
    for d in g.days:
        for r in d.rows:
            for c in (r.show_if, r.hide_if):
                if c and c.is_ not in picks.get(c.pick, set()):
                    problems.append(f"row {r.key}: no pick {c.pick} option {c.is_}")
    return (g, []) if not problems else (None, problems)


# ---------------------------------------------------------------- what the API returns

class PlaceOut(BaseModel):
    kind: Literal["spot", "terminal", "trip_place"]
    id: UUID
    name: str | None  # None if the row is gone
    category: str | None  # a spot's category (its map icon); None for a terminal
    lodging: bool  # the guide's lodging: drawn as the hotel
    # TG-61: a trip place's own pin and link; None for a spot or a terminal
    lat: float | None = None
    lng: float | None = None
    maps_url: str | None = None


class RouteLegOut(BaseModel):
    """TG-61: a leg on file. Every value is the last_mile_routes row's."""
    kind: Literal["route"] = "route"
    last_mile_route_id: UUID
    mode: str
    minutes: int | None
    fare_min_php: float | None
    fare_max_php: float | None
    signboard: str | None
    last_verified_at: datetime | None


class EstimateLegOut(BaseModel):
    """TG-61: an estimate from the distance, never a fare."""
    kind: Literal["estimate"] = "estimate"
    mode: Literal["walk", "taxi"]
    minutes: int
    km: float


class RowOut(BaseModel):
    key: str
    time: str
    plan: str
    note: str
    place: PlaceOut | None
    bus: str | None
    show_if: dict | None
    hide_if: dict | None
    leg: RouteLegOut | EstimateLegOut | None = None  # TG-61: None when the row has none, or its route is gone


class OptionOut(BaseModel):
    id: str
    label: str
    leave: str
    what: str
    place: PlaceOut | None


class PickOut(BaseModel):
    key: str
    title: str
    options: list[OptionOut]


class DayOut(BaseModel):
    day: int
    title: str
    intro: str
    pick: PickOut | None
    rows: list[RowOut]
    tips: list[str]


class BusRowOut(BaseModel):
    trip_id: UUID
    date: Date
    trip: Trip | None  # from the schedule data; None if the trip row is gone
    note: str
    booked: bool
    # TG-61: why this bus may not run any more, from the schedule data; nothing changes by itself
    warning: Literal["gone", "retired", "not_running"] | None = None


class BusTableOut(BaseModel):
    title: str
    intro: str
    buses: list[BusRowOut]
    tips: list[str]


class GuideOut(BaseModel):
    title: str
    summary: str
    lodging: PlaceOut | None
    getting_there: BusTableOut
    days: list[DayOut]
    getting_home: BusTableOut
    budget: Budget
    todo: list[Todo]
    sources: list[Source]


def trip_ids(g: Guide) -> set[UUID]:
    return {b.trip_id for t in (g.getting_there, g.getting_home) for b in t.buses}


def _places(g: Guide) -> list[Place | None]:
    return [r.place for d in g.days for r in d.rows] + [o.place for d in g.days if d.pick for o in d.pick.options] + [g.lodging]


def spot_ids(g: Guide) -> set[UUID]:
    return {p.spot_id for p in _places(g) if p and p.spot_id}


def terminal_ids(g: Guide) -> set[UUID]:
    return {p.terminal_id for p in _places(g) if p and p.terminal_id}


def trip_place_ids(g: Guide) -> set[UUID]:
    return {p.trip_place_id for p in _places(g) if p and p.trip_place_id}


def leg_ids(g: Guide) -> set[UUID]:
    return {r.leg.last_mile_route_id for d in g.days for r in d.rows if r.leg and r.leg.last_mile_route_id}


def bus_warning(trip_row: dict | None, d: Date) -> str | None:
    """TG-61: "gone" (no trip row), "retired" (is_active false) or "not_running" (not on that date), else None."""
    if trip_row is None:
        return "gone"
    if not trip_row["is_active"]:
        return "retired"
    if not runs_on(trip_row["days_of_week"], trip_row["valid_from"], trip_row["valid_to"], d):
        return "not_running"
    return None


def build(g: Guide, trips: dict, spots: dict, terminal_names: dict, trip_places: dict | None = None, legs: dict | None = None) -> GuideOut:
    """The guide with its trips and places filled in. `trips` are TRIP_ROWS_SQL rows by trip id; `spots` are
    last_mile.Spot rows by id. TG-61: `trip_places` are the trip's own trip_places rows by id (only the trip that
    owns the copy: another trip's place builds as missing), and `legs` are last_mile.LastMileLeg rows by id."""
    home = g.lodging.spot_id if g.lodging else None
    trip_places, legs = trip_places or {}, legs or {}

    def place(p: Place | None) -> PlaceOut | None:
        if p is None:
            return None
        if p.spot_id:
            s = spots.get(p.spot_id)
            return PlaceOut(kind="spot", id=p.spot_id, name=s.name if s else None, category=s.category if s else None, lodging=p.spot_id == home)
        if p.terminal_id:
            return PlaceOut(kind="terminal", id=p.terminal_id, name=terminal_names.get(p.terminal_id), category=None, lodging=False)
        if p.trip_place_id:
            t = trip_places.get(p.trip_place_id)
            return PlaceOut(kind="trip_place", id=p.trip_place_id, name=t["name"] if t else None, category=None, lodging=False,
                            lat=t["lat"] if t else None, lng=t["lng"] if t else None, maps_url=t["maps_url"] if t else None)
        return None

    def leg(x: LegRef | None) -> RouteLegOut | EstimateLegOut | None:
        if x is None:
            return None
        if x.estimate:
            return EstimateLegOut(mode=x.estimate.mode, minutes=x.estimate.minutes, km=x.estimate.km)
        r = legs.get(x.last_mile_route_id)
        return RouteLegOut(last_mile_route_id=r.last_mile_route_id, mode=r.mode, minutes=r.minutes, fare_min_php=r.fare_min_php,
                           fare_max_php=r.fare_max_php, signboard=r.signboard, last_verified_at=r.last_verified_at) if r else None

    def table(t: BusTable) -> BusTableOut:
        return BusTableOut(
            title=t.title, intro=t.intro, tips=t.tips,
            buses=[BusRowOut(trip_id=b.trip_id, date=b.date, note=b.note, booked=b.booked, warning=bus_warning(trips.get(b.trip_id), b.date),
                             trip=trip_from_row(trips[b.trip_id], b.date) if b.trip_id in trips else None) for b in t.buses],
        )

    return GuideOut(
        title=g.title, summary=g.summary, lodging=place(g.lodging), getting_there=table(g.getting_there), getting_home=table(g.getting_home),
        budget=g.budget, todo=g.todo, sources=g.sources,
        days=[DayOut(
            day=d.day, title=d.title, intro=d.intro, tips=d.tips,
            pick=PickOut(key=d.pick.key, title=d.pick.title,
                         options=[OptionOut(id=o.id, label=o.label, leave=o.leave, what=o.what, place=place(o.place)) for o in d.pick.options])
            if d.pick else None,
            rows=[RowOut(key=r.key, time=r.time, plan=r.plan, note=r.note, place=place(r.place), bus=r.bus, leg=leg(r.leg),
                         show_if=r.show_if.model_dump(by_alias=True) if r.show_if else None,
                         hide_if=r.hide_if.model_dump(by_alias=True) if r.hide_if else None) for r in d.rows],
        ) for d in g.days],
    )


def mark_keys(g: Guide) -> set[str]:
    """Every checklist key a trip may tick: "row:<row key>" for a day row, "todo:<nn>" for a to-do."""
    return {f"row:{r.key}" for d in g.days for r in d.rows} | {f"todo:{t.key.removeprefix('todo-')}" for t in g.todo}


def pick_options(g: Guide) -> dict[str, set[str]]:
    return {d.pick.key: {o.id for o in d.pick.options} for d in g.days if d.pick}


