"""The trip's shared checklist (TG-52 PR 3): ticks on the itinerary guide's day rows and to-dos, and its picks (the
sunrise option). Owner decisions (2026-11-01): anyone with the trip's link ticks or unticks any row, in any order; the
progress map shows the party at the latest-ticked row that has a place; the to-do list and the sunrise pick are shared.

A key must exist in the guide of the itinerary the trip holds, so a tick can't point at nothing. Logs carry the slug
and the key, which are row numbers, never a row's text.
"""

import logging
import re

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict

from . import db
from . import guide as guides
from .sessions import WRITE_LIMITER, SessionOut, _limit, _load, _private, _session_id

router = APIRouter(tags=["trip-marks"])
logger = logging.getLogger("tara_gala.api")

KEY = re.compile(r"^(row:d[1-9]-\d{2}|todo:\d{2}|pick:[a-z]{1,20})$")
MAX_MARKS = 300


class MarkIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    value: str  # "done" for a row or a to-do; the option's letter for a pick


def _guide(conn, session_id) -> guides.Guide | None:
    row = conn.execute(
        "select i.plan from trip_sessions s join itineraries i on i.id = s.itinerary_id where s.id = %s", (session_id,)
    ).fetchone()
    raw = row["plan"].get("guide") if row and isinstance(row["plan"], dict) else None
    return guides.parse_guide(raw)[0] if raw is not None else None


def _check(conn, session_id, key: str, value: str | None) -> None:
    """422 unless the key is in the trip's guide and the value fits it (value None: an untick)."""
    if not KEY.fullmatch(key):
        raise HTTPException(422, "bad_key")
    g = _guide(conn, session_id)
    if g is None:
        raise HTTPException(422, "no_guide")
    if key.startswith("pick:"):
        options = guides.pick_options(g).get(key.removeprefix("pick:"))
        if options is None or (value is not None and value not in options):
            raise HTTPException(422, "bad_pick")
    elif key not in guides.mark_keys(g):
        raise HTTPException(422, "unknown_key")
    elif value is not None and value != "done":
        raise HTTPException(422, "bad_value")


@router.put("/sessions/{share_slug}/marks/{key}", response_model=SessionOut)
def set_mark(share_slug: str, key: str, body: MarkIn, request: Request, response: Response) -> SessionOut:
    _limit(WRITE_LIMITER, request, "mark")
    with db.get_conn() as conn:
        session_id = _session_id(conn, share_slug, lock=True)
        _check(conn, session_id, key, body.value)
        count = conn.execute("select count(*) as n from session_marks where session_id = %s", (session_id,)).fetchone()["n"]
        if count >= MAX_MARKS:
            raise HTTPException(422, "too_many_marks")
        conn.execute(
            """insert into session_marks (session_id, key, value) values (%s, %s, %s)
               on conflict (session_id, key) do update set value = excluded.value, updated_at = now()""",
            (session_id, key, body.value),
        )
        session = _load(conn, session_id)
    logger.info("trip mark set share_slug=%s key=%s value=%s marks=%d", share_slug, key, body.value, len(session.marks))
    _private(response)
    return session


@router.delete("/sessions/{share_slug}/marks/{key}", response_model=SessionOut)
def clear_mark(share_slug: str, key: str, request: Request, response: Response) -> SessionOut:
    _limit(WRITE_LIMITER, request, "unmark")
    with db.get_conn() as conn:
        session_id = _session_id(conn, share_slug, lock=True)
        if not KEY.fullmatch(key):
            raise HTTPException(422, "bad_key")
        conn.execute("delete from session_marks where session_id = %s and key = %s", (session_id, key))
        session = _load(conn, session_id)
    logger.info("trip mark clear share_slug=%s key=%s marks=%d", share_slug, key, len(session.marks))
    _private(response)
    return session
