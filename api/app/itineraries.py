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
from .last_mile import LastMileLeg, Spot, legs_by_id, spots_by_id
from .models import Trip
from .plan_validation import MODEL_PREMADE, BusLeg, PlanError, check_plan, load_refs, parse_plan
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
    plan: dict  # the stored plan, verbatim (CLAUDE.md shape)
    issues: list[PlanIssue]  # what has changed since it was saved, from TG-24's validator


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
        row = conn.execute(
            """
            select share_slug, trip_date, return_date, party, budget_php, vibe, plan, model, created_at
            from itineraries where share_slug = %s
            """,
            (share_slug,),
        ).fetchone()
        if row is None:
            logger.info("itinerary not found share_slug=%s", share_slug)
            raise HTTPException(404, NOT_FOUND, headers=NOINDEX)

        plan, errors = parse_plan(row["plan"])
        if plan is None:
            logger.error("itinerary unreadable share_slug=%s codes=%s", share_slug, _codes(errors))
            raise HTTPException(500, "Itinerary is unreadable")
        errors = check_plan(plan, load_refs(conn, plan), trip_date=row["trip_date"], return_date=row["return_date"])

        stops = [s for day in plan.days for s in day.stops]
        trips = {r["trip_id"]: r for r in conn.execute(TRIP_ROWS_SQL, ([plan.outbound.trip_id, plan.return_.trip_id],))}
        spots = spots_by_id(conn, {s.spot_id for s in stops})
        legs = legs_by_id(conn, {s.leg.last_mile_route_id for s in stops})

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
    premade = row["model"] == MODEL_PREMADE
    response.headers["Cache-Control"] = "private, no-cache"  # party names are personal
    response.headers.update(NOINDEX)
    logger.info(
        "itinerary get share_slug=%s premade=%s days=%d stops=%d issues=%d codes=%s",
        share_slug, premade, len(days), len(stops), len(errors), _codes(errors),
    )
    return ItineraryOut(
        share_slug=row["share_slug"],
        premade=premade,
        trip_date=row["trip_date"],
        return_date=row["return_date"],
        party=_party(row["party"], share_slug),
        budget_php=float(row["budget_php"]) if row["budget_php"] is not None else None,
        vibe=row["vibe"],
        created_at=row["created_at"],
        outbound=bus(plan.outbound),
        return_=bus(plan.return_),
        days=days,
        plan=row["plan"],
        issues=[PlanIssue(code=e.code, path=e.path, message=e.message) for e in errors],
    )
