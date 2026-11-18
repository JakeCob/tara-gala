"""TG-62: the trip page's Budget panel answer, `GET /sessions/{slug}/budget` (plan §2; options §3 Revision 2, plus a
`state` for ux.md §5's states). The route and its sums are GA2's (session_budget.py); this is only the shape.

Money is whole centavos, except a line's `min` and `max`, which are the estimate's whole pesos (null when it can't be
read). `lines`, `not_in_budget`, `unsorted` and `members` are filled only when `state` is `ok`. `member_count` and
`total_centavos` are filled whenever there's a wallet, which is what the Shared expenses card line needs.
"""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, model_validator

BudgetState = Literal["ok", "no_wallet", "two_trips", "no_budget"]


class BudgetLineSpend(BaseModel):
    key: str
    item: str
    estimate: str  # the plan's own text, as written
    min: int | None  # whole pesos; null when the estimate can't be read
    max: int | None
    readable: bool
    spent: int  # centavos on this line
    spent_each: int  # spent / member_count, half rounding up, in centavos


class NotInBudget(BaseModel):
    """Expenses marked "None of these" (`_none`)."""

    count: int
    spent: int


class Unsorted(BaseModel):
    """Expenses with no line, plus those on a key no current row has (`removed` counts those)."""

    count: int
    spent: int
    removed: int


class MemberSpend(BaseModel):
    member_id: UUID
    name: str
    share_lines: int  # their shares of expenses on a current line
    share_total: int  # all their shares; share_total - share_lines is their "other"


class SessionBudgetOut(BaseModel):
    state: BudgetState
    member_count: int = 0
    total_centavos: int = 0  # 0 when there's no wallet
    lines: list[BudgetLineSpend] = []  # plan order
    not_in_budget: NotInBudget | None = None
    unsorted: Unsorted | None = None
    members: list[MemberSpend] = []  # wallet order

    @model_validator(mode="after")
    def _filled_by_state(self):
        if self.state == "ok":
            if self.not_in_budget is None or self.unsorted is None:
                raise ValueError("ok carries not_in_budget and unsorted")
        elif self.lines or self.members or self.not_in_budget is not None or self.unsorted is not None:
            raise ValueError("only ok carries lines, members, not_in_budget and unsorted")
        if self.state == "no_wallet" and (self.member_count or self.total_centavos):
            raise ValueError("no_wallet has nothing to count")
        return self
