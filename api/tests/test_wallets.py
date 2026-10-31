"""TG-50 shared trip wallets: who paid what, the split, and the settle-up. Names and notes here are made up.

A wallet is private by link: its tables have RLS on with no policy, and the API reads and writes them through
DATABASE_URL. Money is whole centavos everywhere, so every split adds up exactly.
"""

import logging
from uuid import UUID, uuid4

import psycopg
import pytest

from app import wallets as w
from app.limits import RateLimiter
from conftest import ROOT

MIGRATION = ROOT / "supabase" / "migrations" / "2026-10-31_tg50_trip_wallets.sql"
TABLES = ["wallets", "wallet_members", "expenses", "expense_shares", "settlements"]
ORIGIN = "http://localhost:3000"


# ---------------------------------------------------------------- pure: split and settle-up

def test_equal_split_adds_up_and_leftover_centavos_go_to_the_payer_first():
    a, b, c = uuid4(), uuid4(), uuid4()
    assert w.split_equal(90000, [a, b, c], payer=a) == {a: 30000, b: 30000, c: 30000}
    assert w.split_equal(1000, [a, b, c], payer=b) == {b: 334, a: 333, c: 333}
    assert w.split_equal(1001, [a, b, c], payer=a) == {a: 334, b: 334, c: 333}
    # The payer isn't sharing: leftovers go in list order
    assert w.split_equal(1001, [b, c], payer=a) == {b: 501, c: 500}
    for amount in (1, 2, 99, 100001):
        assert sum(w.split_equal(amount, [a, b, c], payer=c).values()) == amount


def test_settle_up_uses_the_fewest_payments_and_is_deterministic():
    a, b, c, d = uuid4(), uuid4(), uuid4(), uuid4()
    order = [a, b, c, d]
    assert w.settle_up({a: 60000, b: -30000, c: -30000, d: 0}, order) == [(b, a, 30000), (c, a, 30000)]
    assert w.settle_up({a: 0, b: 0, c: 0, d: 0}, order) == []
    # Largest debtor pays the largest creditor first
    assert w.settle_up({a: 500, b: 300, c: -700, d: -100}, order) == [(c, a, 500), (c, b, 200), (d, b, 100)]
    with pytest.raises(ValueError):
        w.settle_up({a: 1, b: 0, c: 0, d: 0}, order)  # nets that don't sum to zero are a bug upstream


# ---------------------------------------------------------------- API helpers

def create(client, name="Baguio Nov 6", members=("Jacob", "Ana", "Ben")):
    r = client.post("/wallets", json={"name": name, "members": list(members)})
    assert r.status_code == 201, r.text
    return r.json()


def ids(wallet):
    return {m["name"]: m["id"] for m in wallet["members"]}


def add(client, slug, **body):
    return client.post(f"/wallets/{slug}/expenses", json=body)


@pytest.fixture(autouse=True)
def fresh_limiters(monkeypatch):
    # Limits live in process memory; give each test its own so they don't leak between tests
    monkeypatch.setattr(w, "CREATE_LIMITER", RateLimiter(w.CREATE_PER_HOUR))
    monkeypatch.setattr(w, "WRITE_LIMITER", RateLimiter(w.WRITES_PER_HOUR))


# ---------------------------------------------------------------- create and read

def test_create_returns_a_long_secret_slug_and_an_empty_ledger(client):
    wallet = create(client)
    assert len(wallet["share_slug"]) == 32 and int(wallet["share_slug"], 16) >= 0, "128 random bits, hex"
    assert wallet["name"] == "Baguio Nov 6"
    assert [m["name"] for m in wallet["members"]] == ["Jacob", "Ana", "Ben"], "members keep the order given"
    assert wallet["expenses"] == [] and wallet["settlements"] == [] and wallet["transfers"] == []
    assert wallet["total_centavos"] == 0
    assert all(b["net_centavos"] == 0 for b in wallet["balances"])
    got = client.get(f"/wallets/{wallet['share_slug']}")
    assert got.status_code == 200
    assert got.json() == wallet
    assert got.headers["cache-control"] == "private, no-cache"
    assert got.headers["x-robots-tag"] == "noindex"


@pytest.mark.parametrize(
    "body",
    [
        {"name": "", "members": ["A"]},
        {"name": "x" * 41, "members": ["A"]},
        {"name": "Trip", "members": []},
        {"name": "Trip", "members": [""]},
        {"name": "Trip", "members": ["x" * 31]},
        {"name": "Trip", "members": [f"P{i}" for i in range(21)]},
        {"name": "Trip", "members": ["Ana", " ana "]},
    ],
)
def test_create_rejects_bad_names_and_parties(client, body):
    assert client.post("/wallets", json=body).status_code == 422


def test_names_are_trimmed(client):
    wallet = create(client, name="  Baguio  ", members=("  Jacob ", "Ana"))
    assert wallet["name"] == "Baguio"
    assert [m["name"] for m in wallet["members"]] == ["Jacob", "Ana"]


@pytest.mark.parametrize("slug", ["nope", "0" * 32, "G" * 32, "A" * 32, "x" * 200])
def test_unknown_or_malformed_slugs_are_404(client, slug):
    r = client.get(f"/wallets/{slug}")
    assert r.status_code == 404
    assert r.headers["x-robots-tag"] == "noindex"


def test_create_is_rate_limited_per_ip(client, monkeypatch):
    monkeypatch.setattr(w, "CREATE_LIMITER", RateLimiter(2))
    create(client)
    create(client)
    r = client.post("/wallets", json={"name": "Third", "members": ["A"]})
    assert r.status_code == 429
    assert int(r.headers["retry-after"]) > 0


# ---------------------------------------------------------------- expenses

def test_an_equal_expense_splits_among_the_chosen_people_and_the_payer_is_owed(client):
    wallet = create(client)
    slug, m = wallet["share_slug"], ids(wallet)
    r = add(client, slug, paid_by=m["Jacob"], amount_centavos=90000, note="Taxi to Burnham", split_among=list(m.values()))
    assert r.status_code == 201, r.text
    wallet = r.json()
    [expense] = wallet["expenses"]
    assert expense["note"] == "Taxi to Burnham" and expense["paid_by"] == m["Jacob"] and expense["amount_centavos"] == 90000
    assert sorted(s["share_centavos"] for s in expense["shares"]) == [30000, 30000, 30000]
    net = {b["member_id"]: b["net_centavos"] for b in wallet["balances"]}
    assert net == {m["Jacob"]: 60000, m["Ana"]: -30000, m["Ben"]: -30000}
    paid = {b["member_id"]: b["paid_centavos"] for b in wallet["balances"]}
    assert paid[m["Jacob"]] == 90000 and paid[m["Ana"]] == 0
    assert wallet["total_centavos"] == 90000
    assert wallet["transfers"] == [
        {"from_member": m["Ana"], "to_member": m["Jacob"], "amount_centavos": 30000},
        {"from_member": m["Ben"], "to_member": m["Jacob"], "amount_centavos": 30000},
    ]


def test_a_custom_expense_must_add_up(client):
    wallet = create(client)
    slug, m = wallet["share_slug"], ids(wallet)
    shares = [{"member_id": m["Ana"], "share_centavos": 70000}, {"member_id": m["Ben"], "share_centavos": 20000}]
    r = add(client, slug, paid_by=m["Jacob"], amount_centavos=90000, note="Dinner", shares=shares)
    assert r.status_code == 201, r.text
    net = {b["member_id"]: b["net_centavos"] for b in r.json()["balances"]}
    assert net == {m["Jacob"]: 90000, m["Ana"]: -70000, m["Ben"]: -20000}
    short = [{"member_id": m["Ana"], "share_centavos": 70000}, {"member_id": m["Ben"], "share_centavos": 10000}]
    bad = add(client, slug, paid_by=m["Jacob"], amount_centavos=90000, note="Dinner", shares=short)
    assert bad.status_code == 422
    assert bad.json()["detail"] == "shares_mismatch"


@pytest.mark.parametrize(
    "change",
    [
        {"amount_centavos": 0},
        {"amount_centavos": -5},
        {"amount_centavos": 10_000_001},
        {"note": ""},
        {"note": "x" * 61},
        {"split_among": []},
        {"split_among": None, "shares": None},
    ],
)
def test_expense_validation(client, change):
    wallet = create(client)
    slug, m = wallet["share_slug"], ids(wallet)
    body = {"paid_by": m["Jacob"], "amount_centavos": 1000, "note": "Taho", "split_among": [m["Ana"]]}
    body.update(change)
    body = {k: v for k, v in body.items() if v is not None}
    assert add(client, slug, **body).status_code == 422


def test_both_split_kinds_at_once_is_rejected(client):
    wallet = create(client)
    slug, m = wallet["share_slug"], ids(wallet)
    r = add(client, slug, paid_by=m["Jacob"], amount_centavos=1000, note="Taho", split_among=[m["Ana"]],
            shares=[{"member_id": m["Ana"], "share_centavos": 1000}])
    assert r.status_code == 422


def test_people_from_another_wallet_cant_be_used(client):
    mine, theirs = create(client), create(client, name="Other trip", members=("Zed",))
    slug, m, zed = mine["share_slug"], ids(mine), ids(theirs)["Zed"]
    assert add(client, slug, paid_by=zed, amount_centavos=1000, note="x", split_among=[m["Ana"]]).status_code == 422
    assert add(client, slug, paid_by=m["Ana"], amount_centavos=1000, note="x", split_among=[zed]).status_code == 422
    assert add(client, slug, paid_by=str(uuid4()), amount_centavos=1000, note="x", split_among=[m["Ana"]]).status_code == 422


def test_deleting_an_expense_recomputes_the_balances(client):
    wallet = create(client)
    slug, m = wallet["share_slug"], ids(wallet)
    wallet = add(client, slug, paid_by=m["Jacob"], amount_centavos=900, note="Taho", split_among=list(m.values())).json()
    expense_id = wallet["expenses"][0]["id"]
    r = client.delete(f"/wallets/{slug}/expenses/{expense_id}")
    assert r.status_code == 200
    assert r.json()["expenses"] == [] and r.json()["transfers"] == []
    assert client.delete(f"/wallets/{slug}/expenses/{expense_id}").status_code == 404
    other = create(client, name="Other")
    exp2 = add(client, slug, paid_by=m["Jacob"], amount_centavos=900, note="Taho", split_among=[m["Ana"]]).json()["expenses"][0]["id"]
    assert client.delete(f"/wallets/{other['share_slug']}/expenses/{exp2}").status_code == 404, "only from its own wallet"


def test_expenses_list_newest_first(client):
    wallet = create(client)
    slug, m = wallet["share_slug"], ids(wallet)
    for note in ("Bus", "Taxi", "Strawberries"):
        wallet = add(client, slug, paid_by=m["Ana"], amount_centavos=300, note=note, split_among=list(m.values())).json()
    assert [e["note"] for e in wallet["expenses"]] == ["Strawberries", "Taxi", "Bus"]
    assert wallet["total_centavos"] == 900


# ---------------------------------------------------------------- members and settlements

def test_add_a_member_later(client):
    wallet = create(client)
    slug = wallet["share_slug"]
    r = client.post(f"/wallets/{slug}/members", json={"name": "Cara"})
    assert r.status_code == 201
    assert [x["name"] for x in r.json()["members"]] == ["Jacob", "Ana", "Ben", "Cara"]
    assert client.post(f"/wallets/{slug}/members", json={"name": "cara"}).status_code == 409
    assert client.post(f"/wallets/{slug}/members", json={"name": ""}).status_code == 422


def test_a_member_cap_of_20(client):
    wallet = create(client, members=[f"P{i}" for i in range(20)])
    assert client.post(f"/wallets/{wallet['share_slug']}/members", json={"name": "One more"}).status_code == 409


def test_marking_a_payment_settles_it_and_undo_brings_it_back(client):
    wallet = create(client)
    slug, m = wallet["share_slug"], ids(wallet)
    add(client, slug, paid_by=m["Jacob"], amount_centavos=90000, note="Bus tickets", split_among=list(m.values()))
    r = client.post(f"/wallets/{slug}/settlements", json={"from_member": m["Ana"], "to_member": m["Jacob"], "amount_centavos": 30000})
    assert r.status_code == 201, r.text
    wallet = r.json()
    assert wallet["transfers"] == [{"from_member": m["Ben"], "to_member": m["Jacob"], "amount_centavos": 30000}]
    net = {b["member_id"]: b["net_centavos"] for b in wallet["balances"]}
    assert net[m["Ana"]] == 0 and net[m["Jacob"]] == 30000
    [settlement] = wallet["settlements"]
    undo = client.delete(f"/wallets/{slug}/settlements/{settlement['id']}")
    assert undo.status_code == 200
    assert len(undo.json()["transfers"]) == 2


@pytest.mark.parametrize("amount", [0, -1])
def test_settlement_validation(client, amount):
    wallet = create(client)
    slug, m = wallet["share_slug"], ids(wallet)
    url = f"/wallets/{slug}/settlements"
    assert client.post(url, json={"from_member": m["Ana"], "to_member": m["Jacob"], "amount_centavos": amount}).status_code == 422
    assert client.post(url, json={"from_member": m["Ana"], "to_member": m["Ana"], "amount_centavos": 100}).status_code == 422
    zed = ids(create(client, name="Other", members=("Zed",)))["Zed"]
    assert client.post(url, json={"from_member": zed, "to_member": m["Ana"], "amount_centavos": 100}).status_code == 422


def test_writes_are_rate_limited_per_ip(client, monkeypatch):
    wallet = create(client)
    slug, m = wallet["share_slug"], ids(wallet)
    monkeypatch.setattr(w, "WRITE_LIMITER", RateLimiter(1))
    assert add(client, slug, paid_by=m["Ana"], amount_centavos=100, note="a", split_among=[m["Ana"]]).status_code == 201
    assert add(client, slug, paid_by=m["Ana"], amount_centavos=100, note="b", split_among=[m["Ana"]]).status_code == 429


# ---------------------------------------------------------------- privacy, CORS, schema

def test_logs_carry_the_slug_and_counts_but_never_a_name_or_note(client, caplog):
    caplog.set_level(logging.INFO, logger="tara_gala.api")
    wallet = create(client, members=("Secretname Person",))
    slug, me = wallet["share_slug"], ids(wallet)["Secretname Person"]
    add(client, slug, paid_by=me, amount_centavos=100, note="Secretnote item", split_among=[me])
    client.get(f"/wallets/{slug}")
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert "wallet" in text and slug in text
    assert "Secretname" not in text and "Secretnote" not in text


def test_cors_allows_delete_for_the_wallet(client):
    r = client.options("/wallets/x/expenses/y", headers={"Origin": ORIGIN, "Access-Control-Request-Method": "DELETE"})
    assert r.status_code == 200, r.text
    assert "DELETE" in r.headers["access-control-allow-methods"]


def test_wallet_tables_have_rls_on_and_no_policy(dsn):
    with psycopg.connect(dsn) as conn:
        for table in TABLES:
            rls = conn.execute("select relrowsecurity from pg_class where relname = %s and relnamespace = 'public'::regnamespace", (table,)).fetchone()
            assert rls == (True,), f"{table}: RLS on"
            policies = conn.execute("select count(*) from pg_policies where tablename = %s", (table,)).fetchone()[0]
            assert policies == 0, f"{table}: no policy, so anon and authenticated read nothing"


def test_the_migration_is_safe_to_rerun_on_a_database_built_from_schema_sql(dsn):
    sql = MIGRATION.read_text(encoding="utf-8")
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(sql)
        conn.execute(sql)
        for table in TABLES:
            assert conn.execute("select to_regclass(%s) is not null", (f"public.{table}",)).fetchone()[0], table


def test_the_migration_builds_the_tables_on_a_database_from_before_tg50(dsn):
    schema_sql = (ROOT / "supabase" / "schema.sql").read_text(encoding="utf-8")
    with psycopg.connect(dsn, autocommit=True) as conn:
        for table in reversed(TABLES):
            conn.execute(f"drop table {table} cascade")
        conn.execute(MIGRATION.read_text(encoding="utf-8"))
        cols = {
            t: [r[0] for r in conn.execute(
                "select column_name from information_schema.columns where table_name = %s order by ordinal_position", (t,))]
            for t in TABLES
        }
    assert cols["expenses"] == ["id", "wallet_id", "paid_by", "amount_centavos", "note", "created_at"]
    assert "share_slug" in cols["wallets"]
    for table in TABLES:
        assert f"create table {table}" in schema_sql, f"schema.sql defines {table} too"


def test_a_deleted_wallet_takes_its_rows_with_it(client, dsn):
    wallet = create(client)
    slug, m = wallet["share_slug"], ids(wallet)
    add(client, slug, paid_by=m["Ana"], amount_centavos=100, note="a", split_among=[m["Ana"]])
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute("delete from wallets where share_slug = %s", (slug,))
        for table in TABLES[1:]:
            assert conn.execute(f"select count(*) from {table}").fetchone()[0] == 0, table


def test_ids_are_uuids(client):
    wallet = create(client)
    for member in wallet["members"]:
        UUID(member["id"])
