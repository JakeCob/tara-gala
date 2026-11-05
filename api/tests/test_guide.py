"""TG-52: the owner's real Baguio Barkada trip (Nov 6-8) as the trip's data, and the guide around the checked plan.

The reference case: data/itineraries/baguio-barkada-2026-11-06.json loads against the repo's own spots and last-mile
CSVs plus the Victory Liner trips it names, passes the planner's validator, and comes back from the API with every bus
time and fare from the schedule data, never from the file.
"""

import copy
import json
import shutil
import sys
import uuid

import pytest

from app import guide as guides
from app.plan_validation import parse_plan
from conftest import ROOT

sys.path.insert(0, str(ROOT / "data"))
import load_data  # noqa: E402
import load_itinerary  # noqa: E402

ITINERARY = ROOT / "data" / "itineraries" / "baguio-barkada-2026-11-06.json"
SLUG = "baguio-barkada-nov6"
SRC = "https://tickets.victoryliner.com/"
HEADER = "operator,origin,destination,via,class,fare_php,travel_minutes,seat_layout,has_restroom,departure_time,days,valid_from,valid_to,source_url,verified_on,notes\n"
# The Victory Liner trips the guide names, as Victory Liner's site listed them for Nov 6 and Nov 8 (the scraper's data)
CLASSES = {"deluxe": (880, 300), "regular_aircon": (762, 420), "first_class": (1151, 240), "royal_class": (1677, 240)}
OUT = [("09:00", "deluxe"), ("09:30", "regular_aircon"), ("10:00", "regular_aircon"), ("10:15", "first_class"), ("11:00", "deluxe"), ("11:30", "royal_class")]
BACK = [("13:15", "first_class"), ("13:30", "regular_aircon"), ("14:10", "regular_aircon"), ("14:15", "first_class"), ("14:45", "regular_aircon"),
        ("15:15", "royal_class"), ("15:20", "regular_aircon"), ("16:15", "first_class"), ("16:20", "regular_aircon")]


def trips_csv() -> str:
    rows = []
    for o, d, times in (("vl-cubao", "vl-baguio", OUT), ("vl-baguio", "vl-cubao", BACK)):
        for dep, cls in times:
            fare, minutes = CLASSES[cls]
            rows.append(f"victory-liner,{o},{d},,{cls},{fare},{minutes},2x2,yes,{dep},daily,,,{SRC},2026-10-28,test copy\n")
    return HEADER + "".join(rows)


@pytest.fixture()
def barkada(dsn, tmp_path):
    """The repo's spots and legs, the trips the guide names, then the owner's itinerary."""
    shutil.copy(ROOT / "data" / "spots.csv", tmp_path / "spots.csv")
    shutil.copy(ROOT / "data" / "last_mile_routes.csv", tmp_path / "last_mile_routes.csv")
    (tmp_path / "routes_trips.csv").write_text(trips_csv(), encoding="utf-8")
    assert load_data.run(dsn, tmp_path, dry_run=False) == 0
    assert load_itinerary.run(dsn, ITINERARY, dry_run=False) == 0
    return dsn


def test_the_owners_trip_loads_checks_clean_and_reads_back(barkada, client):
    r = client.get(f"/itineraries/{SLUG}")
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["issues"] == [], "the planner's validator finds nothing wrong"
    assert sorted(d["plan"]) == ["days", "outbound", "return"], "the plan stays the CLAUDE.md shape; the guide is beside it"
    g = d["guide"]
    assert g["title"] == "Baguio Barkada Trip, Nov 6 to 8"
    assert [len(day["rows"]) for day in g["days"]] == [7, 9, 10]
    assert len(g["todo"]) == 8 and [t["done"] for t in g["todo"]][:3] == [True, True, False]
    assert [o["id"] for o in g["days"][1]["pick"]["options"]] == ["A", "B", "C"]
    assert g["days"][1]["pick"]["options"][0]["place"]["name"] == "Mt. Yangbew"
    first = g["days"][0]["rows"][0]["place"]
    assert (first["kind"], first["name"], first["category"], first["lodging"]) == ("terminal", "Victory Liner Cubao", None, False)
    assert g["lodging"]["name"] == "Finteo Skylands Premium" and g["lodging"]["lodging"] is True
    assert g["days"][0]["rows"][3]["place"]["lodging"] is True, "check-in is at the hotel"


def test_bus_tables_come_from_the_schedule_data_with_the_booked_trips_marked(barkada, client):
    g = client.get(f"/itineraries/{SLUG}").json()["guide"]
    out = [(b["trip"]["departure_time"], b["trip"]["service_class"], b["trip"]["fare_php"], b["booked"]) for b in g["getting_there"]["buses"]]
    assert out == [("09:00", "deluxe", 880, False), ("09:30", "regular_aircon", 762, False), ("10:00", "regular_aircon", 762, False),
                   ("10:15", "first_class", 1151, True), ("11:00", "deluxe", 880, False), ("11:30", "royal_class", 1677, False)]
    back = [(b["trip"]["departure_time"], b["booked"]) for b in g["getting_home"]["buses"]]
    assert back[-2] == ("16:15", True) and sum(b for _, b in back) == 1
    for b in g["getting_there"]["buses"] + g["getting_home"]["buses"]:
        assert b["trip"]["confirm_note"], "every trip carries the confirm-with-operator note"
        assert b["trip"]["last_verified_at"], "and when it was last checked"
    # The owner's doc said about 1,032; the operator's fare wins (owner, 2026-11-01). The file holds no fares or times.
    def keys(node):
        if isinstance(node, dict):
            for k, v in node.items():
                yield k
                yield from keys(v)
        elif isinstance(node, list):
            for v in node:
                yield from keys(v)

    text = ITINERARY.read_text(encoding="utf-8")
    assert not [k for k in keys(json.loads(text)) if "fare" in k or "arriv" in k and k != "arrive"], "no fare or arrival fields"
    assert "1,032" not in text and "1151" not in text and "₱1" not in text


def test_what_the_owner_left_unconfirmed_still_says_so():
    """Owner decision: Bell Church, Mt. Yangbew and SM City Baguio, and their fees and hours, stay marked unconfirmed."""
    guide = json.loads(ITINERARY.read_text())["guide"]
    rows = {r["key"]: r for d in guide["days"] for r in d["rows"]}
    assert "Hours unconfirmed" in rows["d2-05"]["note"]
    assert "(confirm it first)" in rows["d3-05"]["note"]
    option_a = next(o for d in guide["days"] if d.get("pick") for o in d["pick"]["options"] if o["id"] == "A")
    assert "(confirm)" in option_a["what"]
    assert next(t for t in guide["todo"] if t["key"] == "todo-04")["text"].startswith("Confirm ")
    spots = (ROOT / "data" / "spots.csv").read_text().splitlines()
    spot = lambda slug: next(line for line in spots if line.startswith(f"{slug},"))  # noqa: E731
    assert "Hours and fee unconfirmed" in spot("bell-church")
    assert "Fee about 50 pesos, unconfirmed" in spot("mt-yangbew")
    assert "confirm the baggage counter first" in spot("sm-city-baguio")


def test_the_sunrise_rows_follow_the_pick():
    rows = {r["key"]: r for d in json.loads(ITINERARY.read_text())["guide"]["days"] for r in d["rows"]}
    assert rows["d2-01"]["show_if"] == {"pick": "sunrise", "is": "A"}
    assert rows["d2-02"]["show_if"] == {"pick": "sunrise", "is": "B"}
    assert rows["d3-01"]["hide_if"] == {"pick": "sunrise", "is": "B"}


def test_a_changed_fare_shows_without_touching_the_file(barkada, client):
    import psycopg

    with psycopg.connect(barkada, autocommit=True) as conn:
        conn.execute("update routes set fare_php = 1200 where class = 'first_class'")
    g = client.get(f"/itineraries/{SLUG}").json()["guide"]
    assert {b["trip"]["fare_php"] for b in g["getting_there"]["buses"] if b["booked"]} == {1200}


@pytest.mark.parametrize(
    "change,expect",
    [
        (lambda d: d["guide"]["days"][1]["rows"][3]["place"].update(spot="nowhere-farm"), "unknown spot 'nowhere-farm'"),
        (lambda d: d["guide"]["getting_there"]["buses"][0]["trip"].update(departure="09:05"), "getting_there.buses[0]"),
        (lambda d: d["guide"]["days"][0]["rows"][1].update(key="d1-01"), "used more than once"),
        (lambda d: d["guide"]["days"][2]["rows"][0]["hide_if"].update({"is": "Z"}), "no pick sunrise option Z"),
        (lambda d: d["days"][1]["stops"][1].update(spot="nowhere-farm"), "unknown spot"),
    ],
)
def test_the_loader_refuses_a_bad_file_and_writes_nothing(dsn, tmp_path, capsys, change, expect):
    shutil.copy(ROOT / "data" / "spots.csv", tmp_path / "spots.csv")
    shutil.copy(ROOT / "data" / "last_mile_routes.csv", tmp_path / "last_mile_routes.csv")
    (tmp_path / "routes_trips.csv").write_text(trips_csv(), encoding="utf-8")
    assert load_data.run(dsn, tmp_path, dry_run=False) == 0
    doc = json.loads(ITINERARY.read_text(encoding="utf-8"))
    change(doc)
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps(doc), encoding="utf-8")
    assert load_itinerary.run(dsn, bad, dry_run=False) == 1
    assert expect in capsys.readouterr().err
    import psycopg

    with psycopg.connect(dsn) as conn:
        assert conn.execute("select count(*) from itineraries").fetchone()[0] == 0


def test_a_rerun_updates_in_place(barkada):
    import psycopg

    assert load_itinerary.run(barkada, ITINERARY, dry_run=False) == 0
    with psycopg.connect(barkada) as conn:
        assert conn.execute("select count(*), min(model) from itineraries").fetchone() == (1, "curated")


def guide_dict() -> dict:
    t = str(uuid.uuid4())
    return {
        "title": "T", "getting_there": {"title": "Out", "buses": [{"trip_id": t, "date": "2026-11-06"}]},
        "getting_home": {"title": "Back", "buses": []}, "budget": {},
        "days": [{"day": 1, "title": "D1", "pick": {"key": "sunrise", "title": "P", "options": [{"id": "A", "label": "a", "leave": "05:00"}, {"id": "B", "label": "b", "leave": "06:00"}]},
                  "rows": [{"key": "d1-01", "time": "09:00", "plan": "x", "show_if": {"pick": "sunrise", "is": "A"}}]}],
        "todo": [{"key": "todo-01", "text": "Book"}],
    }


def test_parse_guide_checks_keys_days_and_picks():
    g, problems = guides.parse_guide(guide_dict())
    assert problems == [] and guides.mark_keys(g) == {"row:d1-01", "todo:01"} and guides.pick_options(g) == {"sunrise": {"A", "B"}}
    bad = copy.deepcopy(guide_dict())
    bad["days"][0]["rows"].append({"key": "d1-01", "time": "10:00", "plan": "y"})
    assert "key d1-01: used more than once" in guides.parse_guide(bad)[1]
    bad = copy.deepcopy(guide_dict())
    bad["days"][0]["rows"][0]["key"] = "d2-01"
    assert any("belongs to another day" in p for p in guides.parse_guide(bad, keys_follow_days=True)[1]), "the owner's files"
    assert guides.parse_guide(bad)[1] == [], "TG-61: in the API a key is an id, and it stays when its row moves day"
    bad = copy.deepcopy(guide_dict())
    bad["days"][0]["rows"][0]["time"] = "9am"
    assert guides.parse_guide(bad)[0] is None
    bad = copy.deepcopy(guide_dict())
    bad["sources"] = [{"label": "x", "url": "javascript:alert(1)"}]
    assert guides.parse_guide(bad)[0] is None, "only https links"


def test_the_planners_output_still_cannot_carry_a_guide():
    raw = json.loads(ITINERARY.read_text(encoding="utf-8"))
    plan = {"outbound": {"trip_id": str(uuid.uuid4()), "date": "2026-11-06"}, "return": {"trip_id": str(uuid.uuid4()), "date": "2026-11-08"},
            "days": [], "guide": raw["guide"]}
    parsed, errors = parse_plan(plan)
    assert parsed is None and errors[0].code == "shape", "the LLM's plan stays the strict CLAUDE.md shape"


# ---------------------------------------------------------------- PR 3: the trip's shared checklist and picks

@pytest.fixture()
def trip(barkada, client, monkeypatch):
    from app import sessions
    from app.limits import RateLimiter

    monkeypatch.setattr(sessions, "WRITE_LIMITER", RateLimiter(sessions.WRITES_PER_HOUR))
    monkeypatch.setattr(sessions, "CREATE_LIMITER", RateLimiter(sessions.CREATE_PER_HOUR))
    slug = client.post("/sessions", json={"name": "Baguio", "start_date": "2026-11-06", "return_date": "2026-11-08"}).json()["share_slug"]
    assert client.put(f"/sessions/{slug}/itinerary", json={"share_slug": SLUG}).status_code == 200
    return slug


def test_anyone_ticks_and_unticks_rows_and_todos_in_any_order(trip, client):
    r = client.put(f"/sessions/{trip}/marks/row:d2-07", json={"value": "done"})
    assert r.status_code == 200, r.text
    client.put(f"/sessions/{trip}/marks/row:d1-01", json={"value": "done"})
    client.put(f"/sessions/{trip}/marks/todo:03", json={"value": "done"})
    marks = {m["key"]: m["value"] for m in client.get(f"/sessions/{trip}").json()["marks"]}
    assert marks == {"row:d2-07": "done", "row:d1-01": "done", "todo:03": "done"}
    r = client.delete(f"/sessions/{trip}/marks/row:d2-07")
    assert {m["key"] for m in r.json()["marks"]} == {"row:d1-01", "todo:03"}
    assert client.delete(f"/sessions/{trip}/marks/row:d2-07").status_code == 200, "unticking twice is fine"


def test_the_sunrise_pick_is_one_of_its_options_and_can_change(trip, client):
    assert client.put(f"/sessions/{trip}/marks/pick:sunrise", json={"value": "B"}).status_code == 200
    r = client.put(f"/sessions/{trip}/marks/pick:sunrise", json={"value": "A"})
    assert [m for m in r.json()["marks"] if m["key"] == "pick:sunrise"][0]["value"] == "A"
    r = client.put(f"/sessions/{trip}/marks/pick:sunrise", json={"value": "Z"})
    assert r.status_code == 422 and r.json()["detail"] == "bad_pick"


@pytest.mark.parametrize(
    "key,value,detail",
    [("row:d1-99", "done", "unknown_key"), ("todo:42", "done", "unknown_key"), ("row:d1-01", "maybe", "bad_value"),
     ("pick:moonrise", "A", "bad_pick"), ("hack", "done", "bad_key")],
)
def test_marks_must_point_at_the_trips_guide(trip, client, key, value, detail):
    r = client.put(f"/sessions/{trip}/marks/{key}", json={"value": value})
    assert r.status_code == 422 and r.json()["detail"] == detail


def test_no_guide_no_checklist(trip, client):
    client.delete(f"/sessions/{trip}/itinerary")
    r = client.put(f"/sessions/{trip}/marks/row:d1-01", json={"value": "done"})
    assert r.status_code == 422 and r.json()["detail"] == "no_guide"


def test_marks_go_with_the_trip(trip, client, barkada):
    import psycopg

    client.put(f"/sessions/{trip}/marks/row:d1-01", json={"value": "done"})
    client.request("DELETE", f"/sessions/{trip}", json={"name": "Baguio"})
    with psycopg.connect(barkada) as conn:
        assert conn.execute("select count(*) from session_marks").fetchone()[0] == 0


def test_mark_logs_carry_keys_never_row_text(trip, client, caplog):
    import logging

    caplog.set_level(logging.INFO, logger="tara_gala.api")
    client.put(f"/sessions/{trip}/marks/row:d1-01", json={"value": "done"})
    assert f"trip mark set share_slug={trip} key=row:d1-01 value=done" in caplog.text
    assert "Cubao terminal" not in caplog.text


def test_the_marks_migration_reruns(dsn):
    import psycopg

    sql = (ROOT / "supabase" / "migrations" / "2026-11-02_tg52_session_marks.sql").read_text(encoding="utf-8")
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(sql)
        conn.execute(sql)
        assert conn.execute("select relrowsecurity from pg_class where relname = 'session_marks'").fetchone()[0]
        assert conn.execute("select count(*) from pg_policies where tablename = 'session_marks'").fetchone()[0] == 0
