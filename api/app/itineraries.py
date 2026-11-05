"""Saved itineraries by share link (TG-23). Read-only, one row by exact slug; there is no listing.

This is the only public read path to the itineraries table (it has no public RLS policy, TG-32). Anyone with
a link sees that plan, including party names on planner rows (a TG-20 decision); those names also stay in
the TG-27 service-worker cache on every device that opened the link. A DB-default slug is 48 random bits.
"""

import logging
import re
from datetime import date as Date
from datetime import datetime, timedelta
from uuid import UUID

from fastapi import APIRouter, HTTPException, Path, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from . import db, schedule
from . import guide as guides
from .last_mile import LastMileLeg, Spot, legs_by_id, spots_by_id
from .models import Trip
from .plan_validation import MODEL_PREMADE, MODEL_TRIP_EDIT, BusLeg, PlanError, check_plan, load_refs, parse_plan
from .trip_rows import TRIP_ROWS_SQL, trip_from_row

router = APIRouter(tags=["itineraries"])
logger = logging.getLogger("tara_gala.api")

# Same pattern as web/src/lib/itinerary.ts SLUG_PATTERN (a test compares them). Use fullmatch: with re.match,
# "$" also matches before a trailing newline.
SLUG = re.compile(r"^[A-Za-z0-9_-]{1,100}$")
NOT_FOUND = "Itinerary not found"
NOINDEX = {"X-Robots-Tag": "noindex"}


class PartyMember(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)  # only type and name leave the API
    type: str
    name: str | None = None


class PlanIssue(BaseModel):
    code: str
    path: str
    message: str


class BusLegOut(BaseModel):
    trip_id: UUID
    date: Date
    trip: Trip | None  # None only if the trips row no longer exists


class StopOut(BaseModel):
    spot_id: UUID
    arrive: str  # "HH:MM" as stored
    leave: str
    spot: Spot | None  # None if the spot row no longer exists
    last_mile_route_id: UUID
    leg: LastMileLeg | None  # None if the leg row no longer exists


class DayOut(BaseModel):
    day: int
    date: Date | None  # None when the outbound arrival is unknown
    stops: list[StopOut]


class ItineraryOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    share_slug: str
    premade: bool
    trip_date: Date
    return_date: Date | None
    party: list[PartyMember]
    budget_php: float | None
    vibe: str | None
    created_at: datetime
    outbound: BusLegOut
    return_: BusLegOut = Field(serialization_alias="return")
    days: list[DayOut]
    plan: dict  # the stored plan (CLAUDE.md shape), without its guide
    issues: list[PlanIssue]  # what has changed since it was saved, from TG-24's validator
    guide: guides.GuideOut | None = None  # TG-52: day tables, bus tables, pick, budget, to-do and sources, if it has one
    edited: bool = False  # TG-61: a trip's own edited copy (model trip-edit)
    seq: int | None = None  # TG-61: the copy's version, read in the same statement as its plan; None for a shared plan


# TG-61 (review M2): seq comes from the same statement as plan, so a save between two reads can't pair them. owner is
# the trip that owns a copy: only its trip places are read into the guide (review S5).
ROW_SQL = """
select i.id, i.share_slug, i.trip_date, i.return_date, i.party, i.budget_php, i.vibe, i.plan, i.model, i.created_at,
       (select max(v.seq) from itinerary_versions v where v.itinerary_id = i.id) as seq,
       (select v.session_id from itinerary_versions v where v.itinerary_id = i.id and v.seq = 0) as owner
from itineraries i where i.share_slug = %s
"""


def _codes(errors: list[PlanError]) -> str:
    return ",".join(sorted({e.code for e in errors})) or "-"


def _party(raw, share_slug: str) -> list[PartyMember]:
    """The entries that fit; a hand-edited or legacy row shouldn't hide the whole plan."""
    entries = raw if isinstance(raw, list) else []
    party, skipped = [], 0 if isinstance(raw, list) else 1
    for entry in entries:
        try:
            party.append(PartyMember.model_validate(entry))
        except ValidationError:
            skipped += 1
    if skipped:
        logger.warning("itinerary party entries skipped share_slug=%s skipped=%d", share_slug, skipped)
    return party


def _day_one(outbound: BusLeg, trip_row: dict | None) -> Date | None:
    """The day the outbound bus arrives (TG-12's arrival helper), or None when that's unknown."""
    if trip_row is None:
        return None
    _, offset = schedule.arrival(outbound.date, trip_row["departure_time"], trip_row["travel_minutes"])
    return outbound.date + timedelta(days=offset) if offset is not None else None


@router.get(
    "/itineraries/{share_slug}",
    response_model=ItineraryOut,
    response_model_by_alias=True,
    responses={404: {"description": NOT_FOUND}, 500: {"description": "Itinerary is unreadable"}},
)
def get_itinerary(
    response: Response,
    share_slug: str = Path(description="The share slug from the link, matched exactly"),
) -> ItineraryOut:
    if not SLUG.fullmatch(share_slug):
        # Not echoed here; the request line (TG-13) logs the path with %r, which escapes newlines
        logger.info("itinerary not found share_slug=<invalid>")
        raise HTTPException(404, NOT_FOUND, headers=NOINDEX)

    with db.get_conn() as conn:
        row = conn.execute(ROW_SQL, (share_slug,)).fetchone()
        if row is None:
            logger.info("itinerary not found share_slug=%s", share_slug)
            raise HTTPException(404, NOT_FOUND, headers=NOINDEX)
        out = build_out(conn, row)
    response.headers["Cache-Control"] = "private, no-cache"  # party names are personal
    response.headers.update(NOINDEX)
    warnings = sum(1 for t in ((out.guide.getting_there, out.guide.getting_home) if out.guide else ()) for b in t.buses if b.warning)
    logger.info(
        "itinerary get share_slug=%s premade=%s days=%d stops=%d issues=%d codes=%s guide=%s edited=%s seq=%s warnings=%d",
        share_slug, out.premade, len(out.days), sum(len(d.stops) for d in out.days), len(out.issues),
        ",".join(sorted({i.code for i in out.issues})) or "-", "yes" if out.guide else "no", out.edited, out.seq, warnings,
    )
    return out


def build_out(conn, row) -> ItineraryOut:
    """The answer for one ROW_SQL row: its plan, checked again, with the trips, spots and legs it names. TG-61's plan
    edits build their answer with this too, inside the save's transaction (review M1)."""
    share_slug = row["share_slug"]
    # TG-52: a guide rides next to the plan; the plan itself stays the planner's strict shape
    stored = dict(row["plan"]) if isinstance(row["plan"], dict) else row["plan"]
    guide_raw = stored.pop("guide", None) if isinstance(stored, dict) else None
    plan, errors = parse_plan(stored)
    if plan is None:
        logger.error("itinerary unreadable share_slug=%s codes=%s", share_slug, _codes(errors))
        raise HTTPException(500, "Itinerary is unreadable")
    errors = check_plan(plan, load_refs(conn, plan), trip_date=row["trip_date"], return_date=row["return_date"])
    edited = row["model"] == MODEL_TRIP_EDIT
    if edited:  # TG-61: a copy's bus warnings (BusRowOut.warning) take the place of the core's bus issues
        errors = [e for e in errors if not e.path.startswith(("outbound", "return"))]

    stops = [s for day in plan.days for s in day.stops]
    trips = {r["trip_id"]: r for r in conn.execute(TRIP_ROWS_SQL, ([plan.outbound.trip_id, plan.return_.trip_id],))}
    spots = spots_by_id(conn, {s.spot_id for s in stops})
    legs = legs_by_id(conn, {s.leg.last_mile_route_id for s in stops})
    the_guide = None
    if guide_raw is not None:
        g, problems = guides.parse_guide(guide_raw)
        if g is None:
            logger.warning("itinerary guide unreadable share_slug=%s problems=%d", share_slug, len(problems))
        else:
            ids = list(guides.trip_ids(g) - set(trips))
            if ids:
                trips.update({r["trip_id"]: r for r in conn.execute(TRIP_ROWS_SQL, (ids,))})
            terminal_names = {r["id"]: r["name"] for r in conn.execute("select id, name from terminals where id = any(%s)", (list(guides.terminal_ids(g)),))}
            trip_places = {r["id"]: r for r in conn.execute(
                "select id, name, lat, lng, maps_url from trip_places where id = any(%s) and session_id = %s",
                (list(guides.trip_place_ids(g)), row["owner"]),
            )} if row["owner"] else {}
            the_guide = guides.build(g, trips, spots_by_id(conn, guides.spot_ids(g)), terminal_names, trip_places, legs_by_id(conn, guides.leg_ids(g)))

    def bus(leg: BusLeg) -> BusLegOut:
        r = trips.get(leg.trip_id)  # an inactive trip is still built; issues says why
        return BusLegOut(trip_id=leg.trip_id, date=leg.date, trip=trip_from_row(r, leg.date) if r else None)

    day1 = _day_one(plan.outbound, trips.get(plan.outbound.trip_id))
    days = [
        DayOut(
            day=day.day,
            date=day1 + timedelta(days=day.day - 1) if day1 else None,
            stops=[
                StopOut(
                    spot_id=s.spot_id, arrive=s.arrive, leave=s.leave, spot=spots.get(s.spot_id),
                    last_mile_route_id=s.leg.last_mile_route_id, leg=legs.get(s.leg.last_mile_route_id),
                )
                for s in day.stops
            ],
        )
        for day in plan.days
    ]
    return ItineraryOut(
        share_slug=row["share_slug"],
        premade=row["model"] == MODEL_PREMADE,
        trip_date=row["trip_date"],
        return_date=row["return_date"],
        party=_party(row["party"], share_slug),
        budget_php=float(row["budget_php"]) if row["budget_php"] is not None else None,
        vibe=row["vibe"],
        created_at=row["created_at"],
        outbound=bus(plan.outbound),
        return_=bus(plan.return_),
        days=days,
        plan=stored,
        issues=[PlanIssue(code=e.code, path=e.path, message=e.message) for e in errors],
        guide=the_guide,
        edited=edited,
        seq=row["seq"] if edited else None,
    )
