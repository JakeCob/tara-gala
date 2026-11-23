"""The Ipon goal's money (TG-73 plan §4): what each person has in the pot, and the pot's close-out. Pure, integers only.

The pot is out of the nets while it's open: a pot spend's only share is the treasurer's, so it nets to zero, and an
ambag isn't an expense at all. When the treasurer closes the pot, close_out() gives the change to each person's net,
which wallets._load adds before settle_up (A2):
- a leftover B > 0 goes back by each person's ambag c_i: wallet_splits.allocate with the treasurer T first, so T keeps
  any odd centavo (the house rule). T holds the cash, so T's net goes down by what the others get back;
- a shortfall D = -B is split equally over the people in the goal, T first (wallets.split_equal's rule, done here with
  allocate and weight 1 each, which is the same split), and everyone pays it to T, who covered it (owner Q2, 2026-11-23).
  A T taken out of the goal still covers it and takes no part.

web/src/lib/pot.ts follows the same steps, and both suites load tests/fixtures/pot_vectors.json, so the close sheet's
preview and the server can't drift.

Keys are whatever the caller uses for people (UUIDs in the API, plain strings in the vectors). A row is a dict or an
object with the same attribute names. Logs: none here; the routes log counts and centavo totals.
"""

from collections.abc import Hashable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field

from .wallet_splits import allocate

KINDS = ("in", "back")
STATUSES = ("sent", "received")


class PotError(Exception):
    """A close the money can't make. `code` reaches the phone as ux.md §14's line (the route answers 409)."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class PotNumbers:
    contributed: dict  # c_i: received 'in' less 'back', for every person with a row or in the goal (wallet order)
    received: int  # C = Σ c_i
    spent: int  # S = Σ the pot spends
    balance: int  # B = C - S; below zero is "short"
    targets: dict  # the in-goal people's own amount, or the goal's each
    pending_centavos: int  # 'in' rows still "sent": they don't count until Received
    pending_count: int
    in_goal: list = field(default_factory=list)  # the in-goal people, in wallet order


@dataclass(frozen=True)
class CloseOut:
    refunds: dict  # B > 0: everyone with c_i > 0, wallet order with T first's leftover; else empty
    shortfall: dict  # B < 0: everyone in the goal but a T who's out; else empty
    delta: dict  # every person in `order`: what the close adds to their net. Σ = 0


def _get(row, key: str):
    return row[key] if isinstance(row, Mapping) else getattr(row, key)


def pot_numbers(people: Iterable, ambag: Iterable, spends: Iterable[int], each: int,
                order: Sequence[Hashable]) -> PotNumbers:
    """people: [{member_id, in_goal, target}] (target None: the goal's `each`); ambag: [{member_id, kind, amount,
    status}]; spends: the pot spends' amounts. `order` is the wallet order; everyone named must be in it."""
    rank = {m: i for i, m in enumerate(order)}
    people = list(people)
    known = {_get(p, "member_id") for p in people}
    c: dict = dict.fromkeys(known, 0)
    pending = count = 0
    for a in ambag:
        m, kind, amount, status = _get(a, "member_id"), _get(a, "kind"), _get(a, "amount"), _get(a, "status")
        if kind not in KINDS or status not in STATUSES or amount < 1:
            raise ValueError(f"bad ambag row kind={kind!r} status={status!r}")
        if kind == "back" and status != "received":
            raise ValueError("a give-back is always received")
        c.setdefault(m, 0)
        if status == "sent":
            pending += amount
            count += 1
        else:
            c[m] += amount if kind == "in" else -amount
    if not set(c) <= set(rank):
        raise ValueError("everyone in the pot must be in the wallet order")
    if any(v < 0 for v in c.values()):
        raise ValueError("a give-back can't be more than what that person put in")  # the API caps it at c_i
    spends = list(spends)
    if any(s < 1 for s in spends):
        raise ValueError("a pot spend is at least 1 centavo")
    in_goal = sorted((_get(p, "member_id") for p in people if _get(p, "in_goal")), key=rank.__getitem__)
    targets = {}
    for p in sorted(people, key=lambda p: rank[_get(p, "member_id")]):
        if _get(p, "in_goal"):
            t = _get(p, "target")
            targets[_get(p, "member_id")] = each if t is None else t
    contributed = {m: c[m] for m in sorted(c, key=rank.__getitem__)}
    received, spent = sum(contributed.values()), sum(spends)
    return PotNumbers(contributed=contributed, received=received, spent=spent, balance=received - spent,
                      targets=targets, pending_centavos=pending, pending_count=count, in_goal=in_goal)


def close_out(numbers: PotNumbers, treasurer: Hashable, order: Sequence[Hashable]) -> CloseOut:
    """The close-out of plan §4.2. Raises PotError("no_one_in_goal") for a shortfall with nobody left in the goal."""
    order = list(order)
    if treasurer not in order:
        raise ValueError("the treasurer must be in the wallet order")
    t_first = [treasurer] + [m for m in order if m != treasurer]
    delta = dict.fromkeys(order, 0)
    refunds: dict = {}
    shortfall: dict = {}
    b = numbers.balance
    if b > 0:
        weights = {m: v for m, v in numbers.contributed.items() if v > 0}  # B > 0 means C > 0, so someone has a weight
        found = allocate(b, weights, t_first)
        refunds = {m: found[m] for m in t_first if m in found}
        for m, r in refunds.items():
            if m != treasurer:
                delta[m] += r
        delta[treasurer] -= b - refunds.get(treasurer, 0)
    elif b < 0:
        d = -b
        people = list(numbers.in_goal)  # a T who's out of the goal isn't in it, so takes no part (plan §4.2's edge)
        if not people:
            raise PotError("no_one_in_goal")
        split = allocate(d, dict.fromkeys(people, 1), t_first)  # = wallets.split_equal(d, people, treasurer)
        shortfall = {m: split[m] for m in t_first if m in split}
        for m, part in shortfall.items():
            if m != treasurer:
                delta[m] -= part
        delta[treasurer] += d - shortfall.get(treasurer, 0)
    if sum(delta.values()) != 0:  # pragma: no cover - the two branches above balance by construction
        raise AssertionError("a close-out must sum to zero")
    return CloseOut(refunds=refunds, shortfall=shortfall, delta=delta)
