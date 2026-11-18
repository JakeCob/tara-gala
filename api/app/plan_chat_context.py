"""TG-61 PR 2: what the chatbot sees (options.md §7). The current guide, compacted, with its keys; the trip's dates and
party size; the Baguio spots; the trip's own places; the routes from the plan's places; and, for the buses, only the
active trips on the plan's bus dates. Every id the model may name is in here, and nothing else is allowed.

No names (review S4): no party names and no attendee names, only the party's size. The plan's own notes go as
written, and those can name people, which is what the chat's privacy line says. No links and no pins either: a trip
place is its id and name.
"""

import json
from dataclasses import dataclass, field
from datetime import date as Date
from uuid import UUID

from . import guide as guides
from .plan_suggest import BAGUIO_CENTRE, haversine_km
from .schedule import arrival, postgres_dow, to_minutes
from .trip_rows import TRIP_ROWS_SQL

MAX_SPOTS = 80
MAX_ROUTES = 200
MAX_BUSES = 60  # per date and direction
PARTY_TYPES = ("adult", "student", "senior", "pwd", "child")

BUSES_SQL = """
    select trip_id, operator_name, departure_time, travel_minutes, class, fare_php
    from trip_search
    where %(dow)s::smallint = any(days_of_week)
      and (valid_from is null or valid_from <= %(d)s) and (valid_to is null or valid_to >= %(d)s)
      and {direction}
    order by departure_time, operator_name, trip_id
    limit %(cap)s
"""
TO_BAGUIO = "destination_city = 'Baguio' and origin_city <> 'Baguio'"
FROM_BAGUIO = "origin_city = 'Baguio' and destination_city <> 'Baguio'"


@dataclass
class ChatContext:
    text: str  # the sections that go in the user message
    spot_ids: set[UUID] = field(default_factory=set)
    trip_place_ids: set[UUID] = field(default_factory=set)
    trip_ids: set[UUID] = field(default_factory=set)  # the buses it was given
    times: set[int] = field(default_factory=set)  # minutes since midnight: the given buses' departures and arrivals
    amounts: set[float] = field(default_factory=set)  # the given buses' and routes' fares


def _section(tag: str, value) -> str:
    return f"<{tag}>\n{json.dumps(value, ensure_ascii=False, default=str, separators=(',', ':'))}\n</{tag}>"


def _place(p: guides.Place | None) -> str | None:
    if p is None:
        return None
    if p.spot_id:
        return f"spot:{p.spot_id}"
    if p.terminal_id:
        return f"terminal:{p.terminal_id}"
    return f"trip_place:{p.trip_place_id}" if p.trip_place_id else None


def compact(g: guides.Guide) -> dict:
    """The guide with its keys, short enough for every turn."""
    def table(t: guides.BusTable) -> list[dict]:
        return [{"index": i, "trip_id": str(b.trip_id), "date": b.date.isoformat(), "booked": b.booked} for i, b in enumerate(t.buses)]

    return {
        "title": g.title,
        "days": [{
            "day": d.day, "title": d.title,
            "pick": {"key": d.pick.key, "title": d.pick.title,
                     "options": [{"id": o.id, "label": o.label, "leave": o.leave} for o in d.pick.options]} if d.pick else None,
            "rows": [{"key": r.key, "time": r.time, "plan": r.plan, "note": r.note, "place": _place(r.place), "bus": r.bus,
                      **({"show_if": r.show_if.model_dump(by_alias=True)} if r.show_if else {}),
                      **({"hide_if": r.hide_if.model_dump(by_alias=True)} if r.hide_if else {})} for r in d.rows],
        } for d in g.days],
        "getting_there": table(g.getting_there),
        "getting_home": table(g.getting_home),
        "todo": [{"key": t.key, "text": t.text} for t in g.todo],
        "budget": {"summary": g.budget.summary, "rows": [b.model_dump() for b in g.budget.rows]},
    }


def _party(raw) -> str:
    entries = raw if isinstance(raw, list) else []
    counts = {t: sum(1 for p in entries if isinstance(p, dict) and p.get("type") == t) for t in PARTY_TYPES}
    return ", ".join(f"{n} {t}" for t, n in counts.items() if n) or "not given"  # the size only, never a name


def load(conn, session_id: UUID, row: dict, g: guides.Guide, focus: str | None) -> ChatContext:
    """The context for one chat turn, from the trip's current plan (`row` is plan_edit.current's)."""
    ctx = ChatContext(text="")
    trip = conn.execute("select start_date, return_date from trip_sessions where id = %s", (session_id,)).fetchone()

    lodging = None
    if g.lodging and g.lodging.spot_id:
        pin = conn.execute("select lat, lng from spots where id = %s", (g.lodging.spot_id,)).fetchone()
        if pin and pin["lat"] is not None and pin["lng"] is not None:
            lodging = (float(pin["lat"]), float(pin["lng"]))
    home = lodging or BAGUIO_CENTRE
    spots = []
    for r in conn.execute("select id, name, category::text as category, lat, lng from spots where city = 'Baguio' order by slug limit %s", (MAX_SPOTS,)):
        km = round(haversine_km(home, (float(r["lat"]), float(r["lng"]))), 1) if r["lat"] is not None and r["lng"] is not None else None
        spots.append({"id": str(r["id"]), "name": r["name"], "category": r["category"], "km_from_lodging": km})
        ctx.spot_ids.add(r["id"])
    ctx.spot_ids |= guides.spot_ids(g)  # a plan's own spots stay usable, wherever they are

    places = [{"id": str(r["id"]), "name": r["name"]} for r in conn.execute(
        "select id, name from trip_places where session_id = %s order by created_at, id", (session_id,))]
    ctx.trip_place_ids = {UUID(p["id"]) for p in places}

    ends = [str(x) for x in guides.spot_ids(g) | guides.terminal_ids(g)]
    routes = []
    for r in conn.execute(
        """select l.id, coalesce(ft.name, fs.name) as "from", coalesce(tt.name, ts.name) as "to", l.mode, l.minutes,
                  l.fare_min_php, l.fare_max_php
           from last_mile_routes l
           left join terminals ft on ft.id = l.from_terminal_id left join spots fs on fs.id = l.from_spot_id
           left join terminals tt on tt.id = l.to_terminal_id left join spots ts on ts.id = l.to_spot_id
           where coalesce(l.from_terminal_id, l.from_spot_id)::text = any(%s)
           order by 2, 3, l.id limit %s""",
        (ends, MAX_ROUTES),
    ):
        routes.append({"id": str(r["id"]), "from": r["from"], "to": r["to"], "mode": r["mode"], "minutes": r["minutes"],
                       "fare_min_php": r["fare_min_php"], "fare_max_php": r["fare_max_php"]})
        ctx.amounts |= {float(x) for x in (r["fare_min_php"], r["fare_max_php"]) if x is not None}

    buses = []
    for name, where in (("getting_there", TO_BAGUIO), ("getting_home", FROM_BAGUIO)):
        for d in sorted({b.date for b in getattr(g, name).buses}):
            for r in conn.execute(BUSES_SQL.format(direction=where), {"dow": postgres_dow(d), "d": d, "cap": MAX_BUSES}):
                arrives, _ = arrival(d, r["departure_time"], r["travel_minutes"])
                dep = r["departure_time"].strftime("%H:%M")
                buses.append({"table": name, "date": d.isoformat(), "trip_id": str(r["trip_id"]), "operator": r["operator_name"],
                              "departs": dep, "arrives": arrives, "class": r["class"], "fare_php": r["fare_php"]})
                ctx.trip_ids.add(r["trip_id"])
                _bus_facts(ctx, dep, arrives, r["fare_php"])
    # the plan's own buses, even one no longer listed: their times and fares may be talked about
    for r in conn.execute(TRIP_ROWS_SQL, (list(guides.trip_ids(g)),)):
        arrives, _ = arrival(trip["start_date"] if trip else Date.today(), r["departure_time"], r["travel_minutes"])
        _bus_facts(ctx, r["departure_time"].strftime("%H:%M"), arrives, r["fare_php"])

    dates = f"start: {trip['start_date']}\nreturn: {trip['return_date']}\n" if trip else ""
    ctx.text = "\n\n".join([
        f"<trip>\n{dates}party: {_party(row.get('party'))}\n</trip>",
        _section("plan", compact(g)),
        _section("spots", spots),
        _section("trip_places", places),
        _section("routes", routes),
        _section("buses", buses),
        *([f"<focus>{focus}</focus>"] if focus else []),
    ])
    return ctx


def _bus_facts(ctx: ChatContext, departs: str, arrives: str | None, fare) -> None:
    ctx.times.add(to_minutes(departs))
    if arrives:
        ctx.times.add(to_minutes(arrives))
    if fare is not None:
        ctx.amounts.add(float(fare))
