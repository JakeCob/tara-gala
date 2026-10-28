"""Baguio spots and last-mile legs (terminal or spot -> spot or terminal). Read-only."""

import logging
from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Query
from pydantic import BaseModel

from . import db

router = APIRouter(tags=["last mile"])
logger = logging.getLogger("tara_gala.api")

LAST_MILE_NOTE = "Fares and routes change. Confirm with the driver or a local before you ride."


class Place(BaseModel):
    kind: Literal["terminal", "spot"]
    id: UUID
    slug: str
    name: str
    lat: float | None = None
    lng: float | None = None


class Spot(BaseModel):
    spot_id: UUID
    slug: str
    name: str
    city: str
    category: str
    lat: float | None = None
    lng: float | None = None
    description: str | None = None
    visit_minutes: int | None = None
    opening_hours: dict[str, Any] | None = None  # raw jsonb, e.g. {"mon": ["06:00", "18:00"]}; not parsed yet
    entrance_fee_php: float | None = None


class LastMileLeg(BaseModel):
    last_mile_route_id: UUID
    origin: Place
    destination: Place
    mode: str
    signboard: str | None = None
    boarding_point: str | None = None
    alighting_point: str | None = None
    fare_min_php: float | None = None
    fare_max_php: float | None = None
    minutes: int | None = None
    notes: str | None = None
    source: str
    last_verified_at: datetime | None = None
    confirm_note: str


def _float(v) -> float | None:
    return float(v) if v is not None else None


def _place(r: dict, terminal: str, spot: str) -> Place:
    """Build a Place from whichever side of the leg is set; the lmr_one_* constraints guarantee exactly one."""
    kind, p = ("terminal", terminal) if r[f"{terminal}_id"] is not None else ("spot", spot)
    return Place(kind=kind, id=r[f"{p}_id"], slug=r[f"{p}_slug"], name=r[f"{p}_name"], lat=r[f"{p}_lat"], lng=r[f"{p}_lng"])


@router.get("/spots", response_model=list[Spot])
def list_spots() -> list[Spot]:
    sql = """
        select id as spot_id, slug, name, city, category::text as category, lat, lng, description,
               visit_minutes, opening_hours, entrance_fee_php
        from spots order by name, slug
    """
    with db.get_conn() as conn:
        rows = conn.execute(sql).fetchall()
    spots = [Spot(**{**r, "entrance_fee_php": _float(r["entrance_fee_php"])}) for r in rows]
    logger.info("spots list results=%d", len(spots))
    return spots


_PLACE_COLS = ", ".join(
    f"{a}.id as {a}_id, {a}.slug as {a}_slug, {a}.name as {a}_name, {a}.lat as {a}_lat, {a}.lng as {a}_lng"
    for a in ("ft", "fs", "tt", "ts")
)


@router.get("/last-mile", response_model=list[LastMileLeg])
def list_last_mile(
    terminal: str | None = Query(None, description="Terminal slug; legs that start there, e.g. vl-baguio. Empty means no filter."),
    spot: str | None = Query(None, description="Spot slug; legs to or from it. Empty means no filter."),
) -> list[LastMileLeg]:
    where: list[str] = []
    params: dict = {}
    if terminal:
        where.append("ft.slug = %(terminal)s")
        params["terminal"] = terminal
    if spot:
        where.append("(fs.slug = %(spot)s or ts.slug = %(spot)s)")
        params["spot"] = spot

    sql = f"""
        select l.id, l.mode::text as mode, l.signboard, l.boarding_point, l.alighting_point,
               l.fare_min_php, l.fare_max_php, l.minutes, l.notes, l.source::text as source, l.last_verified_at,
               {_PLACE_COLS}
        from last_mile_routes l
        left join terminals ft on ft.id = l.from_terminal_id
        left join spots fs on fs.id = l.from_spot_id
        left join terminals tt on tt.id = l.to_terminal_id
        left join spots ts on ts.id = l.to_spot_id
        {"where " + " and ".join(where) if where else ""}
        order by coalesce(ts.name, tt.name), l.minutes nulls last, l.mode, l.id
    """
    with db.get_conn() as conn:
        rows = conn.execute(sql, params).fetchall()

    legs = [
        LastMileLeg(
            last_mile_route_id=r["id"],
            origin=_place(r, "ft", "fs"),
            destination=_place(r, "tt", "ts"),
            mode=r["mode"],
            signboard=r["signboard"],
            boarding_point=r["boarding_point"],
            alighting_point=r["alighting_point"],
            fare_min_php=_float(r["fare_min_php"]),
            fare_max_php=_float(r["fare_max_php"]),
            minutes=r["minutes"],
            notes=r["notes"],
            source=r["source"],
            last_verified_at=r["last_verified_at"],
            confirm_note=LAST_MILE_NOTE,
        )
        for r in rows
    ]
    logger.info("last-mile search terminal=%r spot=%r results=%d", terminal, spot, len(legs))
    return legs
