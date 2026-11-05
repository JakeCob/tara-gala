"""TG-61 PR 1, builder A: a trip's edited copy of its plan, its versions, undo, the checks, and what the reads gain.

The owner's real plan file is the test plan (test_guide.py's barkada fixture), on a made-up trip in a throwaway
database. The ids are plan.md §5's: E1, E2 and E21 to E30, and one test for each of B1 to B20 (E3 to E20), tagged by
the B it pins.
"""

import copy
import dataclasses
import json
import logging
import re
import threading
import uuid

import psycopg
import pytest
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from app import guide as guides
from app.logging_setup import RedactingFormatter
from conftest import ROOT, write_csvs  # noqa: F401
from test_guide import ITINERARY, SLUG, barkada, trip  # noqa: F401  fixtures

HEX32 = re.compile(r"^[0-9a-f]{32}$")
SESSION = {"name": "Baguio", "start_date": "2026-11-06", "return_date": "2026-11-08"}


@pytest.fixture()
def editing(client):
    """PLAN_EDITING on for this test's app; it's off by default."""
    before = client.app.state.flags
    client.app.state.flags = dataclasses.replace(before, plan_editing=True)
    yield client
    client.app.state.flags = before


@pytest.fixture()
def t(trip, editing):  # noqa: F811
    """A made-up trip on the owner's shared plan, with editing on. Never the real trip."""
    return trip


# ---------------------------------------------------------------- helpers

def session(client, slug) -> dict:
    return client.get(f"/sessions/{slug}").json()


def plan_of(client, slug) -> dict:
    s = session(client, slug)
    r = client.get(f"/itineraries/{s['itinerary_slug']}")
    assert r.status_code == 200, r.text
    return r.json()


def stored(guide: dict) -> dict:
    """A GuideOut as the GuideIn a phone sends back (planEdit.toStored's Python twin)."""
    g = copy.deepcopy(guide)

    def place(p):
        if p is None:
            return None
        return {{"spot": "spot_id", "terminal": "terminal_id", "trip_place": "trip_place_id"}[p["kind"]]: p["id"]}

    def leg(x):
        if x is None:
            return None
        if x["kind"] == "route":
            return {"last_mile_route_id": x["last_mile_route_id"]}
        return {"estimate": {"mode": x["mode"], "minutes": x["minutes"], "km": x["km"]}}

    g["lodging"] = place(g["lodging"])
    for table in ("getting_there", "getting_home"):
        g[table]["buses"] = [{k: b[k] for k in ("trip_id", "date", "note", "booked")} for b in g[table]["buses"]]
    for d in g["days"]:
        for r in d["rows"]:
            r["place"] = place(r["place"])
            r["leg"] = leg(r.get("leg"))
        if d["pick"]:
            for o in d["pick"]["options"]:
                o["place"] = place(o["place"])
    return g


def base_of(it: dict) -> dict:
    return {"itinerary_slug": it["share_slug"], "seq": it["seq"] or 0}


def save(client, slug, guide: dict, base: dict | None = None, source: str = "hand"):
    if base is None:
        base = base_of(plan_of(client, slug))
    return client.put(f"/sessions/{slug}/plan", json={"base": base, "guide": guide, "source": source})


def edit(client, slug, change) -> dict:
    """One saved hand edit: change(guide) edits the stored guide in place. Returns PlanSaved."""
    it = plan_of(client, slug)
    g = stored(it["guide"])
    change(g)
    r = save(client, slug, g, base_of(it))
    assert r.status_code == 200, r.text
    return r.json()


def undo(client, slug, base: dict | None = None):
    if base is None:
        base = base_of(plan_of(client, slug))
    return client.post(f"/sessions/{slug}/plan/undo", json={"base": base})


def row(g: dict, key: str) -> dict:
    return next(r for d in g["days"] for r in d["rows"] if r["key"] == key)


def day_of(g: dict, key: str) -> int:
    return next(d["day"] for d in g["days"] for r in d["rows"] if r["key"] == key)


def move(g: dict, key: str, to_day: int, at: int | None = None) -> None:
    r = row(g, key)
    for d in g["days"]:
        d["rows"] = [x for x in d["rows"] if x["key"] != key]
    rows = next(d for d in g["days"] if d["day"] == to_day)["rows"]
    rows.insert(len(rows) if at is None else at, r)


def retime(key: str, time: str):
    return lambda g: row(g, key).update(time=time)


def rows(dsn, sql, *args) -> list[dict]:
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        return conn.execute(sql, args).fetchall()


def one(dsn, sql, *args):
    return rows(dsn, sql, *args)[0]


def trip_ids(dsn, origin: str) -> list:
    """Active trip ids from one terminal, by departure."""
    return [r["id"] for r in rows(dsn, "select t.id from trips t join routes r on r.id = t.route_id join terminals o on o.id = r.origin_terminal_id"
                                       " where o.slug = %s order by t.departure_time", origin)]


def spare_trip(dsn, like, departure: str):
    """Another departure on the same route as trip `like`."""
    with psycopg.connect(dsn, autocommit=True) as conn:
        return conn.execute("insert into trips (route_id, departure_time, days_of_week, source, source_url, last_verified_at)"
                            " select route_id, %s, days_of_week, source, source_url, last_verified_at from trips where id = %s returning id",
                            (departure, like)).fetchone()[0]


def other_trip(client) -> str:
    return client.post("/sessions", json=SESSION).json()["share_slug"]


def place_row(dsn, trip_slug: str, name="Cafe Ozark", lat=16.41, lng=120.6) -> str:
    sid = one(dsn, "select id from trip_sessions where share_slug = %s", trip_slug)["id"]
    with psycopg.connect(dsn, autocommit=True) as conn:
        return str(conn.execute("insert into trip_places (session_id, name, lat, lng, maps_url) values (%s, %s, %s, %s, %s) returning id",
                                (sid, name, lat, lng, "https://maps.app.goo.gl/abc")).fetchone()[0])


# ---------------------------------------------------------------- the flag

def test_editing_is_off_by_default(trip, client):  # noqa: F811
    assert client.app.state.flags.plan_editing is False
    it = plan_of(client, trip)
    assert save(client, trip, stored(it["guide"])).status_code == 404
    assert undo(client, trip).status_code == 404
    assert session(client, trip)["plan_edits"] is None, "reads gain their fields with the flag off"


# ---------------------------------------------------------------- E1, E2: keys are ids

def test_a_copy_with_a_cross_day_move_still_reads_and_ticks(t, client, barkada):  # E1
    edit(client, t, lambda g: move(g, "d1-03", 2))
    it = plan_of(client, t)
    assert it["guide"] is not None, "the API's parse_guide no longer checks a key's day"
    assert day_of(it["guide"], "d1-03") == 2
    r = client.put(f"/sessions/{t}/marks/row:d1-03", json={"value": "done"})
    assert r.status_code == 200, r.text


def test_the_loader_still_refuses_a_row_on_the_wrong_day(barkada, tmp_path):  # E2
    import load_itinerary

    raw = json.loads(ITINERARY.read_text(encoding="utf-8"))
    raw["guide"]["days"][1]["rows"].append(dict(raw["guide"]["days"][0]["rows"][2], key="d1-50"))
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps(raw), encoding="utf-8")
    assert load_itinerary.run(barkada, bad, dry_run=False) == 1


# ---------------------------------------------------------------- B1 to B5: copy and save

def test_the_first_edit_makes_the_trips_own_copy(t, client, barkada):  # B1
    shared = one(barkada, "select * from itineraries where share_slug = %s", SLUG)
    saved = edit(client, t, retime("d2-08", "15:30"))
    copy_slug = saved["itinerary"]["share_slug"]
    assert HEX32.fullmatch(copy_slug) and copy_slug != SLUG
    assert session(client, t)["itinerary_slug"] == copy_slug
    c = one(barkada, "select * from itineraries where share_slug = %s", copy_slug)
    assert c["model"] == "trip-edit"
    assert {k: c[k] for k in ("trip_date", "return_date", "party", "budget_php", "vibe")} == {k: shared[k] for k in ("trip_date", "return_date", "party", "budget_php", "vibe")}
    versions = rows(barkada, "select seq, source, based_on, changes, plan from itinerary_versions where itinerary_id = %s order by seq", c["id"])
    assert [(v["seq"], v["source"]) for v in versions] == [(0, "copy"), (1, "hand")]
    assert versions[0]["changes"] == [{"word": "Copied", "day": None, "text": "the plan"}]
    assert versions[0]["based_on"] == shared["id"] and versions[1]["based_on"] is None
    assert versions[0]["plan"] == shared["plan"] and versions[1]["plan"] == c["plan"]
    assert one(barkada, "select * from itineraries where share_slug = %s", SLUG) == shared, "the shared plan is byte-for-byte unchanged"
    assert saved["itinerary"]["seq"] == 1 and saved["itinerary"]["edited"] is True


def test_the_next_edit_is_the_next_version(t, client, barkada):  # B2
    for n in range(1, 5):
        edit(client, t, retime("d2-08", f"15:{10 * n:02d}"))
    it = plan_of(client, t)
    assert it["seq"] == 4
    saved = edit(client, t, retime("d2-08", "16:00"))
    assert saved["itinerary"]["seq"] == 5 and saved["itinerary"]["share_slug"] == it["share_slug"]
    assert saved["changes"] == [{"word": "Later", "day": 2, "text": row(it["guide"], "d2-08")["plan"] + " to 4:00 PM"}]
    latest = one(barkada, "select v.plan from itinerary_versions v join itineraries i on i.id = v.itinerary_id where i.share_slug = %s and v.seq = 5", it["share_slug"])
    assert latest["plan"] == one(barkada, "select plan from itineraries where share_slug = %s", it["share_slug"])["plan"]


def test_an_older_base_is_a_clash_and_writes_nothing(t, client, barkada):  # B3
    for n in range(1, 6):
        edit(client, t, retime("d2-08", f"15:{10 * n:02d}"))
    it = plan_of(client, t)
    r = save(client, t, stored(it["guide"]) | {"title": "Ours"}, {"itinerary_slug": it["share_slug"], "seq": 4})
    assert r.status_code == 409
    assert r.json() == {"detail": "plan_changed", "itinerary_slug": it["share_slug"], "seq": 5}
    assert plan_of(client, t)["seq"] == 5
    r = save(client, t, stored(it["guide"]) | {"title": "Ours"}, {"itinerary_slug": SLUG, "seq": 0})
    assert r.status_code == 409 and r.json()["itinerary_slug"] == it["share_slug"], "the shared plan's base is stale once a copy exists"


def test_two_phones_first_edit_make_one_copy(t, client, barkada):  # B4 (E4: two threads)
    it = plan_of(client, t)
    base = base_of(it)
    answers = []

    def phone(title):
        answers.append(save(client, t, stored(it["guide"]) | {"title": title}, base))

    threads = [threading.Thread(target=phone, args=(x,)) for x in ("A", "B")]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    assert sorted(a.status_code for a in answers) == [200, 409]
    ok, clash = sorted(answers, key=lambda a: a.status_code)
    assert clash.json()["itinerary_slug"] == ok.json()["itinerary"]["share_slug"] and clash.json()["seq"] == 1
    assert one(barkada, "select count(*) as n from itineraries where model = 'trip-edit'")["n"] == 1


def test_the_nightly_loaders_never_touch_a_copy(t, client, barkada, tmp_path):  # B5 (E5: both loaders, bytes compared)
    import load_itinerary
    import load_premade

    saved = edit(client, t, retime("d2-08", "15:30"))
    slug = saved["itinerary"]["share_slug"]
    before = rows(barkada, "select i.plan::text as plan, (select json_agg(v order by v.seq)::text from itinerary_versions v where v.itinerary_id = i.id) as versions"
                           " from itineraries i where share_slug = %s", slug)
    assert load_itinerary.run(barkada, ITINERARY, dry_run=False) == 0
    folder = ROOT / "data" / "premade"
    if folder.exists():
        load_premade.run(barkada, folder, dry_run=False)
    after = rows(barkada, "select i.plan::text as plan, (select json_agg(v order by v.seq)::text from itinerary_versions v where v.itinerary_id = i.id) as versions"
                          " from itineraries i where share_slug = %s", slug)
    assert after == before


# ---------------------------------------------------------------- B6 to B10: keys, ticks and photos

def photo(dsn, trip_slug, row_key):
    sid = one(dsn, "select id from trip_sessions where share_slug = %s", trip_slug)["id"]
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute("insert into session_files (session_id, kind, storage_path, content_type, bytes, row_key) values (%s, 'photo', %s, 'image/png', 1, %s)",
                     (sid, str(uuid.uuid4()), row_key))


def test_a_moved_row_keeps_its_key_tick_and_photo(t, client, barkada):  # B6
    assert client.put(f"/sessions/{t}/marks/row:d1-03", json={"value": "done"}).status_code == 200
    photo(barkada, t, "d1-03")
    saved = edit(client, t, lambda g: move(g, "d1-03", 2))
    assert day_of(saved["itinerary"]["guide"], "d1-03") == 2
    s = session(client, t)
    assert [(m["key"], m["value"]) for m in s["marks"]] == [("row:d1-03", "done")]
    assert [f["row_key"] for f in s["files"]] == ["d1-03"]
    assert saved["changes"][0]["word"] == "Moved" and saved["changes"][0]["day"] == 2


def test_a_new_row_gets_a_key_no_version_mark_or_photo_used(t, client, barkada):  # B7 (E7: the taken set)
    sid = one(barkada, "select id from trip_sessions where share_slug = %s", t)["id"]
    with psycopg.connect(barkada, autocommit=True) as conn:
        conn.execute("insert into session_marks (session_id, key, value) values (%s, 'row:d2-10', 'done')", (sid,))
    photo(barkada, t, "d2-11")

    def add(g, plan="Snack"):
        g["days"][1]["rows"].append({"key": None, "time": "19:00", "plan": plan})

    first = edit(client, t, add)
    assert [r["key"] for r in first["itinerary"]["guide"]["days"][1]["rows"]][-1] == "d2-12", "d2-10 is ticked and d2-11 has a photo"
    edit(client, t, lambda g: g["days"][1]["rows"].pop())  # d2-12 is now only in a version
    second = edit(client, t, lambda g: add(g, "Dinner"))
    assert [r["key"] for r in second["itinerary"]["guide"]["days"][1]["rows"]][-1] == "d2-13"

    def todo(g):
        g["todo"].append({"key": None, "text": "Pack jackets"})

    third = edit(client, t, todo)
    keys = [x["key"] for x in third["itinerary"]["guide"]["todo"]]
    assert keys[-1] not in keys[:-1] and re.fullmatch(r"todo-\d{2}", keys[-1])


def test_a_key_that_isnt_in_the_base_is_refused(t, client):  # B8
    it = plan_of(client, t)
    g = stored(it["guide"])
    g["days"][1]["rows"].append({"key": "d2-77", "time": "19:00", "plan": "Snack"})
    r = save(client, t, g)
    assert r.status_code == 422 and r.json()["detail"] == "unknown_key"
    g = stored(it["guide"])
    g["todo"].append({"key": "todo-77", "text": "x"})
    assert save(client, t, g).json()["detail"] == "unknown_key"


def test_a_removed_row_hides_its_tick_and_undo_brings_it_back(t, client, barkada):  # B9
    assert client.put(f"/sessions/{t}/marks/row:d3-02", json={"value": "done"}).status_code == 200
    photo(barkada, t, "d3-02")

    def drop(g):
        g["days"][2]["rows"] = [r for r in g["days"][2]["rows"] if r["key"] != "d3-02"]

    saved = edit(client, t, drop)
    assert saved["changes"][0]["word"] == "Dropped"
    assert client.put(f"/sessions/{t}/marks/row:d3-02", json={"value": "done"}).json()["detail"] == "unknown_key"
    s = session(client, t)
    assert any(m["key"] == "row:d3-02" for m in s["marks"]), "hidden, not destroyed"
    assert [f["row_key"] for f in s["files"]] == ["d3-02"]
    r = undo(client, t)
    assert r.status_code == 200, r.text
    assert row(r.json()["itinerary"]["guide"], "d3-02")["plan"]
    assert client.put(f"/sessions/{t}/marks/row:d3-02", json={"value": "done"}).status_code == 200


def test_ticks_save_on_a_copy_with_rows_moved_across_days(t, client):  # B10
    edit(client, t, lambda g: (move(g, "d1-05", 3), move(g, "d3-03", 1)))
    for key in ("row:d1-05", "row:d3-03", "row:d2-04", "todo:01"):
        r = client.put(f"/sessions/{t}/marks/{key}", json={"value": "done"})
        assert r.status_code == 200, (key, r.text)


# ---------------------------------------------------------------- B11 to B15: undo and history

def five_edits(client, slug) -> list[dict]:
    return [edit(client, slug, retime("d2-08", f"15:{10 * n:02d}")) for n in range(1, 6)]


def test_undo_writes_the_version_before_as_a_new_one(t, client, barkada):  # B11
    saved = five_edits(client, t)
    r = undo(client, t)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["itinerary"]["seq"] == 6
    v = {x["seq"]: x for x in rows(barkada, "select seq, source, plan, changes from itinerary_versions v join itineraries i on i.id = v.itinerary_id"
                                            " where i.share_slug = %s", saved[0]["itinerary"]["share_slug"])}
    assert v[6]["plan"] == v[4]["plan"] and v[6]["source"] == "undo"
    assert out["changes"] == v[6]["changes"] == [{"word": "Earlier", "day": 2, "text": row(saved[-1]["itinerary"]["guide"], "d2-08")["plan"] + " to 3:40 PM"}]
    assert session(client, t)["plan_edits"]["versions"][0]["source"] == "undo", "the web labels the next tap Redo"


def test_undo_after_an_undo_puts_the_change_back(t, client):  # B12
    saved = five_edits(client, t)
    undo(client, t)
    r = undo(client, t)
    assert r.status_code == 200 and r.json()["itinerary"]["seq"] == 7
    assert r.json()["itinerary"]["guide"] == saved[-1]["itinerary"]["guide"]


def test_nothing_to_undo_on_the_shared_plan(t, client):  # B13
    r = undo(client, t)
    assert r.status_code == 409 and r.json()["detail"] == "nothing_to_undo"
    r = undo(client, t, {"itinerary_slug": "nope", "seq": 3})
    assert r.status_code == 409 and r.json()["detail"] == "plan_changed"


def test_the_session_lists_the_five_newest_edits(t, client):  # B14
    five_edits(client, t)
    edit(client, t, retime("d2-08", "17:00"))
    edit(client, t, retime("d2-08", "17:30"))
    pe = session(client, t)["plan_edits"]
    assert pe["seq"] == 7
    assert [v["seq"] for v in pe["versions"]] == [7, 6, 5, 4, 3]
    assert set(pe["versions"][0]) == {"seq", "source", "changes", "created_at"}
    assert pe["versions"][0]["changes"][0]["word"] == "Later"


def test_another_phone_sees_the_new_seq_on_its_next_poll(t, client):  # B15
    assert session(client, t)["plan_edits"] is None
    saved = edit(client, t, retime("d2-08", "15:30"))
    s = session(client, t)
    assert s["plan_edits"]["seq"] == saved["itinerary"]["seq"] and s["itinerary_slug"] == saved["itinerary"]["share_slug"]


# ---------------------------------------------------------------- B16 to B20: checks

def test_a_place_must_be_ours(t, client, barkada):  # B16
    it = plan_of(client, t)
    g = stored(it["guide"])
    row(g, "d2-04")["place"] = {"spot_id": str(uuid.uuid4())}
    assert save(client, t, g).json()["detail"] == "unknown_place"
    theirs = place_row(barkada, other_trip(client))
    g = stored(it["guide"])
    row(g, "d2-04")["place"] = {"trip_place_id": theirs}
    assert save(client, t, g).json()["detail"] == "unknown_place", "another trip's place"
    mine = place_row(barkada, t)
    row(g, "d2-04")["place"] = {"trip_place_id": mine}
    assert save(client, t, g).status_code == 200
    g = stored(plan_of(client, t)["guide"])
    row(g, "d2-04")["leg"] = {"last_mile_route_id": str(uuid.uuid4())}
    assert save(client, t, g).json()["detail"] == "unknown_leg"


def test_a_bus_swap_must_be_a_real_running_trip_the_right_way(t, client, barkada):  # B17
    it = plan_of(client, t)
    out, back = trip_ids(barkada, "vl-cubao"), trip_ids(barkada, "vl-baguio")
    unbooked = next(i for i, b in enumerate(it["guide"]["getting_there"]["buses"]) if not b["booked"])
    spare = [spare_trip(barkada, out[0], dep) for dep in ("12:00", "12:30", "13:00")]  # every listed one is in the plan
    with psycopg.connect(barkada, autocommit=True) as conn:
        conn.execute("update trips set is_active = false where id = %s", (spare[0],))
        conn.execute("update trips set days_of_week = '{0,1,2,3,4,6}' where id = %s", (spare[1],))  # not Fridays: Nov 6 is one

    def swap(trip_id):
        g = stored(it["guide"])
        g["getting_there"]["buses"][unbooked]["trip_id"] = str(trip_id)
        return save(client, t, g)

    assert swap(spare[0]).json()["detail"] == "trip_inactive"
    assert swap(spare[1]).json()["detail"] == "trip_not_running"
    assert swap(back[0]).json()["detail"] == "wrong_direction"
    assert swap(uuid.uuid4()).json()["detail"] == "unknown_trip"
    g = stored(it["guide"])
    g["getting_there"]["buses"][0]["departure_time"] = "09:00"
    assert save(client, t, g).status_code == 422, "a bus row has no time or fare to type"
    assert swap(spare[2]).status_code == 200


def test_the_booked_bus_sets_its_rows_time(t, client, barkada):  # B18 (E18)
    it = plan_of(client, t)
    buses = it["guide"]["getting_there"]["buses"]
    b = next(i for i, x in enumerate(buses) if x["booked"])
    other = next(i for i, x in enumerate(buses) if not x["booked"])
    g = stored(it["guide"])
    g["getting_there"]["buses"][b]["booked"] = False
    g["getting_there"]["buses"][other]["booked"] = True
    saved = save(client, t, g)
    assert saved.status_code == 200, saved.text
    assert row(saved.json()["itinerary"]["guide"], "d1-02")["time"] == buses[other]["trip"]["departure_time"]
    assert any(c["word"] == "Bus" for c in saved.json()["changes"])
    g = stored(saved.json()["itinerary"]["guide"])
    row(g, "d1-02")["time"] = "03:00"
    row(g, "d2-08")["time"] = "15:30"
    again = save(client, t, g, base_of(saved.json()["itinerary"]))
    assert row(again.json()["itinerary"]["guide"], "d1-02")["time"] == buses[other]["trip"]["departure_time"], "the server's time wins"


def test_an_edit_that_changes_nothing_is_refused(t, client):  # B19
    it = plan_of(client, t)
    r = save(client, t, stored(it["guide"]))
    assert r.status_code == 422 and r.json()["detail"] == "no_change"


def test_a_bus_table_keeps_its_rows_and_dates(t, client):  # B20
    it = plan_of(client, t)
    for change in (lambda g: g["getting_home"]["buses"].pop(),
                   lambda g: g["getting_home"]["buses"].append(dict(g["getting_home"]["buses"][0])),
                   lambda g: g["getting_home"]["buses"][0].update(date="2026-11-07")):
        g = stored(it["guide"])
        change(g)
        r = save(client, t, g)
        assert r.status_code == 422 and r.json()["detail"] == "bus_table_changed", r.text


# ---------------------------------------------------------------- E21 to E30

def test_deleting_the_trip_deletes_its_copy_versions_and_places(t, client, barkada):  # E21 (B33)
    place_row(barkada, t)
    saved = edit(client, t, retime("d2-08", "15:30"))
    r = client.request("DELETE", f"/sessions/{t}", json={"name": "Baguio"})
    assert r.status_code == 204
    counts = one(barkada, "select (select count(*) from itineraries where model = 'trip-edit') as copies,"
                          " (select count(*) from itinerary_versions) as versions, (select count(*) from trip_places) as places,"
                          " (select count(*) from itineraries where share_slug = %s) as shared", SLUG)
    assert counts == {"copies": 0, "versions": 0, "places": 0, "shared": 1}
    assert client.get(f"/itineraries/{saved['itinerary']['share_slug']}").status_code == 404


def test_another_trips_copy_cant_be_attached(t, client):  # E22 (B34)
    saved = edit(client, t, retime("d2-08", "15:30"))
    copy_slug = saved["itinerary"]["share_slug"]
    other = other_trip(client)
    r = client.put(f"/sessions/{other}/itinerary", json={"share_slug": copy_slug})
    assert r.status_code == 422 and r.json()["detail"] == "itinerary_not_found"
    assert client.delete(f"/sessions/{t}/itinerary").status_code == 200
    assert client.put(f"/sessions/{t}/itinerary", json={"share_slug": copy_slug}).status_code == 200, "its own copy is fine"


def test_session_lists_edits_and_places(t, client, barkada):  # E23
    s = session(client, t)
    assert s["plan_edits"] is None and s["places"] == []
    pid = place_row(barkada, t)
    place_row(barkada, other_trip(client), name="Not ours")
    edit(client, t, retime("d2-08", "15:30"))
    s = session(client, t)
    assert [p["id"] for p in s["places"]] == [pid]
    assert set(s["places"][0]) == {"id", "name", "lat", "lng", "maps_url", "created_at"}
    assert [v["seq"] for v in s["plan_edits"]["versions"]] == [1, 0]
    assert s["plan_edits"]["versions"][1]["changes"] == [{"word": "Copied", "day": None, "text": "the plan"}]


def test_a_copys_read_has_edited_seq_and_bus_warnings(t, client, barkada):  # E24 (B35, B38)
    shared = client.get(f"/itineraries/{SLUG}").json()
    assert shared["edited"] is False and shared["seq"] is None
    booked = next(b for b in shared["guide"]["getting_there"]["buses"] if b["booked"])
    assert all(b["warning"] is None for b in shared["guide"]["getting_there"]["buses"])
    saved = edit(client, t, retime("d2-08", "15:30"))
    with psycopg.connect(barkada, autocommit=True) as conn:
        conn.execute("update trips set is_active = false where id = %s", (booked["trip_id"],))
    assert any(i["code"] == "trip_inactive" for i in client.get(f"/itineraries/{SLUG}").json()["issues"]), "the shared plan says so in issues"
    it = client.get(f"/itineraries/{saved['itinerary']['share_slug']}").json()
    assert it["edited"] is True and it["seq"] == 1
    assert not [i for i in it["issues"] if i["path"].startswith(("outbound", "return"))], "a copy's bus warnings take their place"
    warned = next(b for b in it["guide"]["getting_there"]["buses"] if b["trip_id"] == booked["trip_id"])
    assert warned["warning"] == "retired" and warned["trip"] is not None, "nothing changes by itself"
    with psycopg.connect(barkada, autocommit=True) as conn:
        conn.execute("update trips set is_active = true, days_of_week = '{0}' where id = %s", (booked["trip_id"],))
    it = client.get(f"/itineraries/{saved['itinerary']['share_slug']}").json()
    assert next(b for b in it["guide"]["getting_there"]["buses"] if b["trip_id"] == booked["trip_id"])["warning"] == "not_running"


def test_logs_carry_slugs_seqs_and_counts_only(t, client, barkada, caplog, monkeypatch):  # E25 (A's part)
    caplog.set_level(logging.INFO)
    secret_note = "Meet Ana at the blue gate"
    it = plan_of(client, t)
    names = {row(it["guide"], k)["plan"] for k in ("d2-08", "d2-04")}

    def change(g):
        row(g, "d2-08").update(time="15:30", note=secret_note)

    edit(client, t, change)
    undo(client, t)
    g = stored(plan_of(client, t)["guide"])
    row(g, "d2-04")["place"] = {"spot_id": str(uuid.uuid4())}
    save(client, t, g)
    # a forced database failure: the change lines bypass their cap, so the table's check fires
    from app import plan_diff

    monkeypatch.setattr(plan_diff, "MAX_LINES", 9)
    g = stored(plan_of(client, t)["guide"])
    for k in ("d2-01", "d2-02", "d2-04", "d2-05", "d2-06", "d2-07"):
        row(g, k)["note"] = secret_note
    r = save(client, t, g)
    assert r.status_code == 422 and r.json()["detail"] == "bad_plan"
    fmt = RedactingFormatter("%(levelname)s %(name)s %(message)s")
    text = caplog.text + "\n".join(fmt.format(rec) for rec in caplog.records)  # the app's own formatting, tracebacks included
    for bad in (secret_note, "Ana", *names, "Later", "Dropped"):
        assert bad not in text, bad
    assert "plan save share_slug=" in text and "source=hand" in text
    assert "plan undo share_slug=" in text
    assert "plan save rejected share_slug=" in text and "codes=unknown_place" in text
    assert "codes=bad_plan constraint=itinerary_versions_changes_check" in text
    assert logging.getLogger("httpx").getEffectiveLevel() >= logging.WARNING


def test_a_reads_seq_always_matches_its_plan(t, client, barkada, monkeypatch):  # E26
    saved = edit(client, t, retime("d2-08", "15:30"))
    slug = saved["itinerary"]["share_slug"]
    real = guides.build

    def racing_build(*args, **kwargs):
        # another phone's save lands between the read's statement and the build
        with psycopg.connect(barkada, autocommit=True) as conn:
            iid, plan = conn.execute("select id, plan from itineraries where share_slug = %s", (slug,)).fetchone()
            plan["guide"]["title"] = "Raced"
            conn.execute("insert into itinerary_versions (itinerary_id, session_id, seq, source, plan, changes)"
                         " select %s, session_id, 2, 'hand', %s, '[{\"word\": \"Changed\", \"day\": null, \"text\": \"x\"}]' from itinerary_versions"
                         " where itinerary_id = %s and seq = 0", (iid, Jsonb(plan), iid))
            conn.execute("update itineraries set plan = %s where id = %s", (Jsonb(plan), iid))
        monkeypatch.setattr(guides, "build", real)
        return real(*args, **kwargs)

    monkeypatch.setattr(guides, "build", racing_build)
    it = client.get(f"/itineraries/{slug}").json()
    assert (it["seq"], it["guide"]["title"]) == (1, saved["itinerary"]["guide"]["title"]), "one statement reads both"
    again = client.get(f"/itineraries/{slug}").json()
    assert (again["seq"], again["guide"]["title"]) == (2, "Raced")


def test_the_saves_answer_is_the_fresh_read(t, client):  # E27 (B45)
    saved = edit(client, t, retime("d2-08", "15:30"))
    fresh = client.get(f"/itineraries/{saved['itinerary']['share_slug']}").json()
    assert saved["itinerary"] == fresh
    second = edit(client, t, retime("d2-09", "18:30"))
    assert row(second["itinerary"]["guide"], "d2-08")["time"] == "15:30", "a second edit is worked out from the saved plan"


def test_a_body_over_128_kb_is_refused_before_its_parsed(t, client, caplog):  # E28 (B50)
    caplog.set_level(logging.INFO)
    body = json.dumps({"base": {"itinerary_slug": SLUG, "seq": 0}, "guide": {"title": "x" * 200_000}, "source": "hand"}).encode()
    r = client.put(f"/sessions/{t}/plan", content=body, headers={"content-type": "application/json"})
    assert r.status_code == 413 and r.json() == {"detail": "too_big"}

    def chunks():
        for i in range(0, len(body), 16_384):
            yield body[i:i + 16_384]

    r = client.put(f"/sessions/{t}/plan", content=chunks(), headers={"content-type": "application/json"})
    assert r.status_code == 413 and r.json() == {"detail": "too_big"}
    assert "body too big path=/sessions/{share_slug}/plan" in caplog.text and t not in caplog.text.split("body too big")[1].splitlines()[0]
    small = client.put(f"/sessions/{t}/plan", content=b'{"base": {}}', headers={"content-type": "application/json"})
    assert small.status_code == 422, "a small body still reaches the route"


def test_picked_options_and_bus_rows_with_no_booked_bus(t, client, barkada):  # E29
    it = plan_of(client, t)
    d2 = next(d for d in it["guide"]["days"] if d["pick"])
    picked = d2["pick"]["options"][-1]["id"]
    assert client.put(f"/sessions/{t}/marks/pick:{d2['pick']['key']}", json={"value": picked}).status_code == 200
    g = stored(it["guide"])
    pick = next(d for d in g["days"] if d["pick"])["pick"]
    pick["options"] = [o for o in pick["options"] if o["id"] != picked]
    for r in (r for d in g["days"] for r in d["rows"]):
        for c in ("show_if", "hide_if"):
            if r.get(c) and r[c]["is"] == picked:
                r[c] = None
    r = save(client, t, g)
    assert r.status_code == 422 and r.json()["detail"] == "option_picked"
    # no booked row in the table: the bus row keeps its base time
    g = stored(it["guide"])
    for b in g["getting_home"]["buses"]:
        b["booked"] = False
    row(g, "d3-10")["time"] = "23:00"
    saved = save(client, t, g)
    assert saved.status_code == 200, saved.text
    assert row(saved.json()["itinerary"]["guide"], "d3-10")["time"] == row(it["guide"], "d3-10")["time"]


def test_another_trips_place_in_a_copy_builds_as_missing(t, client, barkada):  # E30
    saved = edit(client, t, retime("d2-08", "15:30"))
    theirs = place_row(barkada, other_trip(client), name="Their secret spot")
    slug = saved["itinerary"]["share_slug"]
    with psycopg.connect(barkada, autocommit=True) as conn:
        plan = conn.execute("select plan from itineraries where share_slug = %s", (slug,)).fetchone()[0]
        next(r for d in plan["guide"]["days"] for r in d["rows"] if r["key"] == "d2-04")["place"] = {"trip_place_id": theirs}
        conn.execute("update itineraries set plan = %s where share_slug = %s", (Jsonb(plan), slug))
    it = client.get(f"/itineraries/{slug}").json()
    p = row(it["guide"], "d2-04")["place"]
    assert p == {"kind": "trip_place", "id": theirs, "name": None, "category": None, "lodging": False, "lat": None, "lng": None, "maps_url": None}
    assert "Their secret spot" not in json.dumps(it)


# ---------------------------------------------------------------- the read of a trip place and a leg

def test_a_trip_place_and_a_leg_read_back(t, client, barkada):
    mine = place_row(barkada, t, name="Cafe Ozark", lat=16.4, lng=120.59)
    route = one(barkada, "select id, mode, minutes, fare_min_php, fare_max_php, signboard, last_verified_at from last_mile_routes limit 1")

    def change(g):
        row(g, "d2-04")["place"] = {"trip_place_id": mine}
        row(g, "d2-04")["leg"] = {"estimate": {"mode": "taxi", "minutes": 15, "km": 3.2}}
        row(g, "d2-05")["leg"] = {"last_mile_route_id": str(route["id"])}

    saved = edit(client, t, change)
    g = saved["itinerary"]["guide"]
    assert row(g, "d2-04")["place"] == {"kind": "trip_place", "id": mine, "name": "Cafe Ozark", "category": None, "lodging": False,
                                        "lat": 16.4, "lng": 120.59, "maps_url": "https://maps.app.goo.gl/abc"}
    assert row(g, "d2-04")["leg"] == {"kind": "estimate", "mode": "taxi", "minutes": 15, "km": 3.2}
    leg = row(g, "d2-05")["leg"]
    assert leg["kind"] == "route" and leg["last_mile_route_id"] == str(route["id"]) and leg["mode"] == route["mode"]
    assert set(leg) == {"kind", "last_mile_route_id", "mode", "minutes", "fare_min_php", "fare_max_php", "signboard", "last_verified_at"}
    assert row(g, "d2-06")["leg"] is None
    spot = row(g, "d2-06")["place"]
    assert spot["kind"] == "spot" and spot["lat"] is None and spot["maps_url"] is None
    assert stored(g) == stored(client.get(f"/itineraries/{saved['itinerary']['share_slug']}").json()["guide"])
