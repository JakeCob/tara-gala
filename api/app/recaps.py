"""The read-only recap link (TG-64): a third key to a trip, so the group can share how it went.

Owner decisions (2026-11-16, ticket.md): its own link, live, turned on at any time by anyone with the trip's link. Turned
on, it shows the map only: the trip's plan with the times each stop was ticked. Photos, people (a count, names, or names
with profile photos) and spending (the group's total only) are each opt-in. It never expires; turning it off kills the
link and resets the toggles, and turning it on again makes a new one.

What it never reads into the answer, whatever the toggles: the trip's, invite's, wallet's or plan's slug; the hotel
booking (its table is never queried; the plan's own lodging place is part of the map); tickets, QRs or proofs;
expense notes, payers or shares; the wallet's members; anyone's answer, or anyone who didn't come; the to-do list.

Every miss is one 404 `recap_not_found` with the same body and headers: a wrong slug, a link that's off, a deleted
trip, the flag off, a file of the wrong kind or trip, or a toggle that's off. Logs carry the recap slug's first 8
characters and counts, never a name, an amount, a file or person id, a time or the full slug. The request log masks the
slug and everything after it (logging_setup.logged_path).
"""

import logging
import secrets
from datetime import date, datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict

from . import db, itineraries
from .guide import Budget, GuideOut
from .limits import RateLimiter
from .sessions import SLUG, MarkOut, SessionOut, _limit, _private, _write
from .trip_files import manila_today, send_file

router = APIRouter(tags=["recaps"])
logger = logging.getLogger("tara_gala.api")

NOT_FOUND = "recap_not_found"
HEADERS = {"Cache-Control": "private, no-cache", "X-Robots-Tag": "noindex"}  # on every recap answer, 404s included
RECAP_PER_HOUR = 600  # the three public reads together, per IP: photo bytes are the heavy part
RECAP_LIMITER = RateLimiter(RECAP_PER_HOUR)


class RecapIn(BaseModel):
    """What the recap shows. All three are sent every time, so one PUT sets the link's whole state."""

    model_config = ConfigDict(extra="forbid")
    photos: bool
    people: Literal["none", "names", "names_photos"]
    spending: Literal["none", "total"]


class RecapPhoto(BaseModel):
    id: UUID
    row_key: str | None  # the checklist row it was taken at, or None for "On the trip"


class RecapPerson(BaseModel):
    name: str
    arrived_at: datetime | None  # at the first meet-up; None when they joined later
    avatar_id: UUID | None  # the attendee's id, only with names_photos and when a profile photo exists


class RecapPeople(BaseModel):
    count: int  # everyone who came: said yes, or was marked here
    list: list[RecapPerson] | None  # None with people "none"


class RecapSpending(BaseModel):
    total_centavos: int  # the group's total only (decision 7): never anyone's share, a member count or a note


class RecapOut(BaseModel):
    """This is the whole of what the recap link can read."""

    name: str
    start_date: date
    return_date: date
    still_on: bool  # Manila's today is on or before return_date
    guide: GuideOut | None  # the trip's own plan (TG-61's copy if edited), without to-dos, sources or budget
    marks: list[MarkOut]  # row: and pick: marks, never todo:; updated_at is when it was ticked
    photos: list[RecapPhoto] | None  # None unless photos are on
    people: RecapPeople
    spending: RecapSpending | None  # None unless spending is on, with a wallet and something spent


def _short(recap_slug: str) -> str:
    return recap_slug[:8] if SLUG.fullmatch(recap_slug) else "<invalid>"


def _missing(recap_slug: str, reason: str) -> HTTPException:
    """The one 404. `reason` is for the log only: the answer never says which miss it was."""
    logger.info("recap not found recap=%s reason=%s", _short(recap_slug), reason)
    return HTTPException(404, NOT_FOUND, headers=HEADERS)


def recap_flag(request: Request) -> None:
    """RECAP_LINKS off: every recap route answers the recap's own 404, the same as a wrong slug (plan §2.2, N2)."""
    if not request.app.state.flags.recap_links:
        raise _missing(request.path_params.get("recap_slug", ""), "flag_off")


def _limited(request: Request) -> None:
    """A dependency on the public reads, so the limit comes before any database work."""
    _limit(RECAP_LIMITER, request, "recap")


def _headers(response: Response) -> None:
    _private(response)  # Cache-Control: private, no-cache and X-Robots-Tag: noindex, as HEADERS


def _recap(conn, recap_slug: str):
    """The trip behind a recap link, or the 404. Only recap_slug is looked up: a trip's own slug opens nothing here."""
    if not SLUG.fullmatch(recap_slug):
        raise _missing(recap_slug, "off_or_wrong")
    trip = conn.execute(
        """select s.id, s.name, s.start_date, s.return_date, s.wallet_id, s.recap_photos, s.recap_people, s.recap_spending,
                  i.share_slug as itinerary_slug
           from trip_sessions s left join itineraries i on i.id = s.itinerary_id where s.recap_slug = %s""",
        (recap_slug,),
    ).fetchone()
    if trip is None:
        raise _missing(recap_slug, "off_or_wrong")
    return trip


def _came(conn, session_id: UUID) -> list:
    """Everyone who came, in list order: said yes, or was marked here whatever they answered (plan Rev 1, S1)."""
    return conn.execute(
        """select id, name, arrived_at from session_attendees
           where session_id = %s and (rsvp = 'yes' or arrived_at is not null) order by seq""",
        (session_id,),
    ).fetchall()


def build(conn, trip) -> RecapOut:
    """The recap for one trip found by _recap. The only builder."""
    guide = None
    if trip["itinerary_slug"] is not None:  # kept in this function only: never in the answer or a log line
        row = conn.execute(itineraries.ROW_SQL, (trip["itinerary_slug"],)).fetchone()
        if row is not None:
            out = itineraries.build_out(conn, row)  # an unreadable plan is its 500, never guide: None
            if out.guide is not None:
                guide = out.guide.model_copy(update={"todo": [], "sources": [], "budget": Budget()})
    marks = conn.execute(
        "select key, value, updated_at from session_marks where session_id = %s and key !~ '^todo:' order by updated_at, key",
        (trip["id"],),
    ).fetchall()
    photos = None
    if trip["recap_photos"]:
        photos = [
            RecapPhoto(**p)
            for p in conn.execute(
                "select id, row_key from session_files where session_id = %s and kind = 'photo' order by created_at, id", (trip["id"],)
            ).fetchall()
        ]
    came = _came(conn, trip["id"])
    listed = None
    if trip["recap_people"] != "none":
        with_avatar = set()
        if trip["recap_people"] == "names_photos" and came:
            with_avatar = {
                r["attendee_id"]
                for r in conn.execute(
                    "select attendee_id from session_files where session_id = %s and kind = 'avatar' and attendee_id = any(%s)",
                    (trip["id"], [p["id"] for p in came]),
                ).fetchall()
            }
        listed = [RecapPerson(name=p["name"], arrived_at=p["arrived_at"], avatar_id=p["id"] if p["id"] in with_avatar else None) for p in came]
    spending = None
    if trip["recap_spending"] == "total" and trip["wallet_id"] is not None:
        total = conn.execute(
            "select coalesce(sum(amount_centavos), 0) as total from expenses where wallet_id = %s", (trip["wallet_id"],)
        ).fetchone()["total"]
        spending = RecapSpending(total_centavos=total) if total else None
    return RecapOut(
        name=trip["name"],
        start_date=trip["start_date"],
        return_date=trip["return_date"],
        still_on=manila_today() <= trip["return_date"],
        guide=guide,
        marks=[MarkOut(**m) for m in marks],
        photos=photos,
        people=RecapPeople(count=len(came), list=listed),
        spending=spending,
    )


# ---------------------------------------------------------------- turning it on and off, with the trip's link

@router.put("/sessions/{share_slug}/recap", response_model=SessionOut)
def set_recap(share_slug: str, body: RecapIn, request: Request, response: Response) -> SessionOut:
    """Turns the link on with a new slug if it's off, or changes what it shows. The slug is made in Python, as the
    invite's is (pgcrypto isn't on every search_path)."""
    made = {}

    def change(conn, sid: UUID) -> None:
        made["new"] = conn.execute("select recap_slug from trip_sessions where id = %s", (sid,)).fetchone()["recap_slug"] is None
        conn.execute(
            """update trip_sessions set recap_slug = coalesce(recap_slug, %s), recap_photos = %s, recap_people = %s,
                      recap_spending = %s where id = %s""",
            (secrets.token_hex(16), body.photos, body.people, body.spending, sid),
        )

    session = _write(share_slug, request, "recap-on", change)
    _headers(response)
    logger.info(
        "recap on share_slug=%s photos=%s people=%s spending=%s new=%s", share_slug, body.photos, body.people, body.spending, made["new"]
    )
    return session


@router.delete("/sessions/{share_slug}/recap", response_model=SessionOut)
def stop_recap(share_slug: str, request: Request, response: Response) -> SessionOut:
    """Off: the link dies, and the toggles go back to map only, so turning it on again starts from there (decision 3)."""
    session = _write(
        share_slug, request, "recap-off",
        lambda conn, sid: conn.execute(
            """update trip_sessions set recap_slug = null, recap_photos = false, recap_people = 'none', recap_spending = 'none'
               where id = %s""",
            (sid,),
        ),
    )
    _headers(response)
    logger.info("recap off share_slug=%s", share_slug)
    return session


# ---------------------------------------------------------------- the recap's own routes

@router.get("/recaps/{recap_slug}", response_model=RecapOut, responses={404: {"description": NOT_FOUND}}, dependencies=[Depends(_limited)])
def get_recap(recap_slug: str, response: Response) -> RecapOut:
    with db.get_conn() as conn:
        trip = _recap(conn, recap_slug)
        out = build(conn, trip)
    _headers(response)
    logger.info(
        "recap view recap=%s rows=%d done=%d photos=%s people=%s spending=%s",
        _short(recap_slug),
        sum(len(d.rows) for d in out.guide.days) if out.guide else 0,
        sum(1 for m in out.marks if m.key.startswith("row:")),
        len(out.photos) if out.photos is not None else "off",
        trip["recap_people"],
        "on" if trip["recap_spending"] == "total" else "off",  # the setting, never the amount
    )
    return out


def _file_id(recap_slug: str, raw: str) -> UUID:
    """A file or person id from the URL. Anything that isn't a UUID is the same 404, not FastAPI's 422."""
    try:
        return UUID(raw)
    except ValueError:
        raise _missing(recap_slug, "file") from None


@router.get("/recaps/{recap_slug}/photos/{file_id}", responses={404: {"description": NOT_FOUND}}, dependencies=[Depends(_limited)])
def get_photo(recap_slug: str, file_id: str) -> Response:
    with db.get_conn() as conn:
        trip = _recap(conn, recap_slug)
        if not trip["recap_photos"]:
            raise _missing(recap_slug, "toggle")
        f = conn.execute(
            "select kind, storage_path, content_type from session_files where id = %s and session_id = %s and kind = 'photo'",
            (_file_id(recap_slug, file_id), trip["id"]),
        ).fetchone()
    if f is None:
        raise _missing(recap_slug, "file")
    answer = send_file(f)
    logger.info("recap file recap=%s kind=photo bytes=%d", _short(recap_slug), len(answer.body))
    return answer


@router.get("/recaps/{recap_slug}/avatars/{attendee_id}", responses={404: {"description": NOT_FOUND}}, dependencies=[Depends(_limited)])
def get_avatar(recap_slug: str, attendee_id: str) -> Response:
    with db.get_conn() as conn:
        trip = _recap(conn, recap_slug)
        if trip["recap_people"] != "names_photos":
            raise _missing(recap_slug, "toggle")
        aid = _file_id(recap_slug, attendee_id)
        f = conn.execute(
            """select f.kind, f.storage_path, f.content_type from session_files f
               join session_attendees a on a.id = f.attendee_id and a.session_id = f.session_id
               where f.session_id = %s and f.kind = 'avatar' and f.attendee_id = %s and (a.rsvp = 'yes' or a.arrived_at is not null)""",
            (trip["id"], aid),
        ).fetchone()
    if f is None:
        raise _missing(recap_slug, "file")
    answer = send_file(f)
    logger.info("recap file recap=%s kind=avatar bytes=%d", _short(recap_slug), len(answer.body))
    return answer
