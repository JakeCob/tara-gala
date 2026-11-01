"""An itinerary's guide (TG-52): the day tables, bus tables, sunrise pick, budget, to-do list and sources around the
checked plan. The owner's real trip is the first one (data/itineraries/, loaded by data/load_itinerary.py).

The guide sits next to the CLAUDE.md plan in itineraries.plan, under "guide". The plan stays the planner's strict shape
(plan_validation.py); the guide is checked here. It never carries a bus time or fare: bus rows name a trip by id, and
the API fills in the trip row (time, class, fare, last checked) from the schedule data. Places name a spot or a
terminal by id, and get their names here. Day rows have stable keys, which the trip's checklist ticks point at.
"""

import logging
from datetime import date as Date
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError

from .models import Trip
from .trip_rows import trip_from_row

logger = logging.getLogger("tara_gala.api")

ROW_KEY = r"^d[1-9]-\d{2}$"
TODO_KEY = r"^todo-\d{2}$"
HHMM = r"^([01]\d|2[0-3]):[0-5]\d$"
Text = Annotated[str, StringConstraints(max_length=300)]
Short = Annotated[str, StringConstraints(min_length=1, max_length=120)]


class _M(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Place(_M):
    spot_id: UUID | None = None
    terminal_id: UUID | None = None


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


def parse_guide(raw) -> tuple[Guide | None, list[str]]:
    """The guide, or the problems ("<path>: <message>"). Keys must be unique, so a tick can't land on two rows."""
    try:
        g = Guide.model_validate(raw)
    except ValidationError as e:
        return None, [f"{'.'.join(str(x) for x in d['loc'])}: {d['msg']}" for d in e.errors(include_url=False, include_input=False)]
    keys = [r.key for d in g.days for r in d.rows] + [t.key for t in g.todo]
    dupes = sorted({k for k in keys if keys.count(k) > 1})
    problems = [f"key {k}: used more than once" for k in dupes]
    for d in g.days:
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
    kind: Literal["spot", "terminal"]
    id: UUID
    name: str | None  # None if the row is gone
    category: str | None  # a spot's category (its map icon); None for a terminal
    lodging: bool  # the guide's lodging: drawn as the hotel


class RowOut(BaseModel):
    key: str
    time: str
    plan: str
    note: str
    place: PlaceOut | None
    bus: str | None
    show_if: dict | None
    hide_if: dict | None


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


def spot_ids(g: Guide) -> set[UUID]:
    places = [r.place for d in g.days for r in d.rows] + [o.place for d in g.days if d.pick for o in d.pick.options] + [g.lodging]
    return {p.spot_id for p in places if p and p.spot_id}


def build(g: Guide, trips: dict, spots: dict, terminal_names: dict) -> GuideOut:
    """The guide with its trips and places filled in. `trips` are TRIP_ROWS_SQL rows by trip id; `spots` are
    last_mile.Spot rows by id."""
    home = g.lodging.spot_id if g.lodging else None

    def place(p: Place | None) -> PlaceOut | None:
        if p is None:
            return None
        if p.spot_id:
            s = spots.get(p.spot_id)
            return PlaceOut(kind="spot", id=p.spot_id, name=s.name if s else None, category=s.category if s else None, lodging=p.spot_id == home)
        if p.terminal_id:
            return PlaceOut(kind="terminal", id=p.terminal_id, name=terminal_names.get(p.terminal_id), category=None, lodging=False)
        return None

    def table(t: BusTable) -> BusTableOut:
        return BusTableOut(
            title=t.title, intro=t.intro, tips=t.tips,
            buses=[BusRowOut(trip_id=b.trip_id, date=b.date, note=b.note, booked=b.booked,
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
            rows=[RowOut(key=r.key, time=r.time, plan=r.plan, note=r.note, place=place(r.place), bus=r.bus,
                         show_if=r.show_if.model_dump(by_alias=True) if r.show_if else None,
                         hide_if=r.hide_if.model_dump(by_alias=True) if r.hide_if else None) for r in d.rows],
        ) for d in g.days],
    )


def mark_keys(g: Guide) -> set[str]:
    """Every checklist key a trip may tick: "row:<row key>" for a day row, "todo:<nn>" for a to-do."""
    return {f"row:{r.key}" for d in g.days for r in d.rows} | {f"todo:{t.key.removeprefix('todo-')}" for t in g.todo}


def pick_options(g: Guide) -> dict[str, set[str]]:
    return {d.pick.key: {o.id for o in d.pick.options} for d in g.days if d.pick}


