"""The wallet's request and response models (TG-50, TG-53; TG-66 adds the split modes, edits, comments and activity).

The pre-TG-66 models moved here from wallets.py unchanged, and wallets.py still exports every name, so its routes,
wallet_proofs.py and the tests keep importing them from there. `ExpenseIn` is the old request shape (`split_among` or
`shares`), also named `ExpenseInLegacy`; `ExpenseInV2` is the new one, told apart by `mode`.

The models check shapes and the tables' bounds only. Every money rule (sums, the 40-item cap, an item with nobody, the
payers' count) is wallet_splits' SplitError, so its code reaches the phone as ux.md §9's line, not as a generic 422.
"""

from datetime import datetime
from typing import Annotated, Literal, Union
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator

MAX_MEMBERS = 20
MAX_CENTAVOS = 10_000_000  # PHP 100,000, the same cap as the table's check

WalletName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]
MemberName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=30)]
Note = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)]
Centavos = Annotated[int, Field(ge=1, le=MAX_CENTAVOS)]
SplitMode = Literal["equal", "exact", "percent", "shares", "adjust", "itemized"]  # TG-66
Category = Literal["transport", "hotel", "food", "activities", "other"]  # TG-66; null is "Not sorted yet"
# TG-62: a budget line's key, the slug a guide budget row carries (guide.BudgetRow.key) and expenses.budget_key's check.
# An expense also takes "_none" ("Not in the budget"); null is "Not sorted yet". Never logged: it's the group's own text.
BUDGET_KEY = r"^[a-z][a-z0-9-]{1,20}$"
BudgetKey = Annotated[str, StringConstraints(pattern=BUDGET_KEY)]
NONE_KEY = "_none"


# ---------------------------------------------------------------- request and response shapes (TG-50, TG-53)

class WalletIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: WalletName
    members: list[MemberName] = Field(min_length=1, max_length=MAX_MEMBERS)

    @field_validator("members")
    @classmethod
    def different_names(cls, names: list[str]) -> list[str]:
        if len({n.lower() for n in names}) != len(names):
            raise ValueError("each person needs a different name")
        return names


class MemberIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: MemberName


class ShareIn(BaseModel):
    member_id: UUID
    share_centavos: int = Field(ge=0, le=MAX_CENTAVOS)


class ExpenseIn(BaseModel):
    """Split equally among `split_among`, or by the exact `shares` given. One or the other."""

    model_config = ConfigDict(extra="forbid")
    paid_by: UUID
    amount_centavos: Centavos
    note: Note
    split_among: list[UUID] | None = Field(default=None, min_length=1, max_length=MAX_MEMBERS)
    shares: list[ShareIn] | None = Field(default=None, min_length=1, max_length=MAX_MEMBERS)

    @model_validator(mode="after")
    def one_split(self):
        if (self.split_among is None) == (self.shares is None):
            raise ValueError("give split_among or shares, not both")
        people = self.split_among if self.split_among is not None else [s.member_id for s in self.shares]
        if len(set(people)) != len(people):
            raise ValueError("each person at most once")
        return self

ExpenseInLegacy = ExpenseIn  # TG-66: the old request shape's second name, beside ExpenseInV2


class SettlementIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    from_member: UUID
    to_member: UUID
    amount_centavos: Centavos

    @model_validator(mode="after")
    def two_people(self):
        if self.from_member == self.to_member:
            raise ValueError("a payment needs two different people")
        return self


class MemberOut(BaseModel):
    id: UUID
    name: str


class ShareOut(BaseModel):
    member_id: UUID
    share_centavos: int


class InputOut(BaseModel):
    member_id: UUID
    value: int  # the mode's own unit: 1 (equal), centavos (exact), basis points (percent), weight (shares), extra centavos (adjust)


class ItemOut(BaseModel):
    seq: int
    name: str
    price_centavos: int
    who: list[UUID]  # wallet order


class ChargeOut(BaseModel):
    kind: Literal["service", "vat"]
    basis: Literal["percent", "amount"]
    value: int  # basis points or centavos


class PayerOut(BaseModel):
    member_id: UUID
    paid_centavos: int


class ExpenseOut(BaseModel):
    id: UUID
    paid_by: UUID
    amount_centavos: int
    note: str
    created_at: datetime
    shares: list[ShareOut]
    # TG-66, all defaulted so today's _load still validates. mode null: from before TG-66 (or the old request shape)
    category: Category | None = None
    mode: SplitMode | None = None
    inputs: list[InputOut] = []
    items: list[ItemOut] = []
    charges: list[ChargeOut] = []
    payers: list[PayerOut] = []  # only with several payers; one payer is paid_by
    version: int = 1
    updated_at: datetime | None = None
    comment_count: int = 0
    budget_key: str | None = None  # TG-62: a line key, "_none" or null (Not sorted yet)


class SettlementOut(BaseModel):
    id: UUID
    from_member: UUID
    to_member: UUID
    amount_centavos: int
    created_at: datetime
    has_proof: bool
    proof_at: datetime | None


class BalanceOut(BaseModel):
    member_id: UUID
    paid_centavos: int  # what they paid for the group
    share_centavos: int  # their part of everything
    net_centavos: int  # paid - share, plus payments sent, minus payments received: above zero means they're owed


class TransferOut(BaseModel):
    from_member: UUID
    to_member: UUID
    amount_centavos: int


class BudgetLine(BaseModel):
    """TG-62: one of the trip plan's budget lines, for the wallet's "Which budget line?" row. Never an estimate or amount."""

    key: str
    item: str
    category: Category | None  # null: listed under other


class WalletBudget(BaseModel):
    """TG-62: the lines of the wallet's one trip (GA1's budget_lines()); null on WalletOut when there isn't exactly one."""

    trip_name: str
    lines: list[BudgetLine]  # plan order


class WalletOut(BaseModel):
    share_slug: str
    name: str
    created_at: datetime
    members: list[MemberOut]  # in the order they were entered
    expenses: list[ExpenseOut]  # newest first
    settlements: list[SettlementOut]  # newest first
    balances: list[BalanceOut]  # party order
    transfers: list[TransferOut]  # what's left to pay, fewest payments
    total_centavos: int
    rev: int = 0  # TG-66: the wallet's write counter
    budget: WalletBudget | None = None  # TG-62: null with BUDGET_LINES off, or unless the wallet is on exactly one trip with keyed lines


# ---------------------------------------------------------------- TG-66: the new request shapes

ItemName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]
CommentBody = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)]
MAX_ITEMS_SENT = 100  # a body bound only: the 40-item rule is the split's too_many_items, so the phone gets its line

# The codes a refusal carries in `detail` (ux.md §9 has a line for each). Strings, except the three in the docstrings below.
SPLIT_CODES = ("shares_mismatch", "percent_total", "shares_zero", "extras_too_big", "item_no_one", "too_many_items",
               "amount_mismatch", "items_zero", "amount_too_big", "charge_too_big", "payers_mismatch")
REFUSALS = SPLIT_CODES + ("feature_off", "expense_changed", "expense_gone", "comments_full", "unknown_member")


def _once(member_ids: list[UUID]) -> None:
    if len(set(member_ids)) != len(member_ids):
        raise ValueError("each person at most once")


class PayerIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    member_id: UUID
    paid_centavos: int = Field(ge=0, le=MAX_CENTAVOS)  # each >= 1 and the count are check_payers' payers_mismatch


class _ExpenseV2(BaseModel):
    """What every mode shares: who paid (one `paid_by`, or `payers`), the note, the category and who's writing."""

    model_config = ConfigDict(extra="forbid")
    paid_by: UUID | None = None
    payers: list[PayerIn] | None = Field(default=None, min_length=1, max_length=MAX_MEMBERS)
    note: Note
    category: Category | None = None
    by: UUID | None = None  # the phone's picked person; the route checks it's a member (422 unknown_member)
    # TG-62: the budget line. On a patch, a body that leaves it out keeps the stored line (GA1 reads model_fields_set,
    # plan Rev 1 M2); only an explicit null clears it. The old request shape never has it (extra="forbid").
    budget_key: Literal["_none"] | BudgetKey | None = None

    @model_validator(mode="after")
    def one_payer_form(self):
        if (self.paid_by is None) == (self.payers is None):
            raise ValueError("give paid_by or payers, not both")
        if self.payers is not None:
            _once([p.member_id for p in self.payers])
        return self


def _input(value_bounds: dict):
    class InputIn(BaseModel):
        model_config = ConfigDict(extra="forbid")
        member_id: UUID
        value: int = Field(**value_bounds)

    return InputIn


EqualInput = _input({"ge": 1, "le": 1})  # the rows are `among`
ExactInput = _input({"ge": 0, "le": MAX_CENTAVOS})
PercentInput = _input({"ge": 0, "le": 10000})  # basis points; the sum of 10000 is percent_total
SharesInput = _input({"ge": 0, "le": 20})
AdjustInput = _input({"ge": -MAX_CENTAVOS, "le": MAX_CENTAVOS})  # extra centavos; the rows are `among`


class _ByPeople(_ExpenseV2):
    amount_centavos: Centavos

    @model_validator(mode="after")
    def people_once(self):
        _once([i.member_id for i in self.inputs])
        return self


class EqualIn(_ByPeople):
    mode: Literal["equal"]
    inputs: list[EqualInput] = Field(min_length=1, max_length=MAX_MEMBERS)


class ExactIn(_ByPeople):
    mode: Literal["exact"]
    inputs: list[ExactInput] = Field(min_length=1, max_length=MAX_MEMBERS)


class PercentIn(_ByPeople):
    mode: Literal["percent"]
    inputs: list[PercentInput] = Field(min_length=1, max_length=MAX_MEMBERS)


class SharesIn(_ByPeople):
    mode: Literal["shares"]
    inputs: list[SharesInput] = Field(min_length=1, max_length=MAX_MEMBERS)


class AdjustIn(_ByPeople):
    mode: Literal["adjust"]
    inputs: list[AdjustInput] = Field(min_length=1, max_length=MAX_MEMBERS)


class ItemIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: ItemName  # never logged or sent back in a refusal: item_no_one carries the seq
    price_centavos: int = Field(ge=0, le=MAX_CENTAVOS)
    who: list[UUID] = Field(max_length=MAX_MEMBERS)  # empty is the split's item_no_one, with this item's seq

    @field_validator("who")
    @classmethod
    def who_once(cls, who: list[UUID]) -> list[UUID]:
        _once(who)
        return who


class ChargeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["service", "vat"]
    basis: Literal["percent", "amount"]
    value: int = Field(ge=0, le=MAX_CENTAVOS)  # basis points (over 10000 is charge_too_big) or centavos


class ItemizedIn(_ExpenseV2):
    """The amount is the items plus the charges, computed by the split. One sent along must match (amount_mismatch)."""

    mode: Literal["itemized"]
    amount_centavos: Centavos | None = None
    items: list[ItemIn] = Field(min_length=1, max_length=MAX_ITEMS_SENT)  # seq = the list order, from 1
    charges: list[ChargeIn] = Field(default=[], max_length=2)

    @field_validator("charges")
    @classmethod
    def one_of_each(cls, charges: list[ChargeIn]) -> list[ChargeIn]:
        if len({c.kind for c in charges}) != len(charges):
            raise ValueError("one service charge and one VAT at most")
        return charges


ExpenseInV2 = Annotated[Union[EqualIn, ExactIn, PercentIn, SharesIn, AdjustIn, ItemizedIn], Field(discriminator="mode")]


class _Versioned(BaseModel):
    version: int = Field(ge=1)  # the version the form opened; a stale one is 409 expense_changed


class EqualPatch(EqualIn, _Versioned): ...
class ExactPatch(ExactIn, _Versioned): ...
class PercentPatch(PercentIn, _Versioned): ...
class SharesPatch(SharesIn, _Versioned): ...
class AdjustPatch(AdjustIn, _Versioned): ...
class ItemizedPatch(ItemizedIn, _Versioned): ...


ExpensePatch = Annotated[
    Union[EqualPatch, ExactPatch, PercentPatch, SharesPatch, AdjustPatch, ItemizedPatch], Field(discriminator="mode")
]


# ---------------------------------------------------------------- TG-66: comments, activity and refusal bodies

class CommentIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    body: CommentBody
    by: UUID | None = None


class CommentOut(BaseModel):
    id: UUID
    expense_id: UUID
    author: UUID | None  # null: "Someone"
    body: str
    created_at: datetime


class CommentsOut(BaseModel):
    """GET …/comments. rev is read in the same transaction as the comments (S1)."""

    rev: int
    comments: list[CommentOut]  # oldest first


class CommentWriteOut(BaseModel):
    """A comment's POST or DELETE: the wallet (its new rev, the card's comment_count) and the expense's comments."""

    wallet: WalletOut
    comments: list[CommentOut]


Action = Literal["expense_add", "expense_edit", "expense_delete", "comment_add", "comment_delete", "settle", "settle_undo",
                 "proof_add", "proof_change", "proof_remove", "member_join"]


class ActivityRowOut(BaseModel):
    id: int
    at: datetime
    actor: UUID | None  # null: "Someone"
    action: Action
    expense_id: UUID | None
    settlement_id: UUID | None
    member_id: UUID | None
    before: dict | None
    after: dict | None


class ActivityOut(BaseModel):
    """GET …/activity: one page, newest first."""

    rev: int
    rows: list[ActivityRowOut]


class WalletRefusal(BaseModel):
    """`detail` of a 409 expense_changed or a 404 expense_gone: the code and the wallet as it is now."""

    code: Literal["expense_changed", "expense_gone"]
    wallet: WalletOut


class ItemRefusal(BaseModel):
    """`detail` of a 422 item_no_one: the item's seq, never its name."""

    code: Literal["item_no_one"] = "item_no_one"
    seq: int
