"""Shared trip wallets (TG-50): who paid what on the trip, the split, and who pays whom at the end.

A wallet has no owner and no accounts: anyone with its share link can read it and write to it, like an itinerary
link (TG-23) but writable. The slug is 128 random bits and is the only key. Money is whole centavos, so every split
adds up exactly. Payout QRs never come here: they stay on each person's phone. Payment proofs (wallet_proofs.py, TG-53)
are the one file a wallet holds.

Logs carry the slug and counts, never a person's name or an expense note.

TG-66: an expense also takes the new shape (`mode`: equal, exact, percent, shares, adjust or itemized; one payer or
several; a category), split by wallet_splits.py. It can be edited (PATCH, with the version the form opened) and deleted
with a version too. Every write calls wallet_activity.record() in its own transaction, so the wallet's rev and its
activity list move together. An expense's before/after in that list is snapshot(): ExpenseOut cut to SNAPSHOT_FIELDS.
`by` is the phone's pick of who's writing, in the v2 body or as `?by=` where the body has no room for it. The logs add
the mode, the category, the people and item counts and the centavo totals (options §8): still never a name, a note, an
item's name, `by` or a member id.

TG-62 (GA1): an expense also carries `budget_key`, a line of the wallet's one trip's budget (budget_lines()), "_none"
or null, and WalletOut.budget lists those lines, both behind BUDGET_LINES. An edit that leaves the field out keeps the
stored line (plan Rev 1 M2). The key is never logged: it's a slug of the group's own line text (`budget=line|none|null`).
"""

import logging
import math
import re
from uuid import UUID

from typing import Union

import psycopg

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response

from . import db, storage, wallet_activity, wallet_pot, wallet_splits
from .limits import RateLimiter, client_ip, ip_hash
from .wallet_activity import record  # defined above wallet_activity's own import of this module, so either loads first
from .wallet_models import (  # TG-66: the models moved, and every name is still importable from here
    MAX_CENTAVOS,
    MAX_MEMBERS,
    BalanceOut,
    Centavos,
    ChargeOut,
    ExpenseIn,
    ExpenseInLegacy,
    ExpenseInV2,
    BudgetLine,
    ExpenseOut,
    ExpensePatch,
    InputOut,
    ItemOut,
    MemberIn,
    MemberName,
    MemberOut,
    Note,
    PayerOut,
    SettlementIn,
    SettlementOut,
    ShareIn,
    ShareOut,
    TransferOut,
    WalletIn,
    WalletName,
    WalletBudget,
    WalletOut,
)
from .guide import Budget
from .wallet_splits import SplitError

router = APIRouter(tags=["wallets"])
logger = logging.getLogger("tara_gala.api")

SLUG = re.compile(r"^[0-9a-f]{32}$")
NOT_FOUND = "Wallet not found"
NOINDEX = {"X-Robots-Tag": "noindex"}
MAX_EXPENSES = 500

# TG-66: an activity row's before/after (plan §2): ExpenseOut's own names, no id, timestamps or comment count
SNAPSHOT_FIELDS = frozenset({"budget_key",  # TG-62 GA1 (plan G8)
                             "amount_centavos", "note", "category", "paid_by", "payers", "mode", "inputs", "items",
                             "charges", "shares", "version"})
FREE_MODES = ("equal", "exact")  # what WALLET_SPLITS off still takes (category dropped): the common case, after a rollback
CHARGE_ORDER = {"service": 0, "vat": 1}

# Per-IP limits, in process memory like the planner's (limits.py): reset on every deploy
CREATE_PER_HOUR = 20
WRITES_PER_HOUR = 600
CREATE_LIMITER = RateLimiter(CREATE_PER_HOUR)
WRITE_LIMITER = RateLimiter(WRITES_PER_HOUR)


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


def _by_expense(conn, sql: str, wallet_id: UUID) -> dict[UUID, list[dict]]:
    out: dict[UUID, list[dict]] = {}
    for r in conn.execute(sql, (wallet_id,)):
        out.setdefault(r["expense_id"], []).append(r)
    return out


def budget_lines(conn, wallet_id: UUID) -> WalletBudget | None:
    """TG-62 G7: the lines of the wallet's one trip, in plan order: only when exactly one trip has this wallet, that trip
    has an itinerary, and its guide's budget has keyed rows. Anything else, a budget that doesn't parse included, is
    None. Never an estimate or an amount. TG-63's scan reads it too."""
    trips = conn.execute(
        "select s.name, i.plan from trip_sessions s left join itineraries i on i.id = s.itinerary_id where s.wallet_id = %s limit 2",
        (wallet_id,),
    ).fetchall()
    if len(trips) != 1 or not isinstance(trips[0]["plan"], dict):
        return None
    guide = trips[0]["plan"].get("guide")
    raw = guide.get("budget") if isinstance(guide, dict) else None
    if not isinstance(raw, dict):
        return None
    try:
        rows = Budget.model_validate(raw).rows
    except ValueError:  # pydantic's ValidationError: a budget we can't read has no lines
        return None
    lines = [BudgetLine(key=r.key, item=r.item, category=r.category) for r in rows if r.key is not None]
    return WalletBudget(trip_name=trips[0]["name"], lines=lines) if lines else None


def load_opts(flags) -> dict:
    """_load's flag keywords, from the request's flags: every route that answers a wallet passes all of them."""
    return {"budget": flags.budget_lines, "pot": flags.wallet_pot}


def _load(conn, wallet_id: UUID, *, budget: bool = False, pot: bool = False) -> WalletOut:
    """The whole wallet. `budget`: BUDGET_LINES (TG-62); `pot`: WALLET_POT (TG-73), the Ipon goal as `pot`. Off, the
    `pot` key isn't in the answer at all (WalletOut's serializer), so today's wallets read byte for byte as before.
    Both come from load_opts(request.app.state.flags) in every route that answers a wallet."""
    wallet = conn.execute("select share_slug, name, created_at, rev from wallets where id = %s", (wallet_id,)).fetchone()
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
    # TG-66: the split's inputs, items (with who had each), charges and several payers
    inputs = _by_expense(conn, """select i.expense_id, i.member_id, i.value from expense_inputs i
                                  join expenses e on e.id = i.expense_id where e.wallet_id = %s""", wallet_id)
    payers = _by_expense(conn, """select p.expense_id, p.member_id, p.paid_centavos from expense_payers p
                                  join expenses e on e.id = p.expense_id where e.wallet_id = %s""", wallet_id)
    charges = _by_expense(conn, """select c.expense_id, c.kind, c.basis, c.value from expense_charges c
                                   join expenses e on e.id = c.expense_id where e.wallet_id = %s""", wallet_id)
    items = _by_expense(conn, """select it.expense_id, it.id, it.seq, it.name, it.price_centavos from expense_items it
                                 join expenses e on e.id = it.expense_id where e.wallet_id = %s order by it.seq""", wallet_id)
    who: dict[UUID, list[UUID]] = {}
    for r in conn.execute(
        """select p.item_id, p.member_id from expense_item_people p join expense_items it on it.id = p.item_id
           join expenses e on e.id = it.expense_id where e.wallet_id = %s""",
        (wallet_id,),
    ):
        who.setdefault(r["item_id"], []).append(r["member_id"])

    def by_rank(rows: list[dict]) -> list[dict]:
        return sorted(rows, key=lambda r: rank[r["member_id"]])

    expenses = [
        ExpenseOut(
            **r,
            shares=sorted(shares.get(r["id"], []), key=lambda s: rank[s.member_id]),
            inputs=[InputOut(member_id=i["member_id"], value=i["value"]) for i in by_rank(inputs.get(r["id"], []))],
            payers=[PayerOut(member_id=p["member_id"], paid_centavos=p["paid_centavos"]) for p in by_rank(payers.get(r["id"], []))],
            charges=[ChargeOut(kind=c["kind"], basis=c["basis"], value=c["value"])
                     for c in sorted(charges.get(r["id"], []), key=lambda c: CHARGE_ORDER[c["kind"]])],
            items=[ItemOut(seq=i["seq"], name=i["name"], price_centavos=i["price_centavos"],
                           who=sorted(who.get(i["id"], []), key=lambda m: rank[m])) for i in items.get(r["id"], [])],
        )
        for r in conn.execute(
            """select id, paid_by, amount_centavos, note, created_at, split_mode as mode, category, version, updated_at,
                      budget_key,  -- TG-62
                      (select count(*) from expense_comments c where c.expense_id = expenses.id) as comment_count  -- TG-66
               from expenses where wallet_id = %s order by created_at desc, id desc""",
            (wallet_id,),
        )
    ]
    settlements = [
        SettlementOut(**r)
        for r in conn.execute(
            """select id, from_member, to_member, amount_centavos, created_at, proof_path is not null as has_proof, proof_at from settlements
               where wallet_id = %s order by created_at desc, id desc""",
            (wallet_id,),
        )
    ]
    paid = dict.fromkeys(order, 0)
    owed = dict.fromkeys(order, 0)
    for e in expenses:
        if e.payers:  # TG-66: several payers, each counted for what they paid
            for p in e.payers:
                paid[p.member_id] += p.paid_centavos
        else:
            paid[e.paid_by] += e.amount_centavos
        for s in e.shares:
            owed[s.member_id] += s.share_centavos
    net = {m: paid[m] - owed[m] for m in order}
    for s in settlements:
        net[s.from_member] += s.amount_centavos
        net[s.to_member] -= s.amount_centavos
    extra = {"pot": wallet_pot.load_pot(conn, wallet_id, wallet["name"], order)} if pot else {}  # TG-73
    return WalletOut(
        **extra,
        share_slug=wallet["share_slug"],
        name=wallet["name"],
        created_at=wallet["created_at"],
        members=[MemberOut(**m) for m in members],
        expenses=expenses,
        settlements=settlements,
        balances=[BalanceOut(member_id=m, paid_centavos=paid[m], share_centavos=owed[m], net_centavos=net[m]) for m in order],
        transfers=[TransferOut(from_member=f, to_member=t, amount_centavos=a) for f, t, a in settle_up(net, order)],
        total_centavos=sum(e.amount_centavos for e in expenses),
        rev=wallet["rev"],  # TG-66: moved by wallet_activity.record() on every write
        budget=budget_lines(conn, wallet_id) if budget else None,  # TG-62
    )


def _private(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-cache"  # names and amounts are personal
    response.headers.update(NOINDEX)


def forget_proof(path: str | None, share_slug: str) -> None:
    """Deletes a proof whose row no longer points to it. A failure only strands bytes, so it's logged, with the path's
    file id so they can be found by hand, not raised."""
    if not path:
        return
    try:
        storage.store().delete([path])
    except storage.StorageError:
        logger.warning("wallet proof cleanup failed share_slug=%s file=%s", share_slug, path.rsplit("/", 1)[-1])


def _counts(w: WalletOut) -> str:
    proofs = sum(1 for s in w.settlements if s.has_proof)
    return f"members={len(w.members)} expenses={len(w.expenses)} settlements={len(w.settlements)} open={len(w.transfers)} proofs={proofs} rev={w.rev}"


# ---------------------------------------------------------------- TG-66: the new expense shape, edits and activity

def snapshot(e: ExpenseOut) -> dict:
    """An expense as an activity row's before/after: plain JSON, ExpenseOut's names, SNAPSHOT_FIELDS only."""
    return e.model_dump(mode="json", include=set(SNAPSHOT_FIELDS))


def _find(wallet: WalletOut, expense_id: UUID) -> ExpenseOut | None:
    return next((e for e in wallet.expenses if e.id == expense_id), None)


def _refuse(share_slug: str, what: str, status: int, code: str, detail=None) -> HTTPException:
    logger.info("wallet expense %s refused share_slug=%s reason=%s", what, share_slug, code)
    return HTTPException(status, code if detail is None else detail)


def _with_wallet(code: str, wallet: WalletOut) -> dict:
    """409 expense_changed and 404 expense_gone: the code and the wallet as it is now, so the phone shows the newer one."""
    return {"code": code, "wallet": wallet.model_dump(mode="json")}


def _v2_split(conn, wallet_id: UUID, body, share_slug: str, what: str):
    """(amount, shares, paid_by, payers or None) for a v2 body, or a 422 with ux.md §9's code."""
    order = [r["id"] for r in conn.execute("select id from wallet_members where wallet_id = %s order by seq", (wallet_id,))]
    inputs, items, charges = getattr(body, "inputs", None) or [], getattr(body, "items", None) or [], getattr(body, "charges", None) or []
    payers = {p.member_id: p.paid_centavos for p in body.payers} if body.payers is not None else None
    people = {i.member_id for i in inputs} | {m for it in items for m in it.who} | set(payers or ())
    people |= {m for m in (body.paid_by, body.by) if m is not None}
    if not people <= set(order):
        raise _refuse(share_slug, what, 422, "unknown_member")
    try:
        payer = wallet_splits.first_payer(body.paid_by, payers, order)
        amount, shares = wallet_splits.split(body.mode, body.amount_centavos, inputs, items, charges, payer, order)
        if payers is not None:
            wallet_splits.check_payers(amount, payers)
    except SplitError as e:
        detail = {"code": e.code, "seq": e.seq} if e.seq is not None else None
        raise _refuse(share_slug, what, 422, e.code, detail) from None
    return amount, shares, payer, payers


def _store_split(conn, expense_id: UUID, body, shares: dict[UUID, int], payers: dict[UUID, int] | None) -> None:
    """The expense's child rows: final shares, then the mode's own inputs, items and charges, and several payers."""
    for member_id, part in shares.items():
        conn.execute("insert into expense_shares (expense_id, member_id, share_centavos) values (%s, %s, %s)",
                     (expense_id, member_id, part))
    for i in getattr(body, "inputs", None) or []:
        conn.execute("insert into expense_inputs (expense_id, member_id, value) values (%s, %s, %s)",
                     (expense_id, i.member_id, i.value))
    for seq, item in enumerate(getattr(body, "items", None) or [], start=1):
        item_id = conn.execute(
            "insert into expense_items (expense_id, seq, name, price_centavos) values (%s, %s, %s, %s) returning id",
            (expense_id, seq, item.name, item.price_centavos),
        ).fetchone()["id"]
        for member_id in item.who:
            conn.execute("insert into expense_item_people (item_id, member_id) values (%s, %s)", (item_id, member_id))
    for c in getattr(body, "charges", None) or []:
        conn.execute("insert into expense_charges (expense_id, kind, basis, value) values (%s, %s, %s, %s)",
                     (expense_id, c.kind, c.basis, c.value))
    for member_id, part in (payers or {}).items():
        conn.execute("insert into expense_payers (expense_id, member_id, paid_centavos) values (%s, %s, %s)",
                     (expense_id, member_id, part))


def _money_and_words(e: ExpenseOut) -> tuple:
    """Amount, payer(s), final shares (a person at 0 is no person), note, category and budget line."""
    return (e.amount_centavos, e.paid_by, {p.member_id: p.paid_centavos for p in e.payers},
            {s.member_id: s.share_centavos for s in e.shares if s.share_centavos}, e.note, e.category,
            e.budget_key)  # TG-62 G8: a line change is a change


def _form(e: ExpenseOut) -> tuple:
    """The split as it was typed: mode, inputs, items (seq, name, price, who) and charges. _load lists them in wallet
    order, items by seq, and charges service then VAT."""
    return (e.mode, tuple((i.member_id, i.value) for i in e.inputs),
            tuple((i.seq, i.name, i.price_centavos, tuple(i.who)) for i in e.items),
            tuple((c.kind, c.basis, c.value) for c in e.charges))


def _form_of(body, order: list[UUID]) -> tuple:
    """_form() of a PATCH body, put in _load's order, so the same expense typed in another order compares equal."""
    rank = {m: i for i, m in enumerate(order)}
    inputs = sorted(((i.member_id, i.value) for i in getattr(body, "inputs", None) or []), key=lambda r: rank[r[0]])
    items = [(seq, it.name, it.price_centavos, tuple(sorted(it.who, key=rank.__getitem__)))
             for seq, it in enumerate(getattr(body, "items", None) or [], start=1)]
    charges = sorted(((c.kind, c.basis, c.value) for c in getattr(body, "charges", None) or []),
                     key=lambda c: CHARGE_ORDER[c[0]])
    return (body.mode, tuple(inputs), tuple(items), tuple(charges))


def _inferred_mode(e: ExpenseOut, order: list[UUID]) -> str:
    """A legacy expense's mode as the form reopens it (B22): equal when its shares are split_equal over its people in
    wallet order, else exact."""
    people = [s.member_id for s in e.shares]  # _load lists them in wallet order
    equal = split_equal(e.amount_centavos, people, e.paid_by) if people else {}
    return "equal" if {s.member_id: s.share_centavos for s in e.shares} == equal else "exact"


def _is_noop(old: ExpenseOut, new_money: tuple, body, order: list[UUID]) -> bool:
    """B12 (tg-review2's M1 on #91): an edit is a no-op only when the whole expense is the same apart from its version:
    money, words, and the split as typed (mode, inputs, item names, charges). One exception keeps a legacy expense
    (mode null) saved unchanged as its inferred mode a no-op, so it never writes "changed the split"."""
    if new_money != _money_and_words(old):
        return False
    if old.mode is None:
        return body.mode == _inferred_mode(old, order) and not getattr(body, "items", None)
    return _form_of(body, order) == _form(old)


def _line_categories(conn, wallet_id: UUID) -> dict[str, str] | None:
    """Each current line's category (a row with none is listed under other), or None without one trip's lines."""
    found = budget_lines(conn, wallet_id)
    return None if found is None else {line.key: line.category or "other" for line in found.lines}


def _sent_line(key: str | None, category: str | None, lines: dict | None, share_slug: str, what: str,
               stored: str | None = None) -> str | None:
    """A budget_key the body sends (G5, G6): a current line with its own category, "_none", or null. Without one trip's
    lines only null. On an edit, the stored key resent is always fine when it's no longer a line (Rev 1 M2)."""
    if key is None:
        return None
    if key == stored and (lines is None or (key != "_none" and key not in lines)):
        return key
    if lines is None or (key != "_none" and key not in lines):
        raise _refuse(share_slug, what, 422, "unknown_budget_line")
    if key != "_none" and lines[key] != category:
        raise _refuse(share_slug, what, 422, "budget_line_category")
    return key


def _kept_line(stored: str | None, category: str | None, lines: dict | None, old_category: str | None) -> str | None:
    """An edit that doesn't set the line (the field left out, or BUDGET_LINES off) keeps the stored one, unless the edit
    changed the category away from that current line's: then it's cleared, not refused, since an old phone can't fix
    that (G9c). "_none", a key that isn't a line any more, and an edit that keeps the category stay (review S1: a line
    the plan moved isn't cleared by a save that didn't move the expense, so G8's no-op holds)."""
    if stored in (None, "_none") or lines is None or stored not in lines or category == old_category:
        return stored
    return stored if lines[stored] == category else None


def _budget_word(key: str | None) -> str:
    """The log's word for a line: never the key, which is the group's own text (N2)."""
    return "null" if key is None else "none" if key == "_none" else "line"


# ---------------------------------------------------------------- routes

@router.post("/wallets", status_code=201, response_model=WalletOut)
def create_wallet(body: WalletIn, request: Request, response: Response) -> WalletOut:
    _limit(CREATE_LIMITER, request, "create")
    with db.get_conn() as conn:
        wallet_id = conn.execute("insert into wallets (name) values (%s) returning id", (body.name,)).fetchone()["id"]
        for name in body.members:
            conn.execute("insert into wallet_members (wallet_id, name) values (%s, %s)", (wallet_id, name))
        wallet = _load(conn, wallet_id, **load_opts(request.app.state.flags))
    _private(response)
    logger.info("wallet create share_slug=%s %s", wallet.share_slug, _counts(wallet))
    return wallet


@router.get("/wallets/{share_slug}", response_model=WalletOut, responses={404: {"description": NOT_FOUND}})
def get_wallet(share_slug: str, request: Request, response: Response) -> WalletOut:
    with db.get_conn() as conn:
        wallet = _load(conn, _wallet_id(conn, share_slug), **load_opts(request.app.state.flags))
    _private(response)
    logger.info("wallet get share_slug=%s %s", share_slug, _counts(wallet))
    return wallet


@router.post("/wallets/{share_slug}/members", status_code=201, response_model=WalletOut)
def add_member(share_slug: str, body: MemberIn, request: Request, response: Response,
               by: UUID | None = Query(None)) -> WalletOut:
    _limit(WRITE_LIMITER, request, "member")
    with db.get_conn() as conn:
        wallet_id = _wallet_id(conn, share_slug, lock=True)
        wallet_activity.check_by(conn, wallet_id, by, share_slug, "member")
        names = [r["name"].lower() for r in conn.execute("select name from wallet_members where wallet_id = %s", (wallet_id,))]
        if len(names) >= MAX_MEMBERS:
            logger.info("wallet member refused share_slug=%s reason=party_full", share_slug)
            raise HTTPException(409, "party_full")
        if body.name.lower() in names:
            logger.info("wallet member refused share_slug=%s reason=name_taken", share_slug)
            raise HTTPException(409, "name_taken")
        member_id = conn.execute(
            "insert into wallet_members (wallet_id, name) values (%s, %s) returning id", (wallet_id, body.name)
        ).fetchone()["id"]
        # TG-73 B6: a newcomer joins an open Ipon goal at its amount each. Only with WALLET_POT on, so this route never
        # touches the pot tables while it's off (nor before the TG-73 migration); the treasurer can put them in later.
        joined = request.app.state.flags.wallet_pot and conn.execute(
            """insert into pot_people (wallet_id, member_id) select wallet_id, %s from wallet_pots
               where wallet_id = %s and closed_at is null returning 1""", (member_id, wallet_id),
        ).fetchone()
        record(conn, wallet_id, "member_join", by=by, member_id=member_id)
        wallet = _load(conn, wallet_id, **load_opts(request.app.state.flags))
    _private(response)
    logger.info("wallet member add share_slug=%s pot=%s %s", share_slug, "joined" if joined else "none", _counts(wallet))
    return wallet


def _feature_off(share_slug: str, what: str) -> HTTPException:
    return _refuse(share_slug, what, 404, "feature_off")


@router.post("/wallets/{share_slug}/expenses", status_code=201, response_model=WalletOut)
def add_expense(share_slug: str, body: Union[ExpenseIn, ExpenseInV2], request: Request, response: Response) -> WalletOut:
    """The old body (no `mode`), as before, or TG-66's: a mode, one payer or several, a category and `by`.

    TG-70: a v2 body may carry the phone's own `id`. Its first step is the replay check (plan Rev 2 F1), before the
    limit and the flag checks: an id this wallet has seen answers 200 with the wallet as it is now and writes nothing,
    whatever changed since. Without `id`, today's order exactly: the limit, the flags, then the wallet."""
    flags = request.app.state.flags
    if isinstance(body, ExpenseIn) or body.id is None:
        _limit(WRITE_LIMITER, request, "expense")
        if isinstance(body, ExpenseIn):
            return _add_legacy(share_slug, body, response, load_opts(flags))
        _v2_allowed(share_slug, body, flags)
        with db.get_conn() as conn:
            wallet, logged = _add_v2(conn, _wallet_id(conn, share_slug, lock=True), body, flags, share_slug)
    else:
        with db.get_conn() as conn:
            wallet_id = _wallet_id(conn, share_slug, lock=True)  # resends of one id go one at a time (B5)
            found = _replay(conn, wallet_id, body.id, share_slug)
            if found is not None:
                wallet = _load(conn, wallet_id, **load_opts(flags))
                response.status_code = 200
                _private(response)
                logger.info("wallet expense add replay share_slug=%s found=%s rev=%d", share_slug, found, wallet.rev)
                return wallet
            _limit(WRITE_LIMITER, request, "expense")  # a refusal here rolls back and frees the lock
            _v2_allowed(share_slug, body, flags)
            wallet, logged = _add_v2(conn, wallet_id, body, flags, share_slug)
    _private(response)
    logger.info("wallet expense add share_slug=%s mode=%s payers=%d people=%d items=%d amount=%d category=%s budget=%s %s%s",
                share_slug, body.mode, *logged, _counts(wallet), " client_id=yes" if body.id is not None else "")
    return wallet


def _v2_allowed(share_slug: str, body, flags) -> None:
    """The v2 add's two flag checks: 404 feature_off for payers with WALLET_MULTI_PAYER off, or a non-free mode with
    WALLET_SPLITS off."""
    if body.payers is not None and not flags.wallet_multi_payer:
        raise _feature_off(share_slug, "add")
    if body.mode not in FREE_MODES and not flags.wallet_splits:
        raise _feature_off(share_slug, "add")


def _replay(conn, wallet_id: UUID, expense_id: UUID, share_slug: str) -> str | None:
    """TG-70: "live" if `expense_id` is this wallet's expense, "deleted" if this wallet's activity has its
    expense_add (the row stays after a delete: no FK, append-only), else None. Another wallet's expense is 409
    id_taken. With the wallet row locked, so a first send and its resend can't both miss."""
    row = conn.execute("select wallet_id from expenses where id = %s", (expense_id,)).fetchone()
    if row is not None:
        if row["wallet_id"] == wallet_id:
            return "live"
        raise _refuse(share_slug, "add", 409, "id_taken")
    seen = conn.execute(
        "select 1 from wallet_activity where wallet_id = %s and expense_id = %s and action = 'expense_add' limit 1",
        (wallet_id, expense_id),
    ).fetchone()
    return "deleted" if seen is not None else None


def _add_v2(conn, wallet_id: UUID, body, flags, share_slug: str) -> tuple[WalletOut, tuple]:
    """Today's v2 add, in the caller's locked transaction: the wallet after it, and the add line's counts (payers,
    people, items, amount, category, budget word). With `body.id`, the expense is stored under that id."""
    category = body.category if flags.wallet_splits else None  # dropped, not refused (plan §2's flag table)
    # TG-62 G9: the line is dropped, not refused, with BUDGET_LINES off, and with WALLET_SPLITS off (with the category)
    wanted = body.budget_key if flags.budget_lines and flags.wallet_splits else None
    amount, shares, paid_by, payers = _v2_split(conn, wallet_id, body, share_slug, "add")
    key = _sent_line(wanted, category, _line_categories(conn, wallet_id) if wanted else None, share_slug, "add")
    _wallet_has_room(conn, wallet_id, share_slug)
    try:
        expense_id = conn.execute(
            """insert into expenses (id, wallet_id, paid_by, amount_centavos, note, split_mode, category, budget_key)
               values (coalesce(%s::uuid, gen_random_uuid()), %s, %s, %s, %s, %s, %s, %s) returning id""",
            (body.id, wallet_id, paid_by, amount, body.note, body.mode, category, key),
        ).fetchone()["id"]
    except psycopg.errors.UniqueViolation as e:
        if e.diag.constraint_name != "expenses_pkey":  # N1: only the id itself; anything else is a bug, so a 500
            raise
        raise _refuse(share_slug, "add", 409, "id_taken") from None  # another wallet's insert won the race (B4)
    _store_split(conn, expense_id, body, shares, payers)
    wallet = _recorded(conn, wallet_id, "expense_add", body.by, expense_id, **load_opts(flags))
    return wallet, (len(payers or {}) or 1, len(shares), len(getattr(body, "items", None) or []), amount, category,
                    _budget_word(key))


def _wallet_has_room(conn, wallet_id: UUID, share_slug: str) -> None:
    count = conn.execute("select count(*) as n from expenses where wallet_id = %s", (wallet_id,)).fetchone()["n"]
    if count >= MAX_EXPENSES:
        logger.info("wallet expense refused share_slug=%s reason=wallet_full", share_slug)
        raise HTTPException(409, "wallet_full")


def _recorded(conn, wallet_id: UUID, action: str, by: UUID | None, expense_id: UUID, before: dict | None = None, *,
              budget: bool = False, pot: bool = False) -> WalletOut:
    """The wallet after an expense add or edit, with its activity row written: `after` is the expense as saved."""
    wallet = _load(conn, wallet_id, budget=budget, pot=pot)
    wallet.rev = record(conn, wallet_id, action, by=by, expense_id=expense_id, before=before,
                        after=snapshot(_find(wallet, expense_id)))
    return wallet


def _add_legacy(share_slug: str, body: ExpenseIn, response: Response, opts: dict) -> WalletOut:
    """Today's body, unchanged: stored with split_mode null (B9). It records expense_add, so rev still moves."""
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
        _wallet_has_room(conn, wallet_id, share_slug)
        expense_id = conn.execute(
            "insert into expenses (wallet_id, paid_by, amount_centavos, note) values (%s, %s, %s, %s) returning id",
            (wallet_id, body.paid_by, body.amount_centavos, body.note),
        ).fetchone()["id"]
        for member_id, part in shares.items():
            conn.execute(
                "insert into expense_shares (expense_id, member_id, share_centavos) values (%s, %s, %s)",
                (expense_id, member_id, part),
            )
        wallet = _recorded(conn, wallet_id, "expense_add", None, expense_id, **opts)
    _private(response)
    split = "equal" if body.split_among is not None else "custom"
    logger.info("wallet expense add share_slug=%s mode=legacy split=%s people=%d amount=%d budget=null %s", share_slug,
                split, len(shares), body.amount_centavos, _counts(wallet))
    return wallet


def splits_on(request: Request, share_slug: str) -> None:
    """WALLET_SPLITS off: every edit is 404 feature_off, before the body is judged (as A2's activity_on), so an old
    phone build's body gets ux.md §9's line, not a 422."""
    if not request.app.state.flags.wallet_splits:
        raise _feature_off(share_slug if SLUG.fullmatch(share_slug) else "<invalid>", "edit")


@router.patch("/wallets/{share_slug}/expenses/{expense_id}", response_model=WalletOut, dependencies=[Depends(splits_on)])
def edit_expense(share_slug: str, expense_id: UUID, body: ExpensePatch, request: Request, response: Response) -> WalletOut:
    """The whole new expense plus the version the form opened. Stale: 409 expense_changed; deleted: 404 expense_gone,
    both with the wallet as it is now. A change to neither money nor words is a no-op: no row, no rev (B12)."""
    _limit(WRITE_LIMITER, request, "expense_edit")
    flags = request.app.state.flags  # WALLET_SPLITS: splits_on, above
    if body.payers is not None and not flags.wallet_multi_payer:
        raise _feature_off(share_slug, "edit")
    with db.get_conn() as conn:
        wallet_id = _wallet_id(conn, share_slug, lock=True)
        current = _load(conn, wallet_id, **load_opts(flags))
        old = _find(current, expense_id)
        if old is None:
            raise _refuse(share_slug, "edit", 404, "expense_gone", _with_wallet("expense_gone", current))
        if old.payers and not flags.wallet_multi_payer:  # S4: a one-payer form would drop the stored payers
            raise _feature_off(share_slug, "edit")
        if body.version != old.version:
            raise _refuse(share_slug, "edit", 409, "expense_changed", _with_wallet("expense_changed", current))
        amount, shares, paid_by, payers = _v2_split(conn, wallet_id, body, share_slug, "edit")
        # TG-62: the line the body sets (G5, G6), or the stored one kept (Rev 1 M2: the field left out, or the flag off)
        lines = _line_categories(conn, wallet_id)
        if flags.budget_lines and "budget_key" in body.model_fields_set:
            key = _sent_line(body.budget_key, body.category, lines, share_slug, "edit", stored=old.budget_key)
        else:
            key = _kept_line(old.budget_key, body.category, lines, old.category)
        new = (amount, paid_by, payers or {}, {m: v for m, v in shares.items() if v}, body.note, body.category, key)
        if _is_noop(old, new, body, [m.id for m in current.members]):
            _private(response)
            logger.info("wallet expense edit noop share_slug=%s mode=%s %s", share_slug, body.mode, _counts(current))
            return current
        conn.execute(
            """update expenses set paid_by = %s, amount_centavos = %s, note = %s, split_mode = %s, category = %s,
                      budget_key = %s, version = version + 1, updated_at = now() where id = %s""",
            (paid_by, amount, body.note, body.mode, body.category, key, expense_id),
        )
        for table in ("expense_shares", "expense_inputs", "expense_items", "expense_charges", "expense_payers"):
            conn.execute(f"delete from {table} where expense_id = %s", (expense_id,))  # items' people cascade
        _store_split(conn, expense_id, body, shares, payers)
        wallet = _recorded(conn, wallet_id, "expense_edit", body.by, expense_id, before=snapshot(old),
                           **load_opts(flags))
    _private(response)
    logger.info("wallet expense edit share_slug=%s mode=%s version=%d amount_before=%d amount_after=%d people=%d "
                "budget=%s %s", share_slug, body.mode, old.version + 1, old.amount_centavos, amount, len(shares),
                _budget_word(key), _counts(wallet))
    return wallet


@router.delete("/wallets/{share_slug}/expenses/{expense_id}", response_model=WalletOut)
def delete_expense(share_slug: str, expense_id: UUID, request: Request, response: Response,
                   version: int | None = Query(None, ge=1), by: UUID | None = Query(None)) -> WalletOut:
    """Without `version`, today's answers. With it: stale is 409 expense_changed, gone is 404 expense_gone (B13)."""
    _limit(WRITE_LIMITER, request, "expense_delete")
    with db.get_conn() as conn:
        wallet_id = _wallet_id(conn, share_slug, lock=True)
        wallet_activity.check_by(conn, wallet_id, by, share_slug, "expense delete")
        current = _load(conn, wallet_id, **load_opts(request.app.state.flags))
        old = _find(current, expense_id)
        if old is None:
            if version is not None:
                raise _refuse(share_slug, "delete", 404, "expense_gone", _with_wallet("expense_gone", current))
            logger.info("wallet expense delete not found share_slug=%s", share_slug)
            raise HTTPException(404, "Expense not found")
        if version is not None and version != old.version:
            raise _refuse(share_slug, "delete", 409, "expense_changed", _with_wallet("expense_changed", current))
        conn.execute("delete from expenses where id = %s and wallet_id = %s", (expense_id, wallet_id))
        record(conn, wallet_id, "expense_delete", by=by, expense_id=expense_id, before=snapshot(old))
        wallet = _load(conn, wallet_id, **load_opts(request.app.state.flags))
    _private(response)
    logger.info("wallet expense delete share_slug=%s amount=%d %s", share_slug, old.amount_centavos, _counts(wallet))
    return wallet


def _payment(row) -> dict:
    """A settle/settle_undo row's `after`: ids and the amount, never names, so the line reads after an undo."""
    return {"from_member": str(row["from_member"]), "to_member": str(row["to_member"]), "amount_centavos": row["amount_centavos"]}


@router.post("/wallets/{share_slug}/settlements", status_code=201, response_model=WalletOut)
def add_settlement(share_slug: str, body: SettlementIn, request: Request, response: Response,
                   by: UUID | None = Query(None)) -> WalletOut:
    _limit(WRITE_LIMITER, request, "settlement")
    with db.get_conn() as conn:
        wallet_id = _wallet_id(conn, share_slug, lock=True)
        if not {body.from_member, body.to_member} <= _member_ids(conn, wallet_id):
            logger.info("wallet settlement refused share_slug=%s reason=unknown_member", share_slug)
            raise HTTPException(422, "unknown_member")
        wallet_activity.check_by(conn, wallet_id, by, share_slug, "settlement")
        row = conn.execute(
            """insert into settlements (wallet_id, from_member, to_member, amount_centavos) values (%s, %s, %s, %s)
               returning id, from_member, to_member, amount_centavos""",
            (wallet_id, body.from_member, body.to_member, body.amount_centavos),
        ).fetchone()
        record(conn, wallet_id, "settle", by=by, settlement_id=row["id"], after=_payment(row))
        wallet = _load(conn, wallet_id, **load_opts(request.app.state.flags))
    _private(response)
    logger.info("wallet settlement add share_slug=%s %s", share_slug, _counts(wallet))
    return wallet


@router.delete("/wallets/{share_slug}/settlements/{settlement_id}", response_model=WalletOut)
def delete_settlement(share_slug: str, settlement_id: UUID, request: Request, response: Response,
                      by: UUID | None = Query(None)) -> WalletOut:
    _limit(WRITE_LIMITER, request, "settlement_delete")
    with db.get_conn() as conn:
        wallet_id = _wallet_id(conn, share_slug, lock=True)
        wallet_activity.check_by(conn, wallet_id, by, share_slug, "settlement delete")
        gone = conn.execute(
            """delete from settlements where id = %s and wallet_id = %s
               returning id, proof_path, from_member, to_member, amount_centavos""", (settlement_id, wallet_id)
        ).fetchone()
        if gone is None:
            logger.info("wallet settlement delete not found share_slug=%s", share_slug)
            raise HTTPException(404, "Payment not found")
        record(conn, wallet_id, "settle_undo", by=by, settlement_id=gone["id"], after=_payment(gone))
        wallet = _load(conn, wallet_id, **load_opts(request.app.state.flags))
    forget_proof(gone["proof_path"], share_slug)
    _private(response)
    logger.info("wallet settlement delete share_slug=%s proof=%d %s", share_slug, 1 if gone["proof_path"] else 0, _counts(wallet))
    return wallet


__all__ = [  # the moved names are part of this module's surface (wallet_proofs.py, sessions.py, the tests)
    "MAX_CENTAVOS", "MAX_MEMBERS", "BalanceOut", "Centavos", "ExpenseIn", "ExpenseInLegacy", "ExpenseOut", "MemberIn", "MemberName", "MemberOut", "Note", "SettlementIn", "SettlementOut", "ShareIn", "ShareOut", "TransferOut", "WalletIn", "WalletName", "WalletOut",
]
