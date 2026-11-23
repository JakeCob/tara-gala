"""TG-66 P0: wallet_activity.record() (plan §2). One activity row and the wallet's rev + 1, in the caller's transaction.
A2 and A3 call it from every write; the routes come later. Made-up wallets only.
"""

import logging
import re

import psycopg
import pytest
from psycopg.rows import dict_row

from conftest import ROOT



class _Missing:
    def __getattr__(self, name):
        raise AssertionError(f"app/wallet_activity.py doesn't exist yet (TG-66 P0): no {name}")


try:
    from app import wallet_activity
except ImportError:  # RED: P0's GREEN adds it, and every test below fails until then
    wallet_activity = _Missing()

MIGRATION = ROOT / "supabase" / "migrations" / "2026-11-16_tg66_wallet_splits.sql"


def wallet(conn):
    wid = conn.execute("insert into wallets (name) values ('E2E made up wallet') returning id").fetchone()["id"]
    a = conn.execute("insert into wallet_members (wallet_id, name) values (%s, 'Ana') returning id", (wid,)).fetchone()["id"]
    return wid, a


def test_actions_are_the_tables():
    sql = MIGRATION.read_text(encoding="utf-8")
    check = re.search(r"action\s+text not null check \(action in \(([^)]*)\)\)", sql, re.S)
    tg66 = set(re.findall(r"'(\w+)'", check.group(1))) if check else set()
    assert len(tg66) == 11 and tg66 <= wallet_activity.ACTIONS
    # TG-73 widened the check (its migration, and schema.sql in place): the 11 plus the pot's 15
    tg73 = (ROOT / "supabase" / "migrations" / "2026-11-29_tg73_pot.sql").read_text(encoding="utf-8")
    widened = re.search(r"check \(action in \(([^)]*)\)\)", tg73, re.S)
    assert widened and set(re.findall(r"'(\w+)'", widened.group(1))) == wallet_activity.ACTIONS
    assert len(wallet_activity.ACTIONS) == 26


def test_record_writes_one_row_and_bumps_rev(dsn):
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        wid, a = wallet(conn)
        eid = conn.execute("insert into expenses (wallet_id, paid_by, amount_centavos, note) values (%s, %s, 1000, 'E2E') returning id", (wid, a)).fetchone()["id"]
        before, after = {"amount": 1000, "version": 1}, {"amount": 1200, "version": 2}
        assert wallet_activity.record(conn, wid, "expense_edit", by=a, expense_id=eid, before=before, after=after) == 1
        assert wallet_activity.record(conn, wid, "member_join", member_id=a) == 2
        assert wallet_activity.record(conn, wid, "comment_delete", expense_id=eid) == 3
        rows = conn.execute("select actor, action, expense_id, settlement_id, member_id, before, after from wallet_activity where wallet_id = %s order by id", (wid,)).fetchall()
        assert rows == [
            {"actor": a, "action": "expense_edit", "expense_id": eid, "settlement_id": None, "member_id": None, "before": before, "after": after},
            {"actor": None, "action": "member_join", "expense_id": None, "settlement_id": None, "member_id": a, "before": None, "after": None},
            {"actor": None, "action": "comment_delete", "expense_id": eid, "settlement_id": None, "member_id": None, "before": None, "after": None},
        ]
        assert conn.execute("select rev from wallets where id = %s", (wid,)).fetchone()["rev"] == 3


def test_record_is_in_the_callers_transaction(dsn):
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        wid, _ = wallet(conn)
        conn.commit()
        assert wallet_activity.record(conn, wid, "settle", after={"from_member": "x", "to_member": "y", "amount_centavos": 100}) == 1
        conn.rollback()  # the caller's write failed: neither the row nor the rev stays
        assert conn.execute("select count(*) as n from wallet_activity").fetchone()["n"] == 0
        assert conn.execute("select rev from wallets where id = %s", (wid,)).fetchone()["rev"] == 0
        assert wallet_activity.record(conn, wid, "settle") == 1


def test_one_wallets_rev_is_its_own(dsn):
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        (w1, _), (w2, _) = wallet(conn), wallet(conn)
        assert [wallet_activity.record(conn, w, "settle") for w in (w1, w1, w2)] == [1, 2, 1]


def test_an_unknown_action_writes_nothing(dsn):
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        wid, _ = wallet(conn)
        with pytest.raises(ValueError):
            wallet_activity.record(conn, wid, "expense_rename")
        assert conn.execute("select count(*) as n from wallet_activity").fetchone()["n"] == 0
        assert conn.execute("select rev from wallets where id = %s", (wid,)).fetchone()["rev"] == 0


def test_a_missing_wallet_is_an_error_not_a_silent_row(dsn):
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        with pytest.raises(psycopg.errors.ForeignKeyViolation):
            wallet_activity.record(conn, "00000000-0000-0000-0000-000000000000", "settle")


def test_load_reads_rev_and_each_expenses_comment_count(dsn):  # test-audit P0 M1: A2's comment answers need both
    from app import wallets

    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        wid, a = wallet(conn)
        e1, e2 = (conn.execute("insert into expenses (wallet_id, paid_by, amount_centavos, note) values (%s, %s, 1000, 'E2E') returning id", (wid, a)).fetchone()["id"] for _ in range(2))
        for e in (e1, e2):
            conn.execute("insert into expense_shares (expense_id, member_id, share_centavos) values (%s, %s, 1000)", (e, a))
        conn.execute("insert into expense_comments (expense_id, body) values (%s, 'E2E one'), (%s, 'E2E two')", (e1, e1))
        assert wallets._load(conn, wid).rev == 0
        wallet_activity.record(conn, wid, "comment_add", expense_id=e1)
        wallet_activity.record(conn, wid, "comment_add", expense_id=e1)
        loaded = wallets._load(conn, wid)
        assert loaded.rev == 2
        assert {e.id: e.comment_count for e in loaded.expenses} == {e1: 2, e2: 0}


def test_the_log_has_the_slug_action_and_rev_only(dsn, caplog):
    caplog.set_level(logging.INFO)
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        wid, a = wallet(conn)
        slug = conn.execute("select share_slug from wallets where id = %s", (wid,)).fetchone()["share_slug"]
        wallet_activity.record(conn, wid, "expense_add", by=a, after={"note": "Lunch at TESTPLACE", "amount": 1000})
    lines = [r.getMessage() for r in caplog.records if r.name.startswith("tara_gala")]
    assert lines == [f"wallet activity share_slug={slug} action=expense_add rev=1"]  # rev is per wallet: the slug ties it to one
    for secret in ("TESTPLACE", "Ana", "E2E", str(a), str(wid)):
        assert all(secret not in line for line in lines), secret
