"""Suggestions for a new or replaced stop (TG-61, options.md §5): a time slot, how to get there, and what it does to
the rest of the day. Pure functions, plus one read in suggest(). Nothing here saves: the web shows the proposal, and
Apply sends the guide with the parts the group picked (PUT /plan, plan_edit.py).

How to get there (owner decision D1): a last_mile_routes row from the previous stop's place when one exists, every
value from the row. Otherwise an estimate from the distance, walk or taxi with minutes and km only: never a fare, and
never "jeep", since we can't name a signboard. The road factor and speeds are guesses, labelled as an estimate
(plan.md §11).

Logs carry the trip slug, kinds and counts, never a place's name, a pin or a link.
"""

import logging
import math
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from . import db, maps_link, trip_places  # modules, not names: trip_places uses haversine_km from here
from . import guide as guides
from .last_mile import spots_by_id
from .limits import RateLimiter
from .sessions import NOINDEX, _limit, _private, _session_id

router = APIRouter(tags=["plan-suggest"])
logger = logging.getLogger("tara_gala.api")

SUGGEST_PER_HOUR = 120  # per IP; a link in it also counts against trip_places.LINK_LIMITER (options.md §5.4)
SUGGEST_LIMITER = RateLimiter(SUGGEST_PER_HOUR)

BAGUIO_CENTRE = (16.4120, 120.5960)  # Session Road: the distance when the lodging has no pin
EARTH_KM = 6371.0
FAR_KM = 25  # over this, the group is asked first (ux.md §4.3)
ROAD_FACTOR = 1.4  # Baguio's winding roads
WALK_KM = 1.2
WALK_KMH = 4.0  # hills
TAXI_KMH = 20.0
TAXI_START_MIN = 5
MAX_LEG_MIN = 600  # the saved leg's bound (options.md §3.4)
MAX_LEG_KM = 1000
STAY_MIN = 60  # spots.visit_minutes is empty for every spot today
TRAVEL_MIN = 15  # to the next row, or when there's no leg
EMPTY_DAY = 9 * 60
LAST_START = 23 * 60  # no row is moved past 23:00
LATEST_SLOT = 23 * 60 + 45
MAX_LINES = 3  # then one "More" line, as the version's change lines (options.md §3.5)
MAX_TEXT = 120

ESTIMATE_NOTE = "An estimate from the distance, not a route on file. A jeep may go there: ask a local."  # D1, as approved
NO_LEG_NOTE = "No directions yet: use the Directions button."
LATE_NOTE = "The day can't run past 11:00 PM."


@dataclass(frozen=True)
class Stop:
    """A day row as the ripple sees it: minutes after midnight, and how long the group stays."""

    key: str
    time: int
    stay: int
    bus: bool
    plan: str


# ---------------------------------------------------------------- time

def minutes(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def hhmm(m: int) -> str:
    return f"{m // 60:02d}:{m % 60:02d}"


def clock12(m: int) -> str:
    h, mm = divmod(m, 60)
    return f"{h % 12 or 12}:{mm:02d} {'AM' if h < 12 else 'PM'}"


def _up(m: float, step: int) -> int:
    return math.ceil(m / step - 1e-9) * step


def _down(m: float, step: int) -> int:
    return math.floor(m / step + 1e-9) * step


# ---------------------------------------------------------------- distance and the leg

def haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lng1, lat2, lng2 = map(math.radians, (*a, *b))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    return 2 * EARTH_KM * math.asin(min(1.0, math.sqrt(h)))


def far(km: float) -> bool:
    return km > FAR_KM


def about_km(km: float) -> int:
    """As the far warning says it: to 10 km over 100 km, else to the km (ux.md §4.3)."""
    return int(_half_up(km / 10) * 10) if km > 100 else int(_half_up(km))


def _half_up(x: float) -> int:
    return math.floor(x + 0.5)


def estimate(straight_km: float) -> dict | None:
    """Walk or taxi from the straight-line distance, or None when it's past the saved leg's bounds."""
    km = straight_km * ROAD_FACTOR
    if km <= WALK_KM:
        mode, mins = "walk", max(5, _up(km / WALK_KMH * 60, 5))
    else:
        mode, mins = "taxi", _up(TAXI_START_MIN + km / TAXI_KMH * 60, 5)
    if mins > MAX_LEG_MIN or km > MAX_LEG_KM:
        return None
    return {"kind": "estimate", "mode": mode, "minutes": mins, "km": round(km, 1)}


def pick_leg(routes: list[dict], prev_pin: tuple[float, float] | None, pin: tuple[float, float] | None) -> dict | None:
    """A route on file (lowest minutes, then id), else an estimate when both ends have a pin, else None."""
    if routes:
        r = min(routes, key=lambda r: (r["minutes"] is None, r["minutes"] or 0, str(r["id"])))
        return {
            "kind": "route", "last_mile_route_id": r["id"], "mode": r["mode"], "minutes": r["minutes"],
            "fare_min_php": _float(r["fare_min_php"]), "fare_max_php": _float(r["fare_max_php"]),
            "signboard": r["signboard"], "last_verified_at": r["last_verified_at"],
        }
    if prev_pin is None or pin is None:
        return None
    return estimate(haversine_km(prev_pin, pin))


def _float(v) -> float | None:
    return float(v) if v is not None else None


def travel(leg: dict | None) -> int:
    return leg["minutes"] if leg and leg.get("minutes") else TRAVEL_MIN


# ---------------------------------------------------------------- the slot and the ripple

def slot_after(prev: Stop, next_time: int | None, travel_min: int) -> int:
    """After `prev`: its time there (the gap to the next row, capped at its stay) and the travel, up to 15 min."""
    there = prev.stay if next_time is None else max(0, min(prev.stay, next_time - prev.time))
    return min(LATEST_SLOT, _up(prev.time + there + travel_min, 15))


def slot_first(first: Stop | None, stay: int) -> int:
    """First of the day: its stay and the travel before the day's first row, down to 15 min."""
    if first is None:
        return EMPTY_DAY
    return max(0, _down(first.time - stay - TRAVEL_MIN, 15))


def _shift(rows: list[Stop], over: int, wall: int | None) -> tuple[list[dict], int, bool]:
    """Move `rows` later by `over`, less each row's slack, until it's absorbed. Returns the moves, the overflow that
    reaches `wall` (the time of the row after them), and whether every moved row still starts by 23:00."""
    moves = []
    for i, r in enumerate(rows):
        if over <= 0:
            break
        at = r.time + over
        if at > LAST_START:
            return moves, over, False
        moves.append({"key": r.key, "time": hhmm(at)})
        nxt = rows[i + 1].time if i + 1 < len(rows) else wall
        slack = math.inf if nxt is None else nxt - r.time - (r.stay + TRAVEL_MIN)
        over -= max(slack, 0)
    return moves, over, True


def ripple(after: list[Stop], ready: int) -> tuple[list[dict], list[str]]:
    """What the new stop does to the rows after it on its day. `ready` is when the group can be at the next row.

    Later rows shift until a gap absorbs it. A bus row never moves, and nothing past it does: if the shift would reach
    it, or push a row past 23:00, the last movable rows before it are dropped instead, and a note says why."""
    bus = next((i for i, r in enumerate(after) if r.bus), None)
    movable = after if bus is None else after[:bus]
    wall = None if bus is None else after[bus].time
    first = movable[0].time if movable else wall
    if first is None or ready <= first:
        return [], []
    note = LATE_NOTE if bus is None else f"The {clock12(after[bus].time)} bus can't move."
    for keep in range(len(movable), -1, -1):
        kept = movable[:keep]
        start = kept[0].time if kept else wall
        moves, over, by_23 = _shift(kept, _up(ready - start, 5), wall) if start is not None else ([], 0, True)
        if by_23 and (wall is None or over <= 0):
            drops = [{"key": r.key, "drop": True} for r in movable[keep:]]
            return moves + drops, [note] if drops else []
    return [{"key": r.key, "drop": True} for r in movable], [note]


# ---------------------------------------------------------------- the change lines

def _fit(name: str, suffix: str = "") -> str:
    room = MAX_TEXT - len(suffix)
    return (name if len(name) <= room else name[: room - 1].rstrip() + "…") + suffix


def change_lines(day: int, at: str, name: str | None, time: int, anchor: Stop | None, moves: list[dict],
                 rows: dict[str, Stop]) -> list[dict]:
    """The proposal's lines in the versions' shape {word, day, text} (options.md §3.5), each tagged with its part, so
    the web can leave out the ripple's lines when the group leaves the ripple out."""
    new = _fit(name or "New stop", f" at {clock12(time)}")
    lines = [{"word": "Out", "day": day, "text": _fit(anchor.plan), "part": "stop"}] if at == "replace" and anchor else []
    lines.append({"word": "In" if at == "replace" else "New", "day": day, "text": new, "part": "stop"})
    later = [
        {"word": "Dropped", "day": day, "text": _fit(rows[m["key"]].plan), "part": "ripple"} if m.get("drop")
        else {"word": "Later", "day": day, "text": _fit(rows[m["key"]].plan, f" to {clock12(minutes(m['time']))}"), "part": "ripple"}
        for m in moves
    ]
    if len(later) > MAX_LINES:
        rest = len(later) - MAX_LINES
        later = later[:MAX_LINES] + [{"word": "More", "day": None, "text": f"and {rest} more changes", "part": "ripple"}]
    return lines + later


# ---------------------------------------------------------------- the route

class _In(BaseModel):
    model_config = ConfigDict(extra="forbid")


class BaseIn(_In):
    """The plan the suggestion is worked out from: the copy's slug and version, or the shared plan's slug and 0."""

    itinerary_slug: Annotated[str, StringConstraints(min_length=1, max_length=100)]
    seq: int = Field(ge=0, le=9999)


RowKey = Annotated[str, StringConstraints(pattern=guides.ROW_KEY)]


def _one(model: BaseModel, names: tuple[str, ...]) -> None:
    if sum(getattr(model, n) is not None for n in names) != 1:
        raise ValueError(f"send exactly one of {', '.join(names)}")


class AtIn(_In):
    replace: RowKey | None = None
    after: RowKey | None = None
    first_of_day: int | None = Field(None, ge=1, le=31)

    @model_validator(mode="after")
    def one(self) -> "AtIn":
        _one(self, ("replace", "after", "first_of_day"))
        return self


class PlaceRefIn(_In):
    """A spot or one of this trip's places by id, or a Google Maps link. A typed name is searched on the phone."""

    spot_id: UUID | None = None
    trip_place_id: UUID | None = None
    link: Annotated[str, StringConstraints(min_length=1, max_length=maps_link.MAX_TEXT)] | None = None
    pin: Annotated[str, StringConstraints(max_length=maps_link.MAX_PIN_TEXT)] | None = None  # pasted after need_pin

    @model_validator(mode="after")
    def one(self) -> "PlaceRefIn":
        _one(self, ("spot_id", "trip_place_id", "link"))
        if self.pin is not None and self.link is None:
            raise ValueError("a pin goes with its link")
        return self


class SuggestIn(_In):
    base: BaseIn
    at: AtIn
    place: PlaceRefIn


class RouteLeg(BaseModel):
    """A last_mile_routes row: every value from it. last_verified_at feeds the Checked line (ux.md §15.1)."""

    kind: Literal["route"]
    last_mile_route_id: UUID
    mode: str
    minutes: int | None
    fare_min_php: float | None
    fare_max_php: float | None
    signboard: str | None
    last_verified_at: datetime | None


class EstimateLeg(BaseModel):
    """From the distance (owner decision D1): walk or taxi, minutes and km, and never a fare."""

    kind: Literal["estimate"]
    mode: Literal["walk", "taxi"]
    minutes: int
    km: float


class SuggestLine(BaseModel):
    word: str
    day: int | None
    text: str
    part: Literal["stop", "ripple"]


class Suggestion(BaseModel):
    name: str | None  # None when a link has none: the group types it
    lat: float | None
    lng: float | None
    maps_url: str | None  # a trip place's or a link's; None for a spot
    km_from_baguio: int | None  # rounded as the far warning says it; None without a pin
    far: bool
    time: str
    leg: Annotated[RouteLeg | EstimateLeg, Field(discriminator="kind")] | None
    ripple: list[dict[str, str | bool]]  # {key, time} or {key, drop: true}
    notes: list[str]
    changes: list[SuggestLine]
    pin_source: Literal["link", "address", "typed"] | None  # a link's; None for a spot or a trip place (owner round 5)


def _limited(request: Request) -> None:
    """A dependency, so the limit comes ahead of the body's validation."""
    _limit(SUGGEST_LIMITER, request, "plan-suggest")


def _refuse(share_slug: str, code: str, status: int = 422) -> HTTPException:
    logger.info("plan suggest refused share_slug=%s reason=%s", share_slug, code)
    return HTTPException(status, code)


def _current(conn, session_id: UUID) -> tuple[str, int, object] | None:
    """The trip's plan: (slug, seq, raw guide). seq is the copy's newest version, or 0 for a shared plan."""
    row = conn.execute(
        """select i.share_slug, i.plan -> 'guide' as guide,
                  (select max(v.seq) from itinerary_versions v where v.itinerary_id = i.id and v.session_id = s.id) as seq
           from trip_sessions s join itineraries i on i.id = s.itinerary_id where s.id = %s""",
        (session_id,),
    ).fetchone()
    return (row["share_slug"], row["seq"] or 0, row["guide"]) if row else None


def _locate(share_slug: str, g: guides.Guide, at: AtIn) -> tuple[guides.Day, int | None]:
    """The day, and the row's index in it (None for first of the day)."""
    if at.first_of_day is not None:
        day = next((d for d in g.days if d.day == at.first_of_day), None)
        if day is None:
            raise _refuse(share_slug, "unknown_day")
        return day, None
    key = at.replace or at.after
    for d in g.days:
        for i, r in enumerate(d.rows):
            if r.key == key:
                if at.replace and r.bus:
                    raise _refuse(share_slug, "bus_row")
                return d, i
    raise _refuse(share_slug, "unknown_key")


def _pin(lat, lng) -> tuple[float, float] | None:
    return (lat, lng) if lat is not None and lng is not None else None


def _prev_pin(conn, session_id: UUID, p: guides.Place, spots: dict) -> tuple[float, float] | None:
    if p.spot_id:
        s = spots.get(p.spot_id)
        return _pin(s.lat, s.lng) if s else None
    if p.terminal_id:
        t = conn.execute("select lat, lng from terminals where id = %s", (p.terminal_id,)).fetchone()
        return _pin(t["lat"], t["lng"]) if t else None
    if p.trip_place_id:
        tp = trip_places.places_by_id(conn, session_id, [p.trip_place_id]).get(p.trip_place_id)
        return _pin(tp.lat, tp.lng) if tp else None
    return None


def _routes(conn, prev: guides.Place, spot_id: UUID) -> list[dict]:
    """last_mile_routes from the previous place (a spot or terminal) to this spot."""
    if not (prev.spot_id or prev.terminal_id):
        return []
    return conn.execute(
        """select id, mode::text as mode, minutes, fare_min_php, fare_max_php, signboard, last_verified_at from last_mile_routes
           where (from_spot_id = %s or from_terminal_id = %s) and to_spot_id = %s""",
        (prev.spot_id, prev.terminal_id, spot_id),
    ).fetchall()


def suggest(conn, share_slug: str, session_id: UUID, g: guides.Guide, at: AtIn, ref: PlaceRefIn,
            resolved: maps_link.Resolved | None) -> tuple[Suggestion, dict]:
    """The proposal, and what the log line says about it. One read; nothing is written."""
    day, idx = _locate(share_slug, g, at)
    rows = day.rows
    spot_ids = {r.place.spot_id for r in rows if r.place and r.place.spot_id} | {ref.spot_id} - {None}
    if g.lodging and g.lodging.spot_id:
        spot_ids.add(g.lodging.spot_id)
    spots = spots_by_id(conn, spot_ids)

    if ref.spot_id:
        spot = spots.get(ref.spot_id)
        if spot is None:
            raise _refuse(share_slug, "unknown_place")
        kind, name, pin, stay, link = "spot", spot.name, _pin(spot.lat, spot.lng), spot.visit_minutes or STAY_MIN, None
    elif ref.trip_place_id:
        tp = trip_places.places_by_id(conn, session_id, [ref.trip_place_id]).get(ref.trip_place_id)
        if tp is None:
            raise _refuse(share_slug, "unknown_place")
        kind, name, pin, stay, link = "trip_place", tp.name, (tp.lat, tp.lng), STAY_MIN, tp.maps_url
    else:
        kind, name, pin, stay, link = "link", resolved.name, (resolved.lat, resolved.lng), STAY_MIN, resolved.maps_url

    before = [] if idx is None else rows[: idx + (0 if at.replace else 1)]
    prev = next((r.place for r in reversed(before) if r.place), None)
    leg = None
    if prev is not None:
        routes = _routes(conn, prev, ref.spot_id) if ref.spot_id else []
        leg = pick_leg(routes, _prev_pin(conn, session_id, prev, spots), pin)

    def stay_of(r: guides.Row) -> int:
        s = spots.get(r.place.spot_id) if r.place and r.place.spot_id else None
        return (s.visit_minutes if s else None) or STAY_MIN

    stops = [Stop(key=r.key, time=minutes(r.time), stay=stay_of(r), bus=r.bus is not None, plan=r.plan) for r in rows]
    moves, ripple_notes = [], []
    if at.replace:
        time = stops[idx].time  # Replace keeps its time slot, so the day around it stays as it is
    else:
        if idx is None:
            time, later = slot_first(stops[0] if stops else None, stay), stops
        else:
            time, later = slot_after(stops[idx], stops[idx + 1].time if idx + 1 < len(stops) else None, travel(leg)), stops[idx + 1:]
        moves, ripple_notes = ripple(later, time + stay + TRAVEL_MIN)

    notes = [ESTIMATE_NOTE] if leg and leg["kind"] == "estimate" else [NO_LEG_NOTE] if leg is None and prev is not None else []
    km = None
    if pin is not None:
        lodge = spots.get(g.lodging.spot_id) if g.lodging and g.lodging.spot_id else None
        km = haversine_km(_pin(lodge.lat, lodge.lng) if lodge and _pin(lodge.lat, lodge.lng) else BAGUIO_CENTRE, pin)
    at_kind = "replace" if at.replace else "after" if at.after else "first"
    out = Suggestion(
        name=name, lat=pin[0] if pin else None, lng=pin[1] if pin else None, maps_url=link,
        km_from_baguio=about_km(km) if km is not None else None, far=km is not None and far(km),
        time=hhmm(time), leg=leg, ripple=moves, notes=notes + ripple_notes, pin_source=resolved.pin_source if resolved else None,
        changes=change_lines(day.day, at_kind, name, time, stops[idx] if at.replace else None, moves, {s.key: s for s in stops}),
    )
    return out, {"place": kind, "at": at_kind, "leg": leg["kind"] if leg else "none", "far": out.far, "ripple": len(moves)}


@router.post("/sessions/{share_slug}/plan/suggest", response_model=Suggestion, dependencies=[Depends(_limited)])
def suggest_stop(share_slug: str, body: SuggestIn, request: Request, response: Response):
    """A time, a way to get there and what it does to the day, for a stop in place of a row, after one, or first on a
    day. Saves nothing. 409 plan_changed, with the current slug and seq, when the base isn't the trip's plan."""
    with db.get_conn() as conn:
        session_id = _session_id(conn, share_slug)
        current = _current(conn, session_id)
    if current is None or current[2] is None:
        raise _refuse(share_slug, "no_guide")
    slug, seq, raw = current
    if (body.base.itinerary_slug, body.base.seq) != (slug, seq):
        logger.info("plan suggest refused share_slug=%s reason=plan_changed base_seq=%d seq=%d", share_slug, body.base.seq, seq)
        return JSONResponse({"detail": "plan_changed", "itinerary_slug": slug, "seq": seq}, status_code=409,
                            headers={"Cache-Control": "private, no-cache", **NOINDEX})
    g, problems = guides.parse_guide(raw)
    if g is None:
        logger.warning("plan suggest guide unreadable share_slug=%s problems=%d", share_slug, len(problems))
        raise _refuse(share_slug, "no_guide")

    resolved = None
    if body.place.link is not None:  # read before the second connection, so no connection waits on Google
        try:
            if body.place.pin is not None:  # pasted after need_pin: nothing is fetched
                resolved = maps_link.typed(body.place.link, body.place.pin)
            else:
                _limit(trip_places.LINK_LIMITER, request, "suggest-link")
                resolved = maps_link.resolve(body.place.link)
        except maps_link.LinkError as e:
            if e.code == "need_pin":
                logger.info("plan suggest refused share_slug=%s reason=need_pin", share_slug)
                return trip_places.need_pin(e)
            raise _refuse(share_slug, e.code) from None
    with db.get_conn() as conn:
        out, kinds = suggest(conn, share_slug, session_id, g, body.at, body.place, resolved)
    _private(response)
    logger.info("plan suggest share_slug=%s place=%s at=%s leg=%s far=%s ripple=%d", share_slug, *kinds.values())
    return out
