"""A trip's list of people (TG-58 PR 1): the names, each person's answer, and when they reached the first meet-up.

Owner decisions (2026-11-03): anyone with the trip's link edits the list and taps a name at the meet-up, the time is
set by the server and can be corrected, and the list is separate from the wallet's members, with a one-tap copy of
their names. Nothing here writes to the wallet or remembers where a name came from.

A person on another trip gets 422 unknown_attendee, never 404: the web reads a 404 as a dead trip link. Logs carry the
slug and counts, never a name, an answer's person or a time.
"""

import logging
from datetime import datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, model_validator

from .sessions import SessionOut, _private, _write
from .trip_files import _forget
from .wallets import MemberName

router = APIRouter(tags=["trip-people"])
logger = logging.getLogger("tara_gala.api")

MAX_ATTENDEES = 30


class AttendeeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: MemberName


class AnswerIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    rsvp: Literal["pending", "yes", "no"]


class ArrivalIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    at: datetime | None = None  # a correction, Manila wall time with no offset. None: the server's time now

    @model_validator(mode="after")
    def wall_time(self) -> "ArrivalIn":
        if self.at is not None and self.at.tzinfo is not None:
            raise ValueError("an arrival is Manila wall time, without an offset")
        return self


def _refuse(share_slug: str, status: int, reason: str) -> HTTPException:
    logger.info("trip attendee refused share_slug=%s reason=%s", share_slug, reason)
    return HTTPException(status, reason)


def _one(share_slug: str, row) -> None:
    """A write that named a person must have found them on this trip."""
    if row is None:
        raise _refuse(share_slug, 422, "unknown_attendee")


@router.post("/sessions/{share_slug}/attendees", status_code=201, response_model=SessionOut)
def add_attendee(share_slug: str, body: AttendeeIn, request: Request, response: Response) -> SessionOut:
    def change(conn, session_id: UUID) -> None:
        taken = conn.execute(
            "select 1 from session_attendees where session_id = %s and lower(name) = lower(%s)", (session_id, body.name)
        ).fetchone()
        if taken:
            raise _refuse(share_slug, 409, "name_taken")
        count = conn.execute("select count(*) as n from session_attendees where session_id = %s", (session_id,)).fetchone()["n"]
        if count >= MAX_ATTENDEES:
            raise _refuse(share_slug, 409, "party_full")
        conn.execute("insert into session_attendees (session_id, name) values (%s, %s)", (session_id, body.name))

    session = _write(share_slug, request, "attendee-add", change)
    _private(response)
    return session


@router.post("/sessions/{share_slug}/attendees/from-wallet", response_model=SessionOut)
def copy_wallet_names(share_slug: str, request: Request, response: Response) -> SessionOut:
    added = skipped = 0

    def change(conn, session_id: UUID) -> None:
        nonlocal added, skipped
        wallet_id = conn.execute("select wallet_id from trip_sessions where id = %s", (session_id,)).fetchone()["wallet_id"]
        if wallet_id is None:
            raise _refuse(share_slug, 422, "no_wallet")
        listed = {r["key"] for r in conn.execute("select lower(name) as key from session_attendees where session_id = %s", (session_id,))}
        members = conn.execute("select name, lower(name) as key from wallet_members where wallet_id = %s order by seq", (wallet_id,)).fetchall()
        for m in members:
            if m["key"] in listed or len(listed) >= MAX_ATTENDEES:
                skipped += 1
                continue
            conn.execute("insert into session_attendees (session_id, name) values (%s, %s)", (session_id, m["name"]))
            listed.add(m["key"])
            added += 1

    session = _write(share_slug, request, "attendee-copy", change)
    logger.info("trip attendee copy share_slug=%s added=%d skipped=%d", share_slug, added, skipped)
    _private(response)
    return session


@router.patch("/sessions/{share_slug}/attendees/{attendee_id}", response_model=SessionOut)
def set_answer(share_slug: str, attendee_id: UUID, body: AnswerIn, request: Request, response: Response) -> SessionOut:
    def change(conn, session_id: UUID) -> None:
        row = conn.execute(
            """update session_attendees set rsvp = %s, rsvp_at = case when %s then null else now() end
               where id = %s and session_id = %s returning id""",
            (body.rsvp, body.rsvp == "pending", attendee_id, session_id),
        ).fetchone()
        _one(share_slug, row)

    session = _write(share_slug, request, "attendee-answer", change)
    _private(response)
    return session


@router.delete("/sessions/{share_slug}/attendees/{attendee_id}", response_model=SessionOut)
def remove_attendee(share_slug: str, attendee_id: UUID, request: Request, response: Response) -> SessionOut:
    paths: list[str] = []

    def change(conn, session_id: UUID) -> None:
        # Read the photo's path first: the cascade would take the row and strand the bytes
        paths.extend(r["storage_path"] for r in conn.execute(
            "delete from session_files where attendee_id = %s and session_id = %s returning storage_path", (attendee_id, session_id)
        ))
        row = conn.execute("delete from session_attendees where id = %s and session_id = %s returning id", (attendee_id, session_id)).fetchone()
        _one(share_slug, row)

    session = _write(share_slug, request, "attendee-remove", change)
    _forget(paths, share_slug)  # after the commit: a failed delete leaves bytes nothing points to, and the person is gone
    _private(response)
    return session


@router.put("/sessions/{share_slug}/attendees/{attendee_id}/arrival", response_model=SessionOut)
def set_arrival(share_slug: str, attendee_id: UUID, body: ArrivalIn, request: Request, response: Response) -> SessionOut:
    def change(conn, session_id: UUID) -> None:
        if body.at is None:  # the first tap's time stays when two phones tap
            row = conn.execute(
                "update session_attendees set arrived_at = coalesce(arrived_at, now()) where id = %s and session_id = %s returning id",
                (attendee_id, session_id),
            ).fetchone()
        else:
            row = conn.execute(
                "update session_attendees set arrived_at = %s::timestamp at time zone 'Asia/Manila' where id = %s and session_id = %s returning id",
                (body.at, attendee_id, session_id),
            ).fetchone()
        _one(share_slug, row)

    session = _write(share_slug, request, "arrival-set" if body.at is None else "arrival-fix", change)
    _private(response)
    return session


@router.delete("/sessions/{share_slug}/attendees/{attendee_id}/arrival", response_model=SessionOut)
def clear_arrival(share_slug: str, attendee_id: UUID, request: Request, response: Response) -> SessionOut:
    def change(conn, session_id: UUID) -> None:
        row = conn.execute(
            "update session_attendees set arrived_at = null where id = %s and session_id = %s returning id", (attendee_id, session_id)
        ).fetchone()
        _one(share_slug, row)

    session = _write(share_slug, request, "arrival-clear", change)
    _private(response)
    return session
