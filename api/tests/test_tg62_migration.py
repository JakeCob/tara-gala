"""TG-62 G0: the budget line migration (plan §2, owner-approved shapes 2026-11-16; G1, Rev 1 S1).

It's built over main's schema.sql from 889259a (before TG-66 and TG-64) with made-up rows in it. Every migration newer
than PRE_NEWEST runs in name order around TG-62's, which runs twice, so the test holds whichever ticket merges first
(test_tg66_migration.py's `later` pattern). The result must equal a fresh build of schema.sql. Old rows read back with
budget_key null, and _load gives the same wallet.
"""

import hashlib
from pathlib import Path

import psycopg
import pytest
from psycopg.rows import dict_row

from app import wallets
from conftest import ROOT, build_schema
from test_tg66_migration import OLD_COLUMNS, balances_from, old_rows, seed
from test_trip_people import schema_shape

MIGRATIONS = ROOT / "supabase" / "migrations"
MIGRATION = MIGRATIONS / "2026-11-19_tg62_expense_budget_key.sql"
PRE = Path(__file__).parent / "fixtures" / "schema_pre_tg62.sql"
PRE_SHA256 = "d832e6d3c0754375c78921d18dde43239764f328c7d9c6791dd120a4693f9359"  # git show 889259a:supabase/schema.sql
PRE_NEWEST = "2026-11-09_tg61_plan_edits.sql"  # the newest migration at 889259a: everything after it is applied on top


def test_fixture_is_mains_schema_before_tg62():
    assert hashlib.sha256(PRE.read_bytes()).hexdigest() == PRE_SHA256
    assert "budget_key" not in PRE.read_text(encoding="utf-8")
    assert sorted(m.name for m in MIGRATIONS.glob("*.sql") if m.name <= PRE_NEWEST)[-1] == PRE_NEWEST


def test_migration_sorts_after_tg66_and_tg64():  # Rev 1 S1: the name is part of the contract
    assert MIGRATION.exists()
    assert MIGRATION.name > "2026-11-16_tg66_wallet_splits.sql"
    assert MIGRATION.name > "2026-11-18_tg64_recap_link.sql"


def load_all(conn, wids) -> list[dict]:
    return [wallets._load(conn, w).model_dump(mode="json") for w in wids]


def test_migration_over_pre_tg62_schema_with_rows_matches_schema_sql(dsn):  # G1
    build_schema(PRE.read_text(encoding="utf-8"))
    later = sorted(m for m in MIGRATIONS.glob("*.sql") if m.name > PRE_NEWEST and m != MIGRATION)
    assert any(m.name == "2026-11-16_tg66_wallet_splits.sql" for m in later), "TG-66's columns come first: _load reads them"
    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        wids = seed(conn)
        before_rows = old_rows(conn)
        # GA1: _load reads budget_key now, so it can't run before TG-62's migration (as test_tg66_migration's _load
        # needs TG-66's columns). The pre-migration baseline comes from the raw rows instead (manager, 2026-11-18).
        want = {w: balances_from(before_rows, w) for w in wids}
        loaded_before = None
        for m in sorted([*later, MIGRATION, MIGRATION], key=lambda p: p.name):  # TG-62's twice: re-runnable
            conn.execute(m.read_text(encoding="utf-8"))
            if m == MIGRATION and loaded_before is None:  # after TG-62's first run: the raw rows' own balances
                loaded_before = load_all(conn, wids)
                for w in wids:
                    first = wallets._load(conn, w, budget=True)
                    assert ([(b.member_id, b.paid_centavos, b.share_centavos, b.net_centavos) for b in first.balances],
                            [(t.from_member, t.to_member, t.amount_centavos) for t in first.transfers]) == want[w]
                    # tg-test: the null default through _load: Not sorted yet, and no trip so no budget
                    assert first.budget is None and all(e.budget_key is None for e in first.expenses)
        # Old rows: budget_key null (Not sorted yet), and nothing else moved
        assert conn.execute("select distinct budget_key from expenses").fetchall() == [{"budget_key": None}]
        assert conn.execute("select count(*) as n from expenses").fetchone()["n"] == 4
        assert old_rows(conn) == before_rows
        # _load gives the same wallet, and its balances are still the old rows' own
        assert load_all(conn, wids) == loaded_before
        for w in wids:
            loaded = wallets._load(conn, w)
            assert {e.budget_key for e in loaded.expenses} == {None}
            assert loaded.budget is None
            want_balances, want_transfers = balances_from(before_rows, w)
            assert [(b.member_id, b.paid_centavos, b.share_centavos, b.net_centavos) for b in loaded.balances] == want_balances
            assert [(t.from_member, t.to_member, t.amount_centavos) for t in loaded.transfers] == want_transfers
    upgraded = schema_shape(dsn)
    build_schema((ROOT / "supabase" / "schema.sql").read_text(encoding="utf-8"))
    assert upgraded == schema_shape(dsn)  # columns (and their order), checks, indexes, RLS, policies


def test_migration_is_a_no_op_on_schema_sql(dsn):
    before = schema_shape(dsn)
    sql = MIGRATION.read_text(encoding="utf-8")
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(sql)
        conn.execute(sql)
    assert schema_shape(dsn) == before


def test_the_column_is_nullable_text_last_in_expenses(dsn):
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        cols = conn.execute(
            "select column_name, data_type, is_nullable, column_default from information_schema.columns"
            " where table_schema = 'public' and table_name = 'expenses' order by ordinal_position"
        ).fetchall()
    assert cols[-1] == {"column_name": "budget_key", "data_type": "text", "is_nullable": "YES", "column_default": None}
    assert [c["column_name"] for c in cols[: len(OLD_COLUMNS["expenses"].split(", "))]] == OLD_COLUMNS["expenses"].split(", ")


def make_expense(conn):
    wid = conn.execute("insert into wallets (name) values ('E2E made up wallet') returning id").fetchone()["id"]
    a = conn.execute("insert into wallet_members (wallet_id, name) values (%s, 'Ana') returning id", (wid,)).fetchone()["id"]
    return conn.execute(
        "insert into expenses (wallet_id, paid_by, amount_centavos, note) values (%s, %s, 1000, 'E2E') returning id", (wid, a)
    ).fetchone()["id"]


@pytest.mark.parametrize("bad", ["Meals", "1meals", "m" * 22, "_other", "m", "meals_2", "meals 2", "", "-meals", "méals"])
def test_the_check_refuses_bad_keys(dsn, bad):  # G1
    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        eid = make_expense(conn)
        with pytest.raises(psycopg.errors.CheckViolation):
            conn.execute("update expenses set budget_key = %s where id = %s", (bad, eid))


@pytest.mark.parametrize("good", ["_none", "meals-2", "meals", "ab", "m" * 21, "line-1", None])
def test_the_check_accepts_keys_none_and_null(dsn, good):  # G1
    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        eid = make_expense(conn)
        conn.execute("update expenses set budget_key = %s where id = %s", (good, eid))
        assert conn.execute("select budget_key from expenses where id = %s", (eid,)).fetchone()["budget_key"] == good


def test_the_check_constraint_by_name(dsn):  # the migration drops and re-adds it by this name
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        found = conn.execute(
            "select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'expenses_budget_key_check'"
        ).fetchall()
    assert len(found) == 1
    assert "budget_key" in found[0]["d"] and "_none" in found[0]["d"]
