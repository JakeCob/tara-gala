"""TG-62 G0: the wallet and panel models (plan §2, G3; Rev 1 M2). Pure: no database, but conftest skips without
TEST_DATABASE_URL.

The old body never has `budget_key` (extra="forbid"). v2 add and patch take a key, `_none` or null. On a patch, a body
that leaves the field out keeps it out of `model_fields_set`, so GA1 can tell "not sent" (keep the stored line, G9a) from
an explicit null (clear it). ExpenseOut and WalletOut only gain defaulted fields, so today's _load still validates.
"""

import json
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import pytest
from pydantic import TypeAdapter, ValidationError

from app import wallet_models as m

A, B = str(uuid4()), str(uuid4())
SNAPSHOT = json.loads((Path(__file__).parent / "fixtures" / "wallet_models_pre_tg66.json").read_text(encoding="utf-8"))
MODES = ["equal", "exact", "percent", "shares", "adjust", "itemized"]


def body(mode, **extra):
    base = {"mode": mode, "paid_by": A, "note": "E2E lunch", "category": "food"}
    if mode == "itemized":
        base |= {"items": [{"name": "E2E item", "price_centavos": 1000, "who": [A, B]}], "charges": []}
    else:
        base |= {"amount_centavos": 1000, "inputs": [{"member_id": A, "value": 1}, {"member_id": B, "value": 1}]}
        if mode == "exact":
            base["inputs"] = [{"member_id": A, "value": 600}, {"member_id": B, "value": 400}]
        if mode == "percent":
            base["inputs"] = [{"member_id": A, "value": 6000}, {"member_id": B, "value": 4000}]
    return base | extra


V2, PATCH = TypeAdapter(m.ExpenseInV2), TypeAdapter(m.ExpensePatch)


# ---------------------------------------------------------------- requests

def test_the_old_body_with_a_budget_key_is_refused():
    old = {"paid_by": A, "amount_centavos": 1000, "note": "E2E", "split_among": [A, B]}
    m.ExpenseInLegacy.model_validate(old)
    for key in ("meals", "_none", None):
        with pytest.raises(ValidationError):
            m.ExpenseInLegacy.model_validate(old | {"budget_key": key})


@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize("key", ["meals", "meals-2", "_none", None, "m" * 21])
def test_v2_add_and_patch_take_a_key_none_or_null(mode, key):
    assert V2.validate_python(body(mode, budget_key=key)).budget_key == key
    e = PATCH.validate_python(body(mode, budget_key=key, version=2))
    assert e.budget_key == key and "budget_key" in e.model_fields_set


@pytest.mark.parametrize("key", ["Meals", "1meals", "m" * 22, "_other", "m", "meals_2", "", 5])
def test_v2_refuses_a_bad_key(key):
    with pytest.raises(ValidationError):
        V2.validate_python(body("equal", budget_key=key))
    with pytest.raises(ValidationError):
        PATCH.validate_python(body("equal", budget_key=key, version=2))


@pytest.mark.parametrize("mode", MODES)
def test_a_patch_without_the_field_leaves_it_unset(mode):  # Rev 1 M2: GA1 keeps the stored line (G9a)
    e = PATCH.validate_python(body(mode, version=2))
    assert e.budget_key is None and "budget_key" not in e.model_fields_set
    explicit = PATCH.validate_python(body(mode, version=2, budget_key=None))
    assert explicit.budget_key is None and "budget_key" in explicit.model_fields_set


def test_an_add_without_the_field_is_null():
    e = V2.validate_python(body("equal"))
    assert e.budget_key is None and "budget_key" not in e.model_fields_set


# ---------------------------------------------------------------- answers

def expense_row(**extra):
    return {"id": uuid4(), "paid_by": uuid4(), "amount_centavos": 1000, "note": "E2E", "created_at": datetime.now(timezone.utc),
            "shares": []} | extra


def wallet_row(**extra):
    return {"share_slug": "c" * 32, "name": "E2E", "created_at": datetime.now(timezone.utc), "members": [], "expenses": [],
            "settlements": [], "balances": [], "transfers": [], "total_centavos": 0} | extra


def test_expense_out_carries_the_key_defaulting_to_null():
    assert m.ExpenseOut(**expense_row()).budget_key is None
    assert m.ExpenseOut(**expense_row(budget_key="meals")).budget_key == "meals"
    assert m.ExpenseOut(**expense_row(budget_key="_none")).budget_key == "_none"
    assert "budget_key" not in m.ExpenseOut.model_json_schema().get("required", [])


def test_wallet_out_without_budget_still_validates():
    w = m.WalletOut(**wallet_row())
    assert w.budget is None and "budget" not in m.WalletOut.model_json_schema().get("required", [])


def test_wallet_budget_is_lines_only():
    lines = [{"key": "meals", "item": "E2E meals", "category": "food"}, {"key": "misc", "item": "E2E misc", "category": None}]
    w = m.WalletOut(**wallet_row(budget={"trip_name": "E2E trip", "lines": lines}))
    assert w.model_dump(mode="json")["budget"] == {"trip_name": "E2E trip", "lines": lines}
    assert set(m.WalletBudget.model_fields) == {"trip_name", "lines"}
    assert set(m.BudgetLine.model_fields) == {"key", "item", "category"}  # never estimates or amounts
    with pytest.raises(ValidationError):
        m.WalletBudget.model_validate({"trip_name": "E2E", "lines": [{"key": "x1", "item": "E2E", "category": "drinks"}]})


@pytest.mark.parametrize("name", ["ExpenseOut", "WalletOut"])
def test_the_snapshotted_fields_are_unchanged(name):  # G3: the other fields of the snapshotted models
    old, now = SNAPSHOT[name], getattr(m, name).model_json_schema()
    for field, spec in old["properties"].items():
        assert now["properties"][field] == spec, f"{name}.{field}"
    assert set(now.get("required", [])) == set(old["required"])


@pytest.mark.parametrize("name", ["WalletIn", "MemberIn", "ShareIn", "ExpenseIn", "SettlementIn", "MemberOut", "ShareOut",
                                  "SettlementOut", "BalanceOut", "TransferOut"])
def test_the_other_snapshotted_models_are_untouched(name):
    assert getattr(m, name).model_json_schema() == SNAPSHOT[name]


# ---------------------------------------------------------------- the panel's answer (budget_models.py)

def test_session_budget_out_ok():
    from app import budget_models as bm

    mid = uuid4()
    ok = bm.SessionBudgetOut(
        state="ok", member_count=4, total_centavos=1_800_000,
        lines=[{"key": "meals", "item": "E2E meals", "estimate": "1,500 to 2,200", "min": 1500, "max": 2200, "readable": True,
                "spent": 1_200_000, "spent_each": 300_000},
               {"key": "misc", "item": "E2E misc", "estimate": "depends", "min": None, "max": None, "readable": False,
                "spent": 0, "spent_each": 0}],
        not_in_budget={"count": 1, "spent": 400_000},
        unsorted={"count": 2, "spent": 200_000, "removed": 1},
        members=[{"member_id": mid, "name": "Ana", "share_lines": 300_000, "share_total": 450_000}],
    )
    dumped = ok.model_dump(mode="json")
    assert dumped["state"] == "ok" and dumped["members"][0]["member_id"] == str(mid)
    assert set(dumped) == {"state", "member_count", "total_centavos", "lines", "not_in_budget", "unsorted", "members"}
    assert set(dumped["lines"][0]) == {"key", "item", "estimate", "min", "max", "readable", "spent", "spent_each"}
    assert set(dumped["unsorted"]) == {"count", "spent", "removed"}
    assert set(dumped["members"][0]) == {"member_id", "name", "share_lines", "share_total"}


@pytest.mark.parametrize("state", ["no_wallet", "two_trips", "no_budget"])
def test_the_other_states_carry_no_lines(state):
    from app import budget_models as bm

    out = bm.SessionBudgetOut(state=state, member_count=0 if state == "no_wallet" else 3, total_centavos=0 if state == "no_wallet" else 900)
    d = out.model_dump(mode="json")
    assert (d["lines"], d["members"], d["not_in_budget"], d["unsorted"]) == ([], [], None, None)
    with pytest.raises(ValidationError):  # lines are filled only when the state is ok
        bm.SessionBudgetOut(state=state, lines=[{"key": "meals", "item": "x", "estimate": "1", "min": 1, "max": 1, "readable": True,
                                                 "spent": 0, "spent_each": 0}])


def test_ok_needs_its_buckets_and_a_bad_state_is_refused():
    from app import budget_models as bm

    with pytest.raises(ValidationError):
        bm.SessionBudgetOut(state="ok", member_count=1, total_centavos=0)  # no not_in_budget / unsorted
    with pytest.raises(ValidationError):
        bm.SessionBudgetOut(state="maybe")
    with pytest.raises(ValidationError):  # no wallet: nothing to count
        bm.SessionBudgetOut(state="no_wallet", member_count=2, total_centavos=0)
