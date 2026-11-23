"""TG-73 P0: the Ipon goal migration (plan §6, owner yes 2026-11-23, owner-questions.md Q1). Test-plan §2.

It's built over main's schema.sql from before TG-73 (99db257) with rows in it, run twice, and must equal a fresh build of
schema.sql. The old rows read back unchanged and _load's balances are those of the old rows. Not applied anywhere but
the throwaway local database.
"""

import hashlib
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg.rows import dict_row

from app import wallets
from conftest import ROOT, build_schema
from test_itineraries_rls import ensure_role, scalar_as
from test_tg66_migration import balances_from, old_rows, seed
from test_trip_people import schema_shape

MIGRATIONS = ROOT / "supabase" / "migrations"
MIGRATION = MIGRATIONS / "2026-11-29_tg73_pot.sql"
PRE = Path(__file__).parent / "fixtures" / "schema_pre_tg73.sql"
PRE_SHA256 = "c44cdcfb60e079a48217c558b0c3631e8e0c47758ee8fb751e222a612275c897"  # git show 99db257:supabase/schema.sql
PRE_NEWEST = "2026-11-19_tg62_expense_budget_key.sql"  # the newest migration at 99db257
NEW_TABLES = ("pot_ambag", "pot_people", "wallet_pots", "wallet_qrs")
OLD_MODES = ("equal", "exact", "percent", "shares", "adjust", "itemized")
OLD_ACTIONS = ("expense_add", "expense_edit", "expense_delete", "comment_add", "comment_delete", "settle", "settle_undo",
               "proof_add", "proof_change", "proof_remove", "member_join")
POT_ACTIONS = ("pot_on", "pot_edit", "pot_off", "pot_person", "ambag_sent", "ambag_received", "ambag_unreceive",
               "ambag_undo", "ambag_back", "ambag_proof_add", "ambag_proof_change", "ambag_proof_remove", "pot_handover",
               "pot_close", "pot_reopen")


def test_fixture_is_mains_schema_before_tg73():
    assert hashlib.sha256(PRE.read_bytes()).hexdigest() == PRE_SHA256
    assert "wallet_pots" not in PRE.read_text(encoding="utf-8")
    assert sorted(m.name for m in MIGRATIONS.glob("*.sql") if m.name <= PRE_NEWEST)[-1] == PRE_NEWEST


def test_migration_sorts_last():  # every older migration test applies `later` in name order, this one at the end
    assert MIGRATION.name > PRE_NEWEST
    assert sorted(m.name for m in MIGRATIONS.glob("*.sql"))[-1] == MIGRATION.name


def test_the_plan_counts_15_pot_actions():
    assert len(POT_ACTIONS) == 15 and not set(POT_ACTIONS) & set(OLD_ACTIONS)


def test_migration_over_pre_tg73_schema_with_rows_matches_schema_sql(dsn):
    build_schema(PRE.read_text(encoding="utf-8"))
    sql = MIGRATION.read_text(encoding="utf-8")
    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        wids = seed(conn)
        conn.execute("update expenses set split_mode = 'equal' where amount_centavos = 1000")  # a TG-66 row as well
        conn.execute("insert into wallet_activity (wallet_id, action) values (%s, 'member_join')", (wids[0],))
        before = old_rows(conn)
        modes = conn.execute("select id, split_mode, category, version, budget_key from expenses order by id").fetchall()
        activity = conn.execute("select * from wallet_activity order by id").fetchall()
        conn.execute(sql)
        conn.execute(sql)  # re-runnable
        assert old_rows(conn) == before
        assert conn.execute("select id, split_mode, category, version, budget_key from expenses order by id").fetchall() == modes
        assert conn.execute("select * from wallet_activity order by id").fetchall() == activity
        for t in NEW_TABLES:
            assert conn.execute(f"select count(*) as n from {t}").fetchone()["n"] == 0, t
        for w in wids:  # today's _load reads the same balances and transfers as the old rows give
            loaded = wallets._load(conn, w)
            want_balances, want_transfers = balances_from(before, w)
            assert [(b.member_id, b.paid_centavos, b.share_centavos, b.net_centavos) for b in loaded.balances] == want_balances
            assert [(t.from_member, t.to_member, t.amount_centavos) for t in loaded.transfers] == want_transfers
    upgraded = schema_shape(dsn)
    build_schema((ROOT / "supabase" / "schema.sql").read_text(encoding="utf-8"))
    assert upgraded == schema_shape(dsn)  # columns, defaults, checks (by name), foreign keys, indexes, RLS, policies


def test_migration_is_a_no_op_on_schema_sql(dsn):
    before = schema_shape(dsn)
    sql = MIGRATION.read_text(encoding="utf-8")
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(sql)
        conn.execute(sql)
    assert schema_shape(dsn) == before


def _check(conn, name: str) -> str:
    row = conn.execute("select pg_get_constraintdef(oid) as d from pg_constraint where conname = %s", (name,)).fetchone()
    assert row is not None, f"no constraint named {name}"
    return row["d"]


def test_the_widened_checks_keep_their_names_and_take_the_new_values(dsn):  # plan §6 "Constraint names"
    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        modes = _check(conn, "expenses_split_mode_check")
        actions = _check(conn, "wallet_activity_action_check")
        for m in (*OLD_MODES, "pot", "libre"):
            assert f"'{m}'::text" in modes
        for a in (*OLD_ACTIONS, *POT_ACTIONS):
            assert f"'{a}'::text" in actions
        wid, a, _b, eid = _make(conn)
        for m in ("pot", "libre", *OLD_MODES):
            conn.execute("update expenses set split_mode = %s where id = %s", (m, eid))
        for action in (*OLD_ACTIONS, *POT_ACTIONS):
            conn.execute("insert into wallet_activity (wallet_id, action) values (%s, %s)", (wid, action))
        with pytest.raises(psycopg.errors.CheckViolation):
            conn.execute("update expenses set split_mode = 'treat' where id = %s", (eid,))
        with pytest.raises(psycopg.errors.CheckViolation):
            conn.execute("insert into wallet_activity (wallet_id, action) values (%s, 'pot_rename')", (wid,))


def test_new_tables_are_api_only(dsn):
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        rls = conn.execute(
            "select c.relname, c.relrowsecurity, c.relforcerowsecurity, count(p.policyname) as policies from pg_class c"
            " left join pg_policies p on p.tablename = c.relname where c.relnamespace = 'public'::regnamespace and c.relname = any(%s)"
            " group by 1, 2, 3 order by 1",
            (list(NEW_TABLES),),
        ).fetchall()
    assert rls == [{"relname": t, "relrowsecurity": True, "relforcerowsecurity": False, "policies": 0} for t in NEW_TABLES]


def test_anon_reads_no_pot_row(dsn):  # as test_itineraries_rls: Supabase-like grants, then a select as anon
    with psycopg.connect(dsn, autocommit=True) as conn:
        for role in ("anon", "authenticated"):
            ensure_role(conn, role)
        conn.execute("grant usage on schema public to anon, authenticated")
        conn.execute("grant all on all tables in schema public to anon, authenticated")
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        wid, a, b, _eid = _make(conn)
        _pot(conn, wid, a, [a, b])
        conn.commit()
    with psycopg.connect(dsn) as conn:
        for role in ("anon", "authenticated"):
            for t in NEW_TABLES:
                assert scalar_as(conn, role, f"select count(*) from {t}") == 0, (role, t)


def _make(conn):
    wid = conn.execute("insert into wallets (name) values ('E2E made up wallet') returning id").fetchone()["id"]
    a, b = (conn.execute("insert into wallet_members (wallet_id, name) values (%s, %s) returning id", (wid, n)).fetchone()["id"]
            for n in ("Ana", "Ben"))
    eid = conn.execute("insert into expenses (wallet_id, paid_by, amount_centavos, note) values (%s, %s, 1000, 'E2E') returning id",
                       (wid, a)).fetchone()["id"]
    return wid, a, b, eid


def _pot(conn, wid, treasurer, people):
    conn.execute("insert into wallet_pots (wallet_id, each_centavos, due_date, treasurer) values (%s, 800000, '2026-11-20', %s)",
                 (wid, treasurer))
    for m in people:
        conn.execute("insert into pot_people (wallet_id, member_id) values (%s, %s)", (wid, m))
    conn.execute("insert into pot_ambag (wallet_id, member_id, amount_centavos, status) values (%s, %s, 500000, 'sent')", (wid, people[-1]))
    conn.execute("insert into pot_ambag (wallet_id, member_id, amount_centavos, status, received_at) values (%s, %s, 800000, 'received', now())",
                 (wid, treasurer))
    conn.execute("insert into wallet_qrs (member_id, wallet_id, storage_path, content_type, bytes) values (%s, %s, %s, 'image/png', 10)",
                 (treasurer, wid, f"wallets/{wid}/qr/{uuid4()}"))


def test_defaults(dsn):
    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        wid, a, b, _eid = _make(conn)
        _pot(conn, wid, a, [a, b])
        pot = conn.execute("select name, version, closed_at, created_at is not null as at from wallet_pots").fetchone()
        assert pot == {"name": None, "version": 1, "closed_at": None, "at": True}
        assert {(r["target_centavos"], r["in_goal"]) for r in conn.execute("select * from pot_people")} == {(None, True)}
        assert {r["kind"] for r in conn.execute("select kind from pot_ambag")} == {"in"}
        assert conn.execute("select delete_after from wallet_qrs").fetchone() == {"delete_after": None}


def test_constraints_refuse_bad_rows(dsn):
    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        wid, a, b, _eid = _make(conn)
        _pot(conn, wid, a, [a])
        other = conn.execute("insert into wallets (name) values ('E2E other') returning id").fetchone()["id"]
        ins_ambag = "insert into pot_ambag (wallet_id, member_id, kind, amount_centavos, status, received_at, proof_path, proof_type, proof_bytes, proof_at) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)"
        ok = (wid, a, "in", 1, "sent", None, None, None, None, None)

        def amb(**kw):
            names = ("wallet_id", "member_id", "kind", "amount", "status", "received_at", "proof_path", "proof_type", "proof_bytes", "proof_at")
            row = dict(zip(names, ok))
            row.update(kw)
            return ins_ambag, tuple(row[n] for n in names)

        now = "2026-11-20T00:00:00+08:00"
        bad = [
            (psycopg.errors.CheckViolation, "update wallet_pots set each_centavos = 99 where wallet_id = %s", (wid,)),
            (psycopg.errors.CheckViolation, "update wallet_pots set each_centavos = 10000001 where wallet_id = %s", (wid,)),
            (psycopg.errors.CheckViolation, "update wallet_pots set name = '' where wallet_id = %s", (wid,)),
            (psycopg.errors.CheckViolation, "update wallet_pots set name = %s where wallet_id = %s", ("x" * 41, wid)),
            (psycopg.errors.CheckViolation, "update wallet_pots set version = 0 where wallet_id = %s", (wid,)),
            (psycopg.errors.NotNullViolation, "update wallet_pots set due_date = null where wallet_id = %s", (wid,)),
            (psycopg.errors.ForeignKeyViolation, "update wallet_pots set treasurer = gen_random_uuid() where wallet_id = %s", (wid,)),
            (psycopg.errors.UniqueViolation,
             "insert into wallet_pots (wallet_id, each_centavos, due_date, treasurer) values (%s, 100, '2026-11-20', %s)", (wid, a)),
            (psycopg.errors.ForeignKeyViolation, "insert into pot_people (wallet_id, member_id) values (%s, %s)", (other, a)),  # no pot there
            (psycopg.errors.UniqueViolation, "insert into pot_people (wallet_id, member_id) values (%s, %s)", (wid, a)),
            (psycopg.errors.CheckViolation, "update pot_people set target_centavos = -1 where member_id = %s", (a,)),
            (psycopg.errors.CheckViolation, "update pot_people set target_centavos = 10000001 where member_id = %s", (a,)),
            (psycopg.errors.CheckViolation, *amb(status="received")),  # received without received_at
            (psycopg.errors.CheckViolation, *amb(received_at=now)),  # sent with received_at
            (psycopg.errors.CheckViolation, *amb(kind="back")),  # a give-back that's only sent
            (psycopg.errors.CheckViolation, *amb(kind="gift")),
            (psycopg.errors.CheckViolation, *amb(status="pending")),
            (psycopg.errors.CheckViolation, *amb(amount=0)),
            (psycopg.errors.CheckViolation, *amb(amount=10000001)),
            (psycopg.errors.CheckViolation, *amb(proof_path="p", proof_type="image/png", proof_at=now)),  # no bytes
            (psycopg.errors.CheckViolation, *amb(proof_path="p", proof_type="image/png", proof_bytes=1)),  # no proof_at
            (psycopg.errors.CheckViolation, *amb(proof_type="image/png", proof_bytes=1, proof_at=now)),  # no path
            (psycopg.errors.CheckViolation, *amb(proof_path="p", proof_type="text/html", proof_bytes=1, proof_at=now)),
            (psycopg.errors.CheckViolation, *amb(proof_path="p", proof_type="image/png", proof_bytes=5242881, proof_at=now)),
            (psycopg.errors.ForeignKeyViolation, *amb(wallet_id=other)),
            (psycopg.errors.UniqueViolation,
             "insert into wallet_qrs (member_id, wallet_id, storage_path, content_type, bytes) values (%s, %s, 'q', 'image/png', 1)", (a, wid)),
            (psycopg.errors.CheckViolation,
             "insert into wallet_qrs (member_id, wallet_id, storage_path, content_type, bytes) values (%s, %s, 'q', 'image/svg+xml', 1)", (b, wid)),
            (psycopg.errors.CheckViolation,
             "insert into wallet_qrs (member_id, wallet_id, storage_path, content_type, bytes) values (%s, %s, 'q', 'image/png', 0)", (b, wid)),
            (psycopg.errors.NotNullViolation,
             "insert into wallet_qrs (member_id, wallet_id, storage_path, content_type, bytes) values (%s, %s, null, 'image/png', 1)", (b, wid)),
        ]
        for error, sql, args in bad:
            with pytest.raises(error):
                conn.execute(sql, args)
        # the bounds themselves are allowed
        conn.execute("update wallet_pots set each_centavos = 100, name = %s where wallet_id = %s", ("x" * 40, wid))
        conn.execute("update wallet_pots set each_centavos = 10000000 where wallet_id = %s", (wid,))
        conn.execute("update pot_people set target_centavos = 0 where member_id = %s", (a,))
        conn.execute("update pot_people set target_centavos = 10000000 where member_id = %s", (a,))
        conn.execute(*amb(amount=10000000, kind="back", status="received", received_at=now,
                          proof_path="p", proof_type="image/webp", proof_bytes=5242880, proof_at=now))
        with pytest.raises(psycopg.errors.UniqueViolation):  # a proof path is one row's
            conn.execute(*amb(proof_path="p", proof_type="image/png", proof_bytes=1, proof_at=now))


def test_a_wallet_delete_takes_its_pot_people_ambag_and_qrs(dsn):
    """In one statement, which also checks the treasurer's no-action foreign key: the cascade takes the members and the
    pot together, with no FK error."""
    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        wid, a, b, _eid = _make(conn)
        _pot(conn, wid, a, [a, b])
        keep, ka, kb, _ = _make(conn)
        _pot(conn, keep, kb, [ka, kb])
        count = lambda t: conn.execute(f"select count(*) as n from {t}").fetchone()["n"]  # noqa: E731
        assert [count(t) for t in ("wallet_pots", "pot_people", "pot_ambag", "wallet_qrs")] == [2, 4, 4, 2]
        conn.execute("delete from wallets where id = %s", (wid,))
        assert [count(t) for t in ("wallet_pots", "pot_people", "pot_ambag", "wallet_qrs")] == [1, 2, 2, 1]
        assert conn.execute("select wallet_id from wallet_pots").fetchone()["wallet_id"] == keep


def test_the_treasurer_foreign_key_has_no_cascade(dsn):  # members are never deleted; one deleted alone is refused
    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        wid, a, b, _eid = _make(conn)
        _pot(conn, wid, a, [a, b])
        conn.execute("delete from expenses where wallet_id = %s", (wid,))
        with pytest.raises(psycopg.errors.ForeignKeyViolation):
            conn.execute("delete from wallet_members where id = %s", (a,))
        conn.execute("delete from wallet_members where id = %s", (b,))  # anyone else's rows go with them
        assert conn.execute("select count(*) as n from pot_people where member_id = %s", (b,)).fetchone()["n"] == 0


def test_the_new_indexes_by_name(dsn):
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        found = {r["indexname"]: r["indexdef"] for r in conn.execute(
            "select indexname, indexdef from pg_indexes where schemaname = 'public' and indexname = any(%s)",
            (["pot_ambag_wallet", "wallet_qrs_wallet"],),
        )}
    assert found == {
        "pot_ambag_wallet": "CREATE INDEX pot_ambag_wallet ON public.pot_ambag USING btree (wallet_id, created_at DESC)",
        "wallet_qrs_wallet": "CREATE INDEX wallet_qrs_wallet ON public.wallet_qrs USING btree (wallet_id)",
    }
