"""The invite link (TG-58 PR 2): a second, limited key to a trip, so the group can be asked who's coming.

Owner decisions (2026-11-03): the invite shows only the trip's name and dates, the names on its list and how many said
yes. It never shows who said no, and it never opens the trip: the organizer sends the trip's own link to the people who
said yes. Through it, someone answers for a name on the list, adds their own name with an answer, or fills an empty
photo slot. It can't replace a photo, since without accounts everyone holding the link can act as anyone.

The invite slug is null until someone with the trip's link turns it on. Turning it off kills it, and turning it on
again makes a new one. Once Manila's today is after the trip's return_date, the invite stops taking answers.

Logs carry the invite slug's first 8 characters and counts, never the full slug, a name or a time. The request log
masks the slug the same way (logging_setup.logged_path).
"""

import logging
import secrets
from datetime import date
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, model_validator

from . import db
from .limits import RateLimiter
from .sessions import NOINDEX, SLUG, SessionOut, _limit, _private, _write
from .trip_files import MAX_AVATAR_BYTES, _save, image_body, manila_today
from .trip_people import name_refused
from .wallets import MemberName

router = APIRouter(tags=["trip-invites"])
logger = logging.getLogger("tara_gala.api")

NOT_FOUND = "Invite not found"
INVITE_PER_HOUR = 60  # both POSTs together, per IP: about 6 MB of photos an hour at most
INVITE_LIMITER = RateLimiter(INVITE_PER_HOUR)


class InvitePerson(BaseModel):
    id: UUID
    name: str


class InviteOut(BaseModel):
    """This list is the whole of what the invite can read."""

    name: str
    start_date: date
    return_date: date
    coming: int  # rsvp = 'yes'
    closed: bool  # Manila's today is after return_date; people is then empty
    people: list[InvitePerson]


class InviteAnswerIn(BaseModel):
    """A name on the list by its id, or a new name. Exactly one."""

    model_config = ConfigDict(extra="forbid")
    attendee_id: UUID | None = None
    name: MemberName | None = None
    answer: Literal["yes", "no"]

    @model_validator(mode="after")
    def one_person(self) -> "InviteAnswerIn":
        if (self.attendee_id is None) == (self.name is None):
            raise ValueError("send attendee_id or name, not both")
        return self


class AnswerOut(BaseModel):
    attendee_id: UUID
    name: str
    answer: str


def _short(invite_slug: str) -> str:
    return invite_slug[:8] if SLUG.fullmatch(invite_slug) else "<invalid>"


def _refuse(invite_slug: str, status: int, reason: str) -> HTTPException:
    logger.info("trip invite refused invite=%s reason=%s", _short(invite_slug), reason)
    return HTTPException(status, reason)


def _invite(conn, invite_slug: str, lock: bool = False):
    """The trip behind an invite, or 404. Only invite_slug is looked up: a trip's own slug opens nothing here."""
    if not SLUG.fullmatch(invite_slug):
        logger.info("trip invite not found invite=<invalid>")
        raise HTTPException(404, NOT_FOUND, headers=NOINDEX)
    trip = conn.execute(
        "select id, share_slug, name, start_date, return_date from trip_sessions where invite_slug = %s" + (" for update" if lock else ""),
        (invite_slug,),
    ).fetchone()
    if trip is None:
        logger.info("trip invite not found invite=%s", _short(invite_slug))
        raise HTTPException(404, NOT_FOUND, headers=NOINDEX)
    return trip


def _closed(trip) -> bool:
    return manila_today() > trip["return_date"]


def _limited(request: Request) -> None:
    """A dependency, so the limit comes ahead of the body's validation."""
    _limit(INVITE_LIMITER, request, "invite")


# ---------------------------------------------------------------- turning it on and off, with the trip's link

@router.put("/sessions/{share_slug}/invite", response_model=SessionOut)
def start_invite(share_slug: str, request: Request, response: Response) -> SessionOut:
    # Made in Python, not by pgcrypto in the query: its schema isn't on every search_path (review S1)
    session = _write(
        share_slug, request, "invite-on",
        lambda conn, sid: conn.execute(
            "update trip_sessions set invite_slug = coalesce(invite_slug, %s) where id = %s", (secrets.token_hex(16), sid)
        ),
    )
    _private(response)
    return session


@router.delete("/sessions/{share_slug}/invite", response_model=SessionOut)
def stop_invite(share_slug: str, request: Request, response: Response) -> SessionOut:
    session = _write(
        share_slug, request, "invite-off",
        lambda conn, sid: conn.execute("update trip_sessions set invite_slug = null where id = %s", (sid,)),
    )
    _private(response)
    return session


# ---------------------------------------------------------------- the invite's own routes

@router.get("/invites/{invite_slug}", response_model=InviteOut, responses={404: {"description": NOT_FOUND}})
def get_invite(invite_slug: str, response: Response) -> InviteOut:
    with db.get_conn() as conn:
        trip = _invite(conn, invite_slug)
        people = conn.execute(
            "select id, name, rsvp from session_attendees where session_id = %s order by seq", (trip["id"],)
        ).fetchall()
    closed = _closed(trip)
    out = InviteOut(
        name=trip["name"],
        start_date=trip["start_date"],
        return_date=trip["return_date"],
        coming=sum(1 for p in people if p["rsvp"] == "yes"),
        closed=closed,
        people=[] if closed else [InvitePerson(id=p["id"], name=p["name"]) for p in people],
    )
    _private(response)
    logger.info("trip invite get invite=%s closed=%s people=%d coming=%d", _short(invite_slug), closed, len(people), out.coming)
    return out


@router.post("/invites/{invite_slug}/answers", response_model=AnswerOut, dependencies=[Depends(_limited)])
def answer(invite_slug: str, body: InviteAnswerIn, response: Response) -> AnswerOut:
    with db.get_conn() as conn:
        trip = _invite(conn, invite_slug, lock=True)  # held until commit, so two new names can't pass the cap
        if _closed(trip):
            raise _refuse(invite_slug, 409, "invite_closed")
        if body.attendee_id is not None:
            row = conn.execute(
                "update session_attendees set rsvp = %s, rsvp_at = now() where id = %s and session_id = %s returning id, name",
                (body.answer, body.attendee_id, trip["id"]),
            ).fetchone()
            if row is None:
                raise _refuse(invite_slug, 422, "unknown_attendee")
        else:
            if reason := name_refused(conn, trip["id"], body.name):
                raise _refuse(invite_slug, 409, reason)
            row = conn.execute(
                "insert into session_attendees (session_id, name, rsvp, rsvp_at) values (%s, %s, %s, now()) returning id, name",
                (trip["id"], body.name, body.answer),
            ).fetchone()
        count = conn.execute("select count(*) as n from session_attendees where session_id = %s", (trip["id"],)).fetchone()["n"]
    _private(response)
    logger.info("trip invite answer invite=%s answer=%s new=%s people=%d", _short(invite_slug), body.answer, body.name is not None, count)
    return AnswerOut(attendee_id=row["id"], name=row["name"], answer=body.answer)


def _open_trip(invite_slug: str) -> str:
    """The share slug behind an open invite, or 404 or 409, checked before a photo's body is read."""
    with db.get_conn() as conn:
        trip = _invite(conn, invite_slug)
    if _closed(trip):
        raise _refuse(invite_slug, 409, "invite_closed")
    return trip["share_slug"]


@router.post("/invites/{invite_slug}/attendees/{attendee_id}/photo", status_code=204, dependencies=[Depends(_limited)])
async def add_photo(invite_slug: str, attendee_id: UUID, request: Request) -> Response:
    """Fills an empty photo slot. Returns nothing, so the trip (_save's SessionOut) never reaches the invite.

    The open check isn't repeated under _save's lock: an upload in flight as the invite is turned off still lands, and
    anyone with the trip's link can remove it.
    """
    share_slug = await run_in_threadpool(_open_trip, invite_slug)
    try:
        content_type, data = await image_body(request, share_slug, "avatar", MAX_AVATAR_BYTES)
        await run_in_threadpool(_save, share_slug, "avatar", "", None, content_type, data, None, attendee_id, True)
    except HTTPException as e:
        logger.info("trip invite refused invite=%s reason=%s", _short(invite_slug), e.detail)
        raise
    logger.info("trip invite photo invite=%s bytes=%d", _short(invite_slug), len(data))
    return Response(status_code=204, headers={"Cache-Control": "private, no-cache", **NOINDEX})
