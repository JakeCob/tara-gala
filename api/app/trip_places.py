"""A trip's own places (TG-61, options.md §1.3): a shop or stop the app doesn't list, pinned from a pasted Google Maps
link. Every one is "added by your group, not verified". It's only on this trip, never shown on another, and it goes
when the trip is deleted. There's no delete in v1: a place no row uses costs nothing.

The pin only ever comes from the link, read on the server (maps_link.py): the body has no lat or lng. The name is the
group's, 1 to 80 printable letters. The same name, ignoring case, within 25 m of a place the trip has is that place.
A trip holds 100.

Every bound is checked here before the insert, so the table's checks are a backstop that user input never reaches: a
check violation's DETAIL carries the whole row (review M3). One that fires anyway is a 422, logged by constraint name.
Logs carry the trip slug, codes and counts, never a name, a link or a pin.
"""

import logging
import math
from datetime import datetime
from typing import Annotated
from uuid import UUID

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, StringConstraints

from . import db, maps_link, plan_suggest, sessions  # modules, not names: plan_suggest reads this one's limiter and places too
from .limits import RateLimiter
from .sessions import _limit, _private, _session_id

router = APIRouter(tags=["trip-places"])
logger = logging.getLogger("tara_gala.api")

LINK_PER_HOUR = 30  # link fetches per IP, here and in suggest together (options.md §5.4)
LINK_LIMITER = RateLimiter(LINK_PER_HOUR)
MAX_PLACES = 100
SAME_PLACE_M = 25
MAX_NAME = 80

PlaceName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_NAME, pattern=r"^[^\x00-\x1f\x7f]+$")]
Link = Annotated[str, StringConstraints(min_length=1, max_length=maps_link.MAX_TEXT)]


class PlaceIn(BaseModel):
    """No lat or lng: the server reads the pin from the link itself."""

    model_config = ConfigDict(extra="forbid")
    link: Link
    name: PlaceName


class TripPlaceOut(BaseModel):
    id: UUID
    name: str
    lat: float
    lng: float
    maps_url: str
    created_at: datetime


_COLUMNS = "id, name, lat, lng, maps_url, created_at"


def load_places(conn, session_id: UUID) -> list[TripPlaceOut]:
    """The trip's places, oldest first: for SessionOut.places."""
    rows = conn.execute(f"select {_COLUMNS} from trip_places where session_id = %s order by created_at, id", (session_id,)).fetchall()
    return [TripPlaceOut(**r) for r in rows]


def places_by_id(conn, session_id: UUID, ids) -> dict[UUID, TripPlaceOut]:
    """Only this trip's places: another trip's id resolves to nothing (review S5)."""
    rows = conn.execute(f"select {_COLUMNS} from trip_places where id = any(%s) and session_id = %s", (list(ids), session_id)).fetchall()
    return {r["id"]: TripPlaceOut(**r) for r in rows}


def _link_limited(request: Request) -> None:
    """A dependency, so the limit comes ahead of the body's validation."""
    _limit(LINK_LIMITER, request, "place-link")


def _bounded(name: str, got: maps_link.Resolved) -> bool:
    """The table's checks, in Python, so none of them ever fires on what someone sent."""
    return (
        1 <= len(name) <= MAX_NAME
        and math.isfinite(got.lat) and math.isfinite(got.lng) and -90 <= got.lat <= 90 and -180 <= got.lng <= 180
        and got.maps_url.startswith("https://") and len(got.maps_url) <= maps_link.MAX_MAPS_URL
    )


def _exists(share_slug: str) -> None:
    with db.get_conn() as conn:
        _session_id(conn, share_slug)


def _insert(share_slug: str, name: str, got: maps_link.Resolved) -> tuple[TripPlaceOut, bool, int]:
    """(the place, whether it was there already, how many the trip has now)."""
    with db.get_conn() as conn:
        session_id = _session_id(conn, share_slug, lock=True)  # held until commit, so two adds can't pass the cap
        places = load_places(conn, session_id)
        for p in places:
            if p.name.casefold() == name.casefold() and plan_suggest.haversine_km((p.lat, p.lng), (got.lat, got.lng)) * 1000 <= SAME_PLACE_M:
                return p, True, len(places)
        if len(places) >= MAX_PLACES:
            logger.warning("trip place refused share_slug=%s code=too_many_places places=%d", share_slug, len(places))
            raise HTTPException(409, "too_many_places")
        try:
            row = conn.execute(
                f"insert into trip_places (session_id, name, lat, lng, maps_url) values (%s, %s, %s, %s, %s) returning {_COLUMNS}",
                (session_id, name, got.lat, got.lng, got.maps_url),
            ).fetchone()
        except psycopg.errors.IntegrityError as e:
            logger.warning("trip place rejected share_slug=%s code=bad_place constraint=%s", share_slug, e.diag.constraint_name or "-")
            raise HTTPException(422, "bad_place") from None
    return TripPlaceOut(**row), False, len(places) + 1


@router.post("/sessions/{share_slug}/places", status_code=201, response_model=TripPlaceOut, dependencies=[Depends(_link_limited)])
def add_place(share_slug: str, body: PlaceIn, request: Request, response: Response) -> TripPlaceOut:
    """201 with the new place, or 200 with the trip's own match. The link is read before the trip is locked."""
    _limit(sessions.WRITE_LIMITER, request, "place-add")
    _exists(share_slug)  # 404 before anything is fetched
    try:
        got = maps_link.resolve(body.link)
    except maps_link.LinkError as e:
        logger.info("trip place refused share_slug=%s code=%s", share_slug, e.code)
        raise HTTPException(422, e.code) from None
    if not _bounded(body.name, got):
        logger.warning("trip place refused share_slug=%s code=bad_place", share_slug)
        raise HTTPException(422, "bad_place")
    place, existing, count = _insert(share_slug, body.name, got)
    _private(response)
    if existing:
        response.status_code = 200
    logger.info("trip place add share_slug=%s places=%d existing=%s", share_slug, count, existing)
    return place
