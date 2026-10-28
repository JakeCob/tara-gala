"""Pre-made itineraries (TG-24): the fallback plans loaded by data/load_premade.py. Read-only."""

import logging
from datetime import date as Date

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from . import db
from .plan_validation import MODEL_PREMADE, check_plan, load_refs, parse_plan

router = APIRouter(tags=["itineraries"])
logger = logging.getLogger("tara_gala.api")


class PremadeSummary(BaseModel):
    share_slug: str
    vibe: str | None = None
    trip_date: Date
    return_date: Date | None = None
    budget_php: float | None = None
    day_count: int
    stop_count: int
    spot_names: list[str]  # in visit order, each once


def require_premade(request: Request) -> None:
    if not request.app.state.flags.premade_itineraries:
        raise HTTPException(404)  # same body as an unknown route


@router.get("/premade-itineraries", response_model=list[PremadeSummary], dependencies=[Depends(require_premade)])
def list_premade() -> list[PremadeSummary]:
    """Every stored pre-made plan that still validates against today's rows. Never returns party data."""
    results: list[PremadeSummary] = []
    dropped = 0
    with db.get_conn() as conn:
        rows = conn.execute(
            """
            select share_slug, vibe, trip_date, return_date, budget_php, plan
            from itineraries where model = %s order by trip_date, share_slug
            """,
            (MODEL_PREMADE,),
        ).fetchall()
        for r in rows:
            # validate_plan's three steps, kept separate so the spot rows give the names
            plan, errors = parse_plan(r["plan"])
            if plan is not None:
                refs = load_refs(conn, plan)
                errors = check_plan(plan, refs, trip_date=r["trip_date"], return_date=r["return_date"])
            if errors:
                # e.g. its bus was deactivated by a scraper run; rerun `load_premade.py --dry-run` to see why
                dropped += 1
                logger.warning(
                    "premade itinerary dropped share_slug=%s codes=%s",
                    r["share_slug"], ",".join(sorted({e.code for e in errors})) or "-",
                )
                continue
            names = list(dict.fromkeys(refs.spots[s.spot_id].name for day in plan.days for s in day.stops))
            results.append(
                PremadeSummary(
                    share_slug=r["share_slug"],
                    vibe=r["vibe"],
                    trip_date=r["trip_date"],
                    return_date=r["return_date"],
                    budget_php=float(r["budget_php"]) if r["budget_php"] is not None else None,
                    day_count=len(plan.days),
                    stop_count=sum(len(day.stops) for day in plan.days),
                    spot_names=names,
                )
            )
    logger.info("premade list results=%d dropped=%d", len(results), dropped)
    return results
