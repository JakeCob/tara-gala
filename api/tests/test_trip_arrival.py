"""TG-12: arrivals after midnight carry a day offset. Fixture data below is made up for tests only, not real schedules."""

from datetime import date, time

import load_data
from app import main
from conftest import write_csvs

SRC = "https://example.test/schedule"
FRIDAY = date(2026, 11, 6)

TRIPS = (
    f"victory-liner,vl-cubao,vl-baguio,,regular_aircon,700,360,2x2,yes,22:00,daily,,,{SRC},2026-10-24,\n"
    f"victory-liner,vl-cubao,vl-baguio,,regular_aircon,700,360,2x2,yes,07:00,daily,,,{SRC},2026-10-24,\n"
    # separate route so its travel_minutes stays null (the loader merges travel_minutes per route)
    f"victory-liner,vl-cubao,vl-baguio,,deluxe,800,,2x2,yes,09:00,daily,,,{SRC},2026-10-24,\n"
)

# Trip fields before TG-12; none may change name or disappear
OLD_TRIP_FIELDS = {
    "trip_id", "operator_slug", "operator_name", "origin_slug", "origin_name", "origin_city",
    "destination_slug", "destination_name", "destination_city", "via", "service_class", "fare_php",
    "travel_minutes", "departure_time", "arrives_around", "booking_url", "source", "source_url",
    "last_verified_at", "confirm_note",
}


def test_arrival_same_day():
    assert main._arrival(FRIDAY, time(7, 0), 360) == ("13:00", 0)


def test_arrival_overnight():
    assert main._arrival(FRIDAY, time(22, 0), 360) == ("04:00", 1)


def test_arrival_exactly_midnight():
    assert main._arrival(FRIDAY, time(18, 0), 360) == ("00:00", 1)


def test_arrival_one_minute_before_midnight():
    assert main._arrival(FRIDAY, time(17, 59), 360) == ("23:59", 0)


def test_after_midnight_departure_same_day():
    # an early-morning arrival is not "next day" when the bus also left after midnight
    assert main._arrival(FRIDAY, time(0, 15), 240) == ("04:15", 0)


def test_arrival_two_midnights():
    assert main._arrival(FRIDAY, time(22, 0), 1560) == ("00:00", 2)


def test_arrival_unknown_minutes():
    assert main._arrival(FRIDAY, time(9, 0), None) == (None, None)
    assert main._arrival(FRIDAY, time(9, 0), 0) == (None, None)


def test_trips_overnight_and_same_day_arrival(dsn, client, tmp_path):
    write_csvs(tmp_path, TRIPS)
    assert load_data.run(dsn, tmp_path, dry_run=False) == 0

    r = client.get("/trips", params={"origin_city": "Metro Manila", "destination_city": "Baguio", "date": "2026-11-06"})
    assert r.status_code == 200
    trips = {t["departure_time"]: t for t in r.json()}
    assert set(trips) == {"07:00", "09:00", "22:00"}

    overnight = trips["22:00"]
    assert overnight["arrives_around"] == "04:00"
    assert overnight["arrives_day_offset"] == 1

    same_day = trips["07:00"]
    assert same_day["arrives_around"] == "13:00"
    assert same_day["arrives_day_offset"] == 0
    assert set(same_day) - {"arrives_day_offset"} == OLD_TRIP_FIELDS
    assert same_day["fare_php"] == 700.0
    assert same_day["last_verified_at"] is not None
    assert "Confirm with the operator" in same_day["confirm_note"]

    unknown = trips["09:00"]
    assert unknown["arrives_around"] is None
    assert unknown["arrives_day_offset"] is None


def test_openapi_documents_day_offset(client):
    schema = client.get("/openapi.json").json()["components"]["schemas"]["Trip"]
    props = schema["properties"]
    assert "arrives_day_offset" in props
    assert {"type": "integer"} in props["arrives_day_offset"]["anyOf"]
    assert {"type": "null"} in props["arrives_day_offset"]["anyOf"]
    assert "arrives_day_offset" not in schema.get("required", [])
    assert {"type": "string"} in props["arrives_around"]["anyOf"]
    assert {"type": "null"} in props["arrives_around"]["anyOf"]
