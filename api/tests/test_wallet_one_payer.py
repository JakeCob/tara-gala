"""TG-66 A3b: the multi-payer rollback script, data/wallet_one_payer.py (plan §6 and the §2 addendum).

Only for a code revert after WALLET_MULTI_PAYER was on: the old code reads `paid_by` and the final shares and ignores
expense_payers, so each multi-payer expense is re-saved as one payer, `paid_by` = the first payer in wallet order, with
the same final shares and an `expense_edit` row. Balances shift between the payers, which is why it needs the owner's
yes: a dry run by default, `--apply` to write. It prints counts and slugs only. Made-up wallets only.
"""

import importlib
import re

import pytest

from conftest import TEST_DSN
from test_wallets_v2 import (  # noqa: F401  fixtures: flags, on, and the autouse fresh_limiters
    NAMES,
    SNAPSHOT,
    add,
    edit,
    equal,
    expense,
    flags,
    fresh_limiters,
    new_wallet,
    on,
    rev,
    rows,
    shares,
    sql,
)

NOTE = "Van to TESTPLACE"
LINE = re.compile(r"^share_slug=[0-9a-f]{32} expenses=\d+$")
FAILED = "FAILED, nothing was written (database error): "  # load_data.db_failure


@pytest.fixture
def script():
    """Imported per test, so before GREEN each test fails on its own."""
    return importlib.import_module("wallet_one_payer")


def multi(client, slug, ids, amount=100000, split=None, note=NOTE):
    """A multi-payer expense: Carla 30%, Ben 70% (Carla listed first), split equally among `split` (all by default)."""
    a, b, c, *_ = ids
    body = equal(split or ids, amount=amount, note=note, category="transport")
    del body["paid_by"]
    body["payers"] = [{"member_id": c, "paid_centavos": amount * 3 // 10},
                      {"member_id": b, "paid_centavos": amount - amount * 3 // 10}]
    r = add(client, slug, body)
    assert r.status_code == 201, r.text
    return r.json()["expenses"][0]["id"]


def payers(dsn, eid):
    return sql(dsn, "select member_id, paid_centavos from expense_payers where expense_id = %s order by member_id", (eid,))


def state(dsn, slug):
    """Everything the script may touch in one wallet."""
    exp = sql(dsn, """select e.id, e.paid_by, e.version, e.updated_at, e.amount_centavos from expenses e
                      join wallets w on w.id = e.wallet_id where w.share_slug = %s order by e.id""", (slug,))
    return {"expenses": exp, "payers": [payers(dsn, e["id"]) for e in exp], "rev": rev(dsn, slug),
            "rows": rows(dsn, slug),
            "shares": sql(dsn, """select s.* from expense_shares s join expenses e on e.id = s.expense_id
                                  join wallets w on w.id = e.wallet_id where w.share_slug = %s
                                  order by s.expense_id, s.member_id""", (slug,))}


@pytest.fixture
def two_wallets(on, dsn):
    """Wallet one: two multi-payer expenses and one single-payer expense. Wallet two: one multi-payer expense.
    Wallet three: single payers only."""
    one, ids1 = new_wallet(on)
    e1 = multi(on, one, ids1)
    e2 = multi(on, one, ids1, amount=1001, split=ids1[:3])
    single1 = add(on, one, equal(ids1[:2], amount=500)).json()["expenses"][0]["id"]
    two, ids2 = new_wallet(on)
    e3 = multi(on, two, ids2, amount=777)
    three, ids3 = new_wallet(on)
    add(on, three, equal(ids3, amount=400))
    return {"one": (one, ids1, [e1, e2], single1), "two": (two, ids2, [e3]), "three": (three, ids3)}


# ---------------------------------------------------------------- dry run (the default)

def test_dry_run_is_the_default_and_lists_counts_and_slugs_only(script, two_wallets, capsys):
    assert script.run(TEST_DSN) == 0
    out = capsys.readouterr().out
    one, two, three = two_wallets["one"][0], two_wallets["two"][0], two_wallets["three"][0]
    lines = out.strip().splitlines()
    listed = [line for line in lines if LINE.match(line)]
    assert sorted(listed) == sorted([f"share_slug={one} expenses=2", f"share_slug={two} expenses=1"])
    assert three not in out, "a wallet with no multi-payer expense isn't listed"
    assert "Dry run" in out and "3 multi-payer expense(s) in 2 wallet(s)" in out
    assert "--apply" in out and "balances shift" in out


def test_dry_run_writes_nothing(script, two_wallets, dsn):
    before = {k: state(dsn, v[0]) for k, v in two_wallets.items()}
    assert script.run(TEST_DSN, apply=False) == 0
    assert {k: state(dsn, v[0]) for k, v in two_wallets.items()} == before


def test_nothing_to_do_says_so(script, on, capsys):
    slug, ids = new_wallet(on)
    add(on, slug, equal(ids, amount=400))
    assert script.run(TEST_DSN) == 0
    out = capsys.readouterr().out
    assert "No multi-payer expenses" in out and "share_slug=" not in out


# ---------------------------------------------------------------- --apply

def test_apply_resaves_each_as_one_payer_with_the_same_shares(script, two_wallets, dsn, on, capsys):
    one, ids1, (e1, e2), _ = two_wallets["one"]
    a, b, c, d = ids1
    old = on.get(f"/wallets/{one}").json()
    rev0, rows0 = rev(dsn, one), len(rows(dsn, one))
    assert script.run(TEST_DSN, apply=True) == 0
    out = capsys.readouterr().out
    assert "Re-saved 3 expense(s) in 2 wallet(s) as one payer" in out
    new = on.get(f"/wallets/{one}").json()
    for eid in (e1, e2):
        was, now = expense(old, eid), expense(new, eid)
        assert now["payers"] == [] and payers(dsn, eid) == []
        assert now["paid_by"] == b == was["paid_by"], "the first payer in wallet order (Ben, though Carla was listed first)"
        assert shares(now) == shares(was), "the same final shares"
        assert (now["amount_centavos"], now["note"], now["category"], now["mode"], now["inputs"]) == (
            was["amount_centavos"], was["note"], was["category"], was["mode"], was["inputs"])
        assert (now["version"], was["version"]) == (2, 1) and now["updated_at"] is not None
    assert rev(dsn, one) == rev0 + 2, "one rev per re-saved expense"
    edits = rows(dsn, one)[rows0:]
    assert [(r["action"], r["actor"]) for r in edits] == [("expense_edit", None)] * 2
    assert {r["expense_id"] for r in edits} == {e1, e2}
    for r in edits:
        was, now = expense(old, r["expense_id"]), expense(new, r["expense_id"])
        assert r["before"] == {k: v for k, v in was.items() if k in SNAPSHOT}, "before: as it was, with its payers"
        assert r["after"] == {k: v for k, v in now.items() if k in SNAPSHOT}
        assert r["before"]["payers"] and r["after"]["payers"] == []
    assert new["rev"] == rev(dsn, one)
    paid = {x["member_id"]: x["paid_centavos"] for x in new["balances"]}
    assert paid == {a: 500, b: 100000 + 1001, c: 0, d: 0}, "Ben now paid the whole of both; Ana her own ₱5"


def test_apply_keeps_the_first_payer_in_wallet_order_even_when_they_paid_the_smaller_part(script, on, dsn):
    """tg-test3's RED should S1: Ben is first in wallet order but paid only 30%; Carla paid 70%. paid_by stays Ben."""
    slug, (a, b, c, d) = new_wallet(on)
    body = equal([a, b, c, d], amount=1000, note=NOTE)
    del body["paid_by"]
    body["payers"] = [{"member_id": c, "paid_centavos": 700}, {"member_id": b, "paid_centavos": 300}]
    eid = add(on, slug, body).json()["expenses"][0]["id"]
    assert script.run(TEST_DSN, apply=True) == 0
    e = expense(on.get(f"/wallets/{slug}").json(), eid)
    assert (e["paid_by"], e["payers"]) == (b, [])
    assert {x["member_id"]: x["paid_centavos"] for x in on.get(f"/wallets/{slug}").json()["balances"]}[b] == 1000


def test_apply_leaves_single_payer_expenses_and_other_wallets_alone(script, two_wallets, dsn):
    one, _, _, single1 = two_wallets["one"]
    three = two_wallets["three"][0]
    single_before = [e for e in state(dsn, one)["expenses"] if str(e["id"]) == single1]
    three_before = state(dsn, three)
    assert script.run(TEST_DSN, apply=True) == 0
    assert [e for e in state(dsn, one)["expenses"] if str(e["id"]) == single1] == single_before
    assert state(dsn, three) == three_before


def test_a_second_run_finds_nothing_and_writes_nothing(script, two_wallets, dsn, capsys):
    assert script.run(TEST_DSN, apply=True) == 0
    capsys.readouterr()
    after = {k: state(dsn, v[0]) for k, v in two_wallets.items()}
    assert script.run(TEST_DSN, apply=True) == 0
    assert "No multi-payer expenses" in capsys.readouterr().out
    assert {k: state(dsn, v[0]) for k, v in two_wallets.items()} == after


def test_apply_is_all_or_nothing(script, two_wallets, dsn, capsys):
    """A failure on the LAST wallet's rev bump leaves every wallet as it was (none committed before it), and says so."""
    before = {k: state(dsn, v[0]) for k, v in two_wallets.items()}
    last = max(two_wallets["one"][0], two_wallets["two"][0])  # the script goes in slug order
    sql(dsn, f"""create function tg66_a3b_fail() returns trigger language plpgsql as
                 $$ begin if new.share_slug = '{last}' then raise exception 'tg66 a3b test'; end if;
                 return new; end $$""")
    sql(dsn, "create trigger tg66_a3b_fail before update of rev on wallets for each row execute function tg66_a3b_fail()")
    try:
        assert script.run(TEST_DSN, apply=True) == 1
    finally:
        sql(dsn, "drop trigger tg66_a3b_fail on wallets")
    assert {k: state(dsn, v[0]) for k, v in two_wallets.items()} == before
    assert capsys.readouterr().err.startswith(FAILED)


def test_after_apply_the_expense_can_be_edited_with_multi_payer_off(script, two_wallets, client, flags):
    """S4 refuses to edit an expense with stored payers while WALLET_MULTI_PAYER is off; once re-saved, it's editable."""
    one, (a, b, *_), (e1, _), _ = two_wallets["one"]
    flags(wallet_splits=True)
    body = {**equal([a, b], amount=100000, payer=b, note=NOTE), "version": 1}
    assert edit(client, one, e1, body).json()["detail"] == "feature_off"
    assert script.run(TEST_DSN, apply=True) == 0
    assert edit(client, one, e1, {**body, "version": 2}).status_code == 200


# ---------------------------------------------------------------- privacy and the command line

def test_the_output_has_counts_and_slugs_only(script, two_wallets, dsn, capsys):
    script.run(TEST_DSN)
    script.run(TEST_DSN, apply=True)
    out = capsys.readouterr()
    text = out.out + out.err
    ids = [m for v in two_wallets.values() for m in v[1]]
    expense_ids = two_wallets["one"][2] + two_wallets["two"][2] + [two_wallets["one"][3]]
    for secret in [*NAMES, "TESTPLACE", *ids, *expense_ids]:
        assert secret not in text, secret
    no_slugs = re.sub(r"\b[0-9a-f]{32}\b", "<slug>", text)  # a random hex slug may hold any digits
    for amount in ("100000", "70000", "30000", "1001", "777", "701", "300"):
        assert amount not in no_slugs, amount
    for line in text.strip().splitlines():
        assert LINE.match(line) or not re.search(r"[0-9a-f]{8}-[0-9a-f]{4}", line), line


def test_main_runs_a_dry_run_unless_told_apply(script, two_wallets, dsn, monkeypatch, capsys):
    monkeypatch.setenv("DATABASE_URL", TEST_DSN)
    before = state(dsn, two_wallets["one"][0])
    assert script.main([]) == 0
    assert "Dry run" in capsys.readouterr().out
    assert state(dsn, two_wallets["one"][0]) == before
    assert script.main(["--apply"]) == 0
    assert "Re-saved 3 expense(s)" in capsys.readouterr().out
    assert payers(dsn, two_wallets["one"][2][0]) == []


def test_main_without_a_database_url_exits_2(script, monkeypatch, capsys):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setattr(script.load_data, "database_url", lambda cli: None)
    assert script.main([]) == 2
    assert "DATABASE_URL" in capsys.readouterr().err


def test_a_database_error_is_one_redacted_line(script, capsys):
    bad = TEST_DSN.rsplit("/", 1)[0] + "/tg66_a3b_no_such_db"
    assert script.run(bad) == 1
    err = capsys.readouterr().err
    assert "Traceback" not in err and "postgres:postgres@" not in err
    assert len(err.strip().splitlines()) == 1
    assert err.startswith(FAILED), "load_data.db_failure's redacted line, not str(e)"  # tg-test3's RED nit
