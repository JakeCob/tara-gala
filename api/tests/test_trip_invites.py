"""TG-58 PR 2: the invite link. A trip can turn on a second, limited link that shows only its name, dates, the names
on the list and a count, and lets someone answer yes or no, add their name, or fill an empty photo. Storage is the
same in-memory stand-in as test_trip_files.py. Names are made up. The ids (I1 and so on) are test-plan.md's.
"""

import asyncio
import logging
import re
import threading
from datetime import date
from pathlib import Path
from uuid import uuid4

import pytest

from app import sessions as s
from app import trip_files as tf
from app import trip_invites as ti
from app.limits import RateLimiter
from test_guide import SLUG as ITINERARY_SLUG
from test_guide import barkada, trip as guide_trip  # noqa: F401  fixtures
from test_trip_files import JPEG, PNG, TRIP, fake_store, trip_with_wallet, upload  # noqa: F401  fake_store is an autouse fixture
from test_trip_people import add, avatar, image, new_trip, people, person, rows, tap

INVITE_KEYS = {"name", "start_date", "return_date", "coming", "closed", "people"}
ANSWER_KEYS = {"attendee_id", "name", "answer"}
HEX32 = re.compile(r"^[0-9a-f]{32}$")
OPEN_DAY = date(2026, 11, 4)  # before TRIP's return_date, whatever today is


@pytest.fixture(autouse=True)
def invite_limits(monkeypatch):
    monkeypatch.setattr(ti, "INVITE_LIMITER", RateLimiter(ti.INVITE_PER_HOUR))
    monkeypatch.setattr(ti, "manila_today", lambda: OPEN_DAY)


def start(client, slug) -> str:
    r = client.put(f"/sessions/{slug}/invite")
    assert r.status_code == 200, r.text
    return r.json()["invite_slug"]


def invited(client, names=("Ana",)) -> tuple[str, str, dict[str, str]]:
    """A trip with these names on its list and its invite on: (share slug, invite slug, {name: id})."""
    slug = new_trip(client)
    ids = {n: person(client, slug, n) for n in names}
    return slug, start(client, slug), ids


def answer(client, invite, **body):
    return client.post(f"/invites/{invite}/answers", json=body)


def photo(client, invite, aid, data=PNG, content_type="image/png"):
    return client.post(f"/invites/{invite}/attendees/{aid}/photo", content=data, headers={"content-type": content_type})


def answers_of(client, slug) -> dict[str, str]:
    return {a["name"]: a["rsvp"] for a in people(client, slug)}


def detail(r):
    return r.status_code, r.json()["detail"]


def dump(dsn) -> list:
    return [rows(dsn, f"select * from {t} order by 1") for t in ("trip_sessions", "session_attendees", "session_files")]


# ---------------------------------------------------------------- turning it on and off

def test_start_invite_is_idempotent(client):  # I1
    slug = new_trip(client)
    r = client.put(f"/sessions/{slug}/invite")
    assert r.status_code == 200, r.text
    invite = r.json()["invite_slug"]
    assert HEX32.fullmatch(invite) and invite != slug
    assert r.headers["cache-control"] == "private, no-cache" and r.json()["share_slug"] == slug
    assert start(client, slug) == invite, "a second tap shares the same link"
    assert client.get(f"/sessions/{slug}").json()["invite_slug"] == invite


def test_turn_off_kills_the_link(client):  # I2
    slug, invite, _ = invited(client)
    r = client.delete(f"/sessions/{slug}/invite")
    assert r.status_code == 200, r.text
    assert r.json()["invite_slug"] is None
    assert client.get(f"/invites/{invite}").status_code == 404
    again = start(client, slug)
    assert again != invite and client.get(f"/invites/{again}").status_code == 200


def test_invite_routes_need_the_trip_link(client):  # I3
    _, invite, _ = invited(client)
    for bad in ("nope", "0" * 32, invite):
        for method in ("PUT", "DELETE"):
            assert client.request(method, f"/sessions/{bad}/invite").status_code == 404, (method, bad)


def test_a_new_trip_has_no_invite(client):
    slug = new_trip(client)
    assert client.get(f"/sessions/{slug}").json()["invite_slug"] is None, "null until someone opts in"


def test_the_slug_is_made_in_python():  # review S1: no gen_random_bytes in a runtime query
    code = Path(ti.__file__).read_text(encoding="utf-8")
    assert "gen_random_bytes" not in code and "secrets.token_hex(16)" in code
    assert "coalesce(invite_slug, %s)" in code


# ---------------------------------------------------------------- what the link reads

def test_invite_keys_are_exact(client):  # I4
    slug, invite, ids = invited(client, ("Ana", "Ben", "Cy"))
    client.patch(f"/sessions/{slug}/attendees/{ids['Ana']}", json={"rsvp": "yes"})
    client.patch(f"/sessions/{slug}/attendees/{ids['Ben']}", json={"rsvp": "no"})
    r = client.get(f"/invites/{invite}")
    assert r.status_code == 200, r.text
    got = r.json()
    assert set(got) == INVITE_KEYS
    assert (got["name"], got["start_date"], got["return_date"], got["closed"]) == (TRIP["name"], TRIP["start_date"], TRIP["return_date"], False)
    assert all(set(p) == {"id", "name"} for p in got["people"])
    assert got["coming"] == 1, "only yes counts"


def test_invite_leaks_nothing(guide_trip, client, fake_store):  # I5
    slug = guide_trip
    wallet = client.post("/wallets", json={"name": "Kitty", "members": ["Ana", "Ben"]}).json()
    client.put(f"/sessions/{slug}/wallet", json={"share_slug": wallet["share_slug"]})
    client.put(f"/sessions/{slug}/hotel", json={"name": "Pinecrest Lodge", "booking_ref": "BKREF9931"})
    client.put(f"/sessions/{slug}/marks/row:d1-01", json={"value": "done"})
    upload(client, slug, kind="ticket", label="Bus")
    upload(client, slug, data=JPEG, content_type="image/jpeg", kind="photo", row_key="d1-05")
    aid = person(client, slug, "Ana")
    avatar(client, slug, aid)
    client.patch(f"/sessions/{slug}/attendees/{aid}", json={"rsvp": "yes"})
    tap(client, slug, aid, at="2026-11-06T09:47:00")
    trip = client.get(f"/sessions/{slug}").json()
    invite = start(client, slug)
    bodies = [
        client.get(f"/invites/{invite}").text,
        answer(client, invite, attendee_id=aid, answer="yes").text,
        answer(client, invite, name="Ben", answer="no").text,
    ]
    secrets = [slug, wallet["share_slug"], ITINERARY_SLUG, "Pinecrest", "BKREF9931", "row:d1-01", "rsvp", "arrived", "09:47", "01:47"]
    secrets += [f["id"] for f in trip["files"]]
    for body in bodies:
        for secret in secrets:
            assert secret not in body, (secret, body)
    r = photo(client, invite, person(client, slug, "Cy"))
    assert (r.status_code, r.content) == (204, b""), "the photo route returns nothing"


def test_invite_hides_who_said_no(client):  # I6
    slug, invite, ids = invited(client, ("Ana", "Ben", "Cy"))
    before = client.get(f"/invites/{invite}").json()["people"]
    client.patch(f"/sessions/{slug}/attendees/{ids['Cy']}", json={"rsvp": "yes"})
    answer(client, invite, attendee_id=ids["Ana"], answer="no")
    after = client.get(f"/invites/{invite}").json()["people"]
    assert after == before == [{"id": ids[n], "name": n} for n in ("Ana", "Ben", "Cy")], "same look, same order"


def _url(path: str, slug: str) -> str:
    def fill(m):
        return slug if m.group(1) == "share_slug" else ("row:d1-01" if m.group(1) == "key" else str(uuid4()))
    return re.sub(r"\{(\w+)\}", fill, path)


def test_invite_slug_opens_nothing_else(client):  # I7
    from app.main import app

    _, invite, ids = invited(client)
    u1, u2 = str(uuid4()), str(uuid4())
    bodies = {
        ("PATCH", "/sessions/{share_slug}"): {"json": {}},
        ("DELETE", "/sessions/{share_slug}"): {"json": {"name": TRIP["name"]}},
        ("PUT", "/sessions/{share_slug}/itinerary"): {"json": {"share_slug": "0" * 32}},
        ("PUT", "/sessions/{share_slug}/wallet"): {"json": {"share_slug": "0" * 32}},
        ("PUT", "/sessions/{share_slug}/hotel"): {"json": {"name": "H"}},
        ("POST", "/sessions/{share_slug}/files"): {"params": {"kind": "ticket", "label": "x"}, "content": PNG, "headers": {"content-type": "image/png"}},
        ("PUT", "/sessions/{share_slug}/marks/{key}"): {"json": {"value": "done"}},
        ("POST", "/sessions/{share_slug}/attendees"): {"json": {"name": "Zed"}},
        ("PATCH", "/sessions/{share_slug}/attendees/{attendee_id}"): {"json": {"rsvp": "yes"}},
        ("PUT", "/sessions/{share_slug}/attendees/{attendee_id}/arrival"): {"json": {}},
        ("POST", "/wallets/{share_slug}/members"): {"json": {"name": "Zed"}},
        ("POST", "/wallets/{share_slug}/expenses"): {"json": {"paid_by": u1, "amount_centavos": 100, "note": "x", "split_among": [u1]}},
        ("POST", "/wallets/{share_slug}/settlements"): {"json": {"from_member": u1, "to_member": u2, "amount_centavos": 100}},
        ("POST", "/wallets/{share_slug}/settlements/{settlement_id}/proof"): {"content": PNG, "headers": {"content-type": "image/png"}},
    }
    tried = 0
    for route in app.routes:
        path = getattr(route, "path", "")
        if not path.startswith(("/sessions/{", "/wallets/{")):
            continue
        for method in route.methods - {"HEAD", "OPTIONS"}:
            r = client.request(method, _url(path, invite), **bodies.get((method, path), {}))
            assert r.status_code == 404, (method, path, r.status_code, r.text)
            tried += 1
    assert tried > 25
    slug = new_trip(client)
    aid = person(client, slug)
    assert client.get(f"/invites/{slug}").status_code == 404, "the trip's own slug isn't an invite"
    assert answer(client, slug, attendee_id=aid, answer="yes").status_code == 404
    assert photo(client, slug, aid).status_code == 404
    assert people(client, slug)[0]["rsvp"] == "pending"


def test_invite_routes_are_exactly_three():  # I8
    from app.main import app

    served = {(m, r.path) for r in app.routes if getattr(r, "path", "").startswith("/invites") for m in r.methods - {"HEAD", "OPTIONS"}}
    assert served == {
        ("GET", "/invites/{invite_slug}"),
        ("POST", "/invites/{invite_slug}/answers"),
        ("POST", "/invites/{invite_slug}/attendees/{attendee_id}/photo"),
    }


# ---------------------------------------------------------------- answers

def test_answer_by_id(client):  # I9
    slug, invite, ids = invited(client)
    r = answer(client, invite, attendee_id=ids["Ana"], answer="yes")
    assert r.status_code == 200, r.text
    assert r.json() == {"attendee_id": ids["Ana"], "name": "Ana", "answer": "yes"}
    assert set(r.json()) == ANSWER_KEYS
    ana = people(client, slug)[0]
    assert ana["rsvp"] == "yes" and ana["rsvp_at"] is not None
    assert client.get(f"/invites/{invite}").json()["coming"] == 1


def test_latest_answer_wins(client):  # I10
    slug, invite, ids = invited(client)
    aid = ids["Ana"]
    answer(client, invite, attendee_id=aid, answer="yes")
    client.patch(f"/sessions/{slug}/attendees/{aid}", json={"rsvp": "no"})
    assert answers_of(client, slug) == {"Ana": "no"}, "the trip page after the invite"
    client.patch(f"/sessions/{slug}/attendees/{aid}", json={"rsvp": "yes"})
    answer(client, invite, attendee_id=aid, answer="no")
    assert answers_of(client, slug) == {"Ana": "no"}, "the invite after the trip page"
    answer(client, invite, attendee_id=aid, answer="yes")
    assert answers_of(client, slug) == {"Ana": "yes"}, "no to yes"


def test_new_name_with_an_answer(client):  # I11
    slug, invite, _ = invited(client)
    r = answer(client, invite, name="  Fe  ", answer="yes")
    assert r.status_code == 200, r.text
    fe = r.json()
    assert (fe["name"], fe["answer"]) == ("Fe", "yes") and set(fe) == ANSWER_KEYS
    assert answer(client, invite, name="Ed", answer="no").status_code == 200
    listed = people(client, slug)
    assert [(a["name"], a["rsvp"]) for a in listed] == [("Ana", "pending"), ("Fe", "yes"), ("Ed", "no")]
    assert next(a for a in listed if a["name"] == "Fe")["id"] == fe["attendee_id"]
    assert all(a["rsvp_at"] for a in listed[1:]), "an answer has its time"
    assert client.get(f"/invites/{invite}").json()["coming"] == 1, "no doesn't count"


def test_a_listed_name_is_refused(client):  # I12
    slug, invite, _ = invited(client, ("Ana", "ñora"))
    before = people(client, slug)
    for name in ("Ana", "ana", "ANA", "Ñora", " ñORA "):
        assert detail(answer(client, invite, name=name, answer="yes")) == (409, "name_taken"), name
    assert people(client, slug) == before, "nobody's answer changed"


def test_full_list(client):  # I13
    slug, invite, _ = invited(client)
    for n in range(29):
        person(client, slug, f"P{n}")
    assert detail(answer(client, invite, name="Zed", answer="yes")) == (409, "party_full")
    first = people(client, slug)[0]
    assert answer(client, invite, attendee_id=first["id"], answer="yes").status_code == 200, "someone listed still answers"
    assert len(people(client, slug)) == 30


def test_two_at_once_cannot_pass_the_cap(client, dsn):  # I14
    slug, invite, _ = invited(client)
    for n in range(28):
        person(client, slug, f"P{n}")
    assert len(people(client, slug)) == 29
    gate = threading.Barrier(8)
    got: list[int] = []

    def go(n):
        gate.wait()
        got.append(answer(client, invite, name=f"New{n}", answer="yes").status_code)

    threads = [threading.Thread(target=go, args=(n,)) for n in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(got) == [200] + [409] * 7
    assert rows(dsn, "select count(*) as n from session_attendees")[0]["n"] == 30


def test_answer_body_rules(client, dsn):  # I15
    slug, invite, ids = invited(client)
    before = dump(dsn)
    aid = ids["Ana"]
    for body in (
        {"attendee_id": aid, "name": "Fe", "answer": "yes"},
        {"answer": "yes"},
        {"attendee_id": aid, "answer": "pending"},
        {"attendee_id": aid, "answer": "maybe"},
        {"attendee_id": aid},
        {"attendee_id": aid, "answer": "yes", "rsvp": "yes"},
        {"name": "", "answer": "yes"},
        {"name": "x" * 31, "answer": "yes"},
    ):
        assert answer(client, invite, **body).status_code == 422, body
    assert dump(dsn) == before, "nothing written"


def test_unknown_person(client):  # I16
    slug, invite, _ = invited(client)
    other, _, theirs = invited(client, ("Ben",))
    before = people(client, other)
    for aid in (str(uuid4()), theirs["Ben"]):
        assert detail(answer(client, invite, attendee_id=aid, answer="yes")) == (422, "unknown_attendee")
        assert detail(photo(client, invite, aid)) == (422, "unknown_attendee")
    assert people(client, other) == before
    assert not [f for f in client.get(f"/sessions/{other}").json()["files"]], "the other trip is unchanged"


def test_closed_after_return_date(client, monkeypatch):  # I17
    slug, invite, ids = invited(client)
    monkeypatch.setattr(ti, "manila_today", lambda: date(2026, 11, 8))
    on_the_day = client.get(f"/invites/{invite}").json()
    assert on_the_day["closed"] is False and on_the_day["people"], "open on return_date"
    assert answer(client, invite, attendee_id=ids["Ana"], answer="yes").status_code == 200
    monkeypatch.setattr(ti, "manila_today", lambda: date(2026, 11, 9))
    got = client.get(f"/invites/{invite}").json()
    assert got["closed"] is True and got["people"] == []
    assert (got["name"], got["start_date"], got["return_date"]) == (TRIP["name"], TRIP["start_date"], TRIP["return_date"])
    for r in (
        answer(client, invite, attendee_id=ids["Ana"], answer="no"),
        answer(client, invite, name="Ana", answer="yes"),  # ahead of name_taken
        answer(client, invite, name="Fe", answer="yes"),
        answer(client, invite, attendee_id=str(uuid4()), answer="yes"),  # ahead of unknown_attendee
        photo(client, invite, ids["Ana"]),
        photo(client, invite, str(uuid4()), b"not a picture"),  # ahead of unknown_attendee and not_an_image
    ):
        assert detail(r) == (409, "invite_closed")
    assert answers_of(client, slug) == {"Ana": "yes"}
    assert client.get(f"/sessions/{slug}").json()["files"] == []


def test_closed_uses_manila_today():  # I17, mutant 41: the closing day is Manila's, not the machine's
    code = Path(ti.__file__).read_text(encoding="utf-8")
    assert re.search(r"from \.trip_files import [\w, ]*\bmanila_today\b", code)
    assert re.search(r"manila_today\(\)\s*>\s*", code), "after return_date, not on it"


def test_dead_link(client):  # I18
    slug, invite, ids = invited(client)
    other_slug, gone, gone_ids = invited(client, ("Ben",))
    client.request("DELETE", f"/sessions/{other_slug}", json={"name": TRIP["name"]})
    for bad, aid in (("nope", ids["Ana"]), ("0" * 32, ids["Ana"]), (invite.upper(), ids["Ana"]), (gone, gone_ids["Ben"])):
        for r in (
            client.get(f"/invites/{bad}"),
            answer(client, bad, attendee_id=aid, answer="yes"),
            photo(client, bad, aid),
        ):
            assert detail(r) == (404, "Invite not found"), bad
            assert r.headers["x-robots-tag"] == "noindex"


def test_invite_headers(client):  # I19
    slug, invite, ids = invited(client)
    for r in (client.get(f"/invites/{invite}"), answer(client, invite, attendee_id=ids["Ana"], answer="yes")):
        assert r.headers["cache-control"] == "private, no-cache"
        assert r.headers["x-robots-tag"] == "noindex"


def test_get_changes_nothing(client, dsn):  # I20
    _, invite, _ = invited(client, ("Ana", "Ben"))
    before = dump(dsn)
    for _ in range(3):
        assert client.get(f"/invites/{invite}").status_code == 200
    assert dump(dsn) == before
    assert client.get(f"/invites/{invite}/answers").status_code == 405, "answering is POST only"


# ---------------------------------------------------------------- photos

def test_photo_fills_an_empty_slot(client, dsn, fake_store):  # I21
    slug, invite, ids = invited(client)
    r = photo(client, invite, ids["Ana"], JPEG, "image/jpeg")
    assert (r.status_code, r.content) == (204, b""), r.text
    [f] = client.get(f"/sessions/{slug}").json()["files"]
    assert (f["kind"], f["attendee_id"], f["delete_after"], f["content_type"]) == ("avatar", ids["Ana"], None, "image/jpeg")
    assert client.get(f"/sessions/{slug}/files/{f['id']}").content == JPEG
    assert rows(dsn, "select delete_after from session_files")[0]["delete_after"] is None


def test_photo_cannot_overwrite(client, fake_store):  # I22
    slug, invite, ids = invited(client)
    assert photo(client, invite, ids["Ana"], JPEG, "image/jpeg").status_code == 204
    stored = dict(fake_store.objects)
    assert detail(photo(client, invite, ids["Ana"])) == (409, "photo_taken")
    assert fake_store.objects == stored, "no put, and the first's bytes stay"
    [f] = client.get(f"/sessions/{slug}").json()["files"]
    assert client.get(f"/sessions/{slug}/files/{f['id']}").content == JPEG
    assert avatar(client, slug, ids["Ana"]).status_code == 201, "the trip link can still replace it"


def test_photo_refusals(client, fake_store):  # I23
    slug, invite, ids = invited(client)
    aid = ids["Ana"]
    assert detail(photo(client, invite, aid, image(200_001))) == (413, "too_big")
    assert detail(photo(client, invite, aid, JPEG, "image/png")) == (422, "not_an_image")
    assert detail(photo(client, invite, aid, b"hello", "text/plain")) == (422, "not_an_image")
    assert detail(photo(client, invite, str(uuid4()))) == (422, "unknown_attendee")
    fake_store.fail = True
    assert detail(photo(client, invite, aid)) == (503, "storage_unavailable")
    fake_store.fail = False
    assert fake_store.objects == {} and client.get(f"/sessions/{slug}").json()["files"] == []
    assert photo(client, invite, aid, image(200_000)).status_code == 204, "200,000 bytes is allowed"


def test_two_photos_at_once(client, dsn):  # I24
    _, invite, ids = invited(client)
    gate = threading.Barrier(2)
    got: list[int] = []

    def go():
        gate.wait()
        got.append(photo(client, invite, ids["Ana"]).status_code)

    threads = [threading.Thread(target=go) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(got) == [204, 409]
    assert rows(dsn, "select count(*) as n from session_files")[0]["n"] == 1


def _raw_post(app, path: str, chunks: int, size: int = 1000) -> tuple[int, int]:
    """Sends a chunked body with no Content-Length straight to the app. Returns (status, chunks the app read)."""
    pulled = []
    sent = []

    async def receive():
        pulled.append(1)
        body = PNG + b"\x00" * (size - len(PNG)) if len(pulled) == 1 else b"\x00" * size
        return {"type": "http.request", "body": body, "more_body": len(pulled) < chunks}

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST", "scheme": "http",
        "path": path, "raw_path": path.encode(), "root_path": "", "query_string": b"",
        "headers": [(b"content-type", b"image/png"), (b"host", b"testserver")],
        "client": ("127.0.0.1", 5000), "server": ("testserver", 80),
    }
    asyncio.run(app(scope, receive, send))
    status = next(m["status"] for m in sent if m["type"] == "http.response.start")
    return status, len(pulled)


def test_photo_stops_reading_at_the_limit(client, monkeypatch):  # I25 (F6)
    from app.main import app

    _, invite, ids = invited(client)
    status, read = _raw_post(app, f"/invites/{invite}/attendees/{ids['Ana']}/photo", chunks=400)
    assert status == 413
    assert read == tf.MAX_AVATAR_BYTES // 1000 + 1, "stops at the chunk that passes 200,000 bytes"
    monkeypatch.setattr(ti, "manila_today", lambda: date(2026, 11, 9))
    status, read = _raw_post(app, f"/invites/{invite}/attendees/{ids['Ana']}/photo", chunks=400)
    assert status == 409 and read == 0, "a closed invite doesn't read the body"
    status, read = _raw_post(app, f"/invites/{'0' * 32}/attendees/{ids['Ana']}/photo", chunks=400)
    assert status == 404 and read == 0, "nor does a dead link"


def test_invite_limit(client):  # I26
    assert ti.INVITE_PER_HOUR == 60
    slug, invite, ids = invited(client)
    aid = ids["Ana"]
    writes = len(s.WRITE_LIMITER._hits.get("testclient", ()))
    uploads = len(tf.UPLOAD_LIMITER._hits.get("testclient", ()))
    for n in range(30):
        assert answer(client, invite, attendee_id=aid, answer="yes" if n % 2 else "no").status_code == 200
        assert photo(client, invite, aid).status_code in (204, 409)
    assert answer(client, invite, bogus=True).status_code == 429, "the 61st, ahead of validation"
    assert photo(client, invite, str(uuid4()), b"x", "text/plain").status_code == 429
    assert answer(client, "0" * 32, attendee_id=aid, answer="yes").status_code == 429, "ahead of the link check"
    assert len(s.WRITE_LIMITER._hits.get("testclient", ())) == writes, "the trip's writes are a separate budget"
    assert len(tf.UPLOAD_LIMITER._hits.get("testclient", ())) == uploads
    assert client.patch(f"/sessions/{slug}/attendees/{aid}", json={"rsvp": "no"}).status_code == 200
    for _ in range(5):
        assert client.get(f"/invites/{invite}").status_code == 200, "reading isn't limited"


def test_invite_logs(client, caplog, monkeypatch):  # I27 (F1)
    caplog.set_level(logging.INFO)
    slug, invite, ids = invited(client, ("Xenia",))
    client.get(f"/invites/{invite}")  # 200
    answer(client, invite, attendee_id=ids["Xenia"], answer="yes")  # 200
    answer(client, invite, name="Quentin", answer="no")  # 200, a new name
    answer(client, invite, name="xenia", answer="yes")  # 409 name_taken
    answer(client, invite, attendee_id=str(uuid4()), answer="yes")  # 422 unknown_attendee
    answer(client, invite, name="Zsazsa", answer="maybe")  # 422 validation
    photo(client, invite, ids["Xenia"])  # 204
    photo(client, invite, ids["Xenia"])  # 409 photo_taken
    client.get(f"/invites/{invite[:31]}")  # 404, near the real slug

    def boom():
        raise RuntimeError("boom")

    monkeypatch.setattr(ti, "manila_today", boom)
    assert client.get(f"/invites/{invite}").status_code == 500
    monkeypatch.setattr(ti, "manila_today", lambda: date(2026, 11, 9))
    answer(client, invite, attendee_id=ids["Xenia"], answer="no")  # 409 invite_closed
    times = [a["rsvp_at"] for a in people(client, slug)]
    text = "\n".join([r.getMessage() for r in caplog.records] + [caplog.text])
    assert invite not in text and invite[:31] not in text, "never the full invite slug"
    assert invite[:8] in text, "the first 8 characters, to follow one invite"
    for name in ("Xenia", "xenia", "Quentin", "Zsazsa"):
        assert name not in text, name
    for t in times:
        assert t[11:19] not in text, "no answer's time"
    lines = [r.getMessage() for r in caplog.records]
    assert any(m.startswith(f"trip invite get invite={invite[:8]} closed=False people=") for m in lines)
    assert any(m.startswith(f"trip invite answer invite={invite[:8]} answer=no new=True people=") for m in lines)
    assert any(m == f"trip invite refused invite={invite[:8]} reason=name_taken" for m in lines)
    assert any(m == f"trip invite refused invite={invite[:8]} reason=invite_closed" for m in lines)
    assert any(m.startswith(f"request method=GET path='/invites/{invite[:8]}") for m in lines), "the request log masks the slug"


def test_rate_limit_is_logged_as_a_warning(client, caplog, monkeypatch):  # I27, plan §9
    caplog.set_level(logging.INFO)
    _, invite, ids = invited(client)
    monkeypatch.setattr(ti, "INVITE_LIMITER", RateLimiter(1))
    ti.INVITE_LIMITER.hit("testclient")
    assert answer(client, invite, attendee_id=ids["Ana"], answer="yes").status_code == 429
    [hit] = [r for r in caplog.records if "rate limited" in r.getMessage()]
    assert hit.levelno == logging.WARNING and invite not in hit.getMessage()


def test_deleting_the_trip_kills_the_invite(client, fake_store):  # I28
    slug, invite, ids = invited(client)
    assert photo(client, invite, ids["Ana"]).status_code == 204
    assert fake_store.objects
    assert client.request("DELETE", f"/sessions/{slug}", json={"name": TRIP["name"]}).status_code == 204
    assert client.get(f"/invites/{invite}").status_code == 404
    assert fake_store.objects == {}, "photos go with the trip"
