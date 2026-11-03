"""Trip sessions (TG-52): one secret link for the whole trip. A session points at an itinerary (a saved or ready-made
plan) and a shared wallet, and holds the hotel and the files the party shares (trip_files.py: tickets, payout QRs,
the hotel's screenshot) and its list of people (trip_people.py).

Like a wallet, a session has no owner and no accounts: anyone with its share link can read it and write to it. The
slug is 128 random bits and is the only key. Opening a session shows its wallet's and itinerary's links too, so the
party needs only the one link.

Logs carry the slug and counts, never a trip, hotel or person's name, a booking reference or a note.
"""

import logging
import math
import re
from datetime import date, datetime, timedelta
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, StringConstraints, model_validator

from . import db, storage
from .itineraries import SLUG as ITINERARY_SLUG
from .limits import RateLimiter, client_ip, ip_hash
from .wallets import SLUG as WALLET_SLUG

router = APIRouter(tags=["sessions"])
logger = logging.getLogger("tara_gala.api")

SLUG = re.compile(r"^[0-9a-f]{32}$")
NOT_FOUND = "Trip not found"
NOINDEX = {"X-Robots-Tag": "noindex"}
MAX_DAYS = 30  # the same cap as the table's check
RETAIN_DAYS = 14  # tickets, payout QRs and the hotel's screenshot go this long after the trip (owner, 2026-11-01)
EXPIRING = ("ticket", "payout_qr", "hotel_proof")

# Per-IP limits, in process memory like the wallets' (limits.py): reset on every deploy
CREATE_PER_HOUR = 20
WRITES_PER_HOUR = 600
CREATE_LIMITER = RateLimiter(CREATE_PER_HOUR)
WRITE_LIMITER = RateLimiter(WRITES_PER_HOUR)

TripName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]
HotelName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]


def _text(limit: int):
    return Annotated[str, StringConstraints(strip_whitespace=True, max_length=limit)]


# ---------------------------------------------------------------- shapes

def _check_dates(start: date | None, back: date | None) -> None:
    if start is not None and back is not None:
        if back < start:
            raise ValueError("return_date is before start_date")
        if back > start + timedelta(days=MAX_DAYS):
            raise ValueError(f"a trip is at most {MAX_DAYS} days")


class SessionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: TripName
    start_date: date
    return_date: date

    @model_validator(mode="after")
    def dates(self) -> "SessionIn":
        _check_dates(self.start_date, self.return_date)
        return self


class SessionPatch(BaseModel):
    """Only the fields sent change. Dates are checked again against the stored ones."""

    model_config = ConfigDict(extra="forbid")
    name: TripName | None = None
    start_date: date | None = None
    return_date: date | None = None


class LinkIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    share_slug: str


class HotelIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: HotelName
    address: _text(200) = ""
    check_in: datetime | None = None  # Manila wall time, no offset
    check_out: datetime | None = None
    booking_ref: _text(40) = ""
    notes: _text(300) = ""

    @model_validator(mode="after")
    def times(self) -> "HotelIn":
        for t in (self.check_in, self.check_out):
            if t is not None and t.tzinfo is not None:
                raise ValueError("hotel times are Manila wall time, without an offset")
        if self.check_in and self.check_out and self.check_out <= self.check_in:
            raise ValueError("check_out is not after check_in")
        return self


class DeleteIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str  # the trip's name, typed again to confirm


class WalletLink(BaseModel):
    share_slug: str
    name: str


class HotelOut(BaseModel):
    name: str
    address: str
    check_in: datetime | None
    check_out: datetime | None
    booking_ref: str
    notes: str


class FileOut(BaseModel):
    id: UUID
    kind: str
    label: str
    member_id: UUID | None
    attendee_id: UUID | None  # whose profile photo
    content_type: str
    bytes: int
    delete_after: date | None
    row_key: str | None  # a photo's checklist row ("d2-05")
    created_at: datetime


class MarkOut(BaseModel):
    key: str  # "row:d2-05", "todo:03" or "pick:sunrise" (trip_marks.py)
    value: str
    updated_at: datetime


class AttendeeOut(BaseModel):
    id: UUID
    name: str
    rsvp: str  # pending, yes or no
    rsvp_at: datetime | None
    arrived_at: datetime | None  # at the first meet-up


class SessionOut(BaseModel):
    share_slug: str
    name: str
    start_date: date
    return_date: date
    created_at: datetime
    itinerary_slug: str | None
    wallet: WalletLink | None
    hotel: HotelOut | None
    files: list[FileOut]
    marks: list[MarkOut]
    attendees: list[AttendeeOut]


# ---------------------------------------------------------------- database

def _limit(limiter: RateLimiter, request: Request, action: str) -> None:
    ip = client_ip(request)
    wait = limiter.hit(ip)
    if wait is not None:
        retry_after = max(1, math.ceil(wait))
        logger.warning("session rate limited action=%s ip=%s retry_after=%d", action, ip_hash(ip), retry_after)
        raise HTTPException(429, "rate_limited", headers={"Retry-After": str(retry_after)})


def _session_id(conn, share_slug: str, lock: bool = False) -> UUID:
    """The session's id, or 404. `lock` holds the row until commit, so writes to one session go one at a time."""
    if not SLUG.fullmatch(share_slug):
        logger.info("session not found share_slug=<invalid>")
        raise HTTPException(404, NOT_FOUND, headers=NOINDEX)
    row = conn.execute(
        "select id from trip_sessions where share_slug = %s" + (" for update" if lock else ""), (share_slug,)
    ).fetchone()
    if row is None:
        logger.info("session not found share_slug=%s", share_slug)
        raise HTTPException(404, NOT_FOUND, headers=NOINDEX)
    return row["id"]


def _load(conn, session_id: UUID) -> SessionOut:
    s = conn.execute(
        """select s.share_slug, s.name, s.start_date, s.return_date, s.created_at,
                  i.share_slug as itinerary_slug, w.share_slug as wallet_slug, w.name as wallet_name
           from trip_sessions s
           left join itineraries i on i.id = s.itinerary_id
           left join wallets w on w.id = s.wallet_id
           where s.id = %s""",
        (session_id,),
    ).fetchone()
    hotel = conn.execute(
        "select name, address, check_in, check_out, booking_ref, notes from session_hotels where session_id = %s",
        (session_id,),
    ).fetchone()
    files = conn.execute(
        """select id, kind, label, member_id, attendee_id, content_type, bytes, delete_after, row_key, created_at from session_files
           where session_id = %s order by kind, created_at, id""",
        (session_id,),
    ).fetchall()
    marks = conn.execute(
        "select key, value, updated_at from session_marks where session_id = %s order by updated_at, key", (session_id,)
    ).fetchall()
    attendees = conn.execute(
        "select id, name, rsvp, rsvp_at, arrived_at from session_attendees where session_id = %s order by seq", (session_id,)
    ).fetchall()
    return SessionOut(
        share_slug=s["share_slug"],
        name=s["name"],
        start_date=s["start_date"],
        return_date=s["return_date"],
        created_at=s["created_at"],
        itinerary_slug=s["itinerary_slug"],
        wallet=WalletLink(share_slug=s["wallet_slug"], name=s["wallet_name"]) if s["wallet_slug"] else None,
        hotel=HotelOut(**hotel) if hotel else None,
        files=[FileOut(**f) for f in files],
        marks=[MarkOut(**m) for m in marks],
        attendees=[AttendeeOut(**a) for a in attendees],
    )


def _private(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-cache"  # the hotel and the party's plans are personal
    response.headers.update(NOINDEX)


def _shape(s: SessionOut) -> str:
    days = (s.return_date - s.start_date).days + 1
    return (
        f"days={days} itinerary={'yes' if s.itinerary_slug else 'no'} wallet={'yes' if s.wallet else 'no'} "
        f"hotel={'yes' if s.hotel else 'no'} files={len(s.files)} marks={len(s.marks)} attendees={len(s.attendees)}"
    )


def _write(share_slug: str, request: Request, action: str, change) -> SessionOut:
    """One write: rate limit, lock the session, apply `change(conn, session_id)`, and return the new state."""
    _limit(WRITE_LIMITER, request, action)
    with db.get_conn() as conn:
        session_id = _session_id(conn, share_slug, lock=True)
        change(conn, session_id)
        session = _load(conn, session_id)
    logger.info("session %s share_slug=%s %s", action, share_slug, _shape(session))
    return session


# ---------------------------------------------------------------- routes

@router.post("/sessions", status_code=201, response_model=SessionOut)
def create_session(body: SessionIn, request: Request, response: Response) -> SessionOut:
    _limit(CREATE_LIMITER, request, "create")
    with db.get_conn() as conn:
        session_id = conn.execute(
            "insert into trip_sessions (name, start_date, return_date) values (%s, %s, %s) returning id",
            (body.name, body.start_date, body.return_date),
        ).fetchone()["id"]
        session = _load(conn, session_id)
    _private(response)
    logger.info("session create share_slug=%s %s", session.share_slug, _shape(session))
    return session


@router.get("/sessions/{share_slug}", response_model=SessionOut, responses={404: {"description": NOT_FOUND}})
def get_session(share_slug: str, response: Response) -> SessionOut:
    with db.get_conn() as conn:
        session = _load(conn, _session_id(conn, share_slug))
    _private(response)
    logger.info("session get share_slug=%s %s", share_slug, _shape(session))
    return session


@router.patch("/sessions/{share_slug}", response_model=SessionOut)
def update_session(share_slug: str, body: SessionPatch, request: Request, response: Response) -> SessionOut:
    def change(conn, session_id: UUID) -> None:
        now = conn.execute("select start_date, return_date from trip_sessions where id = %s", (session_id,)).fetchone()
        start = body.start_date or now["start_date"]
        back = body.return_date or now["return_date"]
        try:
            _check_dates(start, back)
        except ValueError as e:
            raise HTTPException(422, str(e)) from None
        conn.execute(
            "update trip_sessions set name = coalesce(%s, name), start_date = %s, return_date = %s where id = %s",
            (body.name, start, back, session_id),
        )
        # The private files' deadline follows the trip home
        conn.execute(
            "update session_files set delete_after = %s where session_id = %s and kind = any(%s)",
            (back + timedelta(days=RETAIN_DAYS), session_id, list(EXPIRING)),
        )

    session = _write(share_slug, request, "update", change)
    _private(response)
    return session


@router.put("/sessions/{share_slug}/itinerary", response_model=SessionOut)
def attach_itinerary(share_slug: str, body: LinkIn, request: Request, response: Response) -> SessionOut:
    def change(conn, session_id: UUID) -> None:
        row = None
        if ITINERARY_SLUG.fullmatch(body.share_slug):
            row = conn.execute("select id from itineraries where share_slug = %s", (body.share_slug,)).fetchone()
        if row is None:
            logger.info("session itinerary not found share_slug=%s", share_slug)
            raise HTTPException(422, "itinerary_not_found")
        conn.execute("update trip_sessions set itinerary_id = %s where id = %s", (row["id"], session_id))

    session = _write(share_slug, request, "itinerary-attach", change)
    _private(response)
    return session


@router.delete("/sessions/{share_slug}/itinerary", response_model=SessionOut)
def detach_itinerary(share_slug: str, request: Request, response: Response) -> SessionOut:
    session = _write(
        share_slug, request, "itinerary-detach",
        lambda conn, sid: conn.execute("update trip_sessions set itinerary_id = null where id = %s", (sid,)),
    )
    _private(response)
    return session


@router.put("/sessions/{share_slug}/wallet", response_model=SessionOut)
def attach_wallet(share_slug: str, body: LinkIn, request: Request, response: Response) -> SessionOut:
    def change(conn, session_id: UUID) -> None:
        row = None
        if WALLET_SLUG.fullmatch(body.share_slug):
            row = conn.execute("select id from wallets where share_slug = %s", (body.share_slug,)).fetchone()
        if row is None:
            logger.info("session wallet not found share_slug=%s", share_slug)
            raise HTTPException(422, "wallet_not_found")
        conn.execute("update trip_sessions set wallet_id = %s where id = %s", (row["id"], session_id))

    session = _write(share_slug, request, "wallet-attach", change)
    _private(response)
    return session


@router.delete("/sessions/{share_slug}/wallet", response_model=SessionOut)
def detach_wallet(share_slug: str, request: Request, response: Response) -> SessionOut:
    session = _write(
        share_slug, request, "wallet-detach",
        lambda conn, sid: conn.execute("update trip_sessions set wallet_id = null where id = %s", (sid,)),
    )
    _private(response)
    return session


@router.put("/sessions/{share_slug}/hotel", response_model=SessionOut)
def set_hotel(share_slug: str, body: HotelIn, request: Request, response: Response) -> SessionOut:
    def change(conn, session_id: UUID) -> None:
        conn.execute(
            """insert into session_hotels (session_id, name, address, check_in, check_out, booking_ref, notes)
               values (%(id)s, %(name)s, %(address)s, %(check_in)s, %(check_out)s, %(booking_ref)s, %(notes)s)
               on conflict (session_id) do update set name = excluded.name, address = excluded.address,
                 check_in = excluded.check_in, check_out = excluded.check_out, booking_ref = excluded.booking_ref,
                 notes = excluded.notes, updated_at = now()""",
            {"id": session_id, **body.model_dump()},
        )

    session = _write(share_slug, request, "hotel-set", change)
    _private(response)
    return session


@router.delete("/sessions/{share_slug}/hotel", response_model=SessionOut)
def remove_hotel(share_slug: str, request: Request, response: Response) -> SessionOut:
    session = _write(
        share_slug, request, "hotel-remove",
        lambda conn, sid: conn.execute("delete from session_hotels where session_id = %s", (sid,)),
    )
    _private(response)
    return session


@router.delete("/sessions/{share_slug}", status_code=204)
def delete_session(share_slug: str, body: DeleteIn, request: Request) -> Response:
    """Deletes the session, its hotel and its files. The itinerary and the wallet stay: they have their own links."""
    _limit(WRITE_LIMITER, request, "delete")
    with db.get_conn() as conn:
        session_id = _session_id(conn, share_slug, lock=True)
        name = conn.execute("select name from trip_sessions where id = %s", (session_id,)).fetchone()["name"]
        if body.name.strip().casefold() != name.casefold():
            logger.info("session delete refused share_slug=%s reason=name_mismatch", share_slug)
            raise HTTPException(422, "name_mismatch")
        paths = [r["storage_path"] for r in conn.execute("select storage_path from session_files where session_id = %s", (session_id,))]
        conn.execute("delete from trip_sessions where id = %s", (session_id,))
    try:
        if paths:
            storage.store().delete(paths)
    except storage.StorageError:
        # The rows are gone, so nothing can reach the bytes; log it so the objects can be swept by hand
        logger.warning("session delete storage cleanup failed share_slug=%s files=%d", share_slug, len(paths))
    logger.info("session delete share_slug=%s files=%d", share_slug, len(paths))
    return Response(status_code=204, headers=NOINDEX)
