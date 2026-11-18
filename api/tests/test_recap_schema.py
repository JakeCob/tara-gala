"""TG-64: the recap link's four columns on trip_sessions (options.md §3, owner-approved 2026-11-16). Plan §5 G1 to G3:
the migration is built over main's schema.sql from before TG-64 (c360efc) with a made-up trip in it, run twice, with
every later migration applied in name order around it, and must equal a fresh build of schema.sql. The trip reads back
with the recap off and every old column unchanged.
"""

import hashlib
from pathlib import Path

import psycopg
import pytest
from psycopg.rows import dict_row

from conftest import ROOT, build_schema
from test_trip_people import schema_shape

MIGRATIONS = ROOT / "supabase" / "migrations"
MIGRATION = MIGRATIONS / "2026-11-18_tg64_recap_link.sql"
PRE = Path(__file__).parent / "fixtures" / "schema_pre_tg64.sql"
PRE_SHA256 = "d832e6d3c0754375c78921d18dde43239764f328c7d9c6791dd120a4693f9359"  # git show c360efc:supabase/schema.sql
PRE_NEWEST = "2026-11-09_tg61_plan_edits.sql"  # the newest migration at c360efc: everything after it is applied on top
OLD_COLUMNS = "id, share_slug, name, start_date, return_date, itinerary_id, wallet_id, created_at, invite_slug"
INVITE = "ab" * 16  # a made-up invite slug, turned on


def test_fixture_is_mains_schema_before_tg64():
    assert hashlib.sha256(PRE.read_bytes()).hexdigest() == PRE_SHA256
    assert "recap_slug" not in PRE.read_text(encoding="utf-8")


def seed(conn) -> None:
    """Two made-up trips, one with its invite turned on."""
    conn.execute("insert into trip_sessions (name, start_date, return_date) values ('E2E made up trip', '2026-11-06', '2026-11-08')")
    conn.execute(
        "insert into trip_sessions (name, start_date, return_date, invite_slug) values ('E2E second trip', '2026-12-01', '2026-12-03', %s)",
        (INVITE,),
    )


def test_migration_over_pre_tg64_schema_with_rows_matches_schema_sql(dsn):  # G1
    build_schema(PRE.read_text(encoding="utf-8"))
    sql = MIGRATION.read_text(encoding="utf-8")
    later = sorted(m for m in MIGRATIONS.glob("*.sql") if m.name > PRE_NEWEST and m != MIGRATION)
    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        seed(conn)
        before = conn.execute(f"select {OLD_COLUMNS} from trip_sessions order by name").fetchall()
        for m in sorted([*later, MIGRATION, MIGRATION], key=lambda p: p.name):  # TG-64's twice: re-runnable
            conn.execute(sql if m == MIGRATION else m.read_text(encoding="utf-8"))
        assert conn.execute(f"select {OLD_COLUMNS} from trip_sessions order by name").fetchall() == before
        assert conn.execute(
            "select recap_slug, recap_photos, recap_people, recap_spending from trip_sessions order by name"
        ).fetchall() == [{"recap_slug": None, "recap_photos": False, "recap_people": "none", "recap_spending": "none"}] * 2
    upgraded = schema_shape(dsn)
    build_schema((ROOT / "supabase" / "schema.sql").read_text(encoding="utf-8"))
    assert upgraded == schema_shape(dsn)  # columns, defaults, checks, foreign keys and cascades, indexes, RLS, policies


def test_migration_is_a_no_op_on_schema_sql(dsn):  # G2
    before = schema_shape(dsn)
    sql = MIGRATION.read_text(encoding="utf-8")
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(sql)
        conn.execute(sql)
    assert schema_shape(dsn) == before


@pytest.mark.parametrize(
    "column, value",
    [
        ("recap_spending", "per_person"),  # owner decision 7: the total only
        ("recap_people", "all"),
        ("recap_slug", "a" * 31),
        ("recap_slug", "A" * 32),
    ],
)
def test_checks_refuse_bad_values(dsn, column, value):  # G3
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute("insert into trip_sessions (name, start_date, return_date) values ('E2E made up trip', '2026-11-06', '2026-11-08')")
        with pytest.raises(psycopg.errors.CheckViolation):
            conn.execute(f"update trip_sessions set {column} = %s", (value,))


def test_the_recap_slug_is_unique(dsn):
    with psycopg.connect(dsn, autocommit=True) as conn:
        for name in ("E2E one", "E2E two"):
            conn.execute("insert into trip_sessions (name, start_date, return_date) values (%s, '2026-11-06', '2026-11-08')", (name,))
        conn.execute("update trip_sessions set recap_slug = %s where name = 'E2E one'", ("cd" * 16,))
        with pytest.raises(psycopg.errors.UniqueViolation):
            conn.execute("update trip_sessions set recap_slug = %s where name = 'E2E two'", ("cd" * 16,))
