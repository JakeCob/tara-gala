"""TG-53 payment proofs: one screenshot on a settlement, stored privately, deleted by the hourly sweep.

Storage is an in-memory stand-in (the real one is Supabase Storage, app/storage.py). Names, notes and pictures are
made up. Test ids (A1 to A47) are from tickets/TG-53/test-plan.md.

`wallet_proofs` is only reached inside the fixture and the tests, never at module top, so that before the feature
exists each test fails on its own instead of the whole file failing to collect (test-plan section 3).
"""

import logging
import re
import subprocess
import sys
import threading
from contextlib import contextmanager
from datetime import date
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg.rows import dict_row

from app import db, sessions, storage, trip_files as tf, wallets
from app.limits import RateLimiter
from conftest import ROOT
from test_trip_files import FakeStore

API = ROOT / "api"
MIGRATION = ROOT / "supabase" / "migrations" / "2026-11-02_tg53_settlement_proofs.sql"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
PNG2 = b"\x89PNG\r\n\x1a\n" + b"\x01" * 80
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
WEBP = b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x00" * 64
GIF = b"GIF89a" + b"\x00" * 64
LIMIT = 5242880
MEMBERS = ("Jacob", "Ana", "Ben")
TRIP = {"name": "Baguio Nov 6", "start_date": "2026-11-06", "return_date": "2026-11-08"}
SETTLEMENT_COLUMNS = {
    "id": "uuid",
    "wallet_id": "uuid",
    "from_member": "uuid",
    "to_member": "uuid",
    "amount_centavos": "integer",
    "created_at": "timestamp with time zone",
    "proof_path": "text",
    "proof_type": "text",
    "proof_bytes": "integer",
    "proof_at": "timestamp with time zone",
}
OBJECT_PATH = re.compile(r"wallets/[0-9a-f-]{36}/[0-9a-f-]{36}")


class ProofStore(FakeStore):
    """FakeStore plus separate put and delete failures, a put counter, and hooks that run inside those calls."""

    def __init__(self):
        super().__init__()
        self.fail_put = False
        self.fail_delete = False
        self.puts = 0
        self.on_put = None
        self.on_delete = None

    def put(self, path, data, content_type):
        self.puts += 1
        if self.on_put:
            self.on_put(path)
        if self.fail_put:
            raise storage.StorageError("put")
        super().put(path, data, content_type)

    def delete(self, paths):
        if self.on_delete:
            self.on_delete(paths)
        if self.fail_delete:
            raise storage.StorageError("delete")
        super().delete(paths)


@pytest.fixture(autouse=True)
def store(monkeypatch):
    import app.main

    monkeypatch.setattr(app.main, "start_sweeper", lambda stop: None)  # no background thread in tests
    monkeypatch.setattr(wallets, "CREATE_LIMITER", RateLimiter(wallets.CREATE_PER_HOUR))
    monkeypatch.setattr(wallets, "WRITE_LIMITER", RateLimiter(wallets.WRITES_PER_HOUR))
    monkeypatch.setattr(sessions, "CREATE_LIMITER", RateLimiter(sessions.CREATE_PER_HOUR))
    monkeypatch.setattr(sessions, "WRITE_LIMITER", RateLimiter(sessions.WRITES_PER_HOUR))
    monkeypatch.setattr(tf, "UPLOAD_LIMITER", RateLimiter(tf.UPLOADS_PER_HOUR))
    try:
        from app import wallet_proofs
    except ImportError:  # RED: the module doesn't exist yet, and each test fails on its own for that
        wallet_proofs = None
    if wallet_proofs is not None:
        monkeypatch.setattr(wallet_proofs, "PROOF_LIMITER", RateLimiter(wallet_proofs.UPLOADS_PER_HOUR))
    fake = ProofStore()
    storage.set_store(fake)
    yield fake
    storage.set_store(None)


# ---------------------------------------------------------------- helpers

def sql(dsn, statement, params=None):
    """On its own connection, so a hook's work is real and commits at once. A lock held by the API can't hang the run."""
    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        conn.execute("set lock_timeout = '3s'")
        cur = conn.execute(statement, params)
        return cur.fetchall() if cur.description else None


def new_wallet(client, members=MEMBERS, note="Lodging"):
    """A wallet where the first person paid ₱900 split equally, so everyone else owes them."""
    r = client.post("/wallets", json={"name": "Baguio Nov 6", "members": list(members)})
    assert r.status_code == 201, r.text
    wallet = r.json()
    people = {m["name"]: m["id"] for m in wallet["members"]}
    payer = people[members[0]]
    r = client.post(
        f"/wallets/{wallet['share_slug']}/expenses",
        json={"paid_by": payer, "amount_centavos": 90000, "note": note, "split_among": list(people.values())},
    )
    assert r.status_code == 201, r.text
    return wallet["share_slug"], people


def pay(client, slug, people, frm="Ana", to="Jacob", amount=30000):
    """Marks one payment and returns its id, the newest in the list."""
    r = client.post(f"/wallets/{slug}/settlements", json={"from_member": people[frm], "to_member": people[to], "amount_centavos": amount})
    assert r.status_code == 201, r.text
    return r.json()["settlements"][0]["id"]


def upload(client, slug, sid, data=PNG, content_type="image/png"):
    return client.post(f"/wallets/{slug}/settlements/{sid}/proof", content=data, headers={"content-type": content_type})


def proof_url(slug, sid):
    return f"/wallets/{slug}/settlements/{sid}/proof"


def paid_row(client, slug, sid):
    return next(s for s in client.get(f"/wallets/{slug}").json()["settlements"] if s["id"] == sid)


def proof_row(dsn, sid):
    rows = sql(dsn, "select proof_path, proof_type, proof_bytes, proof_at from settlements where id = %s", (sid,))
    return rows[0] if rows else None


def wallet_uuid(dsn, slug):
    return sql(dsn, "select id from wallets where share_slug = %s", (slug,))[0]["id"]


def age(dsn, sid, stamp):
    sql(dsn, "update settlements set proof_at = %s::timestamptz where id = %s", (stamp, sid))


def add_trip(dsn, wallet_id, return_date):
    """A trip on the wallet. SQL, because the API has no route that puts two trips on one wallet in one call."""
    back = date.fromisoformat(return_date)
    sql(
        dsn,
        "insert into trip_sessions (name, start_date, return_date, wallet_id) values ('Trip (made up)', %s, %s, %s)",
        (back, back, wallet_id),
    )


def fill_proofs(dsn, slug, people, n):
    """n payments that each hold a proof, straight in the table. Their bytes aren't in the store."""
    wallet_id = wallet_uuid(dsn, slug)
    sql(
        dsn,
        """insert into settlements (wallet_id, from_member, to_member, amount_centavos, proof_path, proof_type, proof_bytes, proof_at)
           select %s, %s, %s, 100, 'wallets/' || %s || '/' || gen_random_uuid(), 'image/png', 10, now() from generate_series(1, %s)""",
        (wallet_id, people["Ben"], people["Jacob"], str(wallet_id), n),
    )


def api_messages(caplog, level=logging.INFO):
    return [r.getMessage() for r in caplog.records if r.name == "tara_gala.api" and r.levelno >= level]


# ---------------------------------------------------------------- 3.1 the table

def test_settlements_has_exactly_the_approved_columns(dsn):
    """A1 (D1, D4: no extra column for a confirm or a flag)"""
    rows = sql(dsn, "select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = 'settlements'")
    assert {r["column_name"]: r["data_type"] for r in rows} == SETTLEMENT_COLUMNS


def insert_payment(dsn, **proof):
    with psycopg.connect(dsn, autocommit=True) as conn:
        wallet_id = conn.execute("insert into wallets (name) values ('Made up') returning id").fetchone()[0]
        a = conn.execute("insert into wallet_members (wallet_id, name) values (%s, 'A') returning id", (wallet_id,)).fetchone()[0]
        b = conn.execute("insert into wallet_members (wallet_id, name) values (%s, 'B') returning id", (wallet_id,)).fetchone()[0]
        cols = ", ".join(proof)
        marks = ", ".join(["%s"] * len(proof))
        extra = (", " + cols, ", " + marks) if proof else ("", "")
        conn.execute(
            f"insert into settlements (wallet_id, from_member, to_member, amount_centavos{extra[0]}) values (%s, %s, %s, 100{extra[1]})",
            (wallet_id, a, b, *proof.values()),
        )


FULL = {"proof_path": "wallets/a/b", "proof_type": "image/png", "proof_bytes": 10, "proof_at": "2026-11-07T00:00:00Z"}


@pytest.mark.parametrize("proof", [
    {"proof_path": "wallets/a/b"},
    {"proof_type": "image/png"},
    {"proof_bytes": 10},
    {"proof_path": "wallets/a/b", "proof_type": "image/png", "proof_bytes": 10},
], ids=["path only", "type only", "bytes only", "no proof_at"])
def test_a_half_filled_proof_is_refused_by_the_table(dsn, proof):
    """A2"""
    with pytest.raises(psycopg.errors.CheckViolation, match="settlements_proof_whole"):
        insert_payment(dsn, **proof)


@pytest.mark.parametrize("proof", [{}, FULL, {"proof_at": "2026-11-07T00:00:00Z"}], ids=["all null", "all set", "swept: only proof_at"])
def test_a_whole_proof_or_a_swept_one_is_accepted_by_the_table(dsn, proof):
    """A2"""
    assert "proof_path" in {c["column_name"] for c in sql(dsn, "select column_name from information_schema.columns where table_name = 'settlements'")}
    insert_payment(dsn, **proof)


def test_proof_columns_refuse_a_bad_type_a_bad_size_and_a_shared_path(dsn):
    """A3"""
    with pytest.raises(psycopg.errors.CheckViolation):
        insert_payment(dsn, **{**FULL, "proof_type": "image/svg+xml"})
    for size in (0, LIMIT + 1):
        with pytest.raises(psycopg.errors.CheckViolation):
            insert_payment(dsn, **{**FULL, "proof_bytes": size})
    insert_payment(dsn, **{**FULL, "proof_bytes": LIMIT})
    with pytest.raises(psycopg.errors.UniqueViolation):
        insert_payment(dsn, **FULL)  # the same path as the row above


def table_snapshot(conn):
    columns = conn.execute(
        """select column_name, data_type, is_nullable, column_default from information_schema.columns
           where table_schema = 'public' and table_name = 'settlements' order by column_name"""
    ).fetchall()
    constraints = conn.execute(
        """select conname, pg_get_constraintdef(oid) from pg_constraint
           where conrelid = 'public.settlements'::regclass order by conname, 2"""
    ).fetchall()
    return columns, constraints


def test_the_migration_is_a_no_op_on_a_database_built_from_schema_sql(dsn):
    """A4: catches an unnamed check in schema.sql, which would leave two after the migration"""
    migration = MIGRATION.read_text(encoding="utf-8")
    with psycopg.connect(dsn, autocommit=True) as conn:
        before = table_snapshot(conn)
        conn.execute(migration)
        conn.execute(migration)
        assert table_snapshot(conn) == before


def test_the_migration_on_todays_table_keeps_rows_and_matches_schema_sql(client, dsn):
    """A5 (P14)"""
    migration = MIGRATION.read_text(encoding="utf-8")
    slug, people = new_wallet(client)
    with psycopg.connect(dsn, autocommit=True) as conn:
        built = table_snapshot(conn)
        conn.execute("alter table settlements drop constraint if exists settlements_proof_whole")
        conn.execute("alter table settlements drop column if exists proof_path, drop column if exists proof_type, drop column if exists proof_bytes, drop column if exists proof_at")
        wallet_id = conn.execute("select id from wallets where share_slug = %s", (slug,)).fetchone()[0]
        sid = conn.execute(
            "insert into settlements (wallet_id, from_member, to_member, amount_centavos) values (%s, %s, %s, 30000) returning id",
            (wallet_id, people["Ana"], people["Jacob"]),
        ).fetchone()[0]
        conn.execute(migration)
        conn.execute(migration)
        assert table_snapshot(conn) == built
    assert proof_row(dsn, sid) == {"proof_path": None, "proof_type": None, "proof_bytes": None, "proof_at": None}
    row = paid_row(client, slug, str(sid))
    assert row["has_proof"] is False and row["proof_at"] is None
    assert upload(client, slug, sid).status_code == 201


# ---------------------------------------------------------------- 3.2 add, read and undo

def test_mark_paid_then_a_proof_is_one_payment_with_one_proof(client, store):
    """A7 (P4, D1)"""
    slug, people = new_wallet(client)
    sid = pay(client, slug, people)
    after_settle = client.get(f"/wallets/{slug}").json()
    r = upload(client, slug, sid)
    assert r.status_code == 201, r.text
    wallet = r.json()
    assert wallet["share_slug"] == slug and [s["id"] for s in wallet["settlements"]] == [sid]
    assert wallet["settlements"][0]["has_proof"] is True and wallet["settlements"][0]["proof_at"]
    assert len(store.objects) == 1
    assert wallet["transfers"] == after_settle["transfers"], "a proof doesn't touch the money"


def test_a_cash_payment_never_touches_storage(client, store):
    """A8 (P2, B2, D2c)"""
    slug, people = new_wallet(client)
    sid = pay(client, slug, people)
    row = paid_row(client, slug, sid)
    assert row["has_proof"] is False and row["proof_at"] is None
    assert store.puts == 0


def test_a_failed_upload_leaves_the_payment_and_a_retry_adds_the_proof(client, store):
    """A9 (P5, B3)"""
    slug, people = new_wallet(client)
    sid = pay(client, slug, people)
    store.fail_put = True
    r = upload(client, slug, sid)
    assert r.status_code == 503 and r.json()["detail"] == "storage_unavailable"
    wallet = client.get(f"/wallets/{slug}").json()
    assert len(wallet["settlements"]) == 1 and wallet["settlements"][0]["has_proof"] is False
    store.fail_put = False
    assert upload(client, slug, sid).status_code == 201
    wallet = client.get(f"/wallets/{slug}").json()
    assert len(wallet["settlements"]) == 1 and wallet["settlements"][0]["has_proof"] is True


def test_a_refused_payment_stores_nothing(client, dsn, store):
    """A10 (P6, B4)"""
    slug, people = new_wallet(client)
    r = client.post(f"/wallets/{slug}/settlements", json={"from_member": str(uuid4()), "to_member": people["Jacob"], "amount_centavos": 100})
    assert r.status_code == 422
    assert sql(dsn, "select count(*) as n, count(proof_path) as proofs from settlements") == [{"n": 0, "proofs": 0}]
    assert store.puts == 0
    assert client.get(f"/wallets/{slug}").json()["settlements"] == []


def chunks():
    yield PNG
    yield b"\x00" * LIMIT


@pytest.mark.parametrize("data,content_type,status,detail", [
    (b"hello", "image/png", 422, "not_an_image"),
    (JPEG, "image/png", 422, "not_an_image"),  # says PNG, is JPEG
    (b"%PDF-1.7", "application/pdf", 422, "not_an_image"),
    (b'<svg xmlns="http://www.w3.org/2000/svg"/>', "image/svg+xml", 422, "not_an_image"),
    (b"", "image/png", 422, "not_an_image"),
    (PNG + b"\x00" * LIMIT, "image/png", 413, "too_big"),
    (None, "image/png", 413, "too_big"),  # chunked: no content-length to trust
], ids=["text as png", "jpeg as png", "pdf", "svg", "empty", "over the limit", "chunked over the limit"])
def test_a_refused_upload_stores_nothing(client, dsn, store, data, content_type, status, detail):
    """A11 (P7, B5)"""
    slug, people = new_wallet(client)
    sid = pay(client, slug, people)
    r = upload(client, slug, sid, chunks() if data is None else data, content_type)
    assert (r.status_code, r.json()["detail"]) == (status, detail)
    assert store.puts == 0
    assert proof_row(dsn, sid) == {"proof_path": None, "proof_type": None, "proof_bytes": None, "proof_at": None}


def test_the_exact_size_limit_uploads(client, dsn):
    """A12"""
    slug, people = new_wallet(client)
    sid = pay(client, slug, people)
    data = PNG + b"\x00" * (LIMIT - len(PNG))
    assert upload(client, slug, sid, data).status_code == 201
    assert proof_row(dsn, sid)["proof_bytes"] == LIMIT


@pytest.mark.parametrize("data,content_type", [(PNG, "image/png"), (JPEG, "image/jpeg"), (WEBP, "image/webp"), (GIF, "image/gif")], ids=["png", "jpeg", "webp", "gif"])
def test_each_image_type_comes_back_as_itself(client, data, content_type):
    """A13"""
    slug, people = new_wallet(client)
    sid = pay(client, slug, people)
    assert upload(client, slug, sid, data, content_type).status_code == 201
    got = client.get(proof_url(slug, sid))
    assert got.status_code == 200 and got.content == data
    assert got.headers["content-type"] == content_type


def test_a_proof_is_served_with_strict_headers(client):
    """A14 (P12): stricter than get_file, because a proof has no offline use"""
    slug, people = new_wallet(client)
    sid = pay(client, slug, people)
    posted = upload(client, slug, sid)
    assert posted.status_code == 201
    assert posted.headers["cache-control"] == "private, no-cache" and posted.headers["x-robots-tag"] == "noindex"
    got = client.get(proof_url(slug, sid))
    assert got.status_code == 200
    assert got.headers["cache-control"] == "private, no-store"
    assert got.headers["content-disposition"] == "inline"
    assert got.headers["x-content-type-options"] == "nosniff"
    assert got.headers["x-robots-tag"] == "noindex"
    other = pay(client, slug, people, frm="Ben")
    missing = client.get(proof_url(slug, other))
    assert missing.status_code == 404 and missing.headers["x-robots-tag"] == "noindex"


def test_a_proof_is_reachable_only_through_its_own_wallet(client, dsn, store):
    """A15 (D5)"""
    slug, people = new_wallet(client)
    other, _ = new_wallet(client)
    sid = pay(client, slug, people)
    assert upload(client, slug, sid).status_code == 201
    assert client.get(proof_url(slug, sid)).content == PNG, "the link is all you need: no identity"
    before, puts = proof_row(dsn, sid), store.puts
    for s in (other, "0" * 32):
        assert client.get(proof_url(s, sid)).status_code == 404, s
        assert upload(client, s, sid, PNG2).status_code == 404, s
        assert client.delete(proof_url(s, sid)).status_code == 404, s
    assert store.puts == puts
    assert proof_row(dsn, sid) == before
    assert client.get(proof_url(slug, sid)).content == PNG


def test_no_proof_is_a_404(client, dsn):
    """A16: never had one, removed, and swept"""
    from app.wallet_proofs import sweep_proofs

    slug, people = new_wallet(client)
    never = pay(client, slug, people)
    assert (client.get(proof_url(slug, never)).status_code, client.get(proof_url(slug, never)).json()["detail"]) == (404, "Proof not found")
    removed = pay(client, slug, people, frm="Ben")
    assert upload(client, slug, removed).status_code == 201
    assert client.delete(proof_url(slug, removed)).status_code == 200
    assert client.get(proof_url(slug, removed)).json()["detail"] == "Proof not found"
    swept = pay(client, slug, people, amount=100)
    assert upload(client, slug, swept).status_code == 201
    age(dsn, swept, "2026-01-01T00:00:00Z")
    sweep_proofs(date(2026, 6, 1))
    assert client.get(proof_url(slug, swept)).json()["detail"] == "Proof not found"


def test_an_unknown_payment_is_a_404(client, store):
    """A17: exactly this text, because the web branches on it"""
    slug, _ = new_wallet(client)
    unknown = uuid4()
    for r in (upload(client, slug, unknown), client.delete(proof_url(slug, unknown))):
        assert (r.status_code, r.json()["detail"]) == (404, "Payment not found")
    assert store.puts == 0
    assert upload(client, slug, "not-a-uuid").status_code == 422


def test_reading_a_proof_when_storage_is_down_is_a_503(client, store):
    """A18"""
    slug, people = new_wallet(client)
    sid = pay(client, slug, people)
    assert upload(client, slug, sid).status_code == 201
    store.fail = True
    r = client.get(proof_url(slug, sid))
    assert (r.status_code, r.json()["detail"]) == (503, "storage_unavailable")


def test_undo_removes_the_payment_and_its_bytes(client, store, caplog):
    """A19 (P13, B8)"""
    caplog.set_level(logging.INFO, logger="tara_gala.api")
    slug, people = new_wallet(client)
    sid = pay(client, slug, people)
    assert upload(client, slug, sid).status_code == 201
    assert len(store.objects) == 1
    r = client.delete(f"/wallets/{slug}/settlements/{sid}")
    assert r.status_code == 200
    assert r.json()["settlements"] == [] and store.objects == {}
    assert len(r.json()["transfers"]) == 2, "the transfer is back"
    cash = pay(client, slug, people)
    assert client.delete(f"/wallets/{slug}/settlements/{cash}").status_code == 200
    lines = [m for m in api_messages(caplog) if m.startswith("wallet settlement delete")]
    assert re.search(r"\bproof=1\b", lines[0]) and re.search(r"\bproof=0\b", lines[1])


def test_undo_still_works_when_storage_is_down(client, dsn, store, caplog):
    """A20: a stranded object is reconciled later (plan section 11), and the warning names only its file id"""
    caplog.set_level(logging.INFO, logger="tara_gala.api")
    slug, people = new_wallet(client)
    sid = pay(client, slug, people)
    assert upload(client, slug, sid).status_code == 201
    path = proof_row(dsn, sid)["proof_path"]
    store.fail_delete = True
    assert client.delete(f"/wallets/{slug}/settlements/{sid}").status_code == 200
    assert proof_row(dsn, sid) is None
    assert f"wallet proof cleanup failed share_slug={slug} file={path.rsplit('/', 1)[1]}" in api_messages(caplog, logging.WARNING)
    assert not any("Jacob" in m or "Ana" in m for m in api_messages(caplog))


def test_a_proof_can_be_added_to_an_old_payment(client, dsn):
    """A21 (P14, B9)"""
    slug, people = new_wallet(client)
    sid = pay(client, slug, people)
    sql(dsn, "update settlements set created_at = '2026-11-01T00:00:00Z' where id = %s", (sid,))
    assert upload(client, slug, sid).status_code == 201
    row = paid_row(client, slug, sid)
    assert row["has_proof"] is True and row["proof_at"] != row["created_at"]


def test_replacing_swaps_the_bytes_and_restarts_the_clock(client, dsn, store, caplog):
    """A22 (B10)"""
    caplog.set_level(logging.INFO, logger="tara_gala.api")
    slug, people = new_wallet(client)
    sid = pay(client, slug, people)
    assert upload(client, slug, sid).status_code == 201
    old = proof_row(dsn, sid)["proof_path"]
    age(dsn, sid, "2026-11-01T00:00:00Z")
    was = proof_row(dsn, sid)["proof_at"]
    assert upload(client, slug, sid, PNG2).status_code == 201
    now = proof_row(dsn, sid)
    assert client.get(proof_url(slug, sid)).content == PNG2
    assert list(store.objects) == [now["proof_path"]] and now["proof_path"] != old
    assert now["proof_at"] > was
    assert any(m.startswith(f"wallet proof add share_slug={slug}") and " replaced=1 " in m for m in api_messages(caplog))


def test_a_failed_replace_keeps_the_old_proof(client, dsn, store):
    """A23 (P20, B10)"""
    slug, people = new_wallet(client)
    sid = pay(client, slug, people)
    assert upload(client, slug, sid).status_code == 201
    before = proof_row(dsn, sid)
    store.fail_put = True
    assert upload(client, slug, sid, PNG2).status_code == 503
    assert proof_row(dsn, sid) == before
    assert client.get(proof_url(slug, sid)).content == PNG


def test_removing_clears_all_four_and_the_bytes(client, dsn, store):
    """A24 (B11, P22): proof_at null is what separates removed from swept"""
    slug, people = new_wallet(client)
    sid = pay(client, slug, people)
    assert upload(client, slug, sid).status_code == 201
    before = client.get(f"/wallets/{slug}").json()
    r = client.delete(proof_url(slug, sid))
    assert r.status_code == 200
    wallet = r.json()
    assert wallet["settlements"][0]["has_proof"] is False and wallet["settlements"][0]["proof_at"] is None
    assert wallet["balances"] == before["balances"] and wallet["transfers"] == before["transfers"]
    assert [s["id"] for s in wallet["settlements"]] == [sid]
    assert store.objects == {}
    assert proof_row(dsn, sid) == {"proof_path": None, "proof_type": None, "proof_bytes": None, "proof_at": None}


def test_removing_nothing_is_a_404_and_changes_nothing(client, dsn):
    """A25 (F8, B24): a swept row keeps its proof_at, so it still says Proof deleted."""
    from app.wallet_proofs import sweep_proofs

    slug, people = new_wallet(client)
    never = pay(client, slug, people)
    r = client.delete(proof_url(slug, never))
    assert (r.status_code, r.json()["detail"]) == (404, "Proof not found")
    swept = pay(client, slug, people, frm="Ben")
    assert upload(client, slug, swept).status_code == 201
    age(dsn, swept, "2026-01-01T00:00:00Z")
    sweep_proofs(date(2026, 6, 1))
    before = proof_row(dsn, swept)
    assert before["proof_at"] is not None and before["proof_path"] is None
    r = client.delete(proof_url(slug, swept))
    assert (r.status_code, r.json()["detail"]) == (404, "Proof not found")
    assert proof_row(dsn, swept) == before


def test_remove_still_works_when_storage_is_down(client, dsn, store, caplog):
    """A26: the row clears, and reconciliation covers the bytes (test-plan section 6)"""
    caplog.set_level(logging.INFO, logger="tara_gala.api")
    slug, people = new_wallet(client)
    sid = pay(client, slug, people)
    assert upload(client, slug, sid).status_code == 201
    path = proof_row(dsn, sid)["proof_path"]
    store.fail_delete = True
    assert client.delete(proof_url(slug, sid)).status_code == 200
    assert proof_row(dsn, sid)["proof_path"] is None
    assert f"wallet proof cleanup failed share_slug={slug} file={path.rsplit('/', 1)[1]}" in api_messages(caplog, logging.WARNING)


# ---------------------------------------------------------------- 3.3 races: POST's order (plan 2.3)

def test_an_upload_holds_no_wallet_lock_during_put(client, dsn, store):
    """A27: a slow upload can't hold up the wallet's other writes"""
    slug, people = new_wallet(client)
    sid = pay(client, slug, people)

    def probe():
        with psycopg.connect(dsn) as conn:
            conn.execute("select id from wallets where share_slug = %s for update nowait", (slug,))

    # The control, as _save would do it: with the row locked, the probe must fail, or it proves nothing
    with psycopg.connect(dsn) as holder:
        holder.execute("select id from wallets where share_slug = %s for update", (slug,))
        with pytest.raises(psycopg.errors.LockNotAvailable):
            probe()

    seen = []

    def during_put(_path):
        try:
            probe()
            seen.append("free")
        except psycopg.errors.LockNotAvailable:
            seen.append("locked")

    store.on_put = during_put
    assert upload(client, slug, sid).status_code == 201
    assert seen == ["free"]


def test_a_payment_undone_during_the_upload_is_a_404_and_the_bytes_go(client, dsn, store):
    """A28 (B15)"""
    slug, people = new_wallet(client)
    sid = pay(client, slug, people)
    store.on_put = lambda _path: sql(dsn, "delete from settlements where id = %s", (sid,))
    r = upload(client, slug, sid)
    assert (r.status_code, r.json()["detail"]) == (404, "Payment not found")
    assert store.objects == {}


def test_the_404_still_comes_back_when_that_cleanup_fails(client, dsn, store, caplog):
    """A29"""
    caplog.set_level(logging.INFO, logger="tara_gala.api")
    slug, people = new_wallet(client)
    sid = pay(client, slug, people)
    paths = []

    def during_put(path):
        paths.append(path)
        sql(dsn, "delete from settlements where id = %s", (sid,))

    store.on_put = during_put
    store.fail_delete = True
    r = upload(client, slug, sid)
    assert (r.status_code, r.json()["detail"]) == (404, "Payment not found")
    assert f"wallet proof cleanup failed share_slug={slug} file={paths[0].rsplit('/', 1)[1]}" in api_messages(caplog, logging.WARNING)


def test_two_uploads_racing_leave_one_proof_and_one_object(client, dsn, store):
    """A30: a later upload wins, and the one it replaced loses its object too"""
    slug, people = new_wallet(client)
    sid = pay(client, slug, people)
    other = f"wallets/{wallet_uuid(dsn, slug)}/{uuid4()}"

    def during_put(_path):
        store.objects[other] = (PNG2, "image/png")
        sql(dsn, "update settlements set proof_path = %s, proof_type = 'image/png', proof_bytes = 10, proof_at = now() where id = %s", (other, sid))

    store.on_put = during_put
    assert upload(client, slug, sid).status_code == 201
    row = proof_row(dsn, sid)
    assert row["proof_path"] != other
    assert list(store.objects) == [row["proof_path"]]
    assert client.get(proof_url(slug, sid)).content == PNG


def test_the_50_proof_cap(client, dsn, store):
    """A31: full wallet, a replace on a full wallet, and removed and swept rows not counting"""
    from app import wallet_proofs

    assert wallet_proofs.MAX_PROOFS == 50
    slug, people = new_wallet(client)
    sid = pay(client, slug, people)
    fill_proofs(dsn, slug, people, 50)
    r = upload(client, slug, sid)
    assert (r.status_code, r.json()["detail"]) == (409, "too_many_proofs")
    assert store.objects == {}, "its bytes are deleted"
    assert proof_row(dsn, sid)["proof_path"] is None
    one_of_50 = sql(dsn, "select id from settlements where proof_path is not null limit 1")[0]["id"]
    assert upload(client, slug, one_of_50).status_code == 201, "replacing one of the 50 isn't a 51st"
    # One removed row and one swept row free two places: this payment takes one, and is the 49th
    two = [r["id"] for r in sql(dsn, "select id from settlements where proof_path is not null and id <> %s limit 2", (one_of_50,))]
    sql(dsn, "update settlements set proof_path = null, proof_type = null, proof_bytes = null, proof_at = null where id = %s", (two[0],))
    sql(dsn, "update settlements set proof_path = null, proof_type = null, proof_bytes = null where id = %s", (two[1],))
    assert upload(client, slug, sid).status_code == 201


def test_the_cap_filled_during_the_upload_is_a_409_not_a_51st(client, dsn, store):
    """A31: the cap is checked again after put, under the lock"""
    slug, people = new_wallet(client)
    sid = pay(client, slug, people)
    fill_proofs(dsn, slug, people, 49)
    store.on_put = lambda _path: fill_proofs(dsn, slug, people, 1)
    r = upload(client, slug, sid)
    assert (r.status_code, r.json()["detail"]) == (409, "too_many_proofs")
    assert store.objects == {}
    assert sql(dsn, "select count(*) as n from settlements where proof_path is not null")[0]["n"] == 50


def test_the_limiter_counts_every_upload_and_delete(client, store, monkeypatch):
    """A32: _limit runs first, so a refused upload counts, and DELETE is limited too (F8)"""
    from app import wallet_proofs

    assert wallet_proofs.UPLOADS_PER_HOUR == 120
    slug, people = new_wallet(client)
    sid = pay(client, slug, people)
    monkeypatch.setattr(wallet_proofs, "PROOF_LIMITER", RateLimiter(1))
    assert upload(client, slug, sid, b"hello").status_code == 422
    r = upload(client, slug, sid)
    assert r.status_code == 429 and "retry-after" in r.headers
    r = upload(client, slug, sid, PNG + b"\x00" * LIMIT)
    assert r.status_code == 429, "429 before 413: the limit comes first"
    assert store.puts == 0
    monkeypatch.setattr(wallet_proofs, "PROOF_LIMITER", RateLimiter(1))
    assert client.delete(proof_url(slug, sid)).status_code == 404
    assert client.delete(proof_url(slug, sid)).status_code == 429


def test_proof_routes_leave_the_write_limiter_alone(client, monkeypatch):
    """A32"""
    slug, people = new_wallet(client)
    monkeypatch.setattr(wallets, "WRITE_LIMITER", RateLimiter(2))
    sid = pay(client, slug, people)
    assert upload(client, slug, sid).status_code == 201
    assert client.delete(proof_url(slug, sid)).status_code == 200
    assert upload(client, slug, sid).status_code == 201
    assert client.delete(f"/wallets/{slug}/settlements/{sid}").status_code == 200, "the second write still fits"


# ---------------------------------------------------------------- 3.4 privacy and logs

def test_no_response_holds_the_storage_fields(client, dsn):
    """A33 (B16)"""
    slug, people = new_wallet(client)
    trip = client.post("/sessions", json=TRIP).json()["share_slug"]
    assert client.put(f"/sessions/{trip}/wallet", json={"share_slug": slug}).status_code == 200
    sid = pay(client, slug, people)
    posted = upload(client, slug, sid)
    assert posted.status_code == 201
    replaced = upload(client, slug, sid, PNG2)
    assert replaced.status_code == 201
    other = client.post(f"/wallets/{slug}/settlements", json={"from_member": people["Ben"], "to_member": people["Jacob"], "amount_centavos": 100})
    removed = client.delete(proof_url(slug, sid))
    undone = client.delete(f"/wallets/{slug}/settlements/{sid}")
    for r in (posted, replaced, client.get(f"/wallets/{slug}"), other, removed, undone, client.get(f"/sessions/{trip}")):
        assert r.status_code in (200, 201), r.url
        for word in ("proof_path", "proof_type", "proof_bytes"):
            assert word not in r.text, r.url
        assert not OBJECT_PATH.search(r.text), r.url


def test_the_object_path_is_only_two_ids(client, dsn):
    """A34: no slug, no name"""
    slug, people = new_wallet(client)
    sid = pay(client, slug, people)
    assert upload(client, slug, sid).status_code == 201
    wallet_id = wallet_uuid(dsn, slug)
    path = proof_row(dsn, sid)["proof_path"]
    m = re.fullmatch(rf"wallets/{wallet_id}/([0-9a-f-]{{36}})", path)
    assert m, path
    UUID(m.group(1))


def test_logs_carry_slugs_and_sizes_never_a_name_a_note_or_a_path(client, dsn, store, caplog):
    """A35: plan section 9, as written"""
    from app.wallet_proofs import sweep_proofs

    caplog.set_level(logging.DEBUG)
    members = ("Marker-Jacob", "Marker-Ana", "Marker-Ben")
    slug, people = new_wallet(client, members=members, note="Marker-note")
    sid = pay(client, slug, people, frm="Marker-Ana", to="Marker-Jacob")
    assert upload(client, slug, sid, b"hello").status_code == 422
    assert upload(client, slug, sid).status_code == 201
    assert client.get(proof_url(slug, sid)).status_code == 200
    assert client.get(f"/wallets/{slug}").status_code == 200
    store.fail_put = True
    assert upload(client, slug, sid, PNG2).status_code == 503
    store.fail_put = False
    assert client.delete(proof_url(slug, sid)).status_code == 200
    assert upload(client, slug, sid).status_code == 201
    age(dsn, sid, "2026-01-01T00:00:00Z")
    store.fail_delete = True
    assert sweep_proofs(date(2026, 6, 1)) == 0
    store.fail_delete = False
    assert sweep_proofs(date(2026, 6, 1)) == 1

    lines = api_messages(caplog)
    size = len(PNG)
    assert f"wallet proof add share_slug={slug} bytes={size} replaced=0 proofs=1" in lines
    assert f"wallet proof get share_slug={slug} bytes={size}" in lines
    assert f"wallet proof delete share_slug={slug} proofs=0" in lines
    assert f"wallet proof refused share_slug={slug} reason=not_an_image bytes=5" in lines
    assert f"wallet proof upload failed share_slug={slug} bytes={len(PNG2)}" in lines
    assert "wallet proof sweep cleanup failed count=1" in lines
    assert "wallet proof sweep deleted=1" in lines
    assert any(m.startswith(f"wallet get share_slug={slug} ") and re.search(r"\bproofs=1\b", m) for m in lines), "_counts carries proofs="
    for r in caplog.records:
        text = r.getMessage()
        assert "Marker-" not in text, text
        assert not OBJECT_PATH.search(text), text


# ---------------------------------------------------------------- 3.5 the sweep

SWEEP_CASES = {
    # case: (upload, return dates, last day it's kept, first day it's gone). Times are Manila unless marked Z.
    "trip wallet": ("2026-11-07T12:00:00+08", ["2026-11-08"], date(2026, 11, 22), date(2026, 11, 23)),
    "two trips, later counts": ("2026-11-07T12:00:00+08", ["2026-11-08", "2026-11-20"], date(2026, 12, 4), date(2026, 12, 5)),
    "no trip": ("2026-11-07T12:00:00+08", [], date(2026, 11, 21), date(2026, 11, 22)),
    "late upload": ("2026-12-01T12:00:00+08", ["2026-11-08"], date(2026, 12, 15), date(2026, 12, 16)),
    "upload on return day": ("2026-11-08T12:00:00+08", ["2026-11-08"], date(2026, 11, 22), date(2026, 11, 23)),
    "Manila midnight": ("2026-11-15T16:30:00Z", [], date(2026, 11, 30), date(2026, 12, 1)),
    "one minute before midnight": ("2026-11-15T15:59:00Z", [], date(2026, 11, 29), date(2026, 11, 30)),
}


@pytest.mark.parametrize("case", list(SWEEP_CASES))
def test_the_sweep_goes_the_day_after_delete_after_not_on_it(client, dsn, store, case):
    """A36 (B12, D3a)"""
    from app.wallet_proofs import sweep_proofs

    uploaded, returns, kept_on, gone_on = SWEEP_CASES[case]
    slug, people = new_wallet(client)
    wallet_id = wallet_uuid(dsn, slug)
    for back in returns:
        add_trip(dsn, wallet_id, back)
    sid = pay(client, slug, people)
    assert upload(client, slug, sid).status_code == 201
    age(dsn, sid, uploaded)
    assert sweep_proofs(kept_on) == 0, "kept on delete_after"
    assert proof_row(dsn, sid)["proof_path"] is not None and len(store.objects) == 1
    assert sweep_proofs(gone_on) == 1, "gone the day after"
    assert proof_row(dsn, sid)["proof_path"] is None and store.objects == {}


def test_moving_the_trip_moves_the_deadline(client, dsn):
    """A37: later keeps it past the old date; earlier takes it sooner, but never before upload + 14"""
    from app.wallet_proofs import sweep_proofs

    slug, people = new_wallet(client)
    trip = client.post("/sessions", json=TRIP).json()["share_slug"]
    assert client.put(f"/sessions/{trip}/wallet", json={"share_slug": slug}).status_code == 200
    sid = pay(client, slug, people)
    assert upload(client, slug, sid).status_code == 201
    age(dsn, sid, "2026-11-07T12:00:00+08")
    assert client.patch(f"/sessions/{trip}", json={"return_date": "2026-11-20"}).status_code == 200
    assert sweep_proofs(date(2026, 11, 23)) == 0, "the old deadline has passed; the new one hasn't"
    assert client.patch(f"/sessions/{trip}", json={"return_date": "2026-11-07"}).status_code == 200
    assert sweep_proofs(date(2026, 11, 21)) == 0, "upload + 14 still holds"
    assert sweep_proofs(date(2026, 11, 22)) == 1


@pytest.mark.parametrize("how", ["deleted", "detached"])
def test_a_deleted_or_detached_trip_falls_back_to_the_upload_date(client, dsn, store, how):
    """A38"""
    from app.wallet_proofs import sweep_proofs

    slug, people = new_wallet(client)
    trip = client.post("/sessions", json={**TRIP, "return_date": "2026-11-20"}).json()["share_slug"]
    assert client.put(f"/sessions/{trip}/wallet", json={"share_slug": slug}).status_code == 200
    sid = pay(client, slug, people)
    assert upload(client, slug, sid).status_code == 201
    age(dsn, sid, "2026-11-07T12:00:00+08")
    if how == "deleted":
        r = client.request("DELETE", f"/sessions/{trip}", json={"name": TRIP["name"]})
    else:
        r = client.delete(f"/sessions/{trip}/wallet")
    assert r.status_code in (200, 204), r.text
    assert len(store.objects) == 1, "the trip's own delete doesn't take the wallet's proof"
    assert sweep_proofs(date(2026, 11, 21)) == 0
    assert sweep_proofs(date(2026, 11, 22)) == 1


def test_after_the_sweep_the_money_is_the_same_and_the_proof_says_deleted(client, dsn, store):
    """A39 (B13, D3b, P15)"""
    from app.wallet_proofs import sweep_proofs

    slug, people = new_wallet(client)
    sid = pay(client, slug, people)
    assert upload(client, slug, sid).status_code == 201
    age(dsn, sid, "2026-11-07T12:00:00+08")
    stamp = proof_row(dsn, sid)["proof_at"]
    before = client.get(f"/wallets/{slug}").json()
    assert sweep_proofs(date(2026, 12, 1)) == 1
    after = client.get(f"/wallets/{slug}").json()
    assert after["balances"] == before["balances"] and after["transfers"] == before["transfers"]
    row = paid_row(client, slug, sid)
    assert row["has_proof"] is False and row["proof_at"] is not None
    assert proof_row(dsn, sid)["proof_at"] == stamp
    assert client.get(proof_url(slug, sid)).status_code == 404
    assert store.objects == {}


def test_a_wallet_with_no_trip_runs_the_whole_lifecycle(client, dsn, store):
    """A40 (P16)"""
    from app.wallet_proofs import sweep_proofs

    assert sql(dsn, "select count(*) as n from trip_sessions")[0]["n"] == 0
    slug, people = new_wallet(client)
    sid = pay(client, slug, people)
    assert upload(client, slug, sid).status_code == 201
    assert client.get(proof_url(slug, sid)).content == PNG
    assert upload(client, slug, sid, PNG2).status_code == 201
    assert client.get(proof_url(slug, sid)).content == PNG2
    assert client.delete(proof_url(slug, sid)).status_code == 200
    assert upload(client, slug, sid).status_code == 201
    age(dsn, sid, "2026-11-07T12:00:00+08")
    assert sweep_proofs(date(2026, 11, 22)) == 1
    assert upload(client, slug, sid).status_code == 201
    assert client.delete(f"/wallets/{slug}/settlements/{sid}").status_code == 200
    assert store.objects == {}


def test_the_sweep_leaves_everything_else_alone(client, dsn, store, caplog):
    """A41: the deploy check looks for deleted=0"""
    from app.wallet_proofs import sweep_proofs

    caplog.set_level(logging.INFO, logger="tara_gala.api")
    slug, people = new_wallet(client)
    pay(client, slug, people)  # cash
    inside = pay(client, slug, people, frm="Ben")
    assert upload(client, slug, inside).status_code == 201
    removed = pay(client, slug, people, amount=100)
    assert upload(client, slug, removed).status_code == 201
    assert client.delete(proof_url(slug, removed)).status_code == 200
    expired = pay(client, slug, people, amount=200)
    assert upload(client, slug, expired).status_code == 201
    age(dsn, expired, "2026-01-01T00:00:00Z")
    today = date(2026, 6, 1)
    age(dsn, inside, "2026-05-31T00:00:00Z")
    assert sweep_proofs(today) == 1
    assert sweep_proofs(today) == 0, "a second run finds nothing"
    assert "wallet proof sweep deleted=0" in api_messages(caplog)
    assert proof_row(dsn, inside)["proof_path"] is not None
    assert proof_row(dsn, removed)["proof_at"] is None


def test_a_proof_can_be_added_after_the_sweep(client, dsn):
    """A42: a fresh proof_at, and a fresh 14 days"""
    from app.wallet_proofs import sweep_proofs

    slug, people = new_wallet(client)
    sid = pay(client, slug, people)
    assert upload(client, slug, sid).status_code == 201
    age(dsn, sid, "2026-01-01T00:00:00Z")
    assert sweep_proofs(date(2026, 6, 1)) == 1
    was = proof_row(dsn, sid)["proof_at"]
    assert upload(client, slug, sid, PNG2).status_code == 201
    row = paid_row(client, slug, sid)
    assert row["has_proof"] is True
    assert proof_row(dsn, sid)["proof_at"] > was
    age(dsn, sid, "2026-05-30T12:00:00+08")
    assert sweep_proofs(date(2026, 6, 13)) == 0
    assert sweep_proofs(date(2026, 6, 14)) == 1


def test_the_two_sweeps_stay_out_of_each_others_files(client, dsn, store):
    """A43"""
    from app.wallet_proofs import sweep_proofs

    slug, people = new_wallet(client)
    trip = client.post("/sessions", json=TRIP).json()["share_slug"]
    assert client.put(f"/sessions/{trip}/wallet", json={"share_slug": slug}).status_code == 200
    ticket = client.post(f"/sessions/{trip}/files", params={"kind": "ticket", "label": "Bus"}, content=PNG, headers={"content-type": "image/png"})
    photo = client.post(f"/sessions/{trip}/files", params={"kind": "photo"}, content=PNG, headers={"content-type": "image/png"})
    assert ticket.status_code == 201 and photo.status_code == 201
    sid = pay(client, slug, people)
    assert upload(client, slug, sid).status_code == 201
    assert len(store.objects) == 3
    tf.sweep(date(2030, 1, 1))
    assert proof_row(dsn, sid)["proof_path"] in store.objects, "the trip sweep keeps proofs"
    left = set(store.objects)
    assert len(left) == 2, "the ticket went; the proof and the photo stayed"
    sid2_files = sql(dsn, "select storage_path from session_files")
    assert sweep_proofs(date(2030, 1, 1)) == 1
    assert {r["storage_path"] for r in sid2_files} <= set(store.objects), "the proof sweep keeps the trip's own files"


@pytest.mark.parametrize("raises", ["trip", "proof"])
def test_the_sweeper_runs_both_each_in_its_own_try(store, monkeypatch, caplog, raises):
    """A44"""
    from app import wallet_proofs

    caplog.set_level(logging.INFO, logger="tara_gala.api")
    stop = threading.Event()
    ran = []

    def trip_sweep(*_a):
        ran.append("trip")
        if raises == "trip":
            raise RuntimeError("boom")
        return 0

    def proof_sweep(today):
        ran.append(("proof", today))
        stop.set()  # one pass is enough
        if raises == "proof":
            raise RuntimeError("boom")
        return 0

    monkeypatch.setattr(tf, "sweep", trip_sweep)
    monkeypatch.setattr(wallet_proofs, "sweep_proofs", proof_sweep)
    thread = tf.start_sweeper(stop)
    assert thread is not None
    stop.wait(5)
    thread.join(5)
    assert not thread.is_alive(), "the thread exits on stop"
    assert [r if isinstance(r, str) else r[0] for r in ran] == ["trip", "proof"], "one failing doesn't stop the other"
    assert ran[1][1] == tf.manila_today()
    warnings = api_messages(caplog, logging.WARNING)
    if raises == "proof":
        assert "wallet proof sweep failed error=RuntimeError" in warnings
    else:
        assert "trip file sweep failed error=RuntimeError" in warnings


def test_each_module_imports_on_its_own():
    """A45: no import cycle (plan 2.2). Each in a fresh interpreter."""
    for module in ("app.wallet_proofs", "app.trip_files"):
        out = subprocess.run([sys.executable, "-c", f"import {module}"], cwd=API, capture_output=True, text=True, timeout=30)
        assert out.returncode == 0, f"{module}: {out.stderr}"


def test_a_storage_failure_in_the_sweep_keeps_the_row_for_the_next_run(client, dsn, store, caplog):
    """A46 (B14): the opposite order to trip_files.sweep, on purpose"""
    from app.wallet_proofs import sweep_proofs

    caplog.set_level(logging.INFO, logger="tara_gala.api")
    slug, people = new_wallet(client)
    sid = pay(client, slug, people)
    assert upload(client, slug, sid).status_code == 201
    age(dsn, sid, "2026-01-01T00:00:00Z")
    before = proof_row(dsn, sid)
    store.fail_delete = True
    assert sweep_proofs(date(2026, 6, 1)) == 0
    assert proof_row(dsn, sid) == before and len(store.objects) == 1
    assert "wallet proof sweep cleanup failed count=1" in api_messages(caplog, logging.WARNING)
    store.fail_delete = False
    assert sweep_proofs(date(2026, 6, 1)) == 1
    assert store.objects == {}


@pytest.mark.parametrize("step", ["post", "sweep", "replace", "remove", "undo"])
def test_no_connection_is_held_during_a_storage_call(client, dsn, store, monkeypatch, step):
    """A47: the pool is 5 and Storage's timeout is 20 s (plan 2.5)"""
    from app.wallet_proofs import sweep_proofs

    slug, people = new_wallet(client)
    sid = pay(client, slug, people)
    if step != "post":
        assert upload(client, slug, sid).status_code == 201

    real = db.get_conn
    held = {"open": 0}
    seen = []

    @contextmanager
    def counted():
        with real() as conn:
            held["open"] += 1
            try:
                yield conn
            finally:
                held["open"] -= 1

    monkeypatch.setattr(db, "get_conn", counted)

    def note(_arg):
        seen.append(held["open"])

    if step == "post":
        store.on_put = note
        assert upload(client, slug, sid).status_code == 201
    else:
        store.on_delete = note
        if step == "sweep":
            age(dsn, sid, "2026-01-01T00:00:00Z")
            assert sweep_proofs(date(2026, 6, 1)) == 1
        elif step == "replace":
            assert upload(client, slug, sid, PNG2).status_code == 201
        elif step == "remove":
            assert client.delete(proof_url(slug, sid)).status_code == 200
        else:
            assert client.delete(f"/wallets/{slug}/settlements/{sid}").status_code == 200
    assert seen and set(seen) == {0}, f"connections open during Storage: {seen}"
