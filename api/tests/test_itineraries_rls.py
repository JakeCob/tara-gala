"""TG-32: itineraries must not be publicly listable. Itinerary rows below are made up for tests only.

The throwaway Postgres has no Supabase roles, so the tests create `anon` and `authenticated`
(plus `tg32_owner`) and grant them Supabase-like privileges. Roles are cluster-wide and shared
with other builders' databases: create them race-safe, never drop them.
"""

import re

import psycopg
import pytest
from psycopg import sql

from conftest import ROOT

MIGRATIONS = ROOT / "supabase" / "migrations"
MIGRATION = MIGRATIONS / "2026-10-28_tg32_drop_itineraries_public_read.sql"
SCHEMA = ROOT / "supabase" / "schema.sql"

CLIENT_ROLES = ["anon", "authenticated"]
PUBLIC_TABLES = {"operators", "terminals", "operator_terminals", "routes", "trips", "spots", "last_mile_routes"}
OLD_POLICY = "create policy public_read on itineraries for select using (true)"


def ensure_role(conn, name):
    try:
        conn.execute(
            sql.SQL(
                "do $$ begin create role {} nologin; "
                "exception when duplicate_object or unique_violation then null; end $$"
            ).format(sql.Identifier(name))
        )
    except psycopg.errors.InsufficientPrivilege:
        pytest.fail("TEST_DATABASE_URL must be the tg-pg superuser (needs create role)")
    attrs = conn.execute("select rolsuper, rolbypassrls from pg_roles where rolname = %s", (name,)).fetchone()
    assert attrs == (False, False), f"role {name} must be nosuperuser nobypassrls, got (rolsuper, rolbypassrls) = {attrs}"


def set_role(conn, role):
    conn.execute(sql.SQL("set local role {}").format(sql.Identifier(role)))


def scalar_as(conn, role, query, params=None):
    with conn.transaction():
        set_role(conn, role)
        return conn.execute(query, params).fetchone()[0]


def insert_itinerary(conn):
    return conn.execute(
        """insert into itineraries (trip_date, return_date, party, vibe, plan, model)
           values ('2026-11-06', '2026-11-08', '[{"type":"adult","name":"Test Person (made up)"}]',
                   'chill', '{"outbound": null, "days": []}', 'test')
           returning share_slug"""
    ).fetchone()[0]


def snapshot(conn, slug):
    return conn.execute(
        "select vibe, party, plan from itineraries where share_slug = %s", (slug,)
    ).fetchone()


def policy_set(conn):
    rows = conn.execute(
        "select tablename, policyname, cmd, roles, qual from pg_policies where schemaname = 'public'"
    ).fetchall()
    return {(t, p, c, tuple(r), q) for t, p, c, r, q in rows}


@pytest.fixture()
def conn(dsn):
    with psycopg.connect(dsn, autocommit=True) as c:
        for role in CLIENT_ROLES:
            ensure_role(c, role)
        c.execute("grant usage on schema public to anon, authenticated")
        c.execute("grant all on all tables in schema public to anon, authenticated")
        yield c


# T32-1 (B1)
def test_fresh_schema_has_no_itineraries_policy(conn):
    assert conn.execute("select count(*) from pg_policies where tablename = 'itineraries'").fetchone()[0] == 0
    rls = conn.execute(
        "select relrowsecurity, relforcerowsecurity from pg_class where oid = 'public.itineraries'::regclass"
    ).fetchone()
    assert rls == (True, False)
    assert conn.execute("select count(*) from pg_policies where tablename = 'trip_reports'").fetchone()[0] == 0


# T32-2 (B2)
@pytest.mark.parametrize("role", CLIENT_ROLES)
def test_anon_cannot_select_itineraries(conn, role):
    slug = insert_itinerary(conn)
    assert scalar_as(conn, role, "select count(*) from itineraries") == 0
    assert scalar_as(conn, role, "select count(*) from itineraries where share_slug = %s", (slug,)) == 0


# T32-3 (B3), characterisation: the old policy was select-only
@pytest.mark.parametrize("role", CLIENT_ROLES)
def test_anon_cannot_write_itineraries(conn, role):
    slug = insert_itinerary(conn)
    before = snapshot(conn, slug)

    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with conn.transaction():
            set_role(conn, role)
            insert_itinerary(conn)

    with conn.transaction():
        set_role(conn, role)
        assert conn.execute("update itineraries set vibe = 'x'").rowcount == 0
        assert conn.execute("delete from itineraries").rowcount == 0

    assert snapshot(conn, slug) == before
    assert conn.execute("select count(*) from itineraries").fetchone()[0] == 1


# T32-4 (B4), guard: the block comes from the missing policy, not RLS breaking everything
@pytest.mark.parametrize("role", CLIENT_ROLES)
def test_anon_still_reads_reference_data(conn, role):
    assert scalar_as(conn, role, "select count(*) from terminals") == 12
    for table in ("trip_search", "spots", "last_mile_routes"):
        assert scalar_as(conn, role, f"select count(*) from {table}") == 0, table


# T32-5 (B5), guard: the API's DATABASE_URL path still reads by slug
def test_connecting_role_still_reads_itinerary_by_slug(conn):
    slug = insert_itinerary(conn)
    row = conn.execute("select share_slug, party from itineraries where share_slug = %s", (slug,)).fetchone()
    assert row is not None and row[0] == slug

    why = conn.execute(
        """select r.rolsuper, r.rolbypassrls, c.relowner = r.oid, c.relforcerowsecurity
           from pg_roles r, pg_class c
           where r.rolname = current_user and c.oid = 'public.itineraries'::regclass"""
    ).fetchone()
    superuser, bypassrls, owner, force = why
    assert force is False
    assert superuser or bypassrls or owner, f"(rolsuper, rolbypassrls, owns itineraries) = {why[:3]}"


# T32-5b (B5), guard: Supabase's postgres user reads as table owner, not as superuser
def test_non_superuser_table_owner_still_reads(conn):
    ensure_role(conn, "tg32_owner")
    conn.execute("grant usage on schema public to tg32_owner")
    conn.execute("alter table itineraries owner to tg32_owner")
    slug = insert_itinerary(conn)
    assert scalar_as(conn, "tg32_owner", "select count(*) from itineraries where share_slug = %s", (slug,)) == 1


# T32-6 (B6), plus review should-fix 1: old install + migration == fresh install from schema.sql
def test_migration_fixes_an_old_install(conn):
    fresh_policies = policy_set(conn)  # the dsn fixture built this schema from schema.sql only
    insert_itinerary(conn)

    conn.execute(
        f"""do $$ begin
              if not exists (select 1 from pg_policies where tablename = 'itineraries' and policyname = 'public_read')
              then {OLD_POLICY}; end if;
            end $$"""
    )
    assert scalar_as(conn, "anon", "select count(*) from itineraries") == 1  # the bug, reproduced

    with conn.transaction():
        conn.execute(MIGRATION.read_text(encoding="utf-8"))

    assert scalar_as(conn, "anon", "select count(*) from itineraries") == 0
    assert conn.execute("select count(*) from pg_policies where tablename = 'itineraries'").fetchone()[0] == 0
    assert policy_set(conn) == fresh_policies


# T32-7 (B7)
def test_migration_is_idempotent_and_leaves_other_policies(conn):
    migration = MIGRATION.read_text(encoding="utf-8")
    conn.execute(migration)
    conn.execute(migration)
    tables = {
        r[0]
        for r in conn.execute(
            "select tablename from pg_policies where schemaname = 'public' and policyname = 'public_read'"
        ).fetchall()
    }
    assert tables == PUBLIC_TABLES


# T32-8 (B8)
def test_migration_filenames_follow_convention():
    assert MIGRATIONS.is_dir(), f"{MIGRATIONS} is missing"
    files = sorted(MIGRATIONS.glob("*.sql"))
    assert files, "no migrations yet"
    for f in sorted(MIGRATIONS.iterdir()):
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}_tg\d+_[a-z0-9_]+\.sql", f.name), f.name
    for f in files:
        text = f.read_text(encoding="utf-8")
        header = "\n".join(line for line in text.splitlines() if line.startswith("--"))
        assert text.startswith("-- TG-"), f.name
        assert "safe to re-run" in header.lower(), f.name


# T32-9 (B1)
def test_schema_sql_text():
    schema = SCHEMA.read_text(encoding="utf-8")
    policy = re.search(r"create\s+policy\s+\w+\s+on\s+(public\.)?itineraries\b", schema, re.I)
    assert policy is None, f"schema.sql still has: {policy and policy.group(0)}"
    assert re.search(r"alter\s+table\s+itineraries\s+enable\s+row\s+level\s+security", schema, re.I)
    for f in (ROOT / "supabase").rglob("*.sql"):
        assert not re.search(r"force\s+row\s+level\s+security", f.read_text(encoding="utf-8"), re.I), f.name
    view = re.search(r"create\s+view\s+trip_search.*?;", schema, re.I | re.S)
    assert view and "itineraries" not in view.group(0)
