"""TG-66 A1: wallet_splits, the money (plan §2 and §3, B1 to B4a).

Pure functions, no database. The vectors are tg-test's `fixtures/wallet_split_vectors.json`, which W1's
walletSplit.ts loads too, so the server and the phone's preview can't drift.

- B1: every mode reproduces every vector (as plain dicts and as wallet_models' request models).
- B2: 2,000 seeded random cases per mode: shares sum to the amount, none below 0, and the mode's rounding bound.
- B3: `equal` gives today's split_equal when the order is wallet order.
- B4: check_payers and first_payer.
- B4a: itemized is the three steps of §2 (items, then service, then VAT, each through allocate), integers only.
- Logs: counts, mode and refusal code only; never a member id, an item name or an amount.
"""

import ast
import importlib
import json
import logging
import random
import re
from fractions import Fraction
from math import floor
from pathlib import Path
from uuid import UUID

import pytest
from pydantic import TypeAdapter

from app.wallet_models import MAX_CENTAVOS, SPLIT_CODES, ExpenseInV2

VECTORS = json.loads((Path(__file__).parent / "fixtures" / "wallet_split_vectors.json").read_text())
CASES = VECTORS["cases"]
MEMBERS = [UUID(u) for u in VECTORS["members"].values()]  # wallet order
ANA, BEN, CARLA, DAN, ELI, FE = MEMBERS
SOURCE = Path(__file__).resolve().parents[1] / "app" / "wallet_splits.py"
SINGLE_STEP = ("equal", "percent", "shares")


@pytest.fixture
def ws():
    """Imported per test, so before GREEN every test fails on its own rather than the whole file erroring."""
    return importlib.import_module("app.wallet_splits")


# ---------------------------------------------------------------- helpers

def _uuids(case: dict) -> dict:
    """The vector with every member id as a UUID (inputs, items' who, payer, order, expected shares)."""
    out = dict(case)
    out["payer_first"] = UUID(case["payer_first"])
    out["wallet_order"] = [UUID(m) for m in case["wallet_order"]]
    out["inputs"] = [{"member_id": UUID(i["member_id"]), "value": i["value"]} for i in case.get("inputs", [])]
    out["items"] = [{**i, "who": [UUID(m) for m in i["who"]]} for i in case.get("items", [])]
    out["charges"] = list(case.get("charges", []))
    expect = dict(case["expect"])
    if "shares" in expect:
        expect["shares"] = {UUID(m): v for m, v in expect["shares"].items()}
    out["expect"] = expect
    return out


def _run(ws, c: dict):
    return ws.split(c["mode"], c.get("amount"), c["inputs"], c["items"], c["charges"], c["payer_first"],
                    c["wallet_order"])


def _body(case: dict) -> dict:
    """The vector as an ExpenseInV2 request body (contract choices 1 and 2)."""
    body = {"mode": case["mode"], "paid_by": case["payer_first"], "note": "Vector"}
    if case["mode"] == "itemized":
        body["items"] = case["items"]
        body["charges"] = case.get("charges", [])
        if case.get("amount") is not None:
            body["amount_centavos"] = case["amount"]
    else:
        body["inputs"] = case["inputs"]
        body["amount_centavos"] = case["amount"]
    return body


def _ids(case):
    return case["name"]


# ---------------------------------------------------------------- B1: the vectors

def test_the_vectors_cover_every_mode_and_every_split_code_but_payers():
    modes = {c["mode"] for c in CASES}
    assert modes == {"equal", "exact", "percent", "shares", "adjust", "itemized"}
    errors = {c["expect"]["error"] for c in CASES if "error" in c["expect"]}
    assert errors <= set(SPLIT_CODES)
    assert errors == set(SPLIT_CODES) - {"payers_mismatch"}  # payers are check_payers', below (B4)


@pytest.mark.parametrize("case", CASES, ids=_ids)
def test_split_reproduces_the_vector(ws, case):
    c = _uuids(case)
    expect = c["expect"]
    if "error" in expect:
        with pytest.raises(ws.SplitError) as caught:
            _run(ws, c)
        assert caught.value.code == expect["error"]
        assert caught.value.seq == expect.get("seq")
    else:
        amount, shares = _run(ws, c)
        assert amount == expect["amount"]
        assert shares == expect["shares"]
        assert all(type(v) is int for v in shares.values())


@pytest.mark.parametrize("case", CASES, ids=_ids)
def test_split_takes_the_request_models_as_they_are(ws, case):
    """A3 passes the parsed body's lists straight in: the same answer as the plain dicts."""
    body = TypeAdapter(ExpenseInV2).validate_python(_body(case))
    c = _uuids(case)
    inputs = getattr(body, "inputs", [])
    items = getattr(body, "items", [])
    charges = getattr(body, "charges", [])
    expect = c["expect"]

    def call():
        return ws.split(body.mode, body.amount_centavos, inputs, items, charges, c["payer_first"], c["wallet_order"])

    if "error" in expect:
        with pytest.raises(ws.SplitError) as caught:
            call()
        assert (caught.value.code, caught.value.seq) == (expect["error"], expect.get("seq"))
    else:
        assert call() == (expect["amount"], expect["shares"])


def test_the_66_04_items_bill_from_ux(ws):
    case = next(_uuids(c) for c in CASES if c["name"] == "itemized 66-04-items bill (ux)")
    amount, shares = _run(ws, case)
    assert amount == 118800
    assert [shares[m] for m in (ANA, BEN, CARLA, DAN)] == [27501, 41434, 31533, 18332]


# ---------------------------------------------------------------- allocate

def test_allocate_floors_then_gives_the_leftover_one_each_in_the_given_order(ws):
    assert ws.allocate(10, {ANA: 1, BEN: 1, CARLA: 1}, [CARLA, ANA, BEN]) == {ANA: 3, BEN: 3, CARLA: 4}
    assert ws.allocate(11, {ANA: 1, BEN: 1, CARLA: 1}, [CARLA, ANA, BEN]) == {ANA: 4, BEN: 3, CARLA: 4}
    assert ws.allocate(102, {ANA: 2, BEN: 1, CARLA: 1}, [ANA, BEN, CARLA]) == {ANA: 52, BEN: 25, CARLA: 25}


def test_allocate_skips_weight_zero_for_the_leftover_and_keeps_it_in_the_answer(ws):
    assert ws.allocate(5, {ANA: 0, BEN: 1, CARLA: 1}, [ANA, BEN, CARLA]) == {ANA: 0, BEN: 3, CARLA: 2}


def test_allocate_ignores_order_entries_without_a_weight(ws):
    assert ws.allocate(5, {BEN: 1, CARLA: 1}, [ANA, CARLA, BEN, DAN]) == {BEN: 2, CARLA: 3}


def test_allocate_of_zero_is_all_zero(ws):
    assert ws.allocate(0, {ANA: 3, BEN: 1}, [ANA, BEN]) == {ANA: 0, BEN: 0}


@pytest.mark.parametrize("weights,order,amount", [
    ({ANA: 0, BEN: 0}, [ANA, BEN], 5),  # W = 0
    ({}, [ANA], 5),  # no one
    ({ANA: -1, BEN: 2}, [ANA, BEN], 5),  # a negative weight
    ({ANA: 1, BEN: 1}, [ANA], 5),  # a weighted person missing from the order
    ({ANA: 1}, [ANA], -1),  # a negative amount
], ids=["w-zero", "empty", "negative-weight", "missing-from-order", "negative-amount"])
def test_allocate_refuses_what_a_caller_should_never_send(ws, weights, order, amount):
    with pytest.raises(ValueError):
        ws.allocate(amount, weights, order)


def test_allocate_random_cases_follow_the_rule_exactly(ws):
    rng = random.Random(6601)
    for _ in range(2000):
        people = rng.sample(MEMBERS, rng.randint(1, 6))
        weights = {m: rng.choice([0, rng.randint(1, 10000)]) for m in people}
        if not any(weights.values()):
            weights[people[0]] = 1
        order = rng.sample(people, len(people))
        amount = rng.randint(0, MAX_CENTAVOS)
        got = ws.allocate(amount, weights, order)
        total = sum(weights.values())
        floors = {m: amount * w // total for m, w in weights.items()}
        leftover = amount - sum(floors.values())
        plus_one = [m for m in order if weights[m] > 0][:leftover]
        assert got == {m: floors[m] + (1 if m in plus_one else 0) for m in weights}


# ---------------------------------------------------------------- charge_amount

@pytest.mark.parametrize("subtotal,basis,value,expect", [
    (5, "percent", 1000, 1),  # 0.5 rounds up
    (4, "percent", 1000, 0),  # 0.4 rounds down
    (15, "percent", 1000, 2),  # 1.5 rounds up
    (283333, "percent", 500, 14167),
    (283333, "percent", 1200, 34000),
    (999, "percent", 10000, 999),  # 100% is allowed
    (999, "percent", 0, 0),
    (12345, "amount", 101, 101),  # an amount charge is its value
    (12345, "amount", 0, 0),
])
def test_charge_amount_is_integer_half_up(ws, subtotal, basis, value, expect):
    got = ws.charge_amount(subtotal, basis, value)
    assert got == expect and type(got) is int


@pytest.mark.parametrize("basis,value", [("percent", 10001), ("percent", -1), ("amount", -1)])
def test_charge_amount_refuses_charge_too_big(ws, basis, value):
    with pytest.raises(ws.SplitError) as caught:
        ws.charge_amount(1000, basis, value)
    assert caught.value.code == "charge_too_big"


def test_charge_amount_matches_the_half_up_rule_on_random_subtotals(ws):
    rng = random.Random(6602)
    for _ in range(2000):
        s, bp = rng.randint(0, MAX_CENTAVOS), rng.randint(0, 10000)
        exact = Fraction(s * bp, 10000)
        assert ws.charge_amount(s, "percent", bp) == floor(exact + Fraction(1, 2))


# ---------------------------------------------------------------- split: the edges the vectors don't name

def test_an_amount_over_the_cap_is_amount_too_big_in_every_mode(ws):
    for mode in ("equal", "exact", "percent", "shares", "adjust"):
        value = {"equal": 1, "exact": MAX_CENTAVOS + 1, "percent": 10000, "shares": 1, "adjust": 0}[mode]
        with pytest.raises(ws.SplitError) as caught:
            ws.split(mode, MAX_CENTAVOS + 1, [{"member_id": ANA, "value": value}], [], [], ANA, MEMBERS)
        assert caught.value.code == "amount_too_big", mode


@pytest.mark.parametrize("amount", [None, 0, -5])
def test_a_missing_or_non_positive_amount_outside_itemized_is_a_caller_bug(ws, amount):
    with pytest.raises(ValueError):
        ws.split("equal", amount, [{"member_id": ANA, "value": 1}], [], [], ANA, MEMBERS)


def test_an_unknown_mode_is_a_caller_bug(ws):
    with pytest.raises(ValueError):
        ws.split("thirds", 300, [{"member_id": ANA, "value": 1}], [], [], ANA, MEMBERS)


def test_a_person_outside_the_wallet_order_is_a_caller_bug(ws):
    """A3 refuses non-members first (422 unknown_member); the split never guesses a place in the order."""
    stranger = UUID("00000000-0000-4000-8000-0000000000ff")
    with pytest.raises(ValueError):
        ws.split("equal", 300, [{"member_id": stranger, "value": 1}], [], [], ANA, MEMBERS)
    with pytest.raises(ValueError):
        ws.split("itemized", None, [], [{"name": "X", "price_centavos": 300, "who": [stranger]}], [], ANA, MEMBERS)


def test_the_same_person_twice_is_a_caller_bug(ws):
    with pytest.raises(ValueError):
        ws.split("equal", 300, [{"member_id": ANA, "value": 1}, {"member_id": ANA, "value": 1}], [], [], ANA, MEMBERS)


def test_exact_with_a_negative_input_is_shares_mismatch(ws):
    with pytest.raises(ws.SplitError) as caught:
        ws.split("exact", 100, [{"member_id": ANA, "value": 150}, {"member_id": BEN, "value": -50}], [], [], ANA,
                 MEMBERS)
    assert caught.value.code == "shares_mismatch"


def test_an_itemized_charge_order_does_not_matter(ws):
    items = [{"name": "Room", "price_centavos": 250000, "who": [ANA, BEN]},
             {"name": "Breakfast", "price_centavos": 33333, "who": [BEN, CARLA, DAN]}]
    service = {"kind": "service", "basis": "percent", "value": 500}
    vat = {"kind": "vat", "basis": "percent", "value": 1200}
    a = ws.split("itemized", None, [], items, [service, vat], BEN, MEMBERS)
    b = ws.split("itemized", None, [], items, [vat, service], BEN, MEMBERS)
    assert a == b == (331500, {ANA: 146251, BEN: 159251, CARLA: 12999, DAN: 12999})


def test_itemized_refusals_come_in_a_fixed_order(ws):
    """too_many_items, then item_no_one (the first such seq), then charge_too_big, items_zero, amount_too_big and
    amount_mismatch. W1's preview shows the same first problem."""
    nobody = {"name": "TESTITEM", "price_centavos": 0, "who": []}
    free = {"name": "Water", "price_centavos": 0, "who": [ANA]}
    big = {"name": "Van", "price_centavos": MAX_CENTAVOS, "who": [ANA]}
    too_big = {"kind": "vat", "basis": "percent", "value": 10001}

    def code(items, charges=(), amount=None):
        with pytest.raises(ws.SplitError) as caught:
            ws.split("itemized", amount, [], list(items), list(charges), ANA, MEMBERS)
        return caught.value.code, caught.value.seq

    assert code([free] * 40 + [nobody]) == ("too_many_items", None)
    assert code([free, nobody, nobody], [too_big]) == ("item_no_one", 2)
    assert code([free], [too_big]) == ("charge_too_big", None)
    assert code([free], [{"kind": "service", "basis": "amount", "value": 5}]) == ("items_zero", None)
    assert code([big], [{"kind": "service", "basis": "amount", "value": 1}], amount=5) == ("amount_too_big", None)
    assert code([{**free, "price_centavos": 10}], amount=11) == ("amount_mismatch", None)


# ---------------------------------------------------------------- SplitError

def test_split_error_carries_a_known_code_and_an_optional_seq(ws):
    e = ws.SplitError("item_no_one", seq=3)
    assert (e.code, e.seq) == ("item_no_one", 3)
    assert "item_no_one" in str(e)
    assert ws.SplitError("percent_total").seq is None
    with pytest.raises(ValueError):
        ws.SplitError("not_a_code")


def test_item_no_one_names_the_seq_never_the_item(ws):
    case = _uuids(next(c for c in CASES if c["expect"].get("error") == "item_no_one"))
    names = [i["name"] for i in case["items"]]
    with pytest.raises(ws.SplitError) as caught:
        _run(ws, case)
    text = f"{caught.value} {caught.value!r} {caught.value.args}"
    assert caught.value.seq == 2
    assert not any(n in text for n in names)


# ---------------------------------------------------------------- B2: seeded random properties

def _random_people(rng, k_min=1):
    """A non-empty subset of the wallet, in wallet order."""
    picked = set(rng.sample(MEMBERS, rng.randint(k_min, len(MEMBERS))))
    return [m for m in MEMBERS if m in picked]


def _partition(rng, total, n):
    cuts = sorted(rng.randint(0, total) for _ in range(n - 1))
    return [b - a for a, b in zip([0] + cuts, cuts + [total])]


def _check_single_step(c, amount, weights, shares):
    """floor(exact) <= share <= floor(exact) + 1, and the payer gets the +1 first when they carry weight."""
    total = sum(weights.values())
    for m, w in weights.items():
        exact = Fraction(amount * w, total)
        assert floor(exact) <= shares[m] <= floor(exact) + 1, (c, m)
    leftover = amount - sum(amount * w // total for w in weights.values())
    payer = c["payer_first"]
    if leftover and weights.get(payer, 0) > 0:
        assert shares[payer] == amount * weights[payer] // total + 1


def _common(amount, shares, keys):
    assert set(shares) == set(keys)
    assert sum(shares.values()) == amount
    assert all(type(v) is int and v >= 0 for v in shares.values())


def _case(rng, mode):
    return {"mode": mode, "payer_first": rng.choice(MEMBERS), "wallet_order": MEMBERS, "inputs": [], "items": [],
            "charges": []}


def test_b2_equal(ws):
    rng = random.Random(6610)
    for _ in range(2000):
        c = _case(rng, "equal")
        people = _random_people(rng)
        c["amount"] = rng.randint(1, MAX_CENTAVOS)
        c["inputs"] = [{"member_id": m, "value": 1} for m in people]
        amount, shares = _run(ws, c)
        assert amount == c["amount"]
        _common(amount, shares, people)
        _check_single_step(c, amount, {m: 1 for m in people}, shares)


def test_b2_exact(ws):
    rng = random.Random(6611)
    for _ in range(2000):
        c = _case(rng, "exact")
        people = _random_people(rng)
        c["amount"] = rng.randint(1, MAX_CENTAVOS)
        values = _partition(rng, c["amount"], len(people))
        c["inputs"] = [{"member_id": m, "value": v} for m, v in zip(people, values)]
        amount, shares = _run(ws, c)
        _common(amount, shares, people)
        assert shares == dict(zip(people, values))


def test_b2_percent(ws):
    rng = random.Random(6612)
    for _ in range(2000):
        c = _case(rng, "percent")
        people = _random_people(rng)
        c["amount"] = rng.randint(1, MAX_CENTAVOS)
        bps = _partition(rng, 10000, len(people))
        c["inputs"] = [{"member_id": m, "value": v} for m, v in zip(people, bps)]
        amount, shares = _run(ws, c)
        _common(amount, shares, people)
        _check_single_step(c, amount, dict(zip(people, bps)), shares)


def test_b2_shares(ws):
    rng = random.Random(6613)
    for _ in range(2000):
        c = _case(rng, "shares")
        people = _random_people(rng)
        weights = {m: rng.randint(0, 20) for m in people}
        if not any(weights.values()):
            weights[people[-1]] = rng.randint(1, 20)
        c["amount"] = rng.randint(1, MAX_CENTAVOS)
        c["inputs"] = [{"member_id": m, "value": w} for m, w in weights.items()]
        amount, shares = _run(ws, c)
        _common(amount, shares, people)
        _check_single_step(c, amount, weights, shares)


def test_b2_adjust(ws):
    rng = random.Random(6614)
    accepted = 0
    for _ in range(2000):
        c = _case(rng, "adjust")
        people = _random_people(rng)
        c["amount"] = rng.randint(1, 1_000_000)
        span = c["amount"] // len(people)
        extras = {m: rng.choice([0, 0, rng.randint(-span, span)]) for m in people}
        c["inputs"] = [{"member_id": m, "value": e} for m, e in extras.items()]
        rest = c["amount"] - sum(extras.values())
        try:
            amount, shares = _run(ws, c)
        except ws.SplitError as e:
            assert e.code == "extras_too_big"
            assert rest < 0 or any(rest // len(people) + x < 0 for x in extras.values()), c
            continue
        accepted += 1
        _common(amount, shares, people)
        _check_single_step(c, rest, {m: 1 for m in people}, {m: shares[m] - extras[m] for m in people})
    assert accepted > 1000  # most cases are valid, so the properties really ran


def test_b2_itemized(ws):
    rng = random.Random(6615)
    for _ in range(2000):
        c = _case(rng, "itemized")
        c["amount"] = None
        n_items = rng.randint(1, 40)
        items = []
        for k in range(n_items):
            who = _random_people(rng)
            items.append({"name": f"Item {k + 1}", "price_centavos": rng.choice([0, rng.randint(1, 50000)]),
                          "who": who})
        if not any(i["price_centavos"] for i in items):
            items[0]["price_centavos"] = rng.randint(1, 50000)
        charges = []
        for kind in rng.sample(["service", "vat"], rng.randint(0, 2)):
            basis = rng.choice(["percent", "amount"])
            charges.append({"kind": kind, "basis": basis,
                            "value": rng.randint(0, 10000) if basis == "percent" else rng.randint(0, 100000)})
        c["items"], c["charges"] = items, charges
        amount, shares = _run(ws, c)
        people = {m for i in items for m in i["who"]}
        _common(amount, shares, people)
        # step 1's integer subtotals, by the plan's rule, independently of the module
        s = sum(i["price_centavos"] for i in items)
        sub = {m: 0 for m in people}
        exact = {m: Fraction(0) for m in people}
        for it in items:
            who = it["who"]
            order = ([c["payer_first"]] if c["payer_first"] in who else []) + [m for m in MEMBERS
                                                                               if m in who and m != c["payer_first"]]
            base, left = divmod(it["price_centavos"], len(who))
            for idx, m in enumerate(order):
                sub[m] += base + (1 if idx < left else 0)
                exact[m] += Fraction(it["price_centavos"], len(who))
        total = s
        for ch in charges:
            value = ch["value"]
            charge = (s * value + 5000) // 10000 if ch["basis"] == "percent" else value
            total += charge
            for m in people:
                exact[m] += Fraction(charge * sub[m], s)
        assert amount == total
        bound = len(items) + len(charges)
        for m in people:
            assert abs(shares[m] - exact[m]) <= bound, (c, m)


# ---------------------------------------------------------------- B3: equal is today's split_equal

def test_b3_equal_matches_todays_split_equal_in_wallet_order(ws):
    from app.wallets import split_equal

    rng = random.Random(6620)
    for case in [c for c in CASES if c["mode"] == "equal"]:
        c = _uuids(case)
        among = [m for m in c["wallet_order"] if m in {i["member_id"] for i in c["inputs"]}]
        assert _run(ws, c)[1] == split_equal(c["amount"], among, c["payer_first"])
    for _ in range(2000):
        among = _random_people(rng)
        payer = rng.choice(MEMBERS)
        amount = rng.randint(1, MAX_CENTAVOS)
        inputs = [{"member_id": m, "value": 1} for m in rng.sample(among, len(among))]  # input order doesn't matter
        got = ws.split("equal", amount, inputs, [], [], payer, MEMBERS)
        assert got == (amount, split_equal(amount, among, payer))


# ---------------------------------------------------------------- B4: payers

def test_b4_check_payers_accepts_two_or_more_that_sum_to_the_amount(ws):
    assert ws.check_payers(1000, {ANA: 600, BEN: 400}) is None
    assert ws.check_payers(3, {ANA: 1, BEN: 1, CARLA: 1}) is None


@pytest.mark.parametrize("payers", [
    {ANA: 600, BEN: 399},  # short by 1
    {ANA: 600, BEN: 401},  # over by 1
    {ANA: 1000},  # one payer
    {},  # none
    {ANA: 1000, BEN: 0},  # a payer at 0
    {ANA: 1100, BEN: -100},  # a negative payer
], ids=["short", "over", "one", "none", "zero", "negative"])
def test_b4_check_payers_refuses_payers_mismatch(ws, payers):
    with pytest.raises(ws.SplitError) as caught:
        ws.check_payers(1000, payers)
    assert caught.value.code == "payers_mismatch"


def test_b4_first_payer(ws):
    assert ws.first_payer(CARLA, None, MEMBERS) == CARLA
    assert ws.first_payer(None, {DAN: 500, BEN: 300, FE: 200}, MEMBERS) == BEN  # wallet order, not the body's
    assert ws.first_payer(None, {FE: 1, ELI: 1}, MEMBERS) == ELI


@pytest.mark.parametrize("paid_by,payers", [(None, None), (None, {}), (ANA, {BEN: 1, CARLA: 1})],
                         ids=["neither", "empty", "both"])
def test_b4_first_payer_needs_exactly_one_form(ws, paid_by, payers):
    with pytest.raises(ValueError):
        ws.first_payer(paid_by, payers, MEMBERS)


def test_b4_first_payer_refuses_a_payer_outside_the_wallet(ws):
    with pytest.raises(ValueError):
        ws.first_payer(None, {UUID("00000000-0000-4000-8000-0000000000ff"): 1, ANA: 1}, MEMBERS)


# ---------------------------------------------------------------- B4a: three steps, integers only

def test_b4a_itemized_is_items_then_each_charge_through_allocate(ws):
    """Built from allocate itself: step 1 per item in seq order, then each charge on the integer subtotals."""
    rng = random.Random(6630)
    for _ in range(500):
        payer = rng.choice(MEMBERS)
        items = [{"name": f"I{k}", "price_centavos": rng.randint(0, 9999), "who": _random_people(rng)}
                 for k in range(rng.randint(1, 12))]
        items[0]["price_centavos"] += 1
        charges = [{"kind": "service", "basis": "percent", "value": rng.randint(0, 10000)},
                   {"kind": "vat", "basis": "amount", "value": rng.randint(0, 5000)}][: rng.randint(0, 2)]
        sub = {}
        for it in items:
            order = [payer] + [m for m in MEMBERS if m != payer]
            for m, v in ws.allocate(it["price_centavos"], {m: 1 for m in it["who"]}, order).items():
                sub[m] = sub.get(m, 0) + v
        shares, s = dict(sub), sum(i["price_centavos"] for i in items)
        total = s
        for ch in charges:
            c = ws.charge_amount(s, ch["basis"], ch["value"])
            total += c
            for m, v in ws.allocate(c, sub, [payer] + [m for m in MEMBERS if m != payer]).items():
                shares[m] += v
        assert ws.split("itemized", None, [], items, charges, payer, MEMBERS) == (total, shares)


FORBIDDEN_NAMES = {"float", "round", "Decimal", "Fraction", "math", "truediv"}


def _float_problems(source: str) -> list[str]:
    """Float literals, true division, and float helpers. Comments and docstrings are not code, so they don't count."""
    problems = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Constant) and isinstance(node.value, (float, complex)):
            problems.append(f"float literal {node.value!r} at line {node.lineno}")
        elif isinstance(node, (ast.BinOp, ast.AugAssign)) and isinstance(node.op, ast.Div):
            problems.append(f"true division at line {node.lineno}")
        elif isinstance(node, ast.Name) and node.id in FORBIDDEN_NAMES:
            problems.append(f"{node.id} at line {node.lineno}")
        elif isinstance(node, ast.Attribute) and node.attr in FORBIDDEN_NAMES:
            problems.append(f".{node.attr} at line {node.lineno}")
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            names = {a.name.split(".")[0] for a in node.names} | {getattr(node, "module", None) or ""}
            if names & {"math", "decimal", "fractions", "statistics", "numpy"}:
                problems.append(f"import at line {node.lineno}")
    return problems


@pytest.mark.parametrize("snippet", ["x = a / b", "x /= 2", "y = round(x)", "y = float(x)", "y = 0.5",
                                     "import math", "from decimal import Decimal", "y = 1e3",
                                     "from fractions import Fraction"])
def test_b4a_the_guard_itself_catches(snippet):
    assert _float_problems(snippet)


def test_b4a_the_guard_lets_floor_division_and_comments_through():
    assert _float_problems("x = (s * bp + 5000) // 10000  # not 0.5 or round(\n'''a / b'''\n") == []


def test_b4a_wallet_splits_has_no_floats_no_true_division_and_no_round():
    assert SOURCE.exists(), "api/app/wallet_splits.py"
    assert _float_problems(SOURCE.read_text()) == []
    assert not re.search(r"\bround\(", SOURCE.read_text())  # not even in a comment


# ---------------------------------------------------------------- logs

LINE_OK = re.compile(r"^wallet split mode=(equal|exact|percent|shares|adjust|itemized) people=\d+ items=\d+ charges=\d+$")
LINE_NO = re.compile(r"^wallet split refused mode=(equal|exact|percent|shares|adjust|itemized) code=[a-z_]+( seq=\d+)?$")


def test_each_split_logs_one_line_of_counts_and_codes_only(ws, caplog):
    caplog.set_level(logging.DEBUG)
    secrets = {str(m) for m in MEMBERS} | {i["name"] for c in CASES for i in c.get("items", [])}
    for case in CASES:
        c = _uuids(case)
        caplog.clear()
        try:
            amount, shares = _run(ws, c)
        except ws.SplitError as e:
            lines = [r.getMessage() for r in caplog.records if r.name.startswith("tara_gala")]
            assert len(lines) == 1 and LINE_NO.match(lines[0]), (case["name"], lines)
            assert f"code={e.code}" in lines[0]
            assert (f"seq={e.seq}" in lines[0]) == (e.seq is not None)
        else:
            lines = [r.getMessage() for r in caplog.records if r.name.startswith("tara_gala")]
            assert len(lines) == 1 and LINE_OK.match(lines[0]), (case["name"], lines)
            assert f"people={len(shares)} items={len(c['items'])} charges={len(c['charges'])}" in lines[0]
        for line in lines:
            assert not any(s in line for s in secrets), (case["name"], line)
