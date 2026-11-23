"""TG-66 P0: the wallet's request and response models (plan §2). The old ones move to wallet_models.py unchanged, and
wallets.py still exports every name; the new ones are the contract Phase 1 builds against. Pure: no database.
"""

import json
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import pytest
from pydantic import TypeAdapter, ValidationError

from app import wallets



class _Missing:
    """Before P0's GREEN: every use fails its test with this message, instead of stopping collection."""

    def __init__(self, module):
        self.module = module

    def __getattr__(self, name):
        raise AssertionError(f"{self.module} doesn't exist yet (TG-66 P0): no {name}")


try:
    from app import wallet_models as m
except ImportError:  # RED
    m = _Missing("app/wallet_models.py")


SNAPSHOT = json.loads((Path(__file__).parent / "fixtures" / "wallet_models_pre_tg66.json").read_text(encoding="utf-8"))
MOVED = ["WalletIn", "MemberIn", "ShareIn", "ExpenseIn", "SettlementIn", "MemberOut", "ShareOut", "ExpenseOut",
         "SettlementOut", "BalanceOut", "TransferOut", "WalletOut"]
NEW_EXPENSE_FIELDS = {"category": None, "mode": None, "inputs": [], "items": [], "charges": [], "payers": [], "version": 1,
                      "updated_at": None, "comment_count": 0,
                      "budget_key": None}  # TG-62 G0: the expense's budget line (test_tg62_models.py)
A, B, C = (str(uuid4()) for _ in range(3))


class _Adapter:
    """A TypeAdapter made on first use, so the module imports before the models exist."""

    def __init__(self, name):
        self.name = name

    def validate_python(self, value):
        return TypeAdapter(getattr(m, self.name)).validate_python(value)


V2, PATCH = _Adapter("ExpenseInV2"), _Adapter("ExpensePatch")


# ---------------------------------------------------------------- the move

def test_wallets_still_exports_every_moved_name():
    for name in [*MOVED, "ExpenseInLegacy", "WalletName", "MemberName", "Note", "Centavos", "MAX_MEMBERS", "MAX_CENTAVOS"]:
        assert getattr(wallets, name) is getattr(m, name), name
    assert m.ExpenseIn is m.ExpenseInLegacy


def test_wallets_py_defines_no_model_itself():
    src = (Path(wallets.__file__)).read_text(encoding="utf-8")
    for name in MOVED + ["ExpenseInLegacy"]:
        assert f"class {name}(" not in src, f"{name} is defined in wallets.py: it moved to wallet_models.py"


@pytest.mark.parametrize("name", ["WalletIn", "MemberIn", "ShareIn", "ExpenseIn", "SettlementIn", "MemberOut", "ShareOut",
                                  "SettlementOut", "TransferOut"])
def test_unchanged_models_have_the_same_schema(name):
    assert getattr(m, name).model_json_schema() == SNAPSHOT[name]


def test_balance_out_only_gains_the_defaulted_pot_part():  # TG-73 A2: the close-out's part, left out of the answer when off
    now, old = m.BalanceOut.model_json_schema(), SNAPSHOT["BalanceOut"]
    assert {k: v for k, v in now["properties"].items() if k != "pot_centavos"} == old["properties"]
    assert now["properties"]["pot_centavos"] == {"default": 0, "title": "Pot Centavos", "type": "integer"}
    assert now["required"] == old["required"]
    row = m.BalanceOut(member_id=uuid4(), paid_centavos=1, share_centavos=1, net_centavos=0)
    assert "pot_centavos" not in row.model_dump() and "pot_centavos" in m.BalanceOut(**row.model_dump(), pot_centavos=0).model_dump()


def test_expense_and_wallet_out_only_gain_defaulted_fields():
    """Every old field keeps its schema, and each new one has a default, so today's _load still validates."""
    for name, new in (("ExpenseOut", NEW_EXPENSE_FIELDS), ("WalletOut", {"rev": 0, "budget": None, "pot": None})):
        old, now = SNAPSHOT[name], getattr(m, name).model_json_schema()
        for field, spec in old["properties"].items():
            assert now["properties"][field] == spec, f"{name}.{field}"
        assert set(now["properties"]) - set(old["properties"]) == set(new), name
        assert set(now.get("required", [])) == set(old["required"]), f"{name}: a new field is required"
    # TG-73: ExpenseOut.mode reads the two stored modes too (pot, libre); nothing else about it moved
    mode = m.ExpenseOut.model_json_schema()["properties"]["mode"]
    assert mode["anyOf"][0]["enum"] == ["equal", "exact", "percent", "shares", "adjust", "itemized", "pot", "libre"]
    row = {"id": uuid4(), "paid_by": uuid4(), "amount_centavos": 1000, "note": "E2E", "created_at": datetime.now(timezone.utc)}
    assert {k: v for k, v in m.ExpenseOut(**row, shares=[]).model_dump().items() if k in NEW_EXPENSE_FIELDS} == NEW_EXPENSE_FIELDS


# ---------------------------------------------------------------- v2 requests

def body(mode, **extra):
    base = {"mode": mode, "paid_by": A, "note": "E2E lunch"}
    if mode != "itemized":
        base |= {"amount_centavos": 1000, "inputs": [{"member_id": A, "value": 1}, {"member_id": B, "value": 1}]}
    else:
        base |= {"items": [{"name": "E2E item", "price_centavos": 1000, "who": [A, B]}], "charges": []}
    return base | extra


@pytest.mark.parametrize("mode,inputs", [
    ("equal", [1, 1]),
    ("exact", [600, 400]),
    ("percent", [6000, 4000]),
    ("shares", [2, 0]),
    ("adjust", [20000, -500]),
])
def test_each_mode_validates(mode, inputs):
    rows = [{"member_id": who, "value": v} for who, v in zip((A, B), inputs)]
    e = V2.validate_python(body(mode, inputs=rows, category="food", by=C))
    assert e.mode == mode and [i.value for i in e.inputs] == inputs and e.category == "food" and str(e.by) == C


def test_itemized_validates_with_charges_and_computes_its_amount_later():
    e = V2.validate_python(body("itemized", charges=[{"kind": "service", "basis": "percent", "value": 1000}, {"kind": "vat", "basis": "amount", "value": 120}]))
    assert e.mode == "itemized" and e.amount_centavos is None and len(e.items) == 1 and [c.kind for c in e.charges] == ["service", "vat"]
    assert V2.validate_python(body("itemized", amount_centavos=1000)).amount_centavos == 1000
    # an item with nobody, a price of 0 and over 40 items are the split's refusals (item_no_one, items_zero, too_many_items)
    e = V2.validate_python(body("itemized", items=[{"name": "E2E", "price_centavos": 0, "who": []}] * 41))
    assert len(e.items) == 41
    # audit S3: a percent charge over 100% is the split's charge_too_big, so the model lets 10001 bp through
    e = V2.validate_python(body("itemized", charges=[{"kind": "service", "basis": "percent", "value": 10001}]))
    assert e.charges[0].value == 10001


def test_several_payers_validate_and_their_checks_are_the_splits():
    e = V2.validate_python(body("equal", paid_by=None, payers=[{"member_id": A, "paid_centavos": 600}, {"member_id": B, "paid_centavos": 400}]))
    assert e.paid_by is None and [p.paid_centavos for p in e.payers] == [600, 400]
    # one payer, or a payer at 0, is payers_mismatch from check_payers, not a 422 here
    assert len(V2.validate_python(body("equal", paid_by=None, payers=[{"member_id": A, "paid_centavos": 0}])).payers) == 1


@pytest.mark.parametrize("change", [
    {"mode": "ratio"},
    {"extra": 1},
    {"paid_by": None},  # nobody paid
    {"payers": [{"member_id": A, "paid_centavos": 1000}, {"member_id": B, "paid_centavos": 0}]},  # and paid_by too
    {"category": "drinks"},
    {"note": ""},
    {"note": "x" * 61},
    {"amount_centavos": 0},
    {"amount_centavos": 10_000_001},
    {"inputs": []},
    {"inputs": [{"member_id": A, "value": 1}, {"member_id": A, "value": 1}]},  # each person once
    {"inputs": [{"member_id": A, "value": 2}]},  # equal's value is 1
    {"inputs": [{"member_id": str(uuid4()), "value": 1} for _ in range(21)]},  # a wallet holds 20 people
    {"paid_by": None, "payers": [{"member_id": A, "paid_centavos": 600}, {"member_id": A, "paid_centavos": 400}]},  # audit S2: once each
    {"paid_by": None, "payers": [{"member_id": str(uuid4()), "paid_centavos": 1} for _ in range(21)]},  # audit S2: capped
    {"by": "not a uuid"},
])
def test_bad_equal_bodies_are_refused(change):
    with pytest.raises(ValidationError):
        V2.validate_python(body("equal") | change)


@pytest.mark.parametrize("mode,value", [("exact", -1), ("exact", 10_000_001), ("percent", -1), ("percent", 10001),
                                        ("shares", -1), ("shares", 21), ("adjust", 10_000_001), ("adjust", -10_000_001)])
def test_input_values_are_bounded_per_mode(mode, value):
    with pytest.raises(ValidationError):
        V2.validate_python(body(mode, inputs=[{"member_id": A, "value": value}]))


@pytest.mark.parametrize("change", [
    {"inputs": [{"member_id": A, "value": 1}]},  # itemized has items, not inputs
    {"items": []},
    {"items": [{"name": "", "price_centavos": 1, "who": [A]}]},
    {"items": [{"name": "x" * 41, "price_centavos": 1, "who": [A]}]},
    {"items": [{"name": "E2E", "price_centavos": -1, "who": [A]}]},
    {"items": [{"name": "E2E", "price_centavos": 1, "who": [A, A]}]},
    {"charges": [{"kind": "tip", "basis": "amount", "value": 1}]},
    {"charges": [{"kind": "vat", "basis": "ratio", "value": 1}]},
    {"charges": [{"kind": "vat", "basis": "amount", "value": -1}]},
    {"charges": [{"kind": "vat", "basis": "amount", "value": 1}, {"kind": "vat", "basis": "percent", "value": 1}]},
    {"items": [{"name": "E2E", "price_centavos": 1, "who": [A]}] * 101},  # a loose bound on the body; 41 to 100 is too_many_items
])
def test_bad_itemized_bodies_are_refused(change):
    with pytest.raises(ValidationError):
        V2.validate_python(body("itemized") | change)


def test_old_and_new_shapes_never_overlap():
    old = {"paid_by": A, "amount_centavos": 1000, "note": "E2E", "split_among": [A, B]}
    m.ExpenseInLegacy.model_validate(old)
    with pytest.raises(ValidationError):
        V2.validate_python(old)  # no mode: not v2
    with pytest.raises(ValidationError):
        m.ExpenseInLegacy.model_validate(body("equal"))  # extra="forbid" keeps v2 out of the old shape


def test_a_patch_is_a_v2_body_plus_its_version():
    e = PATCH.validate_python(body("shares", version=3))
    assert e.mode == "shares" and e.version == 3
    for bad in ({}, {"version": 0}):
        with pytest.raises(ValidationError):
            PATCH.validate_python(body("shares") | bad)


# ---------------------------------------------------------------- comments, activity and refusals

def test_comment_in():
    assert m.CommentIn.model_validate({"body": "  E2E  ", "by": A}).body == "E2E"
    assert m.CommentIn.model_validate({"body": "x" * 300}).by is None
    for bad in ({"body": ""}, {"body": "   "}, {"body": "x" * 301}, {"body": "E2E", "extra": 1}):
        with pytest.raises(ValidationError):
            m.CommentIn.model_validate(bad)


def test_answer_shapes():
    now = datetime.now(timezone.utc)
    comment = {"id": uuid4(), "expense_id": uuid4(), "author": None, "body": "E2E", "created_at": now}
    assert m.CommentsOut(rev=7, comments=[comment]).model_dump()["rev"] == 7
    wallet = {"share_slug": "c" * 32, "name": "E2E", "created_at": now, "members": [], "expenses": [], "settlements": [],
              "balances": [], "transfers": [], "total_centavos": 0, "rev": 8}
    assert m.CommentWriteOut(wallet=wallet, comments=[comment]).wallet.rev == 8
    row = {"id": 1, "at": now, "actor": None, "action": "comment_delete", "expense_id": uuid4(), "settlement_id": None,
           "member_id": None, "before": None, "after": None}
    page = m.ActivityOut(rev=8, rows=[row])
    assert page.rows[0].action == "comment_delete" and page.rev == 8
    with pytest.raises(ValidationError):
        m.ActivityRowOut(**(row | {"action": "expense_rename"}))


def test_refusal_bodies_carry_codes_never_names():
    now = datetime.now(timezone.utc)
    wallet = m.WalletOut(share_slug="c" * 32, name="E2E", created_at=now, members=[], expenses=[], settlements=[], balances=[],
                         transfers=[], total_centavos=0)
    assert m.WalletRefusal(code="expense_changed", wallet=wallet).model_dump(mode="json")["wallet"]["rev"] == 0
    assert m.ItemRefusal(seq=3).model_dump() == {"code": "item_no_one", "seq": 3}
    assert set(m.ItemRefusal.model_fields) == {"code", "seq"}
    assert m.REFUSALS == (  # audit nit: the whole list, in ux.md §9's words
        "shares_mismatch", "percent_total", "shares_zero", "extras_too_big", "item_no_one", "too_many_items", "amount_mismatch",
        "items_zero", "amount_too_big", "charge_too_big", "payers_mismatch",
        "feature_off", "expense_changed", "expense_gone", "comments_full", "unknown_member", "id_taken",
        "no_pot", "by_required",  # TG-73 A2: a pot spend (ux.md TG-73 §14)
    )
