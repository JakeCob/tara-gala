"""The Ipon goal's request and response models (TG-73 plan §2.2 and §3). Shapes and the tables' bounds only: who may
write, the trip's dates and the money rules are wallet_pot.py's, so their codes reach the phone as ux.md §14's lines.

`by` is the phone's pick of who's writing (TG-66). It's optional in every body so a missing one is wallet_pot's own
`422 by_required`, a code the phone has a line for, not pydantic's generic 422.
"""

from datetime import date, datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

MAX_CENTAVOS = 10_000_000  # wallet_models' own (₱100,000); not imported, since wallet_models imports PotOut from here
MAX_MEMBERS = 20  # wallet_models' own
MIN_EACH = 100  # ₱1, the table's check
GoalName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]
Each = Annotated[int, Field(ge=MIN_EACH, le=MAX_CENTAVOS)]
Target = Annotated[int, Field(ge=0, le=MAX_CENTAVOS)]
AmbagAmount = Annotated[int, Field(ge=1, le=MAX_CENTAVOS)]
Version = Annotated[int, Field(ge=1)]

# The codes a pot refusal carries in `detail` (ux.md §14 has a line for each, plus TG-66's unknown_member and
# feature_off). pot_changed and ambag_gone carry {"code", "wallet"}, as TG-66's 409/404.
POT_CODES = ("by_required", "not_treasurer", "pot_exists", "pot_changed", "pot_in_use", "pot_closed", "due_after_trip",
             "due_past", "not_in_goal", "ambag_gone", "ambag_received", "ambag_given_back", "pot_full", "id_taken",
             "unknown_member", "feature_off", "no_pot", "pot_open", "no_one_in_goal")


# ---------------------------------------------------------------- requests

class PotIn(BaseModel):
    """POST /pot: start the goal. Whoever sends it becomes the treasurer (owner, round 5)."""

    model_config = ConfigDict(extra="forbid")
    by: UUID | None = None
    each_centavos: Each
    due_date: date
    name: GoalName | None = None  # a no-trip goal's own name; null: the wallet's name. A trip's goal takes the trip's.
    people: list[UUID] = Field(min_length=1, max_length=MAX_MEMBERS)

    @field_validator("people")
    @classmethod
    def once(cls, people: list[UUID]) -> list[UUID]:
        if len(set(people)) != len(people):
            raise ValueError("each person at most once")
        return people


class PotPatch(BaseModel):
    """PATCH /pot: the treasurer changes the amount each, the due date or the name. A field left out is kept; an explicit
    null name goes back to the wallet's (or trip's) name."""

    model_config = ConfigDict(extra="forbid")
    by: UUID | None = None
    version: Version
    each_centavos: Each | None = None
    due_date: date | None = None
    name: GoalName | None = None


class PotPersonIn(BaseModel):
    """PUT /pot/people/{member_id}: one person's own amount (null: back to each), out of or back into the goal. With
    in_goal false, give_back true records a give-back of everything they have in the pot (plan B22)."""

    model_config = ConfigDict(extra="forbid")
    by: UUID | None = None
    version: Version
    target_centavos: Target | None = None
    in_goal: bool | None = None
    give_back: bool = False


class AmbagIn(BaseModel):
    """POST /pot/ambag: "I sent ₱X" (the member: pending until Received), or the treasurer's own or a cash-in-hand one
    (received at once). `id` is the phone's own id for a retry-safe send, as TG-70's expense add."""

    model_config = ConfigDict(extra="forbid")
    by: UUID | None = None
    member_id: UUID
    amount_centavos: AmbagAmount
    id: UUID | None = None


class AmbagPatch(BaseModel):
    """PATCH /pot/ambag/{id}: the treasurer marks it Received, or undoes that (back to sent)."""

    model_config = ConfigDict(extra="forbid")
    by: UUID | None = None
    status: Literal["received", "sent"]


class HandoverIn(BaseModel):
    """POST /pot/handover (A2): the treasurer hands the pot to someone in the goal. No settlement is made (plan §4.4):
    the cash, or the gap, moves outside the app, and the sheet says who hands what."""

    model_config = ConfigDict(extra="forbid")
    by: UUID | None = None
    version: Version
    to_member: UUID


class CloseIn(BaseModel):
    """POST /pot/close and /pot/reopen (A2): the treasurer, with the version the sheet opened."""

    model_config = ConfigDict(extra="forbid")
    by: UUID | None = None
    version: Version


# ---------------------------------------------------------------- answers (WalletOut.pot)

class PotTrip(BaseModel):
    """The wallet's one trip: its name and dates (the due date's default and limit, the road's end)."""

    name: str
    start_date: date
    return_date: date


class PotPersonOut(BaseModel):
    member_id: UUID
    target_centavos: int  # their own amount, or the goal's each
    custom: bool  # true: the treasurer set their own amount
    in_goal: bool
    received_centavos: int  # what they have in the pot: Received, less any give-back
    sent_centavos: int  # waiting for Received


class AmbagOut(BaseModel):
    id: UUID
    member_id: UUID
    kind: Literal["in", "back"]
    amount_centavos: int
    status: Literal["sent", "received"]
    sent_at: datetime
    received_at: datetime | None
    has_proof: bool
    proof_at: datetime | None


class PotAmount(BaseModel):
    member_id: UUID
    amount_centavos: int


class CloseOutOut(BaseModel):
    """The close-out the close sheet previews (and, once closed, what Settle up adds). T first, then wallet order."""

    refunds: list[PotAmount]
    shortfall: list[PotAmount]


class PotOut(BaseModel):
    name: str  # the goal's own name, else the trip's, else the wallet's
    each_centavos: int
    due_date: date
    treasurer: UUID
    version: int
    closed_at: datetime | None
    trip: PotTrip | None
    people: list[PotPersonOut]  # everyone who was ever in the goal, wallet order
    ambag: list[AmbagOut]  # newest first
    received_centavos: int  # C
    spent_centavos: int  # S: the pot spends
    balance_centavos: int  # C - S; below zero is short
    target_centavos: int  # the in-goal people's amounts, added up
    pending_centavos: int
    pending_count: int
    close_out: CloseOutOut | None  # null only when the pot is short and nobody is left in the goal (no_one_in_goal)
