from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class Terminal(BaseModel):
    slug: str
    name: str
    city: str
    address: str | None = None
    lat: float | None = None
    lng: float | None = None


class Trip(BaseModel):
    trip_id: UUID
    operator_slug: str
    operator_name: str
    origin_slug: str
    origin_name: str
    origin_city: str
    destination_slug: str
    destination_name: str
    destination_city: str
    via: str | None = None
    service_class: str
    fare_php: float | None = None
    travel_minutes: int | None = None
    departure_time: str          # "HH:MM", Manila time
    arrives_around: str | None   # departure + typical travel time, a rough guide only
    booking_url: str | None = None
    source: str
    source_url: str | None = None
    last_verified_at: datetime | None = None
    confirm_note: str
