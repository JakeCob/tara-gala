"""TG-52 PR 2: files a trip's party shares (tickets, payout QRs, the hotel's screenshot). Storage is an in-memory
stand-in here; the real one is Supabase Storage (app/storage.py). Names and labels are made up.
"""

import logging
from datetime import date

import psycopg
import pytest

from app import storage, trip_files as tf
from app import sessions as s
from app.limits import RateLimiter
from conftest import ROOT

MIGRATION = ROOT / "supabase" / "migrations" / "2026-11-02_tg52_session_files.sql"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
WEBP = b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x00" * 64
TRIP = {"name": "Baguio Nov 6", "start_date": "2026-11-06", "return_date": "2026-11-08"}


class FakeStore:
    def __init__(self):
        self.objects: dict[str, tuple[bytes, str]] = {}
        self.fail = False

    def put(self, path, data, content_type):
        if self.fail:
            raise storage.StorageError("put")
        self.objects[path] = (data, content_type)

    def get(self, path):
        if self.fail or path not in self.objects:
            raise storage.StorageError("get")
        return self.objects[path][0]

    def delete(self, paths):
        if self.fail:
            raise storage.StorageError("delete")
        for p in paths:
            self.objects.pop(p, None)


@pytest.fixture(autouse=True)
def fake_store(monkeypatch):
    import app.main

    monkeypatch.setattr(app.main, "start_sweeper", lambda stop: None)  # no background thread in tests
    monkeypatch.setattr(tf, "UPLOAD_LIMITER", RateLimiter(tf.UPLOADS_PER_HOUR))
    monkeypatch.setattr(s, "CREATE_LIMITER", RateLimiter(s.CREATE_PER_HOUR))
    monkeypatch.setattr(s, "WRITE_LIMITER", RateLimiter(s.WRITES_PER_HOUR))
    from app import wallets

    monkeypatch.setattr(wallets, "CREATE_LIMITER", RateLimiter(wallets.CREATE_PER_HOUR))  # trips here make wallets too
    fake = FakeStore()
    storage.set_store(fake)
    yield fake
    storage.set_store(None)


def trip_with_wallet(client, members=("Jacob", "Ana")):
    trip = client.post("/sessions", json=TRIP).json()
    wallet = client.post("/wallets", json={"name": "Baguio", "members": list(members)}).json()
    client.put(f"/sessions/{trip['share_slug']}/wallet", json={"share_slug": wallet["share_slug"]})
    return trip["share_slug"], {m["name"]: m["id"] for m in wallet["members"]}


def upload(client, slug, data=PNG, content_type="image/png", **params):
    return client.post(f"/sessions/{slug}/files", params=params, content=data, headers={"content-type": content_type})


def test_a_ticket_is_stored_privately_listed_on_the_trip_and_served_under_its_link(client, fake_store):
    slug, _ = trip_with_wallet(client)
    r = upload(client, slug, kind="ticket", label="  Victory Liner Nov 6  ")
    assert r.status_code == 201, r.text
    [f] = r.json()["files"]
    assert (f["kind"], f["label"], f["content_type"], f["bytes"]) == ("ticket", "Victory Liner Nov 6", "image/png", len(PNG))
    assert f["delete_after"] == "2026-11-22", "14 days after the trip comes home"
    [(path, (data, ctype))] = fake_store.objects.items()
    assert data == PNG and ctype == "image/png"
    assert "Victory" not in path and slug not in path, "the object path carries no label or slug"
    got = client.get(f"/sessions/{slug}/files/{f['id']}")
    assert got.status_code == 200 and got.content == PNG
    assert got.headers["content-type"] == "image/png"
    assert got.headers["cache-control"] == "private, no-cache"
    assert got.headers["x-content-type-options"] == "nosniff"
    assert client.get(f"/sessions/{slug}").json()["files"] == [f]


def test_a_file_is_only_reachable_through_its_own_trip(client):
    slug, _ = trip_with_wallet(client)
    other, _ = trip_with_wallet(client)
    fid = upload(client, slug, kind="ticket", label="Mine").json()["files"][0]["id"]
    assert client.get(f"/sessions/{other}/files/{fid}").status_code == 404
    assert client.delete(f"/sessions/{other}/files/{fid}").status_code == 404
    assert client.get(f"/sessions/{'0' * 32}/files/{fid}").status_code == 404


@pytest.mark.parametrize(
    "data,content_type,params,detail",
    [
        (b"hello", "image/png", {"kind": "ticket", "label": "x"}, "not_an_image"),
        (JPEG, "image/png", {"kind": "ticket", "label": "x"}, "not_an_image"),  # says PNG, is JPEG
        (b"%PDF-1.7", "application/pdf", {"kind": "ticket", "label": "x"}, "not_an_image"),
        (PNG, "image/png", {"kind": "ticket", "label": ""}, "bad_label"),
        (PNG, "image/png", {"kind": "ticket", "label": "x" * 41}, "bad_label"),
        (PNG, "image/png", {"kind": "photo"}, "bad_kind"),
        (PNG, "image/png", {"kind": "payout_qr"}, "unknown_member"),
    ],
)
def test_uploads_are_checked(client, data, content_type, params, detail):
    slug, _ = trip_with_wallet(client)
    r = upload(client, slug, data=data, content_type=content_type, **params)
    assert r.status_code == 422 and r.json()["detail"] == detail


def test_too_big_is_413(client, monkeypatch):
    slug, _ = trip_with_wallet(client)
    monkeypatch.setattr(tf, "MAX_BYTES", 32)
    r = upload(client, slug, kind="ticket", label="Big")
    assert r.status_code == 413 and r.json()["detail"] == "too_big"


def test_jpeg_and_webp_are_accepted(client):
    slug, _ = trip_with_wallet(client)
    assert upload(client, slug, data=JPEG, content_type="image/jpeg", kind="ticket", label="A").status_code == 201
    assert upload(client, slug, data=WEBP, content_type="image/webp", kind="ticket", label="B").status_code == 201


def test_one_payout_qr_per_wallet_member_replacing_the_old_one(client, fake_store):
    slug, m = trip_with_wallet(client)
    first = upload(client, slug, kind="payout_qr", member_id=m["Ana"]).json()["files"]
    assert [(f["kind"], f["member_id"], f["label"]) for f in first] == [("payout_qr", m["Ana"], "")]
    second = upload(client, slug, data=JPEG, content_type="image/jpeg", kind="payout_qr", member_id=m["Ana"]).json()["files"]
    assert len(second) == 1 and second[0]["id"] != first[0]["id"] and second[0]["content_type"] == "image/jpeg"
    assert len(fake_store.objects) == 1, "the old QR's bytes are gone too"
    assert len(upload(client, slug, kind="payout_qr", member_id=m["Jacob"]).json()["files"]) == 2


def test_a_payout_qr_needs_someone_in_the_trips_wallet(client):
    slug, _ = trip_with_wallet(client)
    _, outsiders = trip_with_wallet(client, members=("Zed",))
    r = upload(client, slug, kind="payout_qr", member_id=outsiders["Zed"])
    assert r.status_code == 422 and r.json()["detail"] == "unknown_member"
    lone = client.post("/sessions", json=TRIP).json()["share_slug"]
    r = upload(client, lone, kind="payout_qr", member_id=outsiders["Zed"])
    assert r.status_code == 422, "no wallet, no payout QRs"


def test_one_hotel_screenshot_replacing_the_old_one(client):
    slug, _ = trip_with_wallet(client)
    upload(client, slug, kind="hotel_proof", label="ignored")
    files = upload(client, slug, data=JPEG, content_type="image/jpeg", kind="hotel_proof").json()["files"]
    assert [(f["kind"], f["label"], f["content_type"]) for f in files] == [("hotel_proof", "", "image/jpeg")]


def test_tickets_stop_at_30(client, monkeypatch):
    slug, _ = trip_with_wallet(client)
    monkeypatch.setattr(tf, "MAX_TICKETS", 2)
    upload(client, slug, kind="ticket", label="1")
    upload(client, slug, kind="ticket", label="2")
    r = upload(client, slug, kind="ticket", label="3")
    assert r.status_code == 422 and r.json()["detail"] == "too_many_tickets"


def test_delete_a_file_removes_its_row_and_bytes(client, fake_store):
    slug, _ = trip_with_wallet(client)
    fid = upload(client, slug, kind="ticket", label="Gone").json()["files"][0]["id"]
    r = client.delete(f"/sessions/{slug}/files/{fid}")
    assert r.status_code == 200 and r.json()["files"] == []
    assert fake_store.objects == {}
    assert client.get(f"/sessions/{slug}/files/{fid}").status_code == 404


def test_storage_down_is_503_and_saves_nothing(client, fake_store):
    slug, _ = trip_with_wallet(client)
    fake_store.fail = True
    r = upload(client, slug, kind="ticket", label="X")
    assert r.status_code == 503 and r.json()["detail"] == "storage_unavailable"
    fake_store.fail = False
    assert client.get(f"/sessions/{slug}").json()["files"] == []


def test_storage_off_is_503(client):
    storage.set_store(None)
    slug, _ = trip_with_wallet(client)
    r = upload(client, slug, kind="ticket", label="X")
    assert r.status_code == 503


def test_moving_the_trip_home_moves_the_deadline(client):
    slug, m = trip_with_wallet(client)
    upload(client, slug, kind="ticket", label="T")
    upload(client, slug, kind="payout_qr", member_id=m["Ana"])
    files = client.patch(f"/sessions/{slug}", json={"return_date": "2026-11-10"}).json()["files"]
    assert {f["delete_after"] for f in files} == {"2026-11-24"}


def test_deleting_the_trip_deletes_its_files_and_bytes(client, fake_store, dsn):
    slug, m = trip_with_wallet(client)
    upload(client, slug, kind="ticket", label="T")
    upload(client, slug, kind="payout_qr", member_id=m["Ana"])
    assert len(fake_store.objects) == 2
    assert client.request("DELETE", f"/sessions/{slug}", json={"name": "Baguio Nov 6"}).status_code == 204
    assert fake_store.objects == {}
    with psycopg.connect(dsn) as conn:
        assert conn.execute("select count(*) from session_files").fetchone()[0] == 0


def test_the_sweep_deletes_only_files_past_their_deadline(client, fake_store):
    slug, m = trip_with_wallet(client)
    upload(client, slug, kind="ticket", label="T")
    upload(client, slug, kind="payout_qr", member_id=m["Ana"])
    assert tf.sweep(date(2026, 11, 22)) == 0, "the deadline day itself keeps them"
    assert tf.sweep(date(2026, 11, 23)) == 2
    assert fake_store.objects == {}
    assert client.get(f"/sessions/{slug}").json()["files"] == []


def test_logs_carry_kind_and_size_never_labels(client, caplog):
    caplog.set_level(logging.INFO, logger="tara_gala.api")
    slug, m = trip_with_wallet(client)
    upload(client, slug, kind="ticket", label="Victory Liner Jacob")
    assert f"trip file add share_slug={slug} kind=ticket bytes={len(PNG)}" in caplog.text
    assert "Victory Liner Jacob" not in caplog.text


def test_files_table_is_private_and_the_migration_reruns(dsn):
    sql = MIGRATION.read_text(encoding="utf-8")
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(sql)
        conn.execute(sql)
        assert conn.execute("select relrowsecurity from pg_class where relname = 'session_files'").fetchone()[0]
        assert conn.execute("select count(*) from pg_policies where tablename = 'session_files'").fetchone()[0] == 0
        conn.execute("drop table session_files")
        conn.execute(sql)
        assert conn.execute("select count(*) from pg_class where relname = 'session_files'").fetchone()[0] == 1
