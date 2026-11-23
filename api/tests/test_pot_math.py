"""TG-73 P0: the pot's money (plan §4, test-plan §1). Pure functions, no database.

The vectors are fixtures/pot_vectors.json, which web/src/lib/pot.test.ts loads too, so the close sheet's preview and the
server can't drift. The property loop is seeded (hypothesis isn't a dependency), so a failure reproduces.
"""

import ast
import json
import random
from pathlib import Path

import pytest

from app import pot_math, wallets
from app.pot_math import PotError, close_out, pot_numbers

VECTORS = json.loads((Path(__file__).parent / "fixtures" / "pot_vectors.json").read_text(encoding="utf-8"))
CASES = VECTORS["cases"]


def _numbers(case: dict):
    people = [{"member_id": p["id"], "in_goal": p["in_goal"], "target": p["target"]} for p in case["people"]]
    ambag = [{"member_id": a["member"], "kind": a["kind"], "amount": a["amount"], "status": a["status"]} for a in case["ambag"]]
    return pot_numbers(people, ambag, case["spends"], case["each"], case["order"])


def test_the_vectors_name_every_test_plan_case():
    names = {c["name"].split()[0] for c in CASES}
    assert {f"V{i}" for i in range(1, 19)} <= names
    assert any("refuse" in c["expect"] for c in CASES)


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_vector(case):
    want = case["expect"]
    n = _numbers(case)
    assert (n.received, n.spent, n.balance) == (want["C"], want["S"], want["B"])
    assert (n.pending_centavos, n.pending_count) == (want["pending"], want["pending_count"])
    assert n.contributed == want["c"] and list(n.contributed) == list(want["c"])  # wallet order
    if "refuse" in want:
        with pytest.raises(PotError) as e:
            close_out(n, case["treasurer"], case["order"])
        assert e.value.code == want["refuse"]
        return
    out = close_out(n, case["treasurer"], case["order"])
    assert out.refunds == want["refunds"] and list(out.refunds) == list(want["refunds"])  # T first, then wallet order
    assert out.shortfall == want["shortfall"] and list(out.shortfall) == list(want["shortfall"])
    assert out.delta == want["delta"] and list(out.delta) == case["order"]


def test_targets_are_the_in_goal_people_own_amount_or_each():
    n = _numbers(next(c for c in CASES if c["name"].startswith("V2 ")))
    assert n.targets == {"ana": 800000, "ben": 800000, "carlo": 800000, "bea": 500000, "di": 800000}
    n = _numbers(next(c for c in CASES if c["name"].startswith("V13 ")))
    assert n.targets == {"ana": 500000, "ben": 500000} and n.in_goal == ["ana", "ben"]  # Bea is out


def test_a_custom_target_of_zero_is_kept():
    n = pot_numbers([{"member_id": "a", "in_goal": True, "target": 0}], [], [], 800000, ["a"])
    assert n.targets == {"a": 0}


@pytest.mark.parametrize("ambag, why", [
    ([{"member_id": "a", "kind": "back", "amount": 1, "status": "sent"}], "a give-back is always received"),
    ([{"member_id": "a", "kind": "gift", "amount": 1, "status": "received"}], "bad ambag row"),
    ([{"member_id": "a", "kind": "in", "amount": 0, "status": "received"}], "bad ambag row"),
    ([{"member_id": "a", "kind": "back", "amount": 5, "status": "received"}], "can't be more"),
    ([{"member_id": "z", "kind": "in", "amount": 5, "status": "received"}], "wallet order"),
])
def test_caller_bugs_are_value_errors(ambag, why):
    with pytest.raises(ValueError, match=why):
        pot_numbers([{"member_id": "a", "in_goal": True, "target": None}], ambag, [], 100, ["a", "b"])


def test_a_spend_below_one_centavo_is_a_caller_bug():
    with pytest.raises(ValueError):
        pot_numbers([], [], [0], 100, ["a"])


def test_a_treasurer_outside_the_order_is_a_caller_bug():
    n = pot_numbers([], [], [], 100, ["a"])
    with pytest.raises(ValueError):
        close_out(n, "x", ["a"])


def test_rows_can_be_objects_too():
    class Row:
        def __init__(self, **kw):
            self.__dict__.update(kw)

    n = pot_numbers([Row(member_id="a", in_goal=True, target=None)], [Row(member_id="a", kind="in", amount=7, status="received")],
                    [2], 5, ["a"])
    assert (n.received, n.balance) == (7, 5)


# ---------------------------------------------------------------- the property loop (test-plan §1)

def _random_wallet(rng: random.Random):
    size = rng.randint(1, 20)
    order = [f"m{i}" for i in range(size)]
    people = [{"member_id": m, "in_goal": rng.random() < 0.85, "target": rng.choice([None, None, rng.randint(0, 10_000_000)])}
              for m in order if rng.random() < 0.9]
    ambag = []
    for m in order:
        for _ in range(rng.randint(0, 3)):
            amount = rng.randint(1, 10_000_000)
            ambag.append({"member_id": m, "kind": "in", "amount": amount, "status": rng.choice(["sent", "received", "received"])})
        got = sum(a["amount"] for a in ambag if a["member_id"] == m and a["status"] == "received")
        if got and rng.random() < 0.15:
            ambag.append({"member_id": m, "kind": "back", "amount": rng.randint(1, got), "status": "received"})
    total = sum(a["amount"] for a in ambag if a["status"] == "received")
    spends = [rng.randint(1, max(1, total // 3 or 1_000_000)) for _ in range(rng.randint(0, 8))]
    return order, people, ambag, spends, rng.choice(order)


def test_properties_over_500_random_wallets():
    rng = random.Random(7303)
    refused = 0
    for _ in range(500):
        order, people, ambag, spends, t = _random_wallet(rng)
        n = pot_numbers(people, ambag, spends, rng.randint(100, 10_000_000), order)
        assert n.balance == n.received - n.spent and n.received == sum(n.contributed.values())
        assert all(v >= 0 for v in n.contributed.values())
        try:
            out = close_out(n, t, order)
        except PotError as e:
            assert e.code == "no_one_in_goal" and n.balance < 0 and not n.in_goal
            refused += 1
            continue
        assert sum(out.refunds.values()) == max(n.balance, 0)
        assert sum(out.shortfall.values()) == max(-n.balance, 0)
        assert sum(out.delta.values()) == 0 and set(out.delta) == set(order)
        assert all(r >= 0 for r in out.refunds.values()) and all(d >= 0 for d in out.shortfall.values())
        if n.balance > 0:
            for m, r in out.refunds.items():
                assert 0 <= r - n.balance * n.contributed[m] // n.received <= 1
            assert set(out.refunds) == {m for m, v in n.contributed.items() if v > 0}
        if n.balance < 0:  # the same split as wallets.split_equal, T first (the equal split's house rule)
            assert out.shortfall == wallets.split_equal(-n.balance, n.in_goal, t)
            assert t not in out.shortfall or t in n.in_goal
    assert refused < 50  # the loop mostly reaches a close-out


def test_pure_no_floats_and_no_io():
    """As wallet_splits: integers only (no true division, no float, no round) and nothing but the split helper imported."""
    tree = ast.parse(Path(pot_math.__file__).read_text(encoding="utf-8"))
    assert not [n for n in ast.walk(tree) if isinstance(n, ast.BinOp) and isinstance(n.op, ast.Div)]
    names = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
    assert not names & {"float", "round"}
    imported = {n.module for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)} | {
        a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
    assert imported <= {"collections.abc", "dataclasses", "wallet_splits"}
