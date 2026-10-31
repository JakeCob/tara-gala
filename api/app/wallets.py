"""Shared trip wallets (TG-50): who paid what on the trip, the split, and who pays whom at the end.

A wallet has no owner and no accounts: anyone with its share link can read it and write to it, like an itinerary
link (TG-23) but writable. The slug is 128 random bits and is the only key. Money is whole centavos, so every split
adds up exactly. Payout QRs never come here: they stay on each person's phone.

Logs carry the slug and counts, never a person's name or an expense note.
"""

import logging
import math
import re
from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator

from . import db
from .limits import RateLimiter, client_ip, ip_hash

router = APIRouter(tags=["wallets"])
logger = logging.getLogger("tara_gala.api")

SLUG = re.compile(r"^[0-9a-f]{32}$")
NOT_FOUND = "Wallet not found"
NOINDEX = {"X-Robots-Tag": "noindex"}
MAX_MEMBERS = 20
MAX_EXPENSES = 500
MAX_CENTAVOS = 10_000_000  # PHP 100,000, the same cap as the table's check

# Per-IP limits, in process memory like the planner's (limits.py): reset on every deploy
CREATE_PER_HOUR = 20
WRITES_PER_HOUR = 600
CREATE_LIMITER = RateLimiter(CREATE_PER_HOUR)
WRITE_LIMITER = RateLimiter(WRITES_PER_HOUR)

WalletName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]
MemberName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=30)]
Note = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)]
Centavos = Annotated[int, Field(ge=1, le=MAX_CENTAVOS)]


# ---------------------------------------------------------------- the money: pure

def split_equal(amount: int, member_ids: list[UUID], payer: UUID) -> dict[UUID, int]:
    """Equal parts that add up to `amount`. Leftover centavos go one each to the payer first, then in list order."""
    base, extra = divmod(amount, len(member_ids))
    order = ([payer] if payer in member_ids else []) + [m for m in member_ids if m != payer]
    return {m: base + (1 if i < extra else 0) for i, m in enumerate(order)}


def settle_up(nets: dict[UUID, int], order: list[UUID]) -> list[tuple[UUID, UUID, int]]:
    """The payments (from, to, centavos) that bring every net to zero: the largest debtor pays the largest
    creditor, repeatedly. At most one payment fewer than the people with a balance. Ties go by party order."""
    if sum(nets.values()) != 0:
        raise ValueError("nets must sum to zero")
    rank = {m: i for i, m in enumerate(order)}
    creditors = [[m, n] for m, n in nets.items() if n > 0]
    debtors = [[m, -n] for m, n in nets.items() if n < 0]
    payments = []
    while creditors and debtors:
        creditors.sort(key=lambda x: (-x[1], rank[x[0]]))
        debtors.sort(key=lambda x: (-x[1], rank[x[0]]))
        creditor, debtor = creditors[0], debtors[0]
        amount = min(creditor[1], debtor[1])
        payments.append((debtor[0], creditor[0], amount))
        creditor[1] -= amount
        debtor[1] -= amount
        if creditor[1] == 0:
            creditors.pop(0)
        if debtor[1] == 0:
            debtors.pop(0)
    return payments


# ---------------------------------------------------------------- request and response shapes

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


class ExpenseOut(BaseModel):
    id: UUID
    paid_by: UUID
    amount_centavos: int
    note: str
    created_at: datetime
    shares: list[ShareOut]


class SettlementOut(BaseModel):
    id: UUID
    from_member: UUID
    to_member: UUID
    amount_centavos: int
    created_at: datetime


class BalanceOut(BaseModel):
    member_id: UUID
    paid_centavos: int  # what they paid for the group
    share_centavos: int  # their part of everything
    net_centavos: int  # paid - share, plus payments sent, minus payments received: above zero means they're owed


class TransferOut(BaseModel):
    from_member: UUID
    to_member: UUID
    amount_centavos: int


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


# ---------------------------------------------------------------- database

def _limit(limiter: RateLimiter, request: Request, action: str) -> None:
    ip = client_ip(request)
    wait = limiter.hit(ip)
    if wait is not None:
        retry_after = max(1, math.ceil(wait))
        logger.warning("wallet rate limited action=%s ip=%s retry_after=%d", action, ip_hash(ip), retry_after)
        raise HTTPException(429, "rate_limited", headers={"Retry-After": str(retry_after)})


def _wallet_id(conn, share_slug: str, lock: bool = False) -> UUID:
    """The wallet's id, or 404. `lock` holds the row until commit, so writes to one wallet go one at a time."""
    if not SLUG.fullmatch(share_slug):
        logger.info("wallet not found share_slug=<invalid>")
        raise HTTPException(404, NOT_FOUND, headers=NOINDEX)
    row = conn.execute(
        "select id from wallets where share_slug = %s" + (" for update" if lock else ""), (share_slug,)
    ).fetchone()
    if row is None:
        logger.info("wallet not found share_slug=%s", share_slug)
        raise HTTPException(404, NOT_FOUND, headers=NOINDEX)
    return row["id"]


def _member_ids(conn, wallet_id: UUID) -> set[UUID]:
    return {r["id"] for r in conn.execute("select id from wallet_members where wallet_id = %s", (wallet_id,))}


def _load(conn, wallet_id: UUID) -> WalletOut:
    wallet = conn.execute("select share_slug, name, created_at from wallets where id = %s", (wallet_id,)).fetchone()
    members = conn.execute("select id, name from wallet_members where wallet_id = %s order by seq", (wallet_id,)).fetchall()
    order = [m["id"] for m in members]
    rank = {m: i for i, m in enumerate(order)}
    shares: dict[UUID, list[ShareOut]] = {}
    for r in conn.execute(
        """select s.expense_id, s.member_id, s.share_centavos from expense_shares s
           join expenses e on e.id = s.expense_id where e.wallet_id = %s""",
        (wallet_id,),
    ):
        shares.setdefault(r["expense_id"], []).append(ShareOut(member_id=r["member_id"], share_centavos=r["share_centavos"]))
    expenses = [
        ExpenseOut(**r, shares=sorted(shares.get(r["id"], []), key=lambda s: rank[s.member_id]))
        for r in conn.execute(
            """select id, paid_by, amount_centavos, note, created_at from expenses
               where wallet_id = %s order by created_at desc, id desc""",
            (wallet_id,),
        )
    ]
    settlements = [
        SettlementOut(**r)
        for r in conn.execute(
            """select id, from_member, to_member, amount_centavos, created_at from settlements
               where wallet_id = %s order by created_at desc, id desc""",
            (wallet_id,),
        )
    ]
    paid = dict.fromkeys(order, 0)
    owed = dict.fromkeys(order, 0)
    for e in expenses:
        paid[e.paid_by] += e.amount_centavos
        for s in e.shares:
            owed[s.member_id] += s.share_centavos
    net = {m: paid[m] - owed[m] for m in order}
    for s in settlements:
        net[s.from_member] += s.amount_centavos
        net[s.to_member] -= s.amount_centavos
    return WalletOut(
        share_slug=wallet["share_slug"],
        name=wallet["name"],
        created_at=wallet["created_at"],
        members=[MemberOut(**m) for m in members],
        expenses=expenses,
        settlements=settlements,
        balances=[BalanceOut(member_id=m, paid_centavos=paid[m], share_centavos=owed[m], net_centavos=net[m]) for m in order],
        transfers=[TransferOut(from_member=f, to_member=t, amount_centavos=a) for f, t, a in settle_up(net, order)],
        total_centavos=sum(e.amount_centavos for e in expenses),
    )


def _private(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-cache"  # names and amounts are personal
    response.headers.update(NOINDEX)


def _counts(w: WalletOut) -> str:
    return f"members={len(w.members)} expenses={len(w.expenses)} settlements={len(w.settlements)} open={len(w.transfers)}"


# ---------------------------------------------------------------- routes

@router.post("/wallets", status_code=201, response_model=WalletOut)
def create_wallet(body: WalletIn, request: Request, response: Response) -> WalletOut:
    _limit(CREATE_LIMITER, request, "create")
    with db.get_conn() as conn:
        wallet_id = conn.execute("insert into wallets (name) values (%s) returning id", (body.name,)).fetchone()["id"]
        for name in body.members:
            conn.execute("insert into wallet_members (wallet_id, name) values (%s, %s)", (wallet_id, name))
        wallet = _load(conn, wallet_id)
    _private(response)
    logger.info("wallet create share_slug=%s %s", wallet.share_slug, _counts(wallet))
    return wallet


@router.get("/wallets/{share_slug}", response_model=WalletOut, responses={404: {"description": NOT_FOUND}})
def get_wallet(share_slug: str, response: Response) -> WalletOut:
    with db.get_conn() as conn:
        wallet = _load(conn, _wallet_id(conn, share_slug))
    _private(response)
    logger.info("wallet get share_slug=%s %s", share_slug, _counts(wallet))
    return wallet


@router.post("/wallets/{share_slug}/members", status_code=201, response_model=WalletOut)
def add_member(share_slug: str, body: MemberIn, request: Request, response: Response) -> WalletOut:
    _limit(WRITE_LIMITER, request, "member")
    with db.get_conn() as conn:
        wallet_id = _wallet_id(conn, share_slug, lock=True)
        names = [r["name"].lower() for r in conn.execute("select name from wallet_members where wallet_id = %s", (wallet_id,))]
        if len(names) >= MAX_MEMBERS:
            logger.info("wallet member refused share_slug=%s reason=party_full", share_slug)
            raise HTTPException(409, "party_full")
        if body.name.lower() in names:
            logger.info("wallet member refused share_slug=%s reason=name_taken", share_slug)
            raise HTTPException(409, "name_taken")
        conn.execute("insert into wallet_members (wallet_id, name) values (%s, %s)", (wallet_id, body.name))
        wallet = _load(conn, wallet_id)
    _private(response)
    logger.info("wallet member add share_slug=%s %s", share_slug, _counts(wallet))
    return wallet


@router.post("/wallets/{share_slug}/expenses", status_code=201, response_model=WalletOut)
def add_expense(share_slug: str, body: ExpenseIn, request: Request, response: Response) -> WalletOut:
    _limit(WRITE_LIMITER, request, "expense")
    with db.get_conn() as conn:
        wallet_id = _wallet_id(conn, share_slug, lock=True)
        members = _member_ids(conn, wallet_id)
        if body.split_among is not None:
            shares = split_equal(body.amount_centavos, body.split_among, body.paid_by)
        else:
            shares = {s.member_id: s.share_centavos for s in body.shares}
            if sum(shares.values()) != body.amount_centavos:
                logger.info("wallet expense refused share_slug=%s reason=shares_mismatch", share_slug)
                raise HTTPException(422, "shares_mismatch")
        if body.paid_by not in members or not set(shares) <= members:
            logger.info("wallet expense refused share_slug=%s reason=unknown_member", share_slug)
            raise HTTPException(422, "unknown_member")
        count = conn.execute("select count(*) as n from expenses where wallet_id = %s", (wallet_id,)).fetchone()["n"]
        if count >= MAX_EXPENSES:
            logger.info("wallet expense refused share_slug=%s reason=wallet_full", share_slug)
            raise HTTPException(409, "wallet_full")
        expense_id = conn.execute(
            "insert into expenses (wallet_id, paid_by, amount_centavos, note) values (%s, %s, %s, %s) returning id",
            (wallet_id, body.paid_by, body.amount_centavos, body.note),
        ).fetchone()["id"]
        for member_id, part in shares.items():
            conn.execute(
                "insert into expense_shares (expense_id, member_id, share_centavos) values (%s, %s, %s)",
                (expense_id, member_id, part),
            )
        wallet = _load(conn, wallet_id)
    _private(response)
    split = "equal" if body.split_among is not None else "custom"
    logger.info("wallet expense add share_slug=%s split=%s people=%d %s", share_slug, split, len(shares), _counts(wallet))
    return wallet


@router.delete("/wallets/{share_slug}/expenses/{expense_id}", response_model=WalletOut)
def delete_expense(share_slug: str, expense_id: UUID, request: Request, response: Response) -> WalletOut:
    _limit(WRITE_LIMITER, request, "expense_delete")
    with db.get_conn() as conn:
        wallet_id = _wallet_id(conn, share_slug, lock=True)
        gone = conn.execute("delete from expenses where id = %s and wallet_id = %s returning id", (expense_id, wallet_id)).fetchone()
        if gone is None:
            logger.info("wallet expense delete not found share_slug=%s", share_slug)
            raise HTTPException(404, "Expense not found")
        wallet = _load(conn, wallet_id)
    _private(response)
    logger.info("wallet expense delete share_slug=%s %s", share_slug, _counts(wallet))
    return wallet


@router.post("/wallets/{share_slug}/settlements", status_code=201, response_model=WalletOut)
def add_settlement(share_slug: str, body: SettlementIn, request: Request, response: Response) -> WalletOut:
    _limit(WRITE_LIMITER, request, "settlement")
    with db.get_conn() as conn:
        wallet_id = _wallet_id(conn, share_slug, lock=True)
        if not {body.from_member, body.to_member} <= _member_ids(conn, wallet_id):
            logger.info("wallet settlement refused share_slug=%s reason=unknown_member", share_slug)
            raise HTTPException(422, "unknown_member")
        conn.execute(
            "insert into settlements (wallet_id, from_member, to_member, amount_centavos) values (%s, %s, %s, %s)",
            (wallet_id, body.from_member, body.to_member, body.amount_centavos),
        )
        wallet = _load(conn, wallet_id)
    _private(response)
    logger.info("wallet settlement add share_slug=%s %s", share_slug, _counts(wallet))
    return wallet


@router.delete("/wallets/{share_slug}/settlements/{settlement_id}", response_model=WalletOut)
def delete_settlement(share_slug: str, settlement_id: UUID, request: Request, response: Response) -> WalletOut:
    _limit(WRITE_LIMITER, request, "settlement_delete")
    with db.get_conn() as conn:
        wallet_id = _wallet_id(conn, share_slug, lock=True)
        gone = conn.execute(
            "delete from settlements where id = %s and wallet_id = %s returning id", (settlement_id, wallet_id)
        ).fetchone()
        if gone is None:
            logger.info("wallet settlement delete not found share_slug=%s", share_slug)
            raise HTTPException(404, "Payment not found")
        wallet = _load(conn, wallet_id)
    _private(response)
    logger.info("wallet settlement delete share_slug=%s %s", share_slug, _counts(wallet))
    return wallet
