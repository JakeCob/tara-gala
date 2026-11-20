"""TG-66 A3: the expenses' new shapes, edits and deletes in wallets.py (plan §2 and §3: B9 to B17, B11b).

Routes under test (wallets.py):
- POST   /wallets/{slug}/expenses                  the old body (no `mode`) or ExpenseInV2 (a `mode`)
- PATCH  /wallets/{slug}/expenses/{id}             ExpensePatch: the whole new expense plus the `version` it opened
- DELETE /wallets/{slug}/expenses/{id}?version=&by=
- POST   /wallets/{slug}/members?by=, POST /wallets/{slug}/settlements?by=, DELETE …/settlements/{id}?by=
  (`by` rides as a query parameter where the body's model has no `by`, as A2's proof and comment deletes do)

Every write calls wallet_activity.record() in its own transaction, so `rev` moves and the activity row is written.
`test_wallets.py` stays unedited: it's the old shape's proof (B9). Made-up wallets, names and text only.
"""

import dataclasses
import json
import logging
import re
from pathlib import Path
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg.rows import dict_row

from app import wallet_splits
from app import wallets as w
from app.limits import RateLimiter
from app.wallet_models import ExpenseOut

VECTORS = json.loads((Path(__file__).parent / "fixtures" / "wallet_split_vectors.json").read_text())
NAMES = ("Ana Testname", "Ben Testname", "Carla Testname", "Dan Testname", "Eli Testname", "Fe Testname")
NOTE = "Lunch at TESTPLACE"
ITEM = "TESTITEM"
SNAPSHOT = {"amount_centavos", "note", "category", "paid_by", "payers", "mode", "inputs", "items", "charges", "shares",
            "version", "budget_key"}  # budget_key: TG-62 GA1 (plan G8), manager OK


# ---------------------------------------------------------------- fixtures and helpers

@pytest.fixture(autouse=True)
def fresh_limiters(monkeypatch):
    monkeypatch.setattr(w, "CREATE_LIMITER", RateLimiter(w.CREATE_PER_HOUR))
    monkeypatch.setattr(w, "WRITE_LIMITER", RateLimiter(w.WRITES_PER_HOUR))


@pytest.fixture()
def flags(client):
    """flags(**on): sets the wallet flags for this test (every TG-66 flag starts off), restored afterwards."""
    before = client.app.state.flags
    base = dataclasses.replace(before, wallet_splits=False, wallet_multi_payer=False, wallet_activity=False)
    client.app.state.flags = base

    def set_flags(**kw):
        client.app.state.flags = dataclasses.replace(base, **kw)

    yield set_flags
    client.app.state.flags = before


@pytest.fixture()
def on(client, flags):
    """WALLET_SPLITS and WALLET_MULTI_PAYER on."""
    flags(wallet_splits=True, wallet_multi_payer=True)
    return client


def sql(dsn, statement, params=None):
    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        conn.execute("set lock_timeout = '3s'")
        cur = conn.execute(statement, params)
        return cur.fetchall() if cur.description else None


def new_wallet(client, n=4):
    """A made-up wallet of n people. Returns (slug, their ids in wallet order)."""
    r = client.post("/wallets", json={"name": "Test trip", "members": list(NAMES[:n])})
    assert r.status_code == 201, r.text
    wallet = r.json()
    return wallet["share_slug"], [m["id"] for m in wallet["members"]]


def add(client, slug, body, by=None):
    return client.post(f"/wallets/{slug}/expenses", json=body if by is None else {**body, "by": by})


def edit(client, slug, eid, body):
    return client.patch(f"/wallets/{slug}/expenses/{eid}", json=body)


def delete(client, slug, eid, version=None, by=None):
    q = "&".join(f"{k}={v}" for k, v in (("version", version), ("by", by)) if v is not None)
    return client.delete(f"/wallets/{slug}/expenses/{eid}" + (f"?{q}" if q else ""))


def equal(people, amount=90000, payer=None, note="Dinner", **extra):
    return {"mode": "equal", "paid_by": payer or people[0], "amount_centavos": amount, "note": note,
            "inputs": [{"member_id": m, "value": 1} for m in people], **extra}


def exact(pairs, payer, note="Dinner", **extra):
    return {"mode": "exact", "paid_by": payer, "amount_centavos": sum(v for _, v in pairs), "note": note,
            "inputs": [{"member_id": m, "value": v} for m, v in pairs], **extra}


def legacy_equal(people, amount=90000, payer=None, note="Dinner"):
    return {"paid_by": payer or people[0], "amount_centavos": amount, "note": note, "split_among": list(people)}


def expense(wallet, eid):
    return next(e for e in wallet["expenses"] if e["id"] == eid)


def shares(e):
    return {s["member_id"]: s["share_centavos"] for s in e["shares"]}


def rev(dsn, slug):
    return sql(dsn, "select rev from wallets where share_slug = %s", (slug,))[0]["rev"]


def rows(dsn, slug):
    found = sql(dsn, """select a.actor, a.action, a.expense_id, a.settlement_id, a.member_id, a.before, a.after
                        from wallet_activity a join wallets w on w.id = a.wallet_id where w.share_slug = %s
                        order by a.id""", (slug,))
    return [{k: str(v) if isinstance(v, UUID) else v for k, v in r.items()} for r in found]


def stored(dsn, eid):
    return sql(dsn, "select split_mode, category, version, updated_at, paid_by, amount_centavos from expenses "
                    "where id = %s", (eid,))[0]


def detail(r):
    return r.json()["detail"]


def vector_body(case, ids):
    """A vector as an API body in a 6-person wallet: the vector's people map to the wallet's by position."""
    by_uuid = dict(zip(VECTORS["members"].values(), ids))
    text = json.dumps(case)
    for old, new in by_uuid.items():
        text = text.replace(old, new)
    c = json.loads(text)
    body = {"mode": c["mode"], "paid_by": c["payer_first"], "note": "Vector"}
    if c["mode"] == "itemized":
        body["items"], body["charges"] = c["items"], c.get("charges", [])
        if c.get("amount") is not None:
            body["amount_centavos"] = c["amount"]
    else:
        body["inputs"], body["amount_centavos"] = c["inputs"], c["amount"]
    return body, c["expect"]


# ---------------------------------------------------------------- B9: the old shape still works

def test_b9_an_old_shape_add_is_stored_as_legacy_with_todays_shares(client, dsn, flags):
    slug, (a, b, c, _) = new_wallet(client)
    r = add(client, slug, legacy_equal([a, b, c], amount=1000, payer=b))
    assert r.status_code == 201, r.text
    e = r.json()["expenses"][0]
    assert shares(e) == {str(k): v for k, v in w.split_equal(1000, [UUID(a), UUID(b), UUID(c)], UUID(b)).items()}
    assert (e["mode"], e["category"], e["inputs"], e["items"], e["payers"], e["version"]) == (None, None, [], [], [], 1)
    assert stored(dsn, e["id"])["split_mode"] is None
    r = add(client, slug, {"paid_by": a, "amount_centavos": 700, "note": "Taxi",
                           "shares": [{"member_id": a, "share_centavos": 500}, {"member_id": b, "share_centavos": 200}]})
    assert r.status_code == 201, r.text
    assert shares(r.json()["expenses"][0]) == {a: 500, b: 200}


def test_b9_an_old_shape_add_records_expense_add_and_moves_rev(client, dsn, flags):
    slug, (a, b, *_) = new_wallet(client)
    r = add(client, slug, legacy_equal([a, b], amount=1000))
    wallet = r.json()
    e = wallet["expenses"][0]
    assert wallet["rev"] == rev(dsn, slug) == 1
    [row] = rows(dsn, slug)
    assert (row["action"], row["expense_id"], row["actor"], row["before"]) == ("expense_add", e["id"], None, None)
    assert row["after"] == {k: v for k, v in e.items() if k in SNAPSHOT}


# ---------------------------------------------------------------- B10: a v2 add, every mode

SUCCESS = [c for c in VECTORS["cases"] if "shares" in c["expect"]]
REFUSED = [c for c in VECTORS["cases"] if "error" in c["expect"]]


@pytest.mark.parametrize("case", SUCCESS, ids=lambda c: c["name"])
def test_b10_each_vector_adds_with_the_splits_shares(on, case):
    slug, ids = new_wallet(on, 6)
    body, expect = vector_body(case, ids)
    r = add(on, slug, body)
    assert r.status_code == 201, r.text
    e = r.json()["expenses"][0]
    assert e["amount_centavos"] == expect["amount"]
    assert shares(e) == expect["shares"]
    assert e["mode"] == case["mode"]


@pytest.mark.parametrize("case", REFUSED, ids=lambda c: c["name"])
def test_b10_each_refused_vector_is_a_422_with_its_code(on, dsn, case):
    slug, ids = new_wallet(on, 6)
    body, expect = vector_body(case, ids)
    r = add(on, slug, body)
    assert r.status_code == 422, r.text
    if expect["error"] == "item_no_one":
        assert detail(r) == {"code": "item_no_one", "seq": expect["seq"]}  # B15a
    else:
        assert detail(r) == expect["error"]
    assert rev(dsn, slug) == 0 and rows(dsn, slug) == []


def test_b10_a_v2_add_stores_mode_inputs_category_and_shares_from_the_split(on, dsn):
    slug, (a, b, c, d) = new_wallet(on)
    body = {"mode": "percent", "paid_by": b, "amount_centavos": 100, "note": "Pasalubong", "category": "food",
            "inputs": [{"member_id": c, "value": 3334}, {"member_id": a, "value": 3333}, {"member_id": b, "value": 3333}]}
    r = add(on, slug, body)
    assert r.status_code == 201, r.text
    e = r.json()["expenses"][0]
    as_uuids = [{"member_id": UUID(i["member_id"]), "value": i["value"]} for i in body["inputs"]]
    _, want = wallet_splits.split("percent", 100, as_uuids, [], [], UUID(b), [UUID(m) for m in (a, b, c, d)])
    assert shares(e) == {str(k): v for k, v in want.items()}
    assert e["inputs"] == [{"member_id": a, "value": 3333}, {"member_id": b, "value": 3333},
                           {"member_id": c, "value": 3334}], "wallet order, whatever the body's order"
    assert (e["category"], e["mode"], e["version"], e["paid_by"]) == ("food", "percent", 1, b)
    s = stored(dsn, e["id"])
    assert (s["split_mode"], s["category"], s["version"]) == ("percent", "food", 1)
    assert [r["value"] for r in sql(dsn, "select value from expense_inputs where expense_id = %s order by value",
                                    (e["id"],))] == [3333, 3333, 3334]


def test_b10_an_itemized_add_stores_items_who_and_charges_in_order(on, dsn):
    slug, (a, b, c, d) = new_wallet(on)
    body = {"mode": "itemized", "paid_by": a, "note": NOTE, "category": "food",
            "items": [{"name": "Pinikpikan", "price_centavos": 42000, "who": [b, a]},
                      {"name": "Strawberry taho", "price_centavos": 12000, "who": [c]},
                      {"name": "Grilled tilapia", "price_centavos": 38000, "who": [d, c, b]},
                      {"name": "Rice", "price_centavos": 16000, "who": [a, b, c, d]}],
            "charges": [{"kind": "vat", "basis": "amount", "value": 0},
                        {"kind": "service", "basis": "percent", "value": 1000}]}
    r = add(on, slug, body)
    assert r.status_code == 201, r.text
    e = r.json()["expenses"][0]
    assert e["amount_centavos"] == 118800
    assert shares(e) == {a: 27501, b: 41434, c: 31533, d: 18332}
    assert [(i["seq"], i["name"], i["price_centavos"], i["who"]) for i in e["items"]] == [
        (1, "Pinikpikan", 42000, [a, b]), (2, "Strawberry taho", 12000, [c]),
        (3, "Grilled tilapia", 38000, [b, c, d]), (4, "Rice", 16000, [a, b, c, d])], "who in wallet order"
    assert e["charges"] == [{"kind": "service", "basis": "percent", "value": 1000},
                            {"kind": "vat", "basis": "amount", "value": 0}], "service, then VAT"
    assert e["inputs"] == []
    assert len(sql(dsn, "select 1 from expense_item_people p join expense_items i on i.id = p.item_id "
                        "where i.expense_id = %s", (e["id"],))) == 2 + 1 + 3 + 4


def test_b10_an_itemized_amount_sent_must_match(on):
    slug, (a, b, *_) = new_wallet(on)
    items = [{"name": "Kape", "price_centavos": 500, "who": [a, b]}]
    assert add(on, slug, {"mode": "itemized", "paid_by": a, "note": "x", "items": items, "amount_centavos": 500}).status_code == 201
    r = add(on, slug, {"mode": "itemized", "paid_by": a, "note": "x", "items": items, "amount_centavos": 501})
    assert (r.status_code, detail(r)) == (422, "amount_mismatch")


@pytest.mark.parametrize("where", ["paid_by", "inputs", "payers", "who", "by"])
def test_b10_a_stranger_anywhere_in_the_body_is_unknown_member(on, dsn, where):
    slug, (a, b, *_) = new_wallet(on)
    _, (stranger, *_) = new_wallet(on, 1)
    body = equal([a, b], amount=1000)
    if where == "paid_by":
        body["paid_by"] = stranger
    elif where == "inputs":
        body["inputs"].append({"member_id": stranger, "value": 1})
    elif where == "payers":
        del body["paid_by"]
        body["payers"] = [{"member_id": a, "paid_centavos": 500}, {"member_id": stranger, "paid_centavos": 500}]
    elif where == "who":
        body = {"mode": "itemized", "paid_by": a, "note": "x",
                "items": [{"name": "Kape", "price_centavos": 500, "who": [a, stranger]}]}
    else:
        body["by"] = stranger
    r = add(on, slug, body)
    assert (r.status_code, detail(r)) == (422, "unknown_member")
    assert rev(dsn, slug) == 0


def test_b10_a_v2_add_still_stops_at_a_full_wallet(on, monkeypatch):
    monkeypatch.setattr(w, "MAX_EXPENSES", 1)
    slug, (a, b, *_) = new_wallet(on)
    assert add(on, slug, equal([a, b], amount=100)).status_code == 201
    r = add(on, slug, equal([a, b], amount=100))
    assert (r.status_code, detail(r)) == (409, "wallet_full")


def test_b10_by_is_recorded_as_the_actor(on, dsn):
    slug, (a, b, c, _) = new_wallet(on)
    add(on, slug, equal([a, b], amount=100), by=c)
    assert rows(dsn, slug)[0]["actor"] == c


# ---------------------------------------------------------------- B14: several payers

def test_b14_several_payers_count_in_the_balances_and_paid_by_is_the_first_in_wallet_order(on, dsn):
    slug, (a, b, c, d) = new_wallet(on)
    body = equal([a, b, c, d], amount=100000, note="Van")
    del body["paid_by"]
    body["payers"] = [{"member_id": c, "paid_centavos": 30000}, {"member_id": b, "paid_centavos": 70000}]
    r = add(on, slug, body)
    assert r.status_code == 201, r.text
    wallet = r.json()
    e = wallet["expenses"][0]
    assert e["paid_by"] == b, "the first payer in wallet order, not the body's"
    assert e["payers"] == [{"member_id": b, "paid_centavos": 70000}, {"member_id": c, "paid_centavos": 30000}]
    paid = {x["member_id"]: x["paid_centavos"] for x in wallet["balances"]}
    assert paid == {a: 0, b: 70000, c: 30000, d: 0}
    assert shares(e) == {a: 25000, b: 25000, c: 25000, d: 25000}
    net = {x["member_id"]: x["net_centavos"] for x in wallet["balances"]}
    assert net == {a: -25000, b: 45000, c: 5000, d: -25000}
    assert stored(dsn, e["id"])["paid_by"] == UUID(b)


def test_b14_the_leftover_goes_to_the_first_payer(on):
    slug, (a, b, c, _) = new_wallet(on)
    body = equal([a, b, c], amount=1001)
    del body["paid_by"]
    body["payers"] = [{"member_id": c, "paid_centavos": 1}, {"member_id": b, "paid_centavos": 1000}]
    e = add(on, slug, body).json()["expenses"][0]
    assert shares(e) == {a: 334, b: 334, c: 333}, "b first (the first payer in wallet order, not the body's c), then a"


@pytest.mark.parametrize("payers", [
    [(0, 500), (1, 499)],  # short
    [(0, 1000)],  # one payer
    [(0, 1000), (1, 0)],  # a payer at 0: refused by the split's rule, not a 422 from the model
], ids=["short", "one", "zero"])
def test_b14_payers_that_dont_add_up_are_payers_mismatch(on, dsn, payers):
    slug, ids = new_wallet(on)
    body = equal(ids[:2], amount=1000)
    del body["paid_by"]
    body["payers"] = [{"member_id": ids[i], "paid_centavos": v} for i, v in payers]
    r = add(on, slug, body)
    assert (r.status_code, detail(r)) == (422, "payers_mismatch")
    assert rev(dsn, slug) == 0


def test_b14_an_itemized_bill_with_payers_checks_them_against_the_computed_amount(on):
    slug, (a, b, *_) = new_wallet(on)
    body = {"mode": "itemized", "note": "x", "items": [{"name": "Kape", "price_centavos": 500, "who": [a, b]}],
            "charges": [{"kind": "service", "basis": "percent", "value": 1000}],
            "payers": [{"member_id": a, "paid_centavos": 300}, {"member_id": b, "paid_centavos": 250}]}
    assert add(on, slug, body).status_code == 201
    body["payers"][1]["paid_centavos"] = 200
    r = add(on, slug, body)
    assert (r.status_code, detail(r)) == (422, "payers_mismatch")


# ---------------------------------------------------------------- B11, B11a, B11b: edit

def test_b11_an_edit_bumps_version_sets_updated_at_and_records_before_and_after(on, dsn):
    slug, (a, b, c, _) = new_wallet(on)
    first = add(on, slug, equal([a, b], amount=1000, category="food")).json()
    e0 = first["expenses"][0]
    r = edit(on, slug, e0["id"], {**equal([a, b, c], amount=1500, note="Dinner and dessert"), "version": 1,
                                   "category": "food"})
    assert r.status_code == 200, r.text
    wallet = r.json()
    e1 = expense(wallet, e0["id"])
    assert (e1["version"], e1["amount_centavos"], e1["note"]) == (2, 1500, "Dinner and dessert")
    assert e1["updated_at"] is not None and e0["updated_at"] is None
    assert e1["created_at"] == e0["created_at"]
    assert shares(e1) == {a: 500, b: 500, c: 500}
    assert wallet["rev"] == first["rev"] + 1 == rev(dsn, slug)
    row = rows(dsn, slug)[-1]
    assert (row["action"], row["expense_id"]) == ("expense_edit", e0["id"])
    assert row["before"] == {k: v for k, v in e0.items() if k in SNAPSHOT}
    assert row["after"] == {k: v for k, v in e1.items() if k in SNAPSHOT}
    assert stored(dsn, e0["id"])["version"] == 2


def test_b11_an_edit_replaces_inputs_items_charges_and_payers(on, dsn):
    slug, (a, b, c, d) = new_wallet(on)
    body = {"mode": "itemized", "paid_by": a, "note": "x", "items": [{"name": "Kape", "price_centavos": 500, "who": [a, b]}],
            "charges": [{"kind": "service", "basis": "amount", "value": 100}]}
    eid = add(on, slug, body).json()["expenses"][0]["id"]
    new = equal([c, d], amount=600)
    del new["paid_by"]
    new["payers"] = [{"member_id": c, "paid_centavos": 100}, {"member_id": d, "paid_centavos": 500}]
    e = expense(edit(on, slug, eid, {**new, "version": 1}).json(), eid)
    assert (e["mode"], e["items"], e["charges"]) == ("equal", [], [])
    assert e["inputs"] == [{"member_id": c, "value": 1}, {"member_id": d, "value": 1}]
    assert len(e["payers"]) == 2 and e["paid_by"] == c
    for table in ("expense_items", "expense_charges"):
        assert sql(dsn, f"select 1 from {table} where expense_id = %s", (eid,)) == []
    back = expense(edit(on, slug, eid, {**equal([a, b], amount=600, payer=a), "version": 2}).json(), eid)
    assert back["payers"] == [] and back["paid_by"] == a
    assert sql(dsn, "select 1 from expense_payers where expense_id = %s", (eid,)) == []


def test_b11_a_stale_version_is_409_expense_changed_with_the_wallet_and_nothing_written(on, dsn):
    slug, (a, b, *_) = new_wallet(on)
    eid = add(on, slug, equal([a, b], amount=1000)).json()["expenses"][0]["id"]
    assert edit(on, slug, eid, {**equal([a, b], amount=1200), "version": 1}).status_code == 200
    before_rev, before_rows = rev(dsn, slug), rows(dsn, slug)
    r = edit(on, slug, eid, {**equal([a, b], amount=1400), "version": 1})
    assert r.status_code == 409, r.text
    d = detail(r)
    assert d["code"] == "expense_changed"
    assert expense(d["wallet"], eid)["amount_centavos"] == 1200 and expense(d["wallet"], eid)["version"] == 2
    assert d["wallet"]["rev"] == before_rev
    assert (rev(dsn, slug), rows(dsn, slug)) == (before_rev, before_rows)


def test_b11_editing_an_expense_deleted_meanwhile_is_404_expense_gone_with_the_wallet(on, dsn):
    slug, (a, b, *_) = new_wallet(on)
    eid = add(on, slug, equal([a, b], amount=1000)).json()["expenses"][0]["id"]
    assert delete(on, slug, eid).status_code == 200
    r = edit(on, slug, eid, {**equal([a, b], amount=1200), "version": 1})
    assert r.status_code == 404, r.text
    assert detail(r)["code"] == "expense_gone"
    assert detail(r)["wallet"]["expenses"] == [] and detail(r)["wallet"]["rev"] == rev(dsn, slug)
    other_slug, _ = new_wallet(on)
    r = edit(on, other_slug, eid, {**equal([a, b], amount=1200), "version": 1})
    assert (r.status_code, detail(r)["code"]) == (404, "expense_gone"), "another wallet's expense is gone here"


def test_b11_an_edit_refused_by_the_split_writes_nothing(on, dsn):
    slug, (a, b, *_) = new_wallet(on)
    eid = add(on, slug, equal([a, b], amount=1000)).json()["expenses"][0]["id"]
    n = rev(dsn, slug)
    r = edit(on, slug, eid, {**exact([(a, 400), (b, 500)], payer=a), "amount_centavos": 1000, "version": 1})
    assert (r.status_code, detail(r)) == (422, "shares_mismatch")
    assert rev(dsn, slug) == n and stored(dsn, eid)["version"] == 1


def test_b11_an_edit_checks_its_people_and_by(on, dsn):
    slug, (a, b, *_) = new_wallet(on)
    _, (stranger, *_) = new_wallet(on, 1)
    eid = add(on, slug, equal([a, b], amount=1000)).json()["expenses"][0]["id"]
    r = edit(on, slug, eid, {**equal([a, stranger], amount=1000), "version": 1})
    assert (r.status_code, detail(r)) == (422, "unknown_member")
    r = edit(on, slug, eid, {**equal([a, b], amount=1200), "version": 1, "by": stranger})
    assert (r.status_code, detail(r)) == (422, "unknown_member")
    r = edit(on, slug, eid, {**equal([a, b], amount=1200), "version": 1, "by": b})
    assert r.status_code == 200 and rows(dsn, slug)[-1]["actor"] == b


def test_b11a_the_history_is_a_chain(on, dsn):
    slug, (a, b, c, _) = new_wallet(on)
    eid = add(on, slug, equal([a, b], amount=1000)).json()["expenses"][0]["id"]
    steps = [equal([a, b, c], amount=1000), exact([(a, 100), (b, 900)], payer=b),
             {"mode": "shares", "paid_by": c, "amount_centavos": 1001, "note": "Dinner", "category": "other",
              "inputs": [{"member_id": a, "value": 2}, {"member_id": c, "value": 1}]}]
    for version, body in enumerate(steps, start=1):
        assert edit(on, slug, eid, {**body, "version": version}).status_code == 200
    chain = [r for r in rows(dsn, slug) if r["expense_id"] == eid]
    assert [r["action"] for r in chain] == ["expense_add", "expense_edit", "expense_edit", "expense_edit"]
    for prev, row in zip(chain, chain[1:]):
        assert row["before"] == prev["after"]
        assert row["after"]["version"] == row["before"]["version"] + 1
    assert [r["after"]["version"] for r in chain] == [1, 2, 3, 4]


def test_b11b_snapshot_is_the_expense_cut_to_the_snapshot_fields(on):
    assert set(w.SNAPSHOT_FIELDS) == SNAPSHOT
    slug, (a, b, *_) = new_wallet(on)
    e = add(on, slug, equal([a, b], amount=1000, category="hotel")).json()["expenses"][0]
    snap = w.snapshot(ExpenseOut(**e))
    assert set(snap) == SNAPSHOT
    assert snap == {k: v for k, v in e.items() if k in SNAPSHOT}
    json.dumps(snap)  # plain JSON: ids are strings


def test_b11b_every_add_edit_and_delete_row_uses_the_snapshot_keys(on, dsn):
    slug, (a, b, *_) = new_wallet(on)
    eid = add(on, slug, equal([a, b], amount=1000)).json()["expenses"][0]["id"]
    edit(on, slug, eid, {**equal([a, b], amount=1100), "version": 1})
    delete(on, slug, eid)
    add(on, slug, legacy_equal([a, b], amount=500))
    for row in rows(dsn, slug):
        for snap in (row["before"], row["after"]):
            assert snap is None or set(snap) == SNAPSHOT, row["action"]
    assert [r["before"] is None for r in rows(dsn, slug)] == [True, False, False, True]


def test_b11b_a_legacy_expenses_first_before_has_mode_null_and_no_inputs(on, dsn):
    slug, (a, b, *_) = new_wallet(on)
    eid = add(on, slug, legacy_equal([a, b], amount=1000)).json()["expenses"][0]["id"]
    edit(on, slug, eid, {**equal([a, b], amount=1100), "version": 1})
    before = rows(dsn, slug)[-1]["before"]
    assert (before["mode"], before["inputs"], before["version"]) == (None, [], 1)


class SneakyConn:
    """Wraps the request's connection. Just before the edit's `update expenses`, after its version check, a second phone
    tries the same expense: it takes the wallet lock first, as every API write does, then edits and commits."""

    def __init__(self, conn, sneak):
        self._conn, self._sneak = conn, sneak

    def execute(self, query, *args, **kwargs):
        if str(query).lstrip().startswith("update expenses"):
            self._sneak()
        return self._conn.execute(query, *args, **kwargs)

    def __getattr__(self, name):
        return getattr(self._conn, name)


def test_b11_the_version_check_and_the_write_are_one_step_under_the_wallet_lock(on, dsn, monkeypatch):
    """tg-test3's RED nit: without the lock, a second phone's edit between the check and the write would be lost."""
    from contextlib import contextmanager

    from app import db

    slug, (a, b, *_) = new_wallet(on)
    eid = add(on, slug, equal([a, b], amount=1000)).json()["expenses"][0]["id"]
    outcome = []

    def sneak():
        with psycopg.connect(dsn) as other:
            other.execute("set lock_timeout = '1s'")
            try:
                other.execute("select id from wallets where share_slug = %s for update", (slug,))
                other.execute("update expenses set version = version + 1, note = 'Sneaky' where id = %s", (eid,))
                outcome.append("wrote")
            except psycopg.errors.LockNotAvailable:
                outcome.append("blocked")

    real = db.get_conn

    @contextmanager
    def get_conn():
        with real() as conn:
            yield SneakyConn(conn, sneak)

    monkeypatch.setattr(db, "get_conn", get_conn)
    r = edit(on, slug, eid, {**equal([a, b], amount=1200), "version": 1})
    monkeypatch.setattr(db, "get_conn", real)
    assert r.status_code == 200, r.text
    assert outcome == ["blocked"], "the second phone waits for the wallet lock"
    assert (stored(dsn, eid)["version"], stored(dsn, eid)["amount_centavos"]) == (2, 1200)


# ---------------------------------------------------------------- B12: a no-op edit

def test_b12_a_no_op_edit_writes_nothing(on, dsn):
    slug, (a, b, *_) = new_wallet(on)
    eid = add(on, slug, equal([a, b], amount=1000, category="food")).json()["expenses"][0]["id"]
    n, before_rows = rev(dsn, slug), rows(dsn, slug)
    r = edit(on, slug, eid, {**equal([b, a], amount=1000, payer=a, category="food"), "version": 1})  # people reordered
    assert r.status_code == 200, r.text
    assert expense(r.json(), eid)["version"] == 1 and expense(r.json(), eid)["updated_at"] is None
    assert (rev(dsn, slug), rows(dsn, slug)) == (n, before_rows)


def test_b12_a_mode_change_with_the_same_money_is_an_edit(on, dsn):
    """tg-review2's M1 on #91 (this test said the opposite at RED): the person chose Shares 1:1:1, so it's saved."""
    slug, (a, b, c, _) = new_wallet(on)
    eid = add(on, slug, equal([a, b, c], amount=900)).json()["expenses"][0]["id"]
    n = rev(dsn, slug)
    same_money = {"mode": "shares", "paid_by": a, "amount_centavos": 900, "note": "Dinner", "version": 1,
                  "inputs": [{"member_id": m, "value": 1} for m in (a, b, c)]}
    r = edit(on, slug, eid, same_money)
    assert r.status_code == 200, r.text
    assert rev(dsn, slug) == n + 1 and stored(dsn, eid)["split_mode"] == "shares"
    assert expense(r.json(), eid)["inputs"] == same_money["inputs"]


def itemized_bill(a, b, charge):
    return {"mode": "itemized", "paid_by": a, "note": "Dinner", "category": "food",
            "items": [{"name": "Rice", "price_centavos": 1000, "who": [a, b]},
                      {"name": "Kape", "price_centavos": 80, "who": [b]}], "charges": [charge]}


@pytest.mark.parametrize("change", ["item_name", "charge_form", "item_order_of_who", "nothing"])
def test_b12_an_itemized_edit_compares_the_items_and_charges_too(on, dsn, change):
    """M1: renaming an item, or a 10% charge typed as the same pesos, changes no money but is a real edit.
    The same bill with an item's people listed in another order is still a no-op."""
    slug, (a, b, *_) = new_wallet(on)
    first = itemized_bill(a, b, {"kind": "service", "basis": "percent", "value": 1000})
    eid = add(on, slug, first).json()["expenses"][0]["id"]
    body = {**first, "version": 1}
    if change == "item_name":
        body["items"] = [{**first["items"][0], "name": "Rice, 4 cups"}, first["items"][1]]
    elif change == "charge_form":
        body["charges"] = [{"kind": "service", "basis": "amount", "value": 108}]  # 10% of 1080 is 108: the same money
    elif change == "item_order_of_who":
        body["items"] = [{**first["items"][0], "who": [b, a]}, first["items"][1]]
    n = rev(dsn, slug)
    r = edit(on, slug, eid, body)
    assert r.status_code == 200, r.text
    e = expense(r.json(), eid)
    if change in ("item_name", "charge_form"):
        assert rev(dsn, slug) == n + 1 and e["version"] == 2
        assert (e["items"][0]["name"], e["charges"]) == (body["items"][0]["name"], body["charges"])
    else:
        assert rev(dsn, slug) == n and e["version"] == 1


def test_b12_a_legacy_tie_given_in_another_order_infers_exact_as_the_web_does(on, dsn):
    """tg-review2: the inferred mode is B22's rule exactly (split_equal over the shares' people in wallet order, the
    stored paid_by as payer), as the web's formFromExpense does. Old order C, B, A stored C334 B334 A333; wallet order
    would give A334, so it reopens as Amounts, and Amounts saved unchanged is a no-op."""
    slug, (a, b, c, d) = new_wallet(on)
    eid = add(on, slug, legacy_equal([c, b, a], amount=1001, payer=d)).json()["expenses"][0]["id"]
    e = expense(on.get(f"/wallets/{slug}").json(), eid)
    assert shares(e) == {a: 333, b: 334, c: 334}
    n = rev(dsn, slug)
    r = edit(on, slug, eid, {**exact([(a, 333), (b, 334), (c, 334)], payer=d), "version": 1})
    assert r.status_code == 200 and rev(dsn, slug) == n, "saved as its inferred mode (exact): a no-op"
    assert stored(dsn, eid)["split_mode"] is None
    r = edit(on, slug, eid, {**equal([a, b, c], amount=1001, payer=d), "version": 1})
    assert r.status_code == 200 and rev(dsn, slug) == n + 1, "Equally moves a centavo from C to A: an edit"


def test_b12_a_legacy_expense_saved_as_the_other_mode_is_an_edit(on, dsn):
    """The legacy exception covers only the inferred mode: a legacy equal saved as Amounts is the person's choice."""
    slug, (a, b, *_) = new_wallet(on)
    eid = add(on, slug, legacy_equal([a, b], amount=1000)).json()["expenses"][0]["id"]
    n = rev(dsn, slug)
    assert edit(on, slug, eid, {**exact([(a, 500), (b, 500)], payer=a), "version": 1}).status_code == 200
    assert rev(dsn, slug) == n + 1 and stored(dsn, eid)["split_mode"] == "exact"


@pytest.mark.parametrize("change", ["note", "category", "amount", "payer", "shares", "payers"])
def test_b12_any_change_to_money_or_words_is_an_edit(on, dsn, change):
    slug, (a, b, c, _) = new_wallet(on)
    first = equal([a, b], amount=1000, category="food")
    if change == "payers":  # tg-test3's S1: same amount, first payer and shares; only the payers' amounts move
        del first["paid_by"]
        first["payers"] = [{"member_id": b, "paid_centavos": 700}, {"member_id": c, "paid_centavos": 300}]
    eid = add(on, slug, first).json()["expenses"][0]["id"]
    body = {**first, "version": 1}
    if change == "note":
        body["note"] = "Dinner, really"
    elif change == "category":
        body["category"] = None
    elif change == "amount":
        body["amount_centavos"] = 1002
    elif change == "payer":
        body["paid_by"] = b
    elif change == "shares":
        body = {**exact([(a, 400), (b, 600)], payer=a, category="food"), "version": 1}
    else:
        body["payers"] = [{"member_id": b, "paid_centavos": 500}, {"member_id": c, "paid_centavos": 500}]
    n = rev(dsn, slug)
    r = edit(on, slug, eid, body)
    assert r.status_code == 200, r.text
    assert rev(dsn, slug) == n + 1 and stored(dsn, eid)["version"] == 2
    if change == "payers":
        assert expense(r.json(), eid)["payers"] == body["payers"]


def test_b12_a_legacy_equal_expense_saved_unchanged_as_equal_is_a_no_op(on, dsn):
    slug, (a, b, c, _) = new_wallet(on)
    eid = add(on, slug, legacy_equal([a, b, c], amount=1000, payer=b)).json()["expenses"][0]["id"]
    n, before_rows = rev(dsn, slug), rows(dsn, slug)
    r = edit(on, slug, eid, {**equal([a, b, c], amount=1000, payer=b), "version": 1})
    assert r.status_code == 200, r.text
    assert (rev(dsn, slug), rows(dsn, slug)) == (n, before_rows)
    assert stored(dsn, eid)["split_mode"] is None, "nothing written: it stays legacy"


def test_b12_a_legacy_exact_expense_saved_unchanged_as_exact_is_a_no_op(on, dsn):
    slug, (a, b, *_) = new_wallet(on)
    eid = add(on, slug, {"paid_by": a, "amount_centavos": 700, "note": "Taxi",
                         "shares": [{"member_id": a, "share_centavos": 500}, {"member_id": b, "share_centavos": 200}]}
              ).json()["expenses"][0]["id"]
    n = rev(dsn, slug)
    r = edit(on, slug, eid, {**exact([(a, 500), (b, 200)], payer=a, note="Taxi"), "version": 1})
    assert r.status_code == 200 and rev(dsn, slug) == n


# ---------------------------------------------------------------- B13: delete

def test_b13_a_delete_records_expense_delete_with_before(on, dsn):
    slug, (a, b, c, _) = new_wallet(on)
    e = add(on, slug, equal([a, b], amount=1000)).json()["expenses"][0]
    r = delete(on, slug, e["id"], version=1, by=c)
    assert r.status_code == 200, r.text
    assert r.json()["expenses"] == [] and r.json()["rev"] == rev(dsn, slug) == 2
    row = rows(dsn, slug)[-1]
    assert (row["action"], row["expense_id"], row["actor"], row["after"]) == ("expense_delete", e["id"], c, None)
    assert row["before"] == {k: v for k, v in e.items() if k in SNAPSHOT}


def test_b13_a_stale_version_is_409_with_the_wallet_and_nothing_deleted(on, dsn):
    slug, (a, b, *_) = new_wallet(on)
    eid = add(on, slug, equal([a, b], amount=1000)).json()["expenses"][0]["id"]
    edit(on, slug, eid, {**equal([a, b], amount=1200), "version": 1})
    n = rev(dsn, slug)
    r = delete(on, slug, eid, version=1)
    assert r.status_code == 409, r.text
    assert detail(r)["code"] == "expense_changed" and expense(detail(r)["wallet"], eid)["version"] == 2
    assert rev(dsn, slug) == n and stored(dsn, eid)["version"] == 2


def test_b13_a_versioned_delete_of_a_gone_expense_is_404_expense_gone_with_the_wallet(on, dsn):
    slug, (a, b, *_) = new_wallet(on)
    eid = add(on, slug, equal([a, b], amount=1000)).json()["expenses"][0]["id"]
    delete(on, slug, eid)
    n = rev(dsn, slug)
    r = delete(on, slug, eid, version=1)
    assert r.status_code == 404, r.text
    assert detail(r)["code"] == "expense_gone" and detail(r)["wallet"]["rev"] == n
    assert rev(dsn, slug) == n


def test_b13_without_version_todays_answers_are_unchanged(client, dsn, flags):
    slug, (a, b, *_) = new_wallet(client)
    eid = add(client, slug, legacy_equal([a, b], amount=1000)).json()["expenses"][0]["id"]
    assert delete(client, slug, eid).status_code == 200
    r = delete(client, slug, eid)
    assert (r.status_code, detail(r)) == (404, "Expense not found")
    assert delete(client, slug, str(uuid4())).json() == {"detail": "Expense not found"}


def test_b13_a_delete_cascades_the_comments(on, dsn):
    slug, (a, b, *_) = new_wallet(on)
    eid = add(on, slug, equal([a, b], amount=1000)).json()["expenses"][0]["id"]
    sql(dsn, "insert into expense_comments (expense_id, author, body) values (%s, %s, 'TESTCOMMENT')", (eid, a))
    assert delete(on, slug, eid).status_code == 200
    assert sql(dsn, "select 1 from expense_comments where expense_id = %s", (eid,)) == []


def test_b13_delete_by_a_stranger_is_unknown_member(on, dsn):
    slug, (a, b, *_) = new_wallet(on)
    _, (stranger, *_) = new_wallet(on, 1)
    eid = add(on, slug, equal([a, b], amount=1000)).json()["expenses"][0]["id"]
    r = delete(on, slug, eid, by=stranger)
    assert (r.status_code, detail(r)) == (422, "unknown_member")
    assert stored(dsn, eid)["version"] == 1


# ---------------------------------------------------------------- B15: the flags

@pytest.mark.parametrize("mode", ["equal", "exact"])
def test_b15_splits_off_still_takes_equal_and_exact_and_drops_the_category(client, dsn, flags, mode):
    flags()
    slug, (a, b, *_) = new_wallet(client)
    body = equal([a, b], amount=1000, category="food") if mode == "equal" else exact([(a, 400), (b, 600)], payer=a, category="food")
    r = add(client, slug, body, by=b)
    assert r.status_code == 201, r.text
    e = r.json()["expenses"][0]
    assert (e["mode"], e["category"]) == (mode, None)
    assert stored(dsn, e["id"])["category"] is None
    row = rows(dsn, slug)[-1]
    assert (row["action"], row["actor"], row["after"]["category"]) == ("expense_add", b, None), "by kept, rev moved"


@pytest.mark.parametrize("mode", ["percent", "shares", "adjust", "itemized"])
def test_b15_splits_off_refuses_the_other_modes(client, dsn, flags, mode):
    flags(wallet_multi_payer=True, wallet_activity=True)
    slug, (a, b, *_) = new_wallet(client)
    bodies = {
        "percent": {"mode": "percent", "paid_by": a, "amount_centavos": 100, "note": "x",
                    "inputs": [{"member_id": a, "value": 5000}, {"member_id": b, "value": 5000}]},
        "shares": {"mode": "shares", "paid_by": a, "amount_centavos": 100, "note": "x",
                   "inputs": [{"member_id": a, "value": 1}, {"member_id": b, "value": 1}]},
        "adjust": {"mode": "adjust", "paid_by": a, "amount_centavos": 100, "note": "x",
                   "inputs": [{"member_id": a, "value": 10}, {"member_id": b, "value": 0}]},
        "itemized": {"mode": "itemized", "paid_by": a, "note": "x",
                     "items": [{"name": "Kape", "price_centavos": 100, "who": [a]}]},
    }
    r = add(client, slug, bodies[mode])
    assert (r.status_code, detail(r)) == (404, "feature_off")
    assert rev(dsn, slug) == 0
    flags(wallet_splits=True)
    assert add(client, slug, bodies[mode]).status_code == 201


def test_b15_splits_off_refuses_every_edit(client, dsn, flags):
    flags(wallet_splits=True)
    slug, (a, b, *_) = new_wallet(client)
    eid = add(client, slug, equal([a, b], amount=1000)).json()["expenses"][0]["id"]
    flags(wallet_multi_payer=True, wallet_activity=True)
    n = rev(dsn, slug)
    r = edit(client, slug, eid, {**equal([a, b], amount=1200), "version": 1})
    assert (r.status_code, detail(r)) == (404, "feature_off")
    assert rev(dsn, slug) == n
    r = edit(client, slug, eid, {**equal([a, b], amount=1000), "version": 1})  # even a no-op
    assert (r.status_code, detail(r)) == (404, "feature_off")


def test_b15_splits_off_refuses_an_edit_before_judging_its_body(client, flags):
    """feature_off, not 422, for a body an old build might send, and for none at all (TG-58's I7 sends none)."""
    flags()
    slug, (a, b, *_) = new_wallet(client)
    eid = add(client, slug, equal([a, b], amount=1000)).json()["expenses"][0]["id"]
    for body in ({"version": 1, "mode": "thirds"}, {}):
        r = edit(client, slug, eid, body)
        assert (r.status_code, detail(r)) == (404, "feature_off"), r.text
    r = client.patch(f"/wallets/{slug}/expenses/{eid}")  # no body
    assert (r.status_code, detail(r)) == (404, "feature_off")


def test_b15_splits_off_deletes_still_work_with_or_without_version(client, flags):
    flags()
    slug, (a, b, *_) = new_wallet(client)
    one = add(client, slug, equal([a, b], amount=1000)).json()["expenses"][0]["id"]
    two = add(client, slug, equal([a, b], amount=1000)).json()["expenses"][0]["id"]
    assert delete(client, slug, one).status_code == 200
    assert delete(client, slug, two, version=1).status_code == 200


def payers_body(a, b, amount=1000):
    body = equal([a, b], amount=amount)
    del body["paid_by"]
    body["payers"] = [{"member_id": a, "paid_centavos": amount - 100}, {"member_id": b, "paid_centavos": 100}]
    return body


def test_b15_multi_payer_off_refuses_a_body_with_payers(client, dsn, flags):
    flags(wallet_splits=True, wallet_activity=True)
    slug, (a, b, *_) = new_wallet(client)
    r = add(client, slug, payers_body(a, b))
    assert (r.status_code, detail(r)) == (404, "feature_off")
    eid = add(client, slug, equal([a, b], amount=1000)).json()["expenses"][0]["id"]
    r = edit(client, slug, eid, {**payers_body(a, b), "version": 1})
    assert (r.status_code, detail(r)) == (404, "feature_off")
    assert stored(dsn, eid)["version"] == 1


def test_b15_multi_payer_off_refuses_a_one_payer_edit_of_a_stored_multi_payer_expense(client, dsn, flags):
    flags(wallet_splits=True, wallet_multi_payer=True)
    slug, (a, b, *_) = new_wallet(client)
    first = add(client, slug, payers_body(a, b)).json()
    eid = first["expenses"][0]["id"]
    flags(wallet_splits=True)
    r = edit(client, slug, eid, {**equal([a, b], amount=1000, payer=a), "version": 1})
    assert (r.status_code, detail(r)) == (404, "feature_off")
    now = client.get(f"/wallets/{slug}").json()
    assert expense(now, eid)["payers"] == expense(first, eid)["payers"], "S4: the payers aren't dropped"
    assert now["balances"] == first["balances"] and now["rev"] == first["rev"]
    assert delete(client, slug, eid, version=1).status_code == 200, "deleting it still works"


def test_b15_reads_include_the_new_fields_with_every_flag_off(client, flags):
    flags(wallet_splits=True, wallet_multi_payer=True)
    slug, (a, b, *_) = new_wallet(client)
    add(client, slug, {**payers_body(a, b), "category": "transport"})
    add(client, slug, {"mode": "itemized", "paid_by": a, "note": "x",
                       "items": [{"name": "Kape", "price_centavos": 100, "who": [a, b]}],
                       "charges": [{"kind": "service", "basis": "amount", "value": 10}]})
    flags()
    wallet = client.get(f"/wallets/{slug}").json()
    itemized, multi = wallet["expenses"]
    assert multi["category"] == "transport" and len(multi["payers"]) == 2 and multi["mode"] == "equal"
    assert itemized["items"][0]["who"] == [a, b] and itemized["charges"][0]["value"] == 10
    assert wallet["rev"] == 2


# ---------------------------------------------------------------- B15a: no item name anywhere

def test_b15a_item_no_one_names_the_seq_in_the_answer_and_never_the_item(on, caplog):
    caplog.set_level(logging.DEBUG)
    slug, (a, *_) = new_wallet(on)
    r = add(on, slug, {"mode": "itemized", "paid_by": a, "note": "x",
                       "items": [{"name": "Lugaw", "price_centavos": 500, "who": [a]},
                                 {"name": ITEM, "price_centavos": 300, "who": []}]})
    assert r.status_code == 422 and r.json() == {"detail": {"code": "item_no_one", "seq": 2}}
    assert ITEM not in r.text
    assert not any(ITEM in rec.getMessage() for rec in caplog.records)


# ---------------------------------------------------------------- B16: every write moves rev and is recorded

def test_b16_every_write_returns_the_new_rev_and_records_its_action(on, dsn):
    slug, (a, b, c, _) = new_wallet(on)
    seen = []

    def step(r, action):
        assert r.status_code in (200, 201), r.text
        seen.append(r.json()["rev"])
        assert rows(dsn, slug)[-1]["action"] == action
        return r.json()

    joined = step(on.post(f"/wallets/{slug}/members?by={a}", json={"name": "Gina Testname"}), "member_join")
    gina = joined["members"][-1]["id"]
    assert rows(dsn, slug)[-1]["member_id"] == gina and rows(dsn, slug)[-1]["actor"] == a
    eid = step(add(on, slug, equal([a, b], amount=1000)), "expense_add")["expenses"][0]["id"]
    step(edit(on, slug, eid, {**equal([a, b], amount=1200), "version": 1}), "expense_edit")
    paid = step(on.post(f"/wallets/{slug}/settlements?by={b}",
                        json={"from_member": b, "to_member": a, "amount_centavos": 600}), "settle")
    sid = paid["settlements"][0]["id"]
    settle_row = rows(dsn, slug)[-1]
    assert (settle_row["settlement_id"], settle_row["actor"]) == (sid, b)
    assert settle_row["after"] == {"from_member": b, "to_member": a, "amount_centavos": 600}
    step(on.delete(f"/wallets/{slug}/settlements/{sid}?by={c}"), "settle_undo")
    undo_row = rows(dsn, slug)[-1]
    assert (undo_row["settlement_id"], undo_row["actor"]) == (sid, c)
    assert undo_row["after"] == {"from_member": b, "to_member": a, "amount_centavos": 600}, "still reads once undone"
    step(delete(on, slug, eid), "expense_delete")
    assert seen == [1, 2, 3, 4, 5, 6]
    assert on.get(f"/wallets/{slug}").json()["rev"] == 6


def test_b16_a_member_join_without_by_is_someone(client, dsn, flags):
    slug, _ = new_wallet(client)
    client.post(f"/wallets/{slug}/members", json={"name": "Gina Testname"})
    assert rows(dsn, slug)[-1]["actor"] is None


@pytest.mark.parametrize("route", ["member", "settle", "undo"])
def test_b16_a_stranger_as_by_is_unknown_member_and_nothing_moves(client, dsn, flags, route):
    slug, (a, b, *_) = new_wallet(client)
    _, (stranger, *_) = new_wallet(client, 1)
    sid = client.post(f"/wallets/{slug}/settlements", json={"from_member": b, "to_member": a,
                                                             "amount_centavos": 100}).json()["settlements"][0]["id"]
    n = rev(dsn, slug)
    if route == "member":
        r = client.post(f"/wallets/{slug}/members?by={stranger}", json={"name": "Gina Testname"})
    elif route == "settle":
        r = client.post(f"/wallets/{slug}/settlements?by={stranger}", json={"from_member": b, "to_member": a,
                                                                          "amount_centavos": 100})
    else:
        r = client.delete(f"/wallets/{slug}/settlements/{sid}?by={stranger}")
    assert (r.status_code, detail(r)) == (422, "unknown_member")
    assert rev(dsn, slug) == n


def test_b16_a_failed_record_rolls_back_the_expense(on, dsn):
    """record() runs in the route's transaction: if its rev bump fails, the expense isn't there either."""
    slug, (a, b, *_) = new_wallet(on)
    sql(dsn, """create function tg66_a3_fail() returns trigger language plpgsql as
                $$ begin raise exception 'tg66 a3 test'; end $$""")
    sql(dsn, "create trigger tg66_a3_fail before update of rev on wallets for each row execute function tg66_a3_fail()")
    try:
        try:
            r = add(on, slug, equal([a, b], amount=1000))
            assert r.status_code == 500
        except psycopg.Error:
            pass
    finally:
        sql(dsn, "drop trigger tg66_a3_fail on wallets")
    assert sql(dsn, "select 1 from expenses e join wallets w on w.id = e.wallet_id where w.share_slug = %s", (slug,)) == []
    assert rows(dsn, slug) == []


# ---------------------------------------------------------------- B17: logs

def test_b17_logs_carry_slug_mode_category_and_totals_never_names_notes_items_or_ids(on, dsn, caplog):
    caplog.set_level(logging.DEBUG)
    slug, (a, b, c, d) = new_wallet(on)
    eid = add(on, slug, {"mode": "itemized", "paid_by": a, "note": NOTE, "category": "food",
                         "items": [{"name": ITEM, "price_centavos": 42000, "who": [a, b]},
                                   {"name": "Rice", "price_centavos": 16000, "who": [a, b, c, d]}],
                         "charges": [{"kind": "service", "basis": "percent", "value": 1000}]}, by=b
              ).json()["expenses"][0]["id"]
    edit(on, slug, eid, {**equal([a, b], amount=5000, note=NOTE, category="food"), "version": 1, "by": c})
    edit(on, slug, eid, {**equal([a, b], amount=5000, note=NOTE), "version": 1})  # stale: refused
    add(on, slug, {"mode": "itemized", "paid_by": a, "note": NOTE,
                   "items": [{"name": ITEM, "price_centavos": 1, "who": []}]})  # item_no_one
    on.post(f"/wallets/{slug}/members?by={a}", json={"name": "Gina Testname"})
    sid = on.post(f"/wallets/{slug}/settlements?by={d}", json={"from_member": b, "to_member": a,
                                                             "amount_centavos": 600}).json()["settlements"][0]["id"]
    on.delete(f"/wallets/{slug}/settlements/{sid}?by={d}")
    delete(on, slug, eid, version=2, by=d)
    lines = [r.getMessage() for r in caplog.records if r.name.startswith("tara_gala")]
    text = "\n".join(lines)
    secrets = [*NAMES, "Gina Testname", "TESTPLACE", ITEM, "Rice", a, b, c, d]  # not expense or payment ids: paths hold them
    for s in secrets:
        assert s not in text, s
    assert f"share_slug={slug}" in text
    assert re.search(r"wallet expense add share_slug=\w+ mode=itemized .*amount=63800 category=food", text), text
    assert re.search(r"wallet expense edit share_slug=\w+ mode=equal version=2 amount_before=63800 amount_after=5000",
                     text), text
    assert re.search(r"wallet expense edit refused share_slug=\w+ reason=expense_changed", text), text
    assert re.search(r"wallet expense add refused share_slug=\w+ reason=item_no_one", text), text
    assert re.search(r"wallet expense delete share_slug=\w+ amount=5000", text), text
    assert re.search(r"rev=\d+", text), "_counts() prints rev"
