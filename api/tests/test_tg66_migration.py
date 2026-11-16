"""TG-66 P0: the wallet splitting migration (options.md §4, owner-approved 2026-11-15). Plan §4 P0 step 1 and review S3:
it's built over main's schema.sql from before TG-66 (a1c4299) with rows in it, run twice, and must equal a fresh build of
schema.sql. The old rows read back unchanged.
"""

import hashlib
from pathlib import Path

import psycopg
import pytest
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from app import wallets
from conftest import ROOT, build_schema
from test_trip_people import schema_shape

MIGRATIONS = ROOT / "supabase" / "migrations"
MIGRATION = MIGRATIONS / "2026-11-16_tg66_wallet_splits.sql"
PRE = Path(__file__).parent / "fixtures" / "schema_pre_tg66.sql"
PRE_SHA256 = "40fff01a13478b1c2d412d9560de4d22406aacc621b70a98f0d1c33ffd0ad8cd"  # git show a1c4299:supabase/schema.sql
PRE_NEWEST = "2026-11-03_tg58_attendees.sql"  # the newest migration at a1c4299: everything after it is applied on top
NEW_TABLES = ("expense_charges", "expense_comments", "expense_inputs", "expense_item_people", "expense_items", "expense_payers", "wallet_activity")


def test_fixture_is_mains_schema_before_tg66():
    assert hashlib.sha256(PRE.read_bytes()).hexdigest() == PRE_SHA256
    assert "wallet_activity" not in PRE.read_text(encoding="utf-8")


def seed(conn) -> list:
    """Two made-up wallets with members, expenses (equal and exact), their shares and a settlement."""
    out = []
    for name, people in (("E2E made up wallet", ["Ana", "Ben", "Cy"]), ("E2E second wallet", ["Di", "Ed"])):
        wid = conn.execute("insert into wallets (name) values (%s) returning id", (name,)).fetchone()["id"]
        ids = [conn.execute("insert into wallet_members (wallet_id, name) values (%s, %s) returning id", (wid, p)).fetchone()["id"] for p in people]
        for amount, payer, parts in ((1000, ids[0], {m: None for m in ids}), (751, ids[-1], {ids[0]: 751, ids[1]: 0})):
            eid = conn.execute(
                "insert into expenses (wallet_id, paid_by, amount_centavos, note) values (%s, %s, %s, 'E2E taxi') returning id", (wid, payer, amount)
            ).fetchone()["id"]
            shares = wallets.split_equal(amount, ids, payer) if None in parts.values() else parts
            for m, s in shares.items():
                conn.execute("insert into expense_shares (expense_id, member_id, share_centavos) values (%s, %s, %s)", (eid, m, s))
        conn.execute("insert into settlements (wallet_id, from_member, to_member, amount_centavos) values (%s, %s, %s, 100)", (wid, ids[1], ids[0]))
        out.append(wid)
    return out


# Every column the wallet tables had before TG-66. They must read back identically after the migration.
OLD_COLUMNS = {
    "wallets": "id, share_slug, name, created_at",
    "wallet_members": "id, seq, wallet_id, name, created_at",
    "expenses": "id, wallet_id, paid_by, amount_centavos, note, created_at",
    "expense_shares": "expense_id, member_id, share_centavos",
    "settlements": "id, wallet_id, from_member, to_member, amount_centavos, created_at, proof_path, proof_type, proof_bytes, proof_at",
}


def old_rows(conn) -> dict:
    return {t: conn.execute(f"select {cols} from {t} order by 1, 2").fetchall() for t, cols in OLD_COLUMNS.items()}


def balances_from(rows: dict, wid) -> tuple[list, list]:
    """The balances and transfers, worked out from the old rows alone (paid_by, the shares and the payments)."""
    order = [m["id"] for m in sorted((m for m in rows["wallet_members"] if m["wallet_id"] == wid), key=lambda m: m["seq"])]
    mine = {e["id"]: e for e in rows["expenses"] if e["wallet_id"] == wid}
    paid, owed = dict.fromkeys(order, 0), dict.fromkeys(order, 0)
    for e in mine.values():
        paid[e["paid_by"]] += e["amount_centavos"]
    for s in rows["expense_shares"]:
        if s["expense_id"] in mine:
            owed[s["member_id"]] += s["share_centavos"]
    net = {m: paid[m] - owed[m] for m in order}
    for s in rows["settlements"]:
        if s["wallet_id"] == wid:
            net[s["from_member"]] += s["amount_centavos"]
            net[s["to_member"]] -= s["amount_centavos"]
    return [(m, paid[m], owed[m], net[m]) for m in order], wallets.settle_up(net, order)


def test_migration_over_pre_tg66_schema_with_rows_matches_schema_sql(dsn):  # S3
    build_schema(PRE.read_text(encoding="utf-8"))
    sql = MIGRATION.read_text(encoding="utf-8")
    later = sorted(m for m in MIGRATIONS.glob("*.sql") if m.name > PRE_NEWEST and m != MIGRATION)
    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        wids = seed(conn)
        before = old_rows(conn)  # _load itself needs TG-66's columns now (it reads rev and comment counts)
        for m in sorted([*later, MIGRATION, MIGRATION], key=lambda p: p.name):  # TG-66's twice: re-runnable
            conn.execute(sql if m == MIGRATION else m.read_text(encoding="utf-8"))
        # The old rows: legacy, not sorted yet, version 1, never edited, and every wallet at rev 0
        assert conn.execute("select distinct split_mode, category, version, updated_at from expenses").fetchall() == [
            {"split_mode": None, "category": None, "version": 1, "updated_at": None}
        ]
        assert conn.execute("select count(*) as n from expenses").fetchone()["n"] == 4
        assert {r["rev"] for r in conn.execute("select rev from wallets")} == {0}
        for t in NEW_TABLES:
            assert conn.execute(f"select count(*) as n from {t}").fetchone()["n"] == 0, t
        # Every old column reads back identically, and _load's balances and transfers are those of the old rows
        assert old_rows(conn) == before
        for w in wids:
            loaded = wallets._load(conn, w)
            want_balances, want_transfers = balances_from(before, w)
            assert [(b.member_id, b.paid_centavos, b.share_centavos, b.net_centavos) for b in loaded.balances] == want_balances
            assert [(t.from_member, t.to_member, t.amount_centavos) for t in loaded.transfers] == want_transfers
            assert loaded.total_centavos == sum(e["amount_centavos"] for e in before["expenses"] if e["wallet_id"] == w)
            assert loaded.rev == 0 and {e.comment_count for e in loaded.expenses} == {0}
    upgraded = schema_shape(dsn)
    build_schema((ROOT / "supabase" / "schema.sql").read_text(encoding="utf-8"))
    assert upgraded == schema_shape(dsn)  # columns, defaults, checks, foreign keys and cascades, indexes, RLS, policies


def test_migration_is_a_no_op_on_schema_sql(dsn):
    before = schema_shape(dsn)
    sql = MIGRATION.read_text(encoding="utf-8")
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(sql)
        conn.execute(sql)
    assert schema_shape(dsn) == before


def test_new_tables_are_api_only(dsn):
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        rls = conn.execute(
            "select c.relname, c.relrowsecurity, c.relforcerowsecurity, count(p.policyname) as policies from pg_class c"
            " left join pg_policies p on p.tablename = c.relname where c.relnamespace = 'public'::regnamespace and c.relname = any(%s)"
            " group by 1, 2, 3 order by 1",
            (list(NEW_TABLES),),
        ).fetchall()
    assert rls == [{"relname": t, "relrowsecurity": True, "relforcerowsecurity": False, "policies": 0} for t in NEW_TABLES]


def make(conn):
    wid = conn.execute("insert into wallets (name) values ('E2E made up wallet') returning id").fetchone()["id"]
    a, b = (conn.execute("insert into wallet_members (wallet_id, name) values (%s, %s) returning id", (wid, n)).fetchone()["id"] for n in ("Ana", "Ben"))
    eid = conn.execute("insert into expenses (wallet_id, paid_by, amount_centavos, note) values (%s, %s, 1000, 'E2E') returning id", (wid, a)).fetchone()["id"]
    return wid, a, b, eid


def test_constraints_refuse_bad_rows(dsn):
    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        wid, a, b, eid = make(conn)
        iid = conn.execute("insert into expense_items (expense_id, seq, name, price_centavos) values (%s, 1, 'E2E item', 500) returning id", (eid,)).fetchone()["id"]
        conn.execute("insert into expense_charges (expense_id, kind, basis, value) values (%s, 'service', 'percent', 1000)", (eid,))
        bad = [
            (psycopg.errors.CheckViolation, "update expenses set split_mode = 'ratio' where id = %s", (eid,)),
            (psycopg.errors.CheckViolation, "update expenses set category = 'drinks' where id = %s", (eid,)),
            (psycopg.errors.CheckViolation, "update expenses set version = 0 where id = %s", (eid,)),
            (psycopg.errors.NotNullViolation, "update expenses set version = null where id = %s", (eid,)),
            (psycopg.errors.NotNullViolation, "update wallets set rev = null where id = %s", (wid,)),
            (psycopg.errors.CheckViolation, "insert into expense_inputs values (%s, %s, 10000001)", (eid, a)),
            (psycopg.errors.CheckViolation, "insert into expense_inputs values (%s, %s, -10000001)", (eid, a)),
            (psycopg.errors.CheckViolation, "insert into expense_payers values (%s, %s, 0)", (eid, a)),
            (psycopg.errors.CheckViolation, "insert into expense_payers values (%s, %s, 10000001)", (eid, a)),
            (psycopg.errors.CheckViolation, "insert into expense_items (expense_id, seq, name, price_centavos) values (%s, 0, 'x', 1)", (eid,)),
            (psycopg.errors.CheckViolation, "insert into expense_items (expense_id, seq, name, price_centavos) values (%s, 41, 'x', 1)", (eid,)),
            (psycopg.errors.CheckViolation, "insert into expense_items (expense_id, seq, name, price_centavos) values (%s, 2, '', 1)", (eid,)),
            (psycopg.errors.CheckViolation, "insert into expense_items (expense_id, seq, name, price_centavos) values (%s, 2, %s, 1)", (eid, "x" * 41)),
            (psycopg.errors.CheckViolation, "insert into expense_items (expense_id, seq, name, price_centavos) values (%s, 2, 'x', -1)", (eid,)),
            (psycopg.errors.UniqueViolation, "insert into expense_items (expense_id, seq, name, price_centavos) values (%s, 1, 'x', 1)", (eid,)),
            (psycopg.errors.UniqueViolation, "insert into expense_charges (expense_id, kind, basis, value) values (%s, 'service', 'amount', 1)", (eid,)),
            (psycopg.errors.CheckViolation, "insert into expense_charges (expense_id, kind, basis, value) values (%s, 'tip', 'amount', 1)", (eid,)),
            (psycopg.errors.CheckViolation, "insert into expense_charges (expense_id, kind, basis, value) values (%s, 'vat', 'ratio', 1)", (eid,)),
            (psycopg.errors.CheckViolation, "insert into expense_charges (expense_id, kind, basis, value) values (%s, 'vat', 'amount', -1)", (eid,)),
            (psycopg.errors.CheckViolation, "insert into expense_comments (expense_id, body) values (%s, '')", (eid,)),
            (psycopg.errors.CheckViolation, "insert into expense_comments (expense_id, body) values (%s, %s)", (eid, "x" * 301)),
            (psycopg.errors.CheckViolation, "insert into wallet_activity (wallet_id, action) values (%s, 'expense_rename')", (wid,)),
            (psycopg.errors.ForeignKeyViolation, "insert into expense_item_people values (gen_random_uuid(), %s)", (a,)),
        ]
        for error, sql, args in bad:
            with pytest.raises(error):
                conn.execute(sql, args)
        # the bounds themselves are allowed
        conn.execute("insert into expense_inputs values (%s, %s, -10000000)", (eid, a))
        conn.execute("insert into expense_inputs values (%s, %s, 10000000)", (eid, b))
        conn.execute("insert into expense_items (expense_id, seq, name, price_centavos) values (%s, 40, %s, 0)", (eid, "x" * 40))
        conn.execute("insert into expense_comments (expense_id, body) values (%s, %s)", (eid, "x" * 300))
        conn.execute("insert into expense_item_people values (%s, %s)", (iid, a))
        for action in ("expense_add", "expense_edit", "expense_delete", "comment_add", "comment_delete", "settle", "settle_undo",
                       "proof_add", "proof_change", "proof_remove", "member_join"):
            conn.execute("insert into wallet_activity (wallet_id, action) values (%s, %s)", (wid, action))


def test_cascades_keep_the_history(dsn):
    """A member's rows go with the member, and the comment and activity lines keep with no actor. An expense's rows go
    with the expense, and its activity lines stay (no FK). Only the wallet's delete removes the activity."""
    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        wid, a, b, eid = make(conn)
        conn.execute("insert into expense_inputs values (%s, %s, 1), (%s, %s, 1)", (eid, a, eid, b))
        conn.execute("insert into expense_payers values (%s, %s, 600), (%s, %s, 400)", (eid, a, eid, b))
        iid = conn.execute("insert into expense_items (expense_id, seq, name, price_centavos) values (%s, 1, 'E2E item', 1000) returning id", (eid,)).fetchone()["id"]
        conn.execute("insert into expense_item_people values (%s, %s), (%s, %s)", (iid, a, iid, b))
        conn.execute("insert into expense_charges (expense_id, kind, basis, value) values (%s, 'vat', 'amount', 120)", (eid,))
        conn.execute("insert into expense_comments (expense_id, author, body) values (%s, %s, 'E2E')", (eid, b))
        conn.execute(
            "insert into wallet_activity (wallet_id, actor, action, expense_id, member_id, after) values (%s, %s, 'expense_add', %s, %s, %s)",
            (wid, b, eid, b, Jsonb({"amount": 1000})),
        )
        count = lambda t, where="true": conn.execute(f"select count(*) as n from {t} where {where}").fetchone()["n"]  # noqa: E731
        conn.execute("delete from wallet_members where id = %s", (b,))
        assert (count("expense_inputs"), count("expense_payers"), count("expense_item_people")) == (1, 1, 1)
        assert conn.execute("select author from expense_comments").fetchone()["author"] is None
        assert conn.execute("select actor, member_id, expense_id from wallet_activity").fetchone() == {"actor": None, "member_id": None, "expense_id": eid}
        conn.execute("delete from expenses where id = %s", (eid,))
        for t in ("expense_inputs", "expense_payers", "expense_items", "expense_item_people", "expense_charges", "expense_comments"):
            assert count(t) == 0, t
        assert count("wallet_activity", f"expense_id = '{eid}'") == 1, "a deleted expense's lines stay"
        conn.execute("delete from wallets where id = %s", (wid,))
        assert count("wallet_activity") == 0
