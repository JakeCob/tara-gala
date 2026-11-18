"""The wallet's money rules (TG-66): how an expense's amount becomes each person's share, in centavos.

Pure functions, integers only: no float, no true division, no rounding helper (a test guards the source). W1's
walletSplit.ts follows the same steps, and both load tests/fixtures/wallet_split_vectors.json, so the phone's preview
and the server can't drift.

The one rounding rule is allocate(): each person's floor(amount * w / W), then the leftover centavos one each in the
given order (the payer first, then wallet order), skipping weight 0. Itemized runs it once per item, then once per
charge on the item subtotals (plan §2, M1), which keeps every product under 10^14.

A money rule a person broke raises SplitError(code), and the code reaches the phone as ux.md §9's line. A ValueError
is a caller bug (a person outside the wallet, an unknown mode): the route checks those first.

Logs: one line per split with the mode and counts, or the refusal code and an item's seq. Never a member id, an item's
name, a note or an amount.
"""

import logging
from collections.abc import Iterable, Mapping
from uuid import UUID

from .wallet_models import MAX_CENTAVOS, SPLIT_CODES

logger = logging.getLogger("tara_gala.api")

MAX_ITEMS = 40  # an itemized bill's item limit (too_many_items); the request body allows more so this line is reached
FULL_BP = 10000  # 100% in basis points
CHARGE_STEPS = ("service", "vat")  # §2: the item subtotal's charges, in this order, never compounded


class SplitError(Exception):
    """A money rule the person broke. `code` is one of SPLIT_CODES; `seq` is the item's place (from 1) for item_no_one.

    It never carries a name: the route turns it into {"detail": code} or {"detail": {"code", "seq"}}.
    """

    def __init__(self, code: str, seq: int | None = None):
        if code not in SPLIT_CODES:
            raise ValueError(f"unknown split code {code!r}")
        super().__init__(code if seq is None else f"{code} seq={seq}")
        self.code = code
        self.seq = seq


def _get(row, key: str):
    """A field of a body row, from a plain dict (tests, scripts) or a wallet_models request model (the routes)."""
    return row[key] if isinstance(row, Mapping) else getattr(row, key)


def allocate(amount: int, weights: dict[UUID, int], order: list[UUID]) -> dict[UUID, int]:
    """floor(amount * w / W) each, then the leftover one centavo each in `order`, skipping weight 0. W = sum(weights).

    Everyone in `weights` is in the answer, weight 0 with 0. `order` may name people without a weight (they're skipped),
    but everyone with a weight must be in it.
    """
    if amount < 0:
        raise ValueError("amount must be >= 0")
    if any(w < 0 for w in weights.values()):
        raise ValueError("weights must be >= 0")
    total = sum(weights.values())
    if total <= 0:
        raise ValueError("the weights must add up to more than 0")
    ranked = [m for m in dict.fromkeys(order) if weights.get(m, 0) > 0]
    if len(ranked) != sum(1 for w in weights.values() if w > 0):
        raise ValueError("everyone with a weight must be in the order")
    shares = {m: amount * w // total for m, w in weights.items()}
    leftover = amount - sum(shares.values())  # < the number of people with a weight
    for m in ranked[:leftover]:
        shares[m] += 1
    return shares


def charge_amount(subtotal: int, basis: str, value: int) -> int:
    """A service charge or VAT on the item subtotal. percent: basis points, half up; amount: the centavos given."""
    if basis == "percent":
        if not 0 <= value <= FULL_BP:
            raise SplitError("charge_too_big")
        return (subtotal * value + FULL_BP // 2) // FULL_BP
    if basis == "amount":
        if value < 0:
            raise SplitError("charge_too_big")
        return value
    raise ValueError(f"unknown charge basis {basis!r}")


def check_payers(amount: int, payers: dict[UUID, int]) -> None:
    """Several payers: at least 2, each paying at least 1 centavo, adding up to the amount."""
    if len(payers) < 2 or any(p < 1 for p in payers.values()) or sum(payers.values()) != amount:
        raise SplitError("payers_mismatch")


def first_payer(paid_by: UUID | None, payers: dict | None, wallet_order: list[UUID]) -> UUID:
    """The one payer, or the first of several in wallet order: expenses.paid_by, and the leftover's first place."""
    if (paid_by is None) == (not payers):
        raise ValueError("give paid_by or payers, not both")
    if paid_by is not None:
        return paid_by
    if not set(payers) <= set(wallet_order):
        raise ValueError("every payer must be in the wallet")
    return next(m for m in wallet_order if m in payers)


def _order(payer_first: UUID, wallet_order: list[UUID]) -> list[UUID]:
    return [payer_first] + [m for m in wallet_order if m != payer_first]


def _people(member_ids: Iterable[UUID], wallet_order: list[UUID]) -> list[UUID]:
    ids = list(member_ids)
    if len(set(ids)) != len(ids):
        raise ValueError("each person at most once")
    if not set(ids) <= set(wallet_order):
        raise ValueError("everyone in a split must be in the wallet")
    return ids


def _by_people(mode: str, amount: int, inputs, order: list[UUID], wallet_order: list[UUID]) -> dict[UUID, int]:
    values = {m: _get(i, "value") for m, i in zip(_people((_get(i, "member_id") for i in inputs), wallet_order),
                                                  inputs)}
    if not values:
        raise ValueError("a split needs at least one person")
    if mode == "equal":
        return allocate(amount, {m: 1 for m in values}, order)
    if mode == "exact":
        if any(v < 0 for v in values.values()) or sum(values.values()) != amount:
            raise SplitError("shares_mismatch")
        return dict(values)
    if mode == "percent":
        if any(v < 0 for v in values.values()) or sum(values.values()) != FULL_BP:
            raise SplitError("percent_total")
        return allocate(amount, values, order)
    if mode == "shares":
        if any(v < 0 for v in values.values()) or sum(values.values()) == 0:
            raise SplitError("shares_zero")
        return allocate(amount, values, order)
    # adjust: the rows are `among`, each with an extra (+ or -); the rest is split equally among them all
    rest = amount - sum(values.values())
    if rest < 0:
        raise SplitError("extras_too_big")
    shares = {m: part + values[m] for m, part in allocate(rest, {m: 1 for m in values}, order).items()}
    if any(s < 0 for s in shares.values()):
        raise SplitError("extras_too_big")
    return shares


def _itemized(amount: int | None, items, charges, payer_first: UUID, wallet_order: list[UUID]) -> tuple[int, dict]:
    if len(items) > MAX_ITEMS:
        raise SplitError("too_many_items")
    whos = []
    for seq, item in enumerate(items, start=1):
        who = _people(_get(item, "who"), wallet_order)
        if not who:
            raise SplitError("item_no_one", seq=seq)
        whos.append(who)
    by_kind = {_get(c, "kind"): c for c in charges}
    if len(by_kind) != len(charges) or not set(by_kind) <= set(CHARGE_STEPS):
        raise ValueError("one service charge and one VAT at most")
    for c in charges:  # a bad charge is reported before the totals it would feed
        charge_amount(0, _get(c, "basis"), _get(c, "value"))
    prices = [_get(item, "price_centavos") for item in items]
    if any(p < 0 for p in prices):
        raise ValueError("prices must be >= 0")
    subtotal = sum(prices)
    if subtotal == 0:
        raise SplitError("items_zero")

    order = _order(payer_first, wallet_order)
    # step 1: each item in seq order, by headcount
    sub: dict[UUID, int] = {}
    for price, who in zip(prices, whos):
        for m, part in allocate(price, {m: 1 for m in who}, order).items():
            sub[m] = sub.get(m, 0) + part
    shares = dict(sub)
    total = subtotal
    # steps 2 and 3: service, then VAT, each on the same item subtotals
    for kind in CHARGE_STEPS:
        if kind not in by_kind:
            continue
        c = charge_amount(subtotal, _get(by_kind[kind], "basis"), _get(by_kind[kind], "value"))
        total += c
        for m, part in allocate(c, sub, order).items():
            shares[m] += part
    if total > MAX_CENTAVOS:
        raise SplitError("amount_too_big")
    if amount is not None and amount != total:
        raise SplitError("amount_mismatch")
    return total, shares


def split(mode: str, amount: int | None, inputs, items, charges, payer_first: UUID,
          wallet_order: list[UUID]) -> tuple[int, dict[UUID, int]]:
    """(amount, final shares) for one expense. Itemized computes the amount (one given must match); the other modes
    take it. Rows are dicts or wallet_models' request models: inputs [{member_id, value}], items [{name,
    price_centavos, who}] in seq order, charges [{kind, basis, value}]. `payer_first` is first_payer()'s answer.
    """
    try:
        if mode == "itemized":
            amount, shares = _itemized(amount, list(items), list(charges), payer_first, wallet_order)
        elif mode in ("equal", "exact", "percent", "shares", "adjust"):
            if amount is None or amount < 1:
                raise ValueError("this mode needs an amount of at least 1 centavo")
            if amount > MAX_CENTAVOS:
                raise SplitError("amount_too_big")
            shares = _by_people(mode, amount, list(inputs), _order(payer_first, wallet_order), wallet_order)
        else:
            raise ValueError(f"unknown split mode {mode!r}")
    except SplitError as e:
        logger.info("wallet split refused mode=%s code=%s%s", mode, e.code, "" if e.seq is None else f" seq={e.seq}")
        raise
    logger.info("wallet split mode=%s people=%d items=%d charges=%d", mode, len(shares), len(items), len(charges))
    return amount, shares
