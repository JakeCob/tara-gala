"""TG-64: the read-only recap link (plan.md §4 and §5, owner decisions of 2026-11-16 in ticket.md). Anyone with the trip's
link turns it on, with toggles for photos, people and spending; anyone with the recap link reads the map as travelled
and only what was picked, live. Storage is test_trip_files.py's in-memory stand-in. Every trip, person, hotel and note
here is made up; never the owner's trip. The ids (R1 and so on) are plan.md §5's.
"""

import dataclasses
import json
import logging
import re
from datetime import date

import psycopg
import pytest

from app.limits import RateLimiter
from test_guide import SLUG as ITINERARY_SLUG
from test_guide import barkada, trip as guide_trip  # noqa: F401  fixtures
from test_plan_edit import editing, edit, row  # noqa: F401  fixtures
from test_trip_files import JPEG, PNG, TRIP, fake_store, trip_with_wallet, upload  # noqa: F401  fake_store is an autouse fixture
from test_trip_people import avatar, new_trip, person, rows, tap

HEX32 = re.compile(r"^[0-9a-f]{32}$")
RECAP_KEYS = {"name", "start_date", "return_date", "still_on", "guide", "marks", "photos", "people", "spending"}
DEFAULTS = {"photos": False, "people": "none", "spending": "none"}
EVERYTHING = {"photos": True, "people": "names_photos", "spending": "total"}
NOT_FOUND = {"detail": "recap_not_found"}
LODGING = "Finteo Skylands Premium"  # the barkada plan's lodging spot (test_guide.py)


@pytest.fixture(autouse=True)
def recap_links(client):
    """RECAP_LINKS on for this test's app; it's off by default (plan §6)."""
    before = client.app.state.flags
    client.app.state.flags = dataclasses.replace(before, recap_links=True)
    yield client
    client.app.state.flags = before


# ---------------------------------------------------------------- helpers

def put(client, slug, **settings):
    return client.put(f"/sessions/{slug}/recap", json={**DEFAULTS, **settings})


def on(client, slug, **settings) -> str:
    r = put(client, slug, **settings)
    assert r.status_code == 200, r.text
    return r.json()["recap"]["slug"]


def recap(client, rslug) -> dict:
    r = client.get(f"/recaps/{rslug}")
    assert r.status_code == 200, r.text
    return r.json()


def session(client, slug) -> dict:
    return client.get(f"/sessions/{slug}").json()


def say(client, slug, aid, rsvp):
    r = client.patch(f"/sessions/{slug}/attendees/{aid}", json={"rsvp": rsvp})
    assert r.status_code == 200, r.text


def spend(client, wallet_slug, payer, centavos, note="E2E taxi"):
    r = client.post(f"/wallets/{wallet_slug}/expenses", json={"paid_by": payer, "amount_centavos": centavos, "note": note, "split_among": [payer]})
    assert r.status_code == 201, r.text


def photo_id(r) -> str:
    """The newest photo in an upload's answer (SessionOut lists files by kind, so an avatar comes first)."""
    assert r.status_code in (200, 201), r.text
    return [f["id"] for f in r.json()["files"] if f["kind"] == "photo"][-1]


def walk(value):
    """Every string in a JSON value, keys included."""
    if isinstance(value, dict):
        for k, v in value.items():
            yield k
            yield from walk(v)
    elif isinstance(value, list):
        for v in value:
            yield from walk(v)
    elif isinstance(value, str):
        yield value


def not_found(r) -> tuple:
    """What a recap 404 is made of: the status, the body and the headers that matter (R13: all must be identical)."""
    headers = {k: r.headers.get(k) for k in ("cache-control", "x-robots-tag", "content-type")}
    return r.status_code, r.json(), headers


# ---------------------------------------------------------------- turning it on and off (B1 to B5)

def test_turn_on_with_the_defaults(client):  # R1, B1
    slug = new_trip(client)
    assert session(client, slug)["recap"] == {"slug": None, **DEFAULTS}, "off until someone turns it on"
    r = put(client, slug)
    assert r.status_code == 200, r.text
    got = r.json()["recap"]
    assert HEX32.fullmatch(got["slug"]) and got["slug"] != slug
    assert {k: got[k] for k in DEFAULTS} == DEFAULTS
    assert session(client, slug)["recap"] == got
    assert r.headers["cache-control"] == "private, no-cache" and r.headers["x-robots-tag"] == "noindex"


def test_a_toggle_keeps_the_slug_and_shows_on_the_next_load(guide_trip, client):  # R2, B2
    rslug = on(client, guide_trip)
    assert recap(client, rslug)["photos"] is None
    r = put(client, guide_trip, photos=True, people="names", spending="total")
    assert r.status_code == 200, r.text
    assert r.json()["recap"] == {"slug": rslug, "photos": True, "people": "names", "spending": "total"}
    after = recap(client, rslug)
    assert after["photos"] == [] and after["people"]["list"] == []


def test_turning_it_on_twice_keeps_one_slug(client):  # R3
    slug = new_trip(client)
    assert on(client, slug) == on(client, slug, photos=True)


def test_turning_it_off_kills_the_link_and_resets_the_toggles(client):  # R3, B3
    slug = new_trip(client)
    old = on(client, slug, **EVERYTHING)
    r = client.delete(f"/sessions/{slug}/recap")
    assert r.status_code == 200, r.text
    assert r.json()["recap"] == {"slug": None, **DEFAULTS}, "off goes back to map only (decision 3)"
    assert not_found(client.get(f"/recaps/{old}"))[:2] == (404, NOT_FOUND)
    again = on(client, slug)
    assert again != old and session(client, slug)["recap"] == {"slug": again, **DEFAULTS}
    assert client.get(f"/recaps/{old}").status_code == 404, "the old link stays dead"
    assert client.delete(f"/sessions/{slug}/recap").status_code == 200 and client.delete(f"/sessions/{slug}/recap").status_code == 200


@pytest.mark.parametrize(
    "body",
    [
        {**DEFAULTS, "spending": "per_person"},  # decision 7
        {**DEFAULTS, "people": "all"},
        {"photos": False, "people": "none"},  # all three are required
        {"people": "none", "spending": "none"},
        {**DEFAULTS, "slug": "ab" * 16},  # extra fields are refused
        {**DEFAULTS, "expires": "2027-01-01"},
        {**DEFAULTS, "photos": None},
    ],
)
def test_bad_settings_are_422_and_change_nothing(client, dsn, body):  # R4, B4
    slug = new_trip(client)
    rslug = on(client, slug, photos=True)
    before = rows(dsn, "select recap_slug, recap_photos, recap_people, recap_spending from trip_sessions")
    r = client.put(f"/sessions/{slug}/recap", json=body)
    assert r.status_code == 422, r.text
    assert rows(dsn, "select recap_slug, recap_photos, recap_people, recap_spending from trip_sessions") == before
    assert session(client, slug)["recap"] == {"slug": rslug, "photos": True, "people": "none", "spending": "none"}


@pytest.mark.parametrize("dates", [("2025-03-01", "2025-03-03"), ("2026-11-06", "2026-11-08"), ("2030-01-01", "2030-01-02")])
def test_it_can_be_turned_on_before_during_or_after_the_trip(client, dates):  # R5, B5 (decision 4)
    slug = client.post("/sessions", json={"name": "E2E made up trip", "start_date": dates[0], "return_date": dates[1]}).json()["share_slug"]
    assert HEX32.fullmatch(on(client, slug))


# ---------------------------------------------------------------- what the recap shows (B6 to B12a)

def test_the_defaults_show_the_map_only(guide_trip, client, monkeypatch):  # R6, B6
    from app import recaps

    monkeypatch.setattr(recaps, "manila_today", lambda: date(2026, 11, 7))
    client.put(f"/sessions/{guide_trip}/marks/row:d1-01", json={"value": "done"})
    aid = person(client, guide_trip, "Ana")
    say(client, guide_trip, aid, "yes")
    r = client.get(f"/recaps/{on(client, guide_trip)}")
    assert r.status_code == 200, r.text
    got = r.json()
    assert set(got) == RECAP_KEYS
    assert (got["name"], got["start_date"], got["return_date"], got["still_on"]) == ("Baguio", "2026-11-06", "2026-11-08", True)
    assert [len(d["rows"]) for d in got["guide"]["days"]] == [7, 9, 10]
    assert [m["key"] for m in got["marks"]] == ["row:d1-01"]
    assert got["photos"] is None and got["spending"] is None
    assert got["people"] == {"count": 1, "list": None}, "a count, no names"


def test_still_on_follows_manilas_today(guide_trip, client, monkeypatch):  # R6
    from app import recaps

    rslug = on(client, guide_trip)
    for today, still in ((date(2026, 11, 1), True), (date(2026, 11, 8), True), (date(2026, 11, 9), False)):
        monkeypatch.setattr(recaps, "manila_today", lambda today=today: today)
        assert recap(client, rslug)["still_on"] is still, today


def test_no_plan_gives_no_guide(client):  # R6
    slug = new_trip(client)
    assert recap(client, on(client, slug))["guide"] is None


def test_an_edited_plan_shows_the_copy_without_todo_sources_or_budget(guide_trip, editing, client, dsn):  # noqa: F811  R7, B7
    sid = rows(dsn, "select id from trip_sessions where share_slug = %s", guide_trip)[0]["id"]
    with psycopg.connect(dsn, autocommit=True) as conn:
        tp = conn.execute(
            "insert into trip_places (session_id, name, lat, lng, maps_url) values (%s, 'E2E made up cafe', 16.41, 120.59, 'https://maps.app.goo.gl/E2Emadeup') returning id",
            (sid,),
        ).fetchone()[0]

    def change(g):
        row(g, "d1-05")["note"] = "E2E recap note"
        row(g, "d1-06")["place"] = {"trip_place_id": str(tp)}

    saved = edit(client, guide_trip, change)
    copy_slug = session(client, guide_trip)["itinerary_slug"]
    assert copy_slug != ITINERARY_SLUG
    text = client.get(f"/recaps/{on(client, guide_trip)}").text
    got = json.loads(text)["guide"]
    assert row(got, "d1-05")["note"] == "E2E recap note", "the trip's own copy, not the shared plan"
    assert row(got, "d1-06")["place"]["kind"] == "trip_place" and row(got, "d1-06")["place"]["name"] == "E2E made up cafe"
    assert got["todo"] == [] and got["sources"] == []
    assert got["budget"] == {"summary": "", "rows": [], "excluded": ""}
    assert got["getting_there"]["buses"] and got["getting_home"]["buses"], "the bus tables stay: the map's bus rows use them"
    assert copy_slug not in text and ITINERARY_SLUG not in text and saved["itinerary"]["share_slug"] not in text


def test_an_unreadable_plan_is_a_500_not_no_plan(guide_trip, client, dsn):  # R7 (plan §2.2 step 2)
    rslug = on(client, guide_trip)
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute("update itineraries set plan = '{\"days\": \"not a plan\"}'::jsonb where share_slug = %s", (ITINERARY_SLUG,))
    r = client.get(f"/recaps/{rslug}")
    assert r.status_code == 500


def test_ticks_carry_their_time_and_todos_never_show(guide_trip, client):  # R8, B8
    rslug = on(client, guide_trip)
    client.put(f"/sessions/{guide_trip}/marks/row:d2-07", json={"value": "done"})
    client.put(f"/sessions/{guide_trip}/marks/todo:03", json={"value": "done"})
    client.put(f"/sessions/{guide_trip}/marks/pick:sunrise", json={"value": "B"})
    trip = {m["key"]: m for m in session(client, guide_trip)["marks"]}
    got = recap(client, rslug)["marks"]
    assert sorted(m["key"] for m in got) == ["pick:sunrise", "row:d2-07"], "never a to-do"
    for m in got:
        assert m == trip[m["key"]], "the time is the mark's updated_at"
    client.put(f"/sessions/{guide_trip}/marks/row:d1-01", json={"value": "done"})
    assert "row:d1-01" in {m["key"] for m in recap(client, rslug)["marks"]}, "a later tick shows on the next load (decision 5)"


def test_photos_only_list_and_serve_photos(guide_trip, client):  # R9, B9
    slug = guide_trip
    photo = upload(client, slug, data=JPEG, content_type="image/jpeg", kind="photo", row_key="d1-05").json()
    loose = upload(client, slug, kind="photo").json()
    upload(client, slug, kind="ticket", label="Bus")
    upload(client, slug, kind="hotel_proof")
    aid = person(client, slug, "Ana")
    say(client, slug, aid, "yes")
    avatar(client, slug, aid)
    files = {f["kind"]: f["id"] for f in session(client, slug)["files"]}
    photos = [f for f in session(client, slug)["files"] if f["kind"] == "photo"]
    rslug = on(client, slug, photos=True)
    assert recap(client, rslug)["photos"] == [{"id": f["id"], "row_key": f["row_key"]} for f in photos], "created order"
    assert {p["row_key"] for p in recap(client, rslug)["photos"]} == {"d1-05", None}
    assert photo and loose
    r = client.get(f"/recaps/{rslug}/photos/{photos[0]['id']}")
    assert r.status_code == 200 and r.content == JPEG and r.headers["content-type"] == "image/jpeg"
    for kind in ("ticket", "hotel_proof", "avatar"):
        assert not_found(client.get(f"/recaps/{rslug}/photos/{files[kind]}"))[:2] == (404, NOT_FOUND), kind
    put(client, slug, photos=False)
    assert client.get(f"/recaps/{rslug}/photos/{photos[0]['id']}").status_code == 404, "turning photos off closes the URLs at once"


def five(client, slug) -> dict[str, str]:
    """R10's five made-up people, in list order: said yes and here, said yes, never answered but here, never answered,
    said no."""
    ids = {n: person(client, slug, n) for n in ("Ana", "Ben", "Pia", "Quin", "Rex")}
    say(client, slug, ids["Ana"], "yes")
    tap(client, slug, ids["Ana"], at="2026-11-06T09:41:00")
    say(client, slug, ids["Ben"], "yes")
    tap(client, slug, ids["Pia"], at="2026-11-06T09:52:00")
    say(client, slug, ids["Rex"], "no")
    return ids


def test_who_came_is_yes_or_marked_here(client):  # R10, B10
    slug = new_trip(client)
    ids = five(client, slug)
    for n in ("Pia", "Quin", "Rex"):
        avatar(client, slug, ids[n])
    rslug = on(client, slug)
    assert recap(client, rslug)["people"] == {"count": 3, "list": None}
    put(client, slug, people="names")
    got = recap(client, rslug)["people"]
    assert got["count"] == 3
    assert [(p["name"], p["avatar_id"]) for p in got["list"]] == [("Ana", None), ("Ben", None), ("Pia", None)]
    arrived = {a["name"]: a["arrived_at"] for a in session(client, slug)["attendees"]}
    assert [p["arrived_at"] for p in got["list"]] == [arrived["Ana"], None, arrived["Pia"]]
    assert all(set(p) == {"name", "arrived_at", "avatar_id"} for p in got["list"])
    for n in ("Ana", "Ben", "Pia"):
        assert client.get(f"/recaps/{rslug}/avatars/{ids[n]}").status_code == 404, "no avatars without names_photos"
    put(client, slug, people="names_photos")
    got = recap(client, rslug)["people"]["list"]
    assert [(p["name"], p["avatar_id"]) for p in got] == [("Ana", None), ("Ben", None), ("Pia", ids["Pia"])]
    r = client.get(f"/recaps/{rslug}/avatars/{ids['Pia']}")
    assert r.status_code == 200 and r.content == PNG
    for n in ("Quin", "Rex"):
        assert not_found(client.get(f"/recaps/{rslug}/avatars/{ids[n]}"))[:2] == (404, NOT_FOUND), n
    assert client.get(f"/recaps/{rslug}/avatars/{ids['Ana']}").status_code == 404, "no avatar file"


def test_spending_is_the_groups_total_only(client):  # R11, B11
    slug, members = trip_with_wallet(client)
    wallet = session(client, slug)["wallet"]["share_slug"]
    rslug = on(client, slug, spending="total")
    assert recap(client, rslug)["spending"] is None, "nothing spent yet"
    spend(client, wallet, members["Jacob"], 1_000_000)
    spend(client, wallet, members["Ana"], 800_000)
    assert recap(client, rslug)["spending"] == {"total_centavos": 1_800_000}
    put(client, slug, spending="none")
    assert recap(client, rslug)["spending"] is None
    lone = new_trip(client)
    assert recap(client, on(client, lone, spending="total"))["spending"] is None, "no wallet"


def test_the_recap_never_carries_private_data(guide_trip, client, dsn):  # R12, B12
    slug = guide_trip
    wallet = client.post("/wallets", json={"name": "E2E Kitty", "members": ["Jacob", "Ana"]}).json()
    client.put(f"/sessions/{slug}/wallet", json={"share_slug": wallet["share_slug"]})
    jacob = wallet["members"][0]["id"]
    spend(client, wallet["share_slug"], jacob, 50_000, note="E2E secret note")
    hotel = {"name": "E2E Pinecrest Hideaway", "address": "E2E 99 Hidden Lane", "booking_ref": "BKREF77E2E", "notes": "E2E gate code 4471"}
    assert client.put(f"/sessions/{slug}/hotel", json=hotel).status_code == 200
    ticket = upload(client, slug, kind="ticket", label="E2E bus ticket").json()
    qr = upload(client, slug, kind="payout_qr", member_id=jacob).json()
    invite = client.put(f"/sessions/{slug}/invite").json()["invite_slug"]
    ana = person(client, slug, "Ana")
    say(client, slug, ana, "yes")
    zed = person(client, slug, "Zed")  # never answered, never marked here
    avatar(client, slug, zed)
    nora = person(client, slug, "Nora")
    say(client, slug, nora, "no")
    trip = session(client, slug)
    rslug = on(client, slug, **EVERYTHING)
    r = client.get(f"/recaps/{rslug}")
    assert r.status_code == 200, r.text
    text = r.text
    strings = list(walk(r.json()))
    secrets = [slug, invite, wallet["share_slug"], ITINERARY_SLUG, *hotel.values(), "E2E secret note", "Zed", "Nora", "E2E bus ticket"]
    secrets += [f["id"] for f in trip["files"] if f["kind"] != "photo"]
    for secret in secrets:
        assert secret not in text, secret
        assert not any(secret in s for s in strings), secret
    assert ticket and qr
    for word in ("rsvp", "booking_ref", "share_slug", "invite_slug", "itinerary_slug", "wallet", "shares", "paid_by"):
        assert word not in text, word


def test_the_recap_never_reads_the_hotel_booking():  # R12, B12 (Rev 1, M1)
    from conftest import ROOT

    source = (ROOT / "api" / "app" / "recaps.py").read_text(encoding="utf-8")
    assert "session_hotels" not in source, "the booking can't reach the answer if it's never read"
    assert "invite_slug" not in source


def test_the_plans_lodging_is_on_the_map(guide_trip, client):  # R12a, B12a (Rev 1, M1)
    got = recap(client, on(client, guide_trip))
    assert got["guide"]["lodging"]["name"] == LODGING, "the map shows where the group stays; the copy says so"
    assert LODGING in json.dumps(got)


# ---------------------------------------------------------------- one 404 (B13, B14)

def make_cases(client, dsn) -> dict:
    """Every way a recap URL can be wrong (R13). Each must look the same."""
    slug = new_trip(client)
    rslug = on(client, slug, people="names")
    other = new_trip(client)
    other_photo = upload(client, other, kind="photo").json()
    ticket = upload(client, slug, kind="ticket", label="Bus").json()
    aid = person(client, slug, "Ana")
    say(client, slug, aid, "yes")
    avatar(client, slug, aid)
    off = new_trip(client)
    old = on(client, off)
    client.delete(f"/sessions/{off}/recap")
    gone = new_trip(client)
    dead = on(client, gone)
    assert client.request("DELETE", f"/sessions/{gone}", json={"name": TRIP["name"]}).status_code == 204
    files = {f["kind"]: f["id"] for f in session(client, slug)["files"]}
    photo_of_other = next(f["id"] for f in session(client, other)["files"] if f["kind"] == "photo")
    assert other_photo and ticket
    put(client, slug, photos=True, people="names")
    return {
        "wrong slug": f"/recaps/{'0f' * 16}",
        "a link that's off": f"/recaps/{old}",
        "a deleted trip": f"/recaps/{dead}",
        "a trip slug as a recap slug": f"/recaps/{slug}",
        "not a slug": "/recaps/not-a-slug",
        "a photo of another trip": f"/recaps/{rslug}/photos/{photo_of_other}",
        "a ticket's id": f"/recaps/{rslug}/photos/{files['ticket']}",
        "an avatar without names_photos": f"/recaps/{rslug}/avatars/{aid}",
        "not a file id": f"/recaps/{rslug}/photos/not-a-uuid",
    }


def test_every_miss_is_the_same_404(client, dsn):  # R13, B13
    cases = make_cases(client, dsn)
    seen = {label: not_found(client.get(path)) for label, path in cases.items()}
    want = (404, NOT_FOUND, {"cache-control": "private, no-cache", "x-robots-tag": "noindex", "content-type": "application/json"})
    for label, got in seen.items():
        assert got == want, label


def test_the_flag_off_is_the_same_404_and_reads_still_work(client, dsn):  # R13, R14
    slug = new_trip(client)
    rslug = on(client, slug, photos=True)
    pid = photo_id(upload(client, slug, kind="photo"))
    client.app.state.flags = dataclasses.replace(client.app.state.flags, recap_links=False)
    misses = [
        client.get(f"/recaps/{rslug}"),
        client.get(f"/recaps/{rslug}/photos/{pid}"),
        client.get(f"/recaps/{rslug}/avatars/{pid}"),
        put(client, slug, photos=False),
        client.delete(f"/sessions/{slug}/recap"),
    ]
    for r in misses:
        assert not_found(r) == (404, NOT_FOUND, {"cache-control": "private, no-cache", "x-robots-tag": "noindex", "content-type": "application/json"})
    assert session(client, slug)["recap"] == {"slug": rslug, "photos": True, "people": "none", "spending": "none"}, "SessionOut.recap is still read"
    client.app.state.flags = dataclasses.replace(client.app.state.flags, recap_links=True)
    assert recap(client, rslug)["photos"] == [{"id": pid, "row_key": None}], "turned back on, the link works unchanged (plan §6)"


def test_deleting_the_trip_kills_the_recap(client, fake_store):  # R17
    slug = new_trip(client)
    rslug = on(client, slug, photos=True)
    pid = photo_id(upload(client, slug, kind="photo"))
    assert client.get(f"/recaps/{rslug}/photos/{pid}").status_code == 200
    assert client.request("DELETE", f"/sessions/{slug}", json={"name": TRIP["name"]}).status_code == 204
    assert client.get(f"/recaps/{rslug}").status_code == 404
    assert client.get(f"/recaps/{rslug}/photos/{pid}").status_code == 404


# ---------------------------------------------------------------- logs, headers and limits (B17)

def test_logs_carry_8_characters_and_counts_only(client, caplog):  # R15, B17
    caplog.set_level(logging.INFO)
    slug, members = trip_with_wallet(client)
    wallet = session(client, slug)["wallet"]["share_slug"]
    spend(client, wallet, members["Jacob"], 1_234_500)
    ids = five(client, slug)
    avatar(client, slug, ids["Pia"])
    pid = photo_id(upload(client, slug, data=JPEG, content_type="image/jpeg", kind="photo", row_key="d1-05"))
    client.put(f"/sessions/{slug}/marks/row:d1-01", json={"value": "done"})
    rslug = on(client, slug, **EVERYTHING)
    caplog.clear()
    client.get(f"/recaps/{rslug}")
    client.get(f"/recaps/{rslug}/photos/{pid}")
    client.get(f"/recaps/{rslug}/avatars/{ids['Pia']}")
    client.get(f"/recaps/{rslug[:31]}{'1' if rslug[-1] == '0' else '0'}")  # a near miss
    client.delete(f"/sessions/{slug}/recap")
    marks = session(client, slug)["marks"]
    text = "\n".join([r.getMessage() for r in caplog.records] + [caplog.text])
    assert rslug not in text and rslug[:31] not in text, "never the full recap slug"
    assert rslug[:8] in text, "the first 8 characters, to follow one link"
    for secret in ("Ana", "Ben", "Pia", "Quin", "Rex", "Jacob", "1234500", "12,345", pid, ids["Pia"], "09:41", "09:52", "01:41", "01:52"):
        assert secret not in text, secret
    for m in marks:
        assert m["updated_at"][11:19] not in text, "no tick time"
    lines = [r.getMessage() for r in caplog.records]
    assert any(m.startswith(f"recap view recap={rslug[:8]} rows=") and "spending=on" in m and "people=names_photos" in m for m in lines)
    assert any(m == f"recap file recap={rslug[:8]} kind=photo bytes={len(JPEG)}" for m in lines)
    assert any(m == f"recap file recap={rslug[:8]} kind=avatar bytes={len(PNG)}" for m in lines)
    assert any(m.startswith("recap not found recap=") and "reason=" in m for m in lines)
    assert any(m == f"recap off share_slug={slug}" for m in lines)
    # the recap, a photo, an avatar and the near miss: the slug and everything after it (a file or person id) are masked
    assert sum(m.startswith(f"request method=GET path='/recaps/{rslug[:8]}*' ") for m in lines) == 4


def test_turning_it_on_is_logged_without_the_slug(client, caplog):  # R15
    caplog.set_level(logging.INFO)
    slug = new_trip(client)
    rslug = on(client, slug)
    on(client, slug, people="names")
    lines = [r.getMessage() for r in caplog.records]
    assert f"recap on share_slug={slug} photos=False people=none spending=none new=True" in lines
    assert f"recap on share_slug={slug} photos=False people=names spending=none new=False" in lines
    assert any(m.startswith(f"session recap-on share_slug={slug} ") and "recap=on" in m for m in lines)
    assert rslug not in "\n".join(lines)


def test_every_recap_answer_is_private_and_noindex(client):  # R16
    slug = new_trip(client)
    ids = five(client, slug)
    avatar(client, slug, ids["Ana"])
    pid = photo_id(upload(client, slug, kind="photo"))
    rslug = on(client, slug, photos=True, people="names_photos")
    for path in (f"/recaps/{rslug}", f"/recaps/{rslug}/photos/{pid}", f"/recaps/{rslug}/avatars/{ids['Ana']}"):
        r = client.get(path)
        assert r.status_code == 200, path
        assert r.headers["cache-control"] == "private, no-cache" and r.headers["x-robots-tag"] == "noindex", path
    for path in (f"/recaps/{rslug}/photos/{pid}", f"/recaps/{rslug}/avatars/{ids['Ana']}"):
        r = client.get(path)
        assert r.headers["content-disposition"] == "inline" and r.headers["x-content-type-options"] == "nosniff", "send_file's headers"


def test_the_file_headers_are_one_helper(client):  # R16 (plan §2.2: send_file, so the headers can't drift)
    slug = new_trip(client)
    pid = photo_id(upload(client, slug, kind="photo"))
    rslug = on(client, slug, photos=True)
    trip_file = client.get(f"/sessions/{slug}/files/{pid}")
    recap_file = client.get(f"/recaps/{rslug}/photos/{pid}")
    keep = ("cache-control", "content-disposition", "x-content-type-options", "x-robots-tag", "content-type")
    assert {k: recap_file.headers[k] for k in keep} == {k: trip_file.headers[k] for k in keep}
    from conftest import ROOT

    assert "def send_file(" in (ROOT / "api" / "app" / "trip_files.py").read_text(encoding="utf-8")
    assert "send_file(" in (ROOT / "api" / "app" / "recaps.py").read_text(encoding="utf-8")


def test_public_reads_are_rate_limited(client, caplog, monkeypatch):  # plan §2.2 Limits
    from app import recaps

    caplog.set_level(logging.INFO)
    slug = new_trip(client)
    rslug = on(client, slug)
    monkeypatch.setattr(recaps, "RECAP_LIMITER", RateLimiter(1))
    assert client.get(f"/recaps/{rslug}").status_code == 200
    r = client.get(f"/recaps/{rslug}")
    assert r.status_code == 429 and "retry-after" in r.headers
    [hit] = [x for x in caplog.records if "rate limited" in x.getMessage()]
    assert hit.levelno == logging.WARNING and rslug not in hit.getMessage()
    assert recaps.RECAP_PER_HOUR == 600
