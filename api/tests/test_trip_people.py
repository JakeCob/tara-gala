"""TG-58 PR 1: a trip's list of people, the arrival check at the first meet-up, and profile photos. Storage is the same
in-memory stand-in as test_trip_files.py. Names are made up. The ids (A1 and so on) are test-plan.md's.
"""

import asyncio
import logging
import re
from datetime import date, datetime, timedelta, timezone
from uuid import uuid4

import psycopg
import pytest
from psycopg.rows import dict_row
from starlette.requests import Request

from app import sessions as s
from app import trip_files as tf
from app.limits import RateLimiter
from conftest import ROOT
from test_guide import barkada, trip as guide_trip  # noqa: F401  fixtures
from test_trip_files import JPEG, PNG, TRIP, fake_store, trip_with_wallet, upload  # noqa: F401  fake_store is an autouse fixture

MIGRATION = ROOT / "supabase" / "migrations" / "2026-11-03_tg58_attendees.sql"
ATTENDEE_KEYS = {"id", "name", "rsvp", "rsvp_at", "arrived_at"}
UTC = timezone.utc


def new_trip(client) -> str:
    return client.post("/sessions", json=TRIP).json()["share_slug"]


def add(client, slug, name):
    return client.post(f"/sessions/{slug}/attendees", json={"name": name})


def person(client, slug, name="Ana") -> str:
    r = add(client, slug, name)
    assert r.status_code == 201, r.text
    return next(a["id"] for a in r.json()["attendees"] if a["name"] == name)


def people(client, slug) -> list[dict]:
    return client.get(f"/sessions/{slug}").json()["attendees"]


def one(client, slug, attendee_id) -> dict:
    return next(a for a in people(client, slug) if a["id"] == attendee_id)


def avatar(client, slug, attendee_id, data=PNG, content_type="image/png"):
    return upload(client, slug, data, content_type, kind="avatar", attendee_id=attendee_id)


def rows(dsn, sql, *args) -> list[dict]:
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        return conn.execute(sql, args).fetchall()


def wallet_dump(dsn) -> list[dict]:
    return rows(dsn, "select * from wallet_members order by seq")


def at(iso: str) -> datetime:
    return datetime.fromisoformat(iso.replace("Z", "+00:00"))


def image(size: int, head: bytes = PNG) -> bytes:
    return head + b"\x00" * (size - len(head))


def schema_shape(dsn) -> list:
    return [
        rows(dsn, "select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' order by 1, 2"),
        rows(dsn, "select conrelid::regclass::text as t, conname, pg_get_constraintdef(oid) as d from pg_constraint where connamespace = 'public'::regnamespace order by 1, 2"),
        rows(dsn, "select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by 1, 2"),
    ]


# ---------------------------------------------------------------- tables

def test_migration_is_a_no_op_on_schema_sql(dsn):  # A1
    before = schema_shape(dsn)
    sql = MIGRATION.read_text(encoding="utf-8")
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(sql)
        conn.execute(sql)
    assert schema_shape(dsn) == before


def test_tables_and_rls(dsn):  # A2
    columns = {(r["table_name"], r["column_name"]) for r in rows(dsn, "select table_name, column_name from information_schema.columns where table_schema = 'public'")}
    assert {("session_attendees", "name"), ("trip_sessions", "invite_slug"), ("session_files", "attendee_id")} <= columns
    indexes = {r["indexname"] for r in rows(dsn, "select indexname from pg_indexes where schemaname = 'public'")}
    assert {"session_attendees_name", "session_files_one_avatar"} <= indexes
    assert rows(dsn, "select relrowsecurity from pg_class where relname = 'session_attendees'") == [{"relrowsecurity": True}]
    assert rows(dsn, "select 1 from pg_policies where tablename = 'session_attendees'") == []


def test_constraints_refuse_bad_rows(dsn):  # A3
    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        sid = conn.execute("insert into trip_sessions (name, start_date, return_date) values ('T', '2026-11-06', '2026-11-08') returning id").fetchone()["id"]
        aid = conn.execute("insert into session_attendees (session_id, name) values (%s, 'ñora') returning id", (sid,)).fetchone()["id"]

        def file(kind, attendee):
            conn.execute(
                "insert into session_files (session_id, kind, attendee_id, storage_path, content_type, bytes) values (%s, %s, %s, %s, 'image/png', 1)",
                (sid, kind, attendee, str(uuid4())),
            )

        file("avatar", aid)
        bad = [
            (psycopg.errors.CheckViolation, "insert into session_attendees (session_id, name) values (%s, %s)", (sid, "x" * 31)),
            (psycopg.errors.CheckViolation, "insert into session_attendees (session_id, name, rsvp) values (%s, 'B', 'maybe')", (sid,)),
            (psycopg.errors.CheckViolation, "insert into session_attendees (session_id, name, rsvp_at) values (%s, 'C', now())", (sid,)),
            (psycopg.errors.CheckViolation, "insert into session_attendees (session_id, name, rsvp) values (%s, 'D', 'yes')", (sid,)),
            (psycopg.errors.UniqueViolation, "insert into session_attendees (session_id, name) values (%s, 'ÑORA')", (sid,)),
            (psycopg.errors.CheckViolation, "update trip_sessions set invite_slug = 'nope' where id = %s", (sid,)),
        ]
        for error, sql, args in bad:
            with pytest.raises(error):
                conn.execute(sql, args)
        with pytest.raises(psycopg.errors.CheckViolation):
            file("avatar", None)
        with pytest.raises(psycopg.errors.CheckViolation):
            file("photo", aid)
        with pytest.raises(psycopg.errors.UniqueViolation):
            file("avatar", aid)


# ---------------------------------------------------------------- the list

def test_add_a_name(client):  # A5
    slug = new_trip(client)
    first = add(client, slug, "Ben")
    assert first.status_code == 201, first.text
    add(client, slug, "Ana")
    got = people(client, slug)
    assert [a["name"] for a in got] == ["Ben", "Ana"], "in the order entered"
    assert all(a["rsvp"] == "pending" and a["rsvp_at"] is None and a["arrived_at"] is None for a in got)


def test_name_rules(client):  # A6
    slug = new_trip(client)
    assert add(client, slug, " Ana ").json()["attendees"][0]["name"] == "Ana"
    assert add(client, slug, "x" * 30).status_code == 201
    for name in ("x" * 31, "", "   "):
        assert add(client, slug, name).status_code == 422, repr(name)
    r = client.post(f"/sessions/{slug}/attendees", json={"name": "Ben", "rsvp": "yes"})
    assert r.status_code == 422, "an extra field"
    assert len(people(client, slug)) == 2


def test_name_taken_ignores_case(client):  # A7
    slug = new_trip(client)
    person(client, slug, "Ana")
    person(client, slug, "ñora")
    for name in ("ANA", "ÑORA"):
        r = add(client, slug, name)
        assert (r.status_code, r.json()["detail"]) == (409, "name_taken"), name
    assert len(people(client, slug)) == 2


def test_list_holds_30(client):  # A8
    from app.trip_people import MAX_ATTENDEES

    assert MAX_ATTENDEES == 30
    slug = new_trip(client)
    for n in range(30):
        assert add(client, slug, f"P{n}").status_code == 201
    r = add(client, slug, "One more")
    assert (r.status_code, r.json()["detail"]) == (409, "party_full")
    assert len(people(client, slug)) == 30


def test_copy_from_wallet_once(client, dsn):  # A9
    slug, _ = trip_with_wallet(client, members=("Jacob", "Ana", "Ben"))
    before = wallet_dump(dsn)
    r = client.post(f"/sessions/{slug}/attendees/from-wallet")
    assert r.status_code == 200, r.text
    assert [a["name"] for a in r.json()["attendees"]] == ["Jacob", "Ana", "Ben"], "in the wallet's order"
    assert all(a["rsvp"] == "pending" for a in r.json()["attendees"])
    again = client.post(f"/sessions/{slug}/attendees/from-wallet")
    assert again.status_code == 200 and len(again.json()["attendees"]) == 3, "a second tap adds nothing"
    assert wallet_dump(dsn) == before


def test_copy_skips_and_stops_at_the_cap(client):  # A10
    slug, _ = trip_with_wallet(client, members=("Ana", "Ben"))
    person(client, slug, "ana")
    r = client.post(f"/sessions/{slug}/attendees/from-wallet")
    assert [a["name"] for a in r.json()["attendees"]] == ["ana", "Ben"]

    full, _ = trip_with_wallet(client, members=[f"W{n}" for n in range(8)])
    for n in range(25):
        person(client, full, f"P{n}")
    r = client.post(f"/sessions/{full}/attendees/from-wallet")
    assert r.status_code == 200, r.text
    assert [a["name"] for a in r.json()["attendees"]][25:] == ["W0", "W1", "W2", "W3", "W4"], "stops at 30, with no error"


def test_copy_needs_a_wallet(client):  # A11
    r = client.post(f"/sessions/{new_trip(client)}/attendees/from-wallet")
    assert (r.status_code, r.json()["detail"]) == (422, "no_wallet")


def test_set_an_answer(client):  # A12
    slug = new_trip(client)
    aid = person(client, slug)
    url = f"/sessions/{slug}/attendees/{aid}"
    for answer in ("yes", "no"):
        got = next(a for a in client.patch(url, json={"rsvp": answer}).json()["attendees"] if a["id"] == aid)
        assert got["rsvp"] == answer and got["rsvp_at"] is not None
    got = next(a for a in client.patch(url, json={"rsvp": "pending"}).json()["attendees"] if a["id"] == aid)
    assert got["rsvp"] == "pending" and got["rsvp_at"] is None
    for body in ({"rsvp": "maybe"}, {}):
        assert client.patch(url, json=body).status_code == 422, body


def routes(slug, aid):
    """Every route that names a person, as (method, url, json)."""
    base = f"/sessions/{slug}/attendees/{aid}"
    return [("PATCH", base, {"rsvp": "yes"}), ("DELETE", base, None), ("PUT", f"{base}/arrival", {}), ("DELETE", f"{base}/arrival", None)]


def test_unknown_attendee_is_422_on_every_route(client):  # A13
    slug, other = new_trip(client), new_trip(client)
    theirs = person(client, other)
    for aid in (uuid4(), theirs):
        for method, url, body in routes(slug, aid):
            r = client.request(method, url, json=body)
            assert (r.status_code, r.json()["detail"]) == (422, "unknown_attendee"), (method, url)
        r = avatar(client, slug, aid)
        assert (r.status_code, r.json()["detail"]) == (422, "unknown_attendee")
    got = one(client, other, theirs)
    assert (got["rsvp"], got["arrived_at"]) == ("pending", None), "the other trip is unchanged"


def test_bad_trip_slug_is_404(client):  # A14
    calls = routes("0" * 32, uuid4()) + [("POST", f"/sessions/{'0' * 32}/attendees", {"name": "Ana"}), ("POST", f"/sessions/{'0' * 32}/attendees/from-wallet", None)]
    calls += routes("nope", uuid4())
    for method, url, body in calls:
        r = client.request(method, url, json=body)
        assert (r.status_code, r.json()["detail"]) == (404, "Trip not found"), (method, url)
        assert r.headers["x-robots-tag"] == "noindex"


def test_remove_takes_row_file_and_bytes(client, dsn, fake_store):  # A15
    slug, _ = trip_with_wallet(client)
    aid = person(client, slug)
    person(client, slug, "Ben")
    assert avatar(client, slug, aid).status_code == 201
    before = wallet_dump(dsn)
    r = client.delete(f"/sessions/{slug}/attendees/{aid}")
    assert r.status_code == 200, r.text
    assert [a["name"] for a in r.json()["attendees"]] == ["Ben"]
    assert r.json()["files"] == []
    assert fake_store.objects == {}, "the bytes go too"
    assert rows(dsn, "select 1 from session_files") == []
    assert wallet_dump(dsn) == before


def test_remove_survives_storage_failure(client, fake_store, caplog):  # A16
    caplog.set_level(logging.INFO, logger="tara_gala.api")
    slug = new_trip(client)
    aid = person(client, slug)
    avatar(client, slug, aid)
    fake_store.fail = True
    r = client.delete(f"/sessions/{slug}/attendees/{aid}")
    assert r.status_code == 200, r.text
    assert r.json()["attendees"] == []
    assert any(x.levelno == logging.WARNING and "storage cleanup failed" in x.getMessage() for x in caplog.records)


def test_remove_with_no_photo_skips_storage(client, fake_store, monkeypatch):  # A17
    slug = new_trip(client)
    aid = person(client, slug)
    calls = []
    monkeypatch.setattr(fake_store, "delete", calls.append)
    assert client.delete(f"/sessions/{slug}/attendees/{aid}").status_code == 200
    assert calls == []


# ---------------------------------------------------------------- arrival

def tap(client, slug, aid, **body):
    return client.put(f"/sessions/{slug}/attendees/{aid}/arrival", json=body)


def arrived(client, slug, aid) -> str | None:
    return one(client, slug, aid)["arrived_at"]


def test_tap_stores_the_server_time(client):  # A18
    slug = new_trip(client)
    aid = person(client, slug)
    before = datetime.now(UTC) - timedelta(seconds=2)
    assert tap(client, slug, aid).status_code == 200
    after = datetime.now(UTC) + timedelta(seconds=2)
    assert before <= at(arrived(client, slug, aid)) <= after


def test_second_tap_keeps_the_first_time(client):  # A19
    slug = new_trip(client)
    aid = person(client, slug)
    tap(client, slug, aid)
    first = arrived(client, slug, aid)
    assert tap(client, slug, aid).status_code == 200
    assert arrived(client, slug, aid) == first


def test_tap_after_undo_is_a_new_time(client):  # A20
    slug = new_trip(client)
    aid = person(client, slug)
    tap(client, slug, aid)
    first = arrived(client, slug, aid)
    client.delete(f"/sessions/{slug}/attendees/{aid}/arrival")
    tap(client, slug, aid)
    assert at(arrived(client, slug, aid)) > at(first)


def test_correction_is_manila_wall_time(client):  # A21
    slug = new_trip(client)
    aid = person(client, slug)
    tap(client, slug, aid)
    r = tap(client, slug, aid, at="2026-11-06T09:40:00")
    assert r.status_code == 200, r.text
    assert at(arrived(client, slug, aid)) == datetime(2026, 11, 6, 1, 40, tzinfo=UTC), "overwrites, read as Manila time"


def test_correction_refuses_an_offset(client):  # A22
    slug = new_trip(client)
    aid = person(client, slug)
    tap(client, slug, aid, at="2026-11-06T09:40:00")
    stored = arrived(client, slug, aid)
    for bad in ("2026-11-06T09:41:00+08:00", "2026-11-06T09:41:00Z", "not-a-time"):
        assert tap(client, slug, aid, at=bad).status_code == 422, bad
    assert arrived(client, slug, aid) == stored


def test_clear_arrival(client):  # A23
    slug = new_trip(client)
    aid = person(client, slug)
    tap(client, slug, aid)
    url = f"/sessions/{slug}/attendees/{aid}/arrival"
    assert client.delete(url).status_code == 200
    assert arrived(client, slug, aid) is None
    assert client.delete(url).status_code == 200, "clearing twice is fine"


def test_arrival_and_ticks_are_separate(guide_trip, client):  # A24
    aid = person(client, guide_trip)
    assert tap(client, guide_trip, aid).status_code == 200
    assert client.get(f"/sessions/{guide_trip}").json()["marks"] == [], "a tap ticks nothing"
    client.delete(f"/sessions/{guide_trip}/attendees/{aid}/arrival")
    assert client.put(f"/sessions/{guide_trip}/marks/row:d1-01", json={"value": "done"}).status_code == 200
    assert arrived(client, guide_trip, aid) is None, "a tick marks nobody here"


# ---------------------------------------------------------------- the shape, limits and logs

def test_session_shape(client):  # A25
    slug = new_trip(client)
    assert client.get(f"/sessions/{slug}").json()["attendees"] == [], "a new trip has an empty list"
    aid = person(client, slug)
    avatar(client, slug, aid)
    upload(client, slug, kind="ticket", label="Bus")
    trip = client.get(f"/sessions/{slug}").json()
    assert set(trip["attendees"][0]) == ATTENDEE_KEYS
    by_kind = {f["kind"]: f for f in trip["files"]}
    assert by_kind["avatar"]["attendee_id"] == aid
    assert "attendee_id" in by_kind["ticket"] and by_kind["ticket"]["attendee_id"] is None
    assert "invite_slug" not in trip, "PR 2 adds it"


def test_writes_return_the_trip_privately(client):  # A26
    slug, _ = trip_with_wallet(client)
    aid = person(client, slug)
    first = add(client, slug, "Ben")
    copied = client.post(f"/sessions/{slug}/attendees/from-wallet")
    calls = [first, copied] + [client.request(m, u, json=b) for m, u, b in reversed(routes(slug, aid))]
    for r in calls:
        assert r.status_code in (200, 201), r.text
        assert r.headers["cache-control"] == "private, no-cache"
        assert r.headers["x-robots-tag"] == "noindex"
        assert r.json()["share_slug"] == slug and "attendees" in r.json()


def test_writes_are_rate_limited(client, monkeypatch):  # A27
    slug, _ = trip_with_wallet(client)
    aid = person(client, slug)
    calls = routes(slug, aid)[:1] + routes(slug, aid)[2:] + [("POST", f"/sessions/{slug}/attendees", {"name": "Ben"}), ("POST", f"/sessions/{slug}/attendees/from-wallet", None)]
    for method, url, body in calls:
        monkeypatch.setattr(s, "WRITE_LIMITER", RateLimiter(1))
        s.WRITE_LIMITER.hit("testclient")
        r = client.request(method, url, json=body)
        assert r.status_code == 429, (method, url)
    monkeypatch.setattr(s, "WRITE_LIMITER", RateLimiter(1))
    s.WRITE_LIMITER.hit("testclient")
    r = client.patch(f"/sessions/{slug}/attendees/{uuid4()}", json={"rsvp": "yes"})
    assert r.status_code == 429, "ahead of the person check"


def test_logs_carry_no_names_or_times(client, caplog):  # A28
    caplog.set_level(logging.INFO)
    slug, _ = trip_with_wallet(client, members=("Zsazsa", "Quentin"))
    client.post(f"/sessions/{slug}/attendees/from-wallet")
    aid = person(client, slug, "Xenia")
    add(client, slug, "xenia")  # name_taken
    client.patch(f"/sessions/{slug}/attendees/{aid}", json={"rsvp": "yes"})
    tap(client, slug, aid)
    tap(client, slug, aid, at="2026-11-06T09:47:00")
    client.delete(f"/sessions/{slug}/attendees/{aid}/arrival")
    client.delete(f"/sessions/{slug}/attendees/{uuid4()}")  # unknown_attendee
    client.delete(f"/sessions/{slug}/attendees/{aid}")
    client.post(f"/sessions/{new_trip(client)}/attendees/from-wallet")  # no_wallet
    full = new_trip(client)
    for n in range(30):
        person(client, full, f"Yolanda{n}")
    add(client, full, "Wilhelmina")  # party_full
    text = "\n".join(r.getMessage() for r in caplog.records)
    for action in ("attendee-add", "attendee-copy", "attendee-answer", "attendee-remove", "arrival-set", "arrival-fix", "arrival-clear"):
        assert f"session {action} share_slug=" in text, action
    assert "attendees=" in text
    assert f"trip attendee copy share_slug={slug} added=2 skipped=0" in text
    for reason in ("name_taken", "party_full", "unknown_attendee", "no_wallet"):
        assert f"trip attendee refused share_slug=" in text and f"reason={reason}" in text, reason
    for secret in ("Zsazsa", "Quentin", "Xenia", "xenia", "Yolanda", "Wilhelmina", "09:47", "T01:47", "01:47"):
        assert secret not in text, secret


def test_no_code_writes_to_the_wallet():  # A29
    source = (ROOT / "api" / "app" / "trip_people.py").read_text(encoding="utf-8").lower()
    assert not re.search(r"(insert\s+into|update|delete\s+from)\s+wallet_members", source)


# ---------------------------------------------------------------- photos

def test_avatar_upload(client, fake_store):  # A30
    slug = new_trip(client)
    aid = person(client, slug)
    r = avatar(client, slug, aid)
    assert r.status_code == 201, r.text
    [f] = r.json()["files"]
    assert (f["kind"], f["attendee_id"], f["delete_after"], f["label"]) == ("avatar", aid, None, "")
    assert len(fake_store.objects) == 1


def test_new_avatar_replaces_the_old(client, dsn, fake_store):  # A31
    slug = new_trip(client)
    aid = person(client, slug)
    avatar(client, slug, aid)
    r = avatar(client, slug, aid, JPEG, "image/jpeg")
    assert r.status_code == 201, r.text
    assert [f["content_type"] for f in r.json()["files"]] == ["image/jpeg"]
    assert len(rows(dsn, "select 1 from session_files")) == 1
    assert [d for d, _ in fake_store.objects.values()] == [JPEG], "the old bytes are gone"


def test_failed_replace_keeps_the_old_avatar(client, fake_store):  # A32
    slug = new_trip(client)
    aid = person(client, slug)
    [old] = avatar(client, slug, aid).json()["files"]
    fake_store.fail = True
    r = avatar(client, slug, aid, JPEG, "image/jpeg")
    assert (r.status_code, r.json()["detail"]) == (503, "storage_unavailable")
    fake_store.fail = False
    assert [f["id"] for f in client.get(f"/sessions/{slug}").json()["files"]] == [old["id"]]
    assert client.get(f"/sessions/{slug}/files/{old['id']}").content == PNG


def test_remove_photo_keeps_the_person(client, fake_store):  # A33
    slug = new_trip(client)
    aid = person(client, slug)
    [f] = avatar(client, slug, aid).json()["files"]
    r = client.delete(f"/sessions/{slug}/files/{f['id']}")
    assert r.status_code == 200, r.text
    assert r.json()["files"] == [] and fake_store.objects == {}
    assert [a["id"] for a in r.json()["attendees"]] == [aid]


def test_avatar_and_person_go_together(client, fake_store):  # A34
    slug = new_trip(client)
    aid = person(client, slug)
    for params in ({"kind": "avatar"}, {"kind": "ticket", "label": "Bus", "attendee_id": aid}, {"kind": "photo", "attendee_id": aid}):
        r = upload(client, slug, **params)
        assert (r.status_code, r.json()["detail"]) == (422, "unknown_attendee"), params
    assert fake_store.objects == {}, "no put"


def test_avatar_size_limit(client):  # A35
    assert tf.MAX_AVATAR_BYTES == 200_000
    slug = new_trip(client)
    aid = person(client, slug)
    assert avatar(client, slug, aid, image(200_000)).status_code == 201

    def stream(data):
        yield data

    url = f"/sessions/{slug}/files"
    params = {"kind": "avatar", "attendee_id": aid}
    r = client.post(url, params=params, content=image(200_001), headers={"content-type": "image/png"})
    assert (r.status_code, r.json()["detail"]) == (413, "too_big"), "an honest Content-Length"
    r = client.post(url, params=params, content=stream(image(200_001)), headers={"content-type": "image/png"})
    assert (r.status_code, r.json()["detail"]) == (413, "too_big"), "no Content-Length"
    assert upload(client, slug, image(200_001), kind="ticket", label="Bus").status_code == 201, "a ticket keeps its 5 MB"


def test_body_stops_being_read_at_the_limit():  # F6: a chunked body with no Content-Length isn't read whole
    sent = []

    async def receive():
        sent.append(1)
        return {"type": "http.request", "body": b"\x00" * 1000, "more_body": len(sent) < 100}

    request = Request({"type": "http", "method": "POST", "path": "/", "headers": [(b"content-type", b"image/png")]}, receive)
    with pytest.raises(tf.HTTPException) as e:
        asyncio.run(tf.image_body(request, "0" * 32, "avatar", limit=2500))
    assert (e.value.status_code, e.value.detail) == (413, "too_big")
    assert len(sent) == 3, "stops at the chunk that passes the limit"


def test_avatar_must_be_an_image(client):  # A36
    slug = new_trip(client)
    aid = person(client, slug)
    for data, content_type in ((b"hello", "image/png"), (PNG, "image/jpeg")):
        r = avatar(client, slug, aid, data, content_type)
        assert (r.status_code, r.json()["detail"]) == (422, "not_an_image")


def test_sweep_leaves_avatars(client, dsn, fake_store):  # A37
    slug = new_trip(client)
    aid = person(client, slug)
    upload(client, slug, kind="ticket", label="Bus")
    avatar(client, slug, aid, JPEG, "image/jpeg")
    assert tf.sweep(date(2026, 12, 25)) == 1
    assert [r["kind"] for r in rows(dsn, "select kind from session_files")] == ["avatar"]
    assert [d for d, _ in fake_store.objects.values()] == [JPEG]


def test_new_dates_leave_avatars(client):  # A38
    slug = new_trip(client)
    aid = person(client, slug)
    avatar(client, slug, aid)
    upload(client, slug, kind="ticket", label="Bus")
    r = client.patch(f"/sessions/{slug}", json={"return_date": "2026-11-09"})
    assert r.status_code == 200, r.text
    after = {f["kind"]: f["delete_after"] for f in r.json()["files"]}
    assert after == {"avatar": None, "ticket": "2026-11-23"}


def test_deleting_the_trip_takes_everything(client, dsn, fake_store):  # A39
    slug = new_trip(client)
    aid = person(client, slug)
    avatar(client, slug, aid)
    r = client.request("DELETE", f"/sessions/{slug}", json={"name": TRIP["name"]})
    assert r.status_code == 204, r.text
    assert rows(dsn, "select 1 from session_attendees") == [] and rows(dsn, "select 1 from session_files") == []
    assert fake_store.objects == {}


def test_caps_are_separate(client):  # A40
    slug = new_trip(client)
    for n in range(30):
        assert upload(client, slug, kind="ticket", label=f"T{n}").status_code == 201
    assert upload(client, slug, kind="ticket", label="One more").json()["detail"] == "too_many_tickets"
    assert avatar(client, slug, person(client, slug)).status_code == 201, "tickets don't block a photo"

    other = new_trip(client)
    for n in range(30):
        assert avatar(client, other, person(client, other, f"P{n}")).status_code == 201
    assert upload(client, other, kind="ticket", label="Bus").status_code == 201, "photos don't block a ticket"


def test_avatar_is_served_only_by_the_trip(client, fake_store):  # A41
    slug, other = new_trip(client), new_trip(client)
    aid = person(client, slug)
    r = avatar(client, slug, aid)
    [f] = r.json()["files"]
    got = client.get(f"/sessions/{slug}/files/{f['id']}")
    assert got.status_code == 200 and got.content == PNG
    assert got.headers["cache-control"] == "private, no-cache"
    assert got.headers["x-content-type-options"] == "nosniff"
    assert client.get(f"/sessions/{other}/files/{f['id']}").status_code == 404
    [path] = fake_store.objects
    assert "storage_path" not in r.text and path not in r.text
    assert path not in client.get(f"/sessions/{slug}").text
