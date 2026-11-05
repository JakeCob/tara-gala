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

from . import db, maps_link, plan_edit, trip_places  # modules, not names: trip_places uses haversine_km from here
from . import guide as guides
from .last_mile import spots_by_id
from .limits import MANILA_TZ, RateLimiter
from .plan_validation import RETURN_BUFFER_MINUTES
from .sessions import NOINDEX, _limit, _private, _session_id
from .trip_rows import TRIP_ROWS_SQL

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
NO_FIT_NOTE = "No free slot found. Tap a stop and use Add after."

# Where does it fit? (options.md §5.5): the score is in minutes, lower is better
FIT_COUNT = 3
DROP_MIN = 90  # what a dropped stop costs
CONDITION_MIN = 15  # a slot that only happens if the group makes one pick
NEAR_KM = 3.0  # a neighbour further than this isn't "near"
NOW_MARGIN = 15  # during the trip, a slot starts at least this long from now
DAY_END = 24 * 60


@dataclass(frozen=True)
class Stop:
    """A day row as the ripple sees it: minutes after midnight, and how long the group stays."""

    key: str
    time: int
    stay: int
    bus: bool
    plan: str
    fixed: bool = False  # the check-in row: the ripple walls on it as on a bus row (options.md §5.5)


@dataclass(frozen=True)
class FitRow(Stop):
    """A day row as best_fit sees it. place_id is its spot, terminal or trip place; cond its raw (pick, is, kind)."""

    pin: tuple[float, float] | None = None
    place_id: UUID | None = None
    lodging: bool = False
    cond: tuple[str, str, str] | None = None
    bus_kind: str | None = None  # "outbound" or "return"


@dataclass(frozen=True)
class FitDay:
    day: int
    rows: list[FitRow]


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
    mode, mins = _by_road(km)
    if mins > MAX_LEG_MIN or km > MAX_LEG_KM:
        return None
    return {"kind": "estimate", "mode": mode, "minutes": mins, "km": round(km, 1)}


def _by_road(km: float) -> tuple[str, int]:
    if km <= WALK_KM:
        return "walk", max(5, _up(km / WALK_KMH * 60, 5))
    return "taxi", _up(TAXI_START_MIN + km / TAXI_KMH * 60, 5)


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

    Later rows shift until a gap absorbs it. A bus row or the check-in never moves, and nothing past it does: if the
    shift would reach it, or push a row past 23:00, the last movable rows before it are dropped instead, and a note
    says why."""
    stop = next((i for i, r in enumerate(after) if r.bus or r.fixed), None)
    movable = after if stop is None else after[:stop]
    wall = None if stop is None else after[stop].time
    first = movable[0].time if movable else wall
    if first is None or ready <= first:
        return [], []
    note = LATE_NOTE if stop is None else _wall_note(after[stop])
    for keep in range(len(movable), -1, -1):
        kept = movable[:keep]
        start = kept[0].time if kept else wall
        moves, over, by_23 = _shift(kept, _up(ready - start, 5), wall) if start is not None else ([], 0, True)
        if by_23 and (wall is None or over <= 0):
            drops = [{"key": r.key, "drop": True} for r in movable[keep:]]
            return moves + drops, [note] if drops else []
    return [{"key": r.key, "drop": True} for r in movable], [note]


def _wall_note(r: Stop) -> str:
    return f"The {clock12(r.time)} {'bus' if r.bus else 'check-in'} can't move."


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
    anywhere: Literal[True] | None = None  # where does it fit? (options.md §5.5)

    @model_validator(mode="after")
    def one(self) -> "AtIn":
        _one(self, ("replace", "after", "first_of_day", "anywhere"))
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


Leg = Annotated[RouteLeg | EstimateLeg, Field(discriminator="kind")]


class FitCondition(BaseModel):
    """The anchor's own condition, which the new row takes on Apply."""

    model_config = ConfigDict(populate_by_name=True)

    pick: str
    is_: str = Field(alias="is")
    kind: Literal["show_if", "hide_if"]


class FitReason(BaseModel):
    """What the card says about it (ux.md §4.8): the pinned neighbour closest to the place, and the time left over."""

    kind: Literal["near_stops", "near_hotel", "free_time"]
    near_key: str | None  # None for the lodging's own pin, or without a pin
    near_km: float | None
    free_min: int  # negative when the day runs over
    dropped: int


class Fit(BaseModel):
    """One slot for the place. Apply is the tap flow's Apply at {after: fit.after}."""

    day: int
    after: str
    time: str
    leg: Leg | None
    ripple: list[dict[str, str | bool]]
    notes: list[str]
    changes: list[SuggestLine]
    condition: FitCondition | None
    reason: FitReason


class Suggestion(BaseModel):
    name: str | None  # None when a link has none: the group types it
    lat: float | None
    lng: float | None
    maps_url: str | None  # a trip place's or a link's; None for a spot
    km_from_baguio: int | None  # rounded as the far warning says it; None without a pin
    far: bool
    time: str
    leg: Leg | None
    ripple: list[dict[str, str | bool]]  # {key, time} or {key, drop: true}
    notes: list[str]
    changes: list[SuggestLine]
    pin_source: Literal["link", "address", "typed"] | None  # a link's; None for a spot or a trip place (owner round 5)
    fits: list[Fit] | None = None  # {anywhere: true} only, best first; the top level repeats fits[0]


# ---------------------------------------------------------------- where does it fit? (options.md §5.5)

def _est_min(a: tuple[float, float], b: tuple[float, float]) -> int:
    """§5.3's estimate minutes between two pins, with no upper bound: it only ranks."""
    return _by_road(haversine_km(a, b) * ROAD_FACTOR)[1]


def detour(prev: tuple[float, float] | None, new: tuple[float, float] | None, nxt: tuple[float, float] | None) -> int:
    """The estimate minutes the new place adds between its pinned neighbours. A missing end adds nothing."""
    if new is None or (prev is None and nxt is None):
        return 0
    if prev is None or nxt is None:
        return _est_min(prev or nxt, new)
    return _est_min(prev, new) + _est_min(new, nxt) - _est_min(prev, nxt)


def score(detour_min: int, overflow: int, dropped: int, inherits: bool) -> int:
    return detour_min + overflow + DROP_MIN * dropped + (CONDITION_MIN if inherits else 0)


def _shows(r: FitRow, picked: dict[str, str]) -> bool | None:
    """True when the row shows, False when a pick already made hides it, None until its pick is made."""
    if r.cond is None:
        return True
    pick, is_, kind = r.cond
    if pick not in picked:
        return None
    return (picked[pick] == is_) == (kind == "show_if")


def _reason(pin, near: list[tuple[str | None, tuple[float, float] | None, bool]], free_min: int, dropped: int) -> FitReason:
    """near: (key, pin, at the lodging) for the neighbours before and after the slot."""
    found = [(haversine_km(pin, p), key, lodging) for key, p, lodging in near if p is not None] if pin else []
    if not found:
        return FitReason(kind="free_time", near_key=None, near_km=None, free_min=free_min, dropped=dropped)
    km, key, lodging = min(found, key=lambda x: x[0])
    kind = "free_time" if km > NEAR_KM else "near_hotel" if lodging else "near_stops"
    return FitReason(kind=kind, near_key=key, near_km=round(km, 1), free_min=free_min, dropped=dropped)


def _day_slots(d: FitDay, pin, stay: int, name: str | None, *, far: bool, legs_from: dict, blocked: list[tuple[int, int]],
               picked: dict[str, str], lodging_pin, earliest: int | None) -> tuple[list[tuple], int, int]:
    """Every slot on one day as (score, day, time, row index, Fit), with how many anchors there were and were excluded."""
    seen = [(i, r, sh) for i, r in enumerate(d.rows) if (sh := _shows(r, picked)) is not False]
    out_at = next((j for j, (_, r, _) in enumerate(seen) if r.bus_kind == "outbound"), None)
    home_at = next((j for j, (_, r, _) in enumerate(seen) if r.bus_kind == "return"), None)
    rows_by_key = {r.key: r for r in d.rows}
    slots, excluded = [], 0
    for j, (i, a, a_shows) in enumerate(seen):
        cond = a.cond if a_shows is None else None  # a pick not made yet: the new row would only happen with it

        def with_it(r: FitRow, sh: bool | None) -> bool:
            return sh is True or (cond is not None and r.cond == cond)

        earlier = [r for _, r, sh in seen[: j + 1] if with_it(r, sh)]
        later = [r for _, r, sh in seen[j + 1:] if with_it(r, sh)]
        fork = cond is None and j + 1 < len(seen) and seen[j + 1][2] is None
        if (a.bus_kind == "outbound" or (out_at is not None and j < out_at and not far) or (home_at is not None and j >= home_at)
                or (a.lodging and j == len(seen) - 1) or fork):
            excluded += 1
            continue
        nxt = later[0] if later else None
        src = next((r for r in reversed(earlier) if r.place_id is not None), None)
        leg = pick_leg(legs_from.get(src.place_id, []), src.pin, pin) if src else None
        time = slot_after(a, nxt.time if nxt else None, travel(leg))
        ready = time + stay + TRAVEL_MIN
        wall = next((r for r in later if r.bus or r.fixed), None)
        if (time > LAST_START or any(time < b and time + stay > s for s, b in blocked) or (earliest is not None and time < earliest)
                or (wall is not None and ready > wall.time)):
            excluded += 1
            continue
        moves, ripple_notes = ripple(later, ready)
        dropped = sum(1 for m in moves if m.get("drop"))
        end = nxt.time if nxt else LAST_START
        before = next((r for r in reversed(earlier) if r.pin), None)
        after = next((r for r in later if r.pin), None)
        near = [(before.key, before.pin, before.lodging) if before else (None, lodging_pin, True),
                (after.key, after.pin, after.lodging) if after else (None, lodging_pin, True)]
        notes = [ESTIMATE_NOTE] if leg and leg["kind"] == "estimate" else [NO_LEG_NOTE] if leg is None and src else []
        fit = Fit(
            day=d.day, after=a.key, time=hhmm(time), leg=leg, ripple=moves, notes=notes + ripple_notes,
            changes=change_lines(d.day, "after", name, time, None, moves, rows_by_key),
            condition=FitCondition(pick=a.cond[0], is_=a.cond[1], kind=a.cond[2]) if a.cond else None,
            reason=_reason(pin, near, end - ready, dropped),
        )
        total = score(detour(near[0][1], pin, near[1][1]), max(0, ready - end), dropped, cond is not None)
        slots.append((total, d.day, time, i, fit))
    return slots, len(seen), excluded


def best_fit(days: list[FitDay], pin: tuple[float, float] | None, stay: int, *, name: str | None, far: bool,
             legs_from: dict[UUID, list[dict]], blocked: dict[int, list[tuple[int, int]]], picked: dict[str, str],
             lodging_pin: tuple[float, float] | None, today: int | None, now_min: int | None) -> tuple[list[Fit], dict]:
    """Up to 3 slots for a new place, best first, and the counts for the log. Pure: the route reads the data.

    Every row that shows is an anchor, unless a hard rule excludes it: the bus up and what's before it (unless the
    place is far), the 30 minutes before the bus home and what's after it, bedtime at the lodging, the fork before a
    pick, a span that hits a bus window, past 23:00, before now during the trip, or a slot that runs into the bus home
    or the check-in. The rest are scored (detour + overflow + 90 per drop + 15 for a pick); the best, then the best on
    each other day, then the best whose anchor isn't next to a chosen one."""
    slots, anchors, excluded = [], 0, 0
    for d in days:
        if today is not None and d.day < today:
            n = sum(1 for r in d.rows if _shows(r, picked) is not False)
            anchors, excluded = anchors + n, excluded + n
            continue
        earliest = now_min + NOW_MARGIN if today == d.day and now_min is not None else None
        found, n, x = _day_slots(d, pin, stay, name, far=far, legs_from=legs_from, blocked=blocked.get(d.day, []),
                                 picked=picked, lodging_pin=lodging_pin, earliest=earliest)
        slots, anchors, excluded = slots + found, anchors + n, excluded + x
    slots.sort(key=lambda c: c[:4])
    chosen = slots[:1]
    for c in slots[1:]:
        if len(chosen) < FIT_COUNT and c[1] not in {x[1] for x in chosen}:
            chosen.append(c)
    for c in slots:
        if len(chosen) < FIT_COUNT and c not in chosen and all(c[1] != x[1] or abs(c[3] - x[3]) > 1 for x in chosen):
            chosen.append(c)
    chosen.sort(key=lambda c: c[:4])
    return [c[4] for c in chosen], {"candidates": anchors, "excluded": excluded, "best_day": chosen[0][1] if chosen else None}


def _windows(trips: dict, g: guides.Guide) -> dict[int, list[tuple[int, int]]]:
    """Each bus's window in minutes on the day of its bus row: the booked trip's departure to its arrival on the way
    up, and from 30 minutes before its departure to midnight on the way home. With no booked trip on file, the bus
    row's time: only that minute is blocked on the way up, as no arrival is known."""
    out: dict[int, list[tuple[int, int]]] = {}
    for table, kind in ((g.getting_there, "outbound"), (g.getting_home, "return")):
        found = next(((d.day, r) for d in g.days for r in d.rows if r.bus == kind), None)
        if found is None:
            continue
        day, row = found
        booked = next((b for b in table.buses if b.booked), None)
        trip = trips.get(booked.trip_id) if booked else None
        dep = trip["departure_time"].hour * 60 + trip["departure_time"].minute if trip else minutes(row.time)
        if kind == "outbound":
            arrive = min(DAY_END, dep + trip["travel_minutes"]) if trip and trip["travel_minutes"] else dep
            out.setdefault(day, []).append((dep, arrive))
        else:
            out.setdefault(day, []).append((dep - RETURN_BUFFER_MINUTES, DAY_END))
    return out


def _routes_to(conn, spot_id: UUID, place_ids: list[UUID]) -> dict[UUID, list[dict]]:
    """last_mile_routes to this spot from any of these places (spots or terminals), by the place they start from."""
    out: dict[UUID, list[dict]] = {}
    for r in conn.execute(
        """select id, from_spot_id, from_terminal_id, mode::text as mode, minutes, fare_min_php, fare_max_php, signboard,
                  last_verified_at
           from last_mile_routes where to_spot_id = %s and (from_spot_id = any(%s) or from_terminal_id = any(%s))""",
        (spot_id, place_ids, place_ids),
    ).fetchall():
        out.setdefault(r["from_spot_id"] or r["from_terminal_id"], []).append(r)
    return out


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


def _place_id(p: guides.Place | None) -> UUID | None:
    return (p.spot_id or p.terminal_id or p.trip_place_id) if p else None


def _check_in(g: guides.Guide) -> str | None:
    """The first row of the trip at the lodging: it never moves (options.md §5.5)."""
    lodge = _place_id(g.lodging)
    return next((r.key for d in g.days for r in d.rows if lodge and _place_id(r.place) == lodge), None)


def _stay(spots: dict, r: guides.Row) -> int:
    s = spots.get(r.place.spot_id) if r.place and r.place.spot_id else None
    return (s.visit_minutes if s else None) or STAY_MIN


def _the_place(conn, share_slug: str, session_id: UUID, ref: PlaceRefIn, resolved: maps_link.Resolved | None, spots: dict):
    """(kind, name, pin, stay, link) for the place the group gave."""
    if ref.spot_id:
        spot = spots.get(ref.spot_id)
        if spot is None:
            raise _refuse(share_slug, "unknown_place")
        return "spot", spot.name, _pin(spot.lat, spot.lng), spot.visit_minutes or STAY_MIN, None
    if ref.trip_place_id:
        tp = trip_places.places_by_id(conn, session_id, [ref.trip_place_id]).get(ref.trip_place_id)
        if tp is None:
            raise _refuse(share_slug, "unknown_place")
        return "trip_place", tp.name, (tp.lat, tp.lng), STAY_MIN, tp.maps_url
    return "link", resolved.name, (resolved.lat, resolved.lng), STAY_MIN, resolved.maps_url


def _km_from_baguio(g: guides.Guide, spots: dict, pin) -> float | None:
    if pin is None:
        return None
    lodge = spots.get(g.lodging.spot_id) if g.lodging and g.lodging.spot_id else None
    return haversine_km(_pin(lodge.lat, lodge.lng) if lodge and _pin(lodge.lat, lodge.lng) else BAGUIO_CENTRE, pin)


def suggest(conn, share_slug: str, session_id: UUID, g: guides.Guide, at: AtIn, ref: PlaceRefIn,
            resolved: maps_link.Resolved | None) -> tuple[Suggestion, dict]:
    """The proposal, and what the log line says about it. One read; nothing is written."""
    if at.anywhere:
        return _anywhere(conn, share_slug, session_id, g, ref, resolved)
    day, idx = _locate(share_slug, g, at)
    rows = day.rows
    spot_ids = {r.place.spot_id for r in rows if r.place and r.place.spot_id} | {ref.spot_id} - {None}
    if g.lodging and g.lodging.spot_id:
        spot_ids.add(g.lodging.spot_id)
    spots = spots_by_id(conn, spot_ids)
    kind, name, pin, stay, link = _the_place(conn, share_slug, session_id, ref, resolved, spots)

    before = [] if idx is None else rows[: idx + (0 if at.replace else 1)]
    prev = next((r.place for r in reversed(before) if r.place), None)
    leg = None
    if prev is not None:
        routes = _routes(conn, prev, ref.spot_id) if ref.spot_id else []
        leg = pick_leg(routes, _prev_pin(conn, session_id, prev, spots), pin)

    check_in = _check_in(g)
    stops = [Stop(key=r.key, time=minutes(r.time), stay=_stay(spots, r), bus=r.bus is not None, plan=r.plan, fixed=r.key == check_in)
             for r in rows]
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
    km = _km_from_baguio(g, spots, pin)
    at_kind = "replace" if at.replace else "after" if at.after else "first"
    out = Suggestion(
        name=name, lat=pin[0] if pin else None, lng=pin[1] if pin else None, maps_url=link,
        km_from_baguio=about_km(km) if km is not None else None, far=km is not None and far(km),
        time=hhmm(time), leg=leg, ripple=moves, notes=notes + ripple_notes, pin_source=resolved.pin_source if resolved else None,
        changes=change_lines(day.day, at_kind, name, time, stops[idx] if at.replace else None, moves, {s.key: s for s in stops}),
    )
    return out, {"place": kind, "at": at_kind, "leg": leg["kind"] if leg else "none", "far": out.far, "ripple": len(moves)}


def _manila_now() -> datetime:
    return datetime.now(MANILA_TZ)


def _fit_days(conn, session_id: UUID, g: guides.Guide, spots: dict) -> tuple[list[FitDay], tuple[float, float] | None]:
    """The guide's days as best_fit sees them, and the lodging's pin. Pins come from the spots, terminals and this
    trip's own places, one read each."""
    places = [p for d in g.days for r in d.rows for p in [r.place] if p] + ([g.lodging] if g.lodging else [])
    terminal_ids = list({p.terminal_id for p in places if p.terminal_id})
    terminals = {t["id"]: _pin(t["lat"], t["lng"]) for t in conn.execute(
        "select id, lat, lng from terminals where id = any(%s)", (terminal_ids,))} if terminal_ids else {}
    mine = trip_places.places_by_id(conn, session_id, list({p.trip_place_id for p in places if p.trip_place_id}))

    def pin_of(p: guides.Place | None):
        if p is None:
            return None
        if p.spot_id:
            s = spots.get(p.spot_id)
            return _pin(s.lat, s.lng) if s else None
        if p.terminal_id:
            return terminals.get(p.terminal_id)
        tp = mine.get(p.trip_place_id)
        return (tp.lat, tp.lng) if tp else None

    lodge, check_in = _place_id(g.lodging), _check_in(g)

    def cond(r: guides.Row):
        c, kind = (r.show_if, "show_if") if r.show_if else (r.hide_if, "hide_if")
        return (c.pick, c.is_, kind) if c else None

    days = [FitDay(day=d.day, rows=[
        FitRow(key=r.key, time=minutes(r.time), stay=_stay(spots, r), bus=r.bus is not None, plan=r.plan, fixed=r.key == check_in,
               pin=pin_of(r.place), place_id=_place_id(r.place), lodging=lodge is not None and _place_id(r.place) == lodge,
               cond=cond(r), bus_kind=r.bus)
        for r in d.rows]) for d in g.days]
    return days, pin_of(g.lodging)


def _anywhere(conn, share_slug: str, session_id: UUID, g: guides.Guide, ref: PlaceRefIn,
              resolved: maps_link.Resolved | None) -> tuple[Suggestion, dict]:
    """Where does it fit? Every slot in the plan, ranked; the top level repeats the best (options.md §5.5)."""
    spot_ids = {r.place.spot_id for d in g.days for r in d.rows if r.place and r.place.spot_id} | {ref.spot_id} - {None}
    if g.lodging and g.lodging.spot_id:
        spot_ids.add(g.lodging.spot_id)
    spots = spots_by_id(conn, spot_ids)
    kind, name, pin, stay, link = _the_place(conn, share_slug, session_id, ref, resolved, spots)
    days, lodging_pin = _fit_days(conn, session_id, g, spots)
    from_ids = list({r.place_id for d in days for r in d.rows if r.place_id})
    legs_from = _routes_to(conn, ref.spot_id, from_ids) if ref.spot_id and from_ids else {}
    booked = [b.trip_id for t in (g.getting_there, g.getting_home) for b in t.buses if b.booked]
    trips = {r["trip_id"]: r for r in conn.execute(TRIP_ROWS_SQL, (booked,))} if booked else {}
    dates = conn.execute("select start_date, return_date from trip_sessions where id = %s", (session_id,)).fetchone()
    now = _manila_now()
    today = now_min = None
    if dates and dates["start_date"] <= now.date() <= dates["return_date"]:
        today, now_min = (now.date() - dates["start_date"]).days + 1, now.hour * 60 + now.minute
    km = _km_from_baguio(g, spots, pin)
    is_far = km is not None and far(km)
    fits, counts = best_fit(days, pin, stay, name=name, far=is_far, legs_from=legs_from, blocked=_windows(trips, g),
                            picked=plan_edit.picked(conn, session_id), lodging_pin=lodging_pin, today=today, now_min=now_min)
    top = fits[0] if fits else None
    out = Suggestion(
        name=name, lat=pin[0] if pin else None, lng=pin[1] if pin else None, maps_url=link,
        km_from_baguio=about_km(km) if km is not None else None, far=is_far,
        time=top.time if top else "", leg=top.leg if top else None, ripple=top.ripple if top else [],
        notes=top.notes if top else [NO_FIT_NOTE], changes=top.changes if top else [], fits=fits,
        pin_source=resolved.pin_source if resolved else None,  # as the tap flow does (owner round 5)
    )
    # Two silent fallbacks, counted for the log: a placed row with no pin ranks without a detour, and a booked trip
    # that's gone leaves its bus row's time as the window
    no_pin = sum(1 for d in days for r in d.rows if r.place_id and r.pin is None)
    return out, {"place": kind, "at": "anywhere", "leg": top.leg.kind if top and top.leg else "none", "far": is_far,
                 "ripple": len(out.ripple), "fits": len(fits), **counts, "no_pin": no_pin,
                 "bus_gone": sum(1 for b in booked if b not in trips)}


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
    line = "plan suggest share_slug=%s place=%s at=%s leg=%s far=%s ripple=%d"
    args = [share_slug, kinds["place"], kinds["at"], kinds["leg"], kinds["far"], kinds["ripple"]]
    if "fits" in kinds:  # where does it fit? counts only
        line += " fits=%d candidates=%d excluded=%d best_day=%s no_pin=%d bus_gone=%d"
        args += [kinds["fits"], kinds["candidates"], kinds["excluded"], kinds["best_day"] or "none", kinds["no_pin"], kinds["bus_gone"]]
    logger.info(line, *args)
    return out
