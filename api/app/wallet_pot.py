"""The Ipon goal → trip pot (TG-73 A1): the goal, who's in it, and each ambag. Behind WALLET_POT.

The app records money and never moves it: an ambag is "I sent ₱X" (pending) until the treasurer taps Received, and only
received money fills the pot. Whoever starts the goal is its treasurer. Every write locks the wallet row, checks `by`
(the phone's pick, required here: 422 by_required), writes, and calls wallet_activity.record() in the same transaction,
so the activity list and the wallet's rev move together. Each answers the whole wallet, as every wallet write does.

The pot stays out of the nets while it's open (plan §4): an ambag is not an expense, and nothing here touches
expenses, shares or settlements. load_pot() is WalletOut.pot, built by wallets._load with the flag on.

WALLET_POT off: every route is 404 feature_off before its body is judged (as TG-66's activity_on), and _load leaves the
`pot` key out of the answer, so today's wallets read byte for byte as before. The rows stay either way.

Logs carry the slug, counts, centavo totals and the rev (plan §7): never a name, a goal name, a member id or `by`.
"""

import logging
from datetime import date
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response

from . import pot_math
from .limits import manila_today
from .pot_models import (
    AmbagIn,
    AmbagOut,
    AmbagPatch,
    CloseOutOut,
    PotAmount,
    PotIn,
    PotOut,
    PotPatch,
    PotPersonIn,
    PotPersonOut,
    PotTrip,
)

logger = logging.getLogger("tara_gala.api")

MAX_AMBAG = 500  # rows per goal, like a wallet's 500 expenses: keeps every pot sum far inside an int and a JS number


# ---------------------------------------------------------------- the read: WalletOut.pot

def wallet_trip(conn, wallet_id: UUID) -> PotTrip | None:
    """The wallet's one trip (as budget_lines: exactly one trip has this wallet), or None."""
    trips = conn.execute(
        "select name, start_date, return_date from trip_sessions where wallet_id = %s limit 2", (wallet_id,)
    ).fetchall()
    return PotTrip(**trips[0]) if len(trips) == 1 else None


def _rows(conn, wallet_id: UUID):
    pot = conn.execute(
        "select name, each_centavos, due_date, treasurer, version, closed_at from wallet_pots where wallet_id = %s",
        (wallet_id,),
    ).fetchone()
    if pot is None:
        return None
    people = conn.execute(
        """select p.member_id, p.target_centavos, p.in_goal from pot_people p join wallet_members m on m.id = p.member_id
           where p.wallet_id = %s order by m.seq""",
        (wallet_id,),
    ).fetchall()
    ambag = conn.execute(
        """select id, member_id, kind, amount_centavos, status, created_at as sent_at, received_at,
                  proof_path is not null as has_proof, proof_at
           from pot_ambag where wallet_id = %s order by created_at desc, id desc""",
        (wallet_id,),
    ).fetchall()
    spends = [r["amount_centavos"] for r in conn.execute(
        "select amount_centavos from expenses where wallet_id = %s and split_mode = 'pot'", (wallet_id,))]
    return pot, people, ambag, spends


def numbers(people, ambag, spends, each: int, order: list[UUID]) -> pot_math.PotNumbers:
    return pot_math.pot_numbers(
        [{"member_id": p["member_id"], "in_goal": p["in_goal"], "target": p["target_centavos"]} for p in people],
        [{"member_id": a["member_id"], "kind": a["kind"], "amount": a["amount_centavos"], "status": a["status"]} for a in ambag],
        spends, each, order,
    )


def load_pot(conn, wallet_id: UUID, wallet_name: str, order: list[UUID]) -> PotOut | None:
    """The goal as the phone shows it, or None with no goal. `order` is the wallet's member order."""
    found = _rows(conn, wallet_id)
    if found is None:
        return None
    pot, people, ambag, spends = found
    n = numbers(people, ambag, spends, pot["each_centavos"], order)
    sent: dict[UUID, int] = {}
    for a in ambag:
        if a["status"] == "sent":
            sent[a["member_id"]] = sent.get(a["member_id"], 0) + a["amount_centavos"]
    try:
        out = pot_math.close_out(n, pot["treasurer"], order)
        close = CloseOutOut(refunds=[PotAmount(member_id=m, amount_centavos=v) for m, v in out.refunds.items()],
                            shortfall=[PotAmount(member_id=m, amount_centavos=v) for m, v in out.shortfall.items()])
    except pot_math.PotError:  # short, with nobody left in the goal: the close is refused, so there's no preview
        close = None
    trip = wallet_trip(conn, wallet_id)
    return PotOut(
        name=pot["name"] or (trip.name if trip else wallet_name),
        each_centavos=pot["each_centavos"], due_date=pot["due_date"], treasurer=pot["treasurer"], version=pot["version"],
        closed_at=pot["closed_at"], trip=trip,
        people=[PotPersonOut(member_id=p["member_id"], target_centavos=pot["each_centavos"] if p["target_centavos"] is None else p["target_centavos"],
                             custom=p["target_centavos"] is not None, in_goal=p["in_goal"],
                             received_centavos=n.contributed.get(p["member_id"], 0), sent_centavos=sent.get(p["member_id"], 0))
                for p in people],
        ambag=[AmbagOut(**a) for a in ambag],
        received_centavos=n.received, spent_centavos=n.spent, balance_centavos=n.balance,
        target_centavos=sum(n.targets.values()), pending_centavos=n.pending_centavos, pending_count=n.pending_count,
        close_out=close,
    )


# ---------------------------------------------------------------- the routes
#
# Imported here, below load_pot(): wallets.py calls wallet_pot.load_pot at call time, so either module can load first
# (wallet_activity.py's pattern). The tests' wallets.* monkeypatches (the rate limiters) reach these routes too.
from . import db, wallets  # noqa: E402
from . import wallet_activity  # noqa: E402  (its names read at call time: it may still be loading)
from .wallet_models import WalletOut  # noqa: E402

router = APIRouter(tags=["wallets"])


def _logged(share_slug: str) -> str:
    return share_slug if wallets.SLUG.fullmatch(share_slug) else "<invalid>"


def pot_on(request: Request, share_slug: str) -> None:
    """WALLET_POT off: 404 feature_off, before the body is judged."""
    if not request.app.state.flags.wallet_pot:
        logger.info("wallet pot refused share_slug=%s action=any reason=feature_off", _logged(share_slug))
        raise HTTPException(404, "feature_off")


def _refuse(share_slug: str, action: str, status: int, code: str, detail=None) -> HTTPException:
    logger.info("wallet pot refused share_slug=%s action=%s reason=%s", share_slug, action, code)
    return HTTPException(status, code if detail is None else detail)


def _answer(conn, wallet_id: UUID, request: Request):
    return wallets._load(conn, wallet_id, **wallets.load_opts(request.app.state.flags))


def _with_wallet(code: str, conn, wallet_id: UUID, request: Request) -> dict:
    """409 pot_changed and 404 ambag_gone: the code and the wallet as it is now, as TG-66's expense_changed."""
    return {"code": code, "wallet": _answer(conn, wallet_id, request).model_dump(mode="json")}


def _by(conn, wallet_id: UUID, by: UUID | None, share_slug: str, action: str) -> UUID:
    if by is None:
        raise _refuse(share_slug, action, 422, "by_required")
    wallet_activity.check_by(conn, wallet_id, by, share_slug, f"pot {action}")  # 422 unknown_member
    return by


def _pot(conn, wallet_id: UUID, share_slug: str, action: str) -> dict:
    pot = conn.execute(
        "select each_centavos, due_date, name, treasurer, version, closed_at from wallet_pots where wallet_id = %s",
        (wallet_id,),
    ).fetchone()
    if pot is None:
        raise _refuse(share_slug, action, 404, "no_pot")
    return pot


def _treasurer(pot: dict, by: UUID, share_slug: str, action: str) -> None:
    if by != pot["treasurer"]:
        raise _refuse(share_slug, action, 403, "not_treasurer")


def _fresh(pot: dict, version: int, conn, wallet_id: UUID, request: Request, share_slug: str, action: str) -> None:
    if version != pot["version"]:
        raise _refuse(share_slug, action, 409, "pot_changed", _with_wallet("pot_changed", conn, wallet_id, request))


def _open(pot: dict, share_slug: str, action: str) -> None:
    if pot["closed_at"] is not None:
        raise _refuse(share_slug, action, 409, "pot_closed")


def _due_ok(due: date, trip: PotTrip | None, share_slug: str, action: str) -> None:
    """B2: on a trip's wallet, on or before the trip's start; and never before Manila today."""
    if due < manila_today():
        raise _refuse(share_slug, action, 422, "due_past")
    if trip is not None and due > trip.start_date:
        raise _refuse(share_slug, action, 422, "due_after_trip")


def _bump(conn, wallet_id: UUID) -> None:
    conn.execute("update wallet_pots set version = version + 1 where wallet_id = %s", (wallet_id,))


def _order(conn, wallet_id: UUID) -> list[UUID]:
    return [r["id"] for r in conn.execute("select id from wallet_members where wallet_id = %s order by seq", (wallet_id,))]


def _contributed(conn, wallet_id: UUID, pot: dict) -> pot_math.PotNumbers:
    _, people, ambag, spends = _rows(conn, wallet_id)
    return numbers(people, ambag, spends, pot["each_centavos"], _order(conn, wallet_id))


def _ambag_after(row: dict) -> dict:
    """An ambag line's `after`: ids and centavos only, never a name (plan §2.3)."""
    return {"ambag_id": str(row["id"]), "member_id": str(row["member_id"]), "amount_centavos": row["amount_centavos"]}


def _done(response: Response) -> None:
    wallets._private(response)


@router.post("/wallets/{share_slug}/pot", status_code=201, response_model=WalletOut, dependencies=[Depends(pot_on)])
def start_pot(share_slug: str, body: PotIn, request: Request, response: Response):
    """B1: start the goal. Whoever sends it is the treasurer; everyone in `people` is in it at `each_centavos`."""
    wallets._limit(wallets.WRITE_LIMITER, request, "pot")
    with db.get_conn() as conn:
        wallet_id = wallets._wallet_id(conn, share_slug, lock=True)
        by = _by(conn, wallet_id, body.by, share_slug, "on")
        if conn.execute("select 1 from wallet_pots where wallet_id = %s", (wallet_id,)).fetchone() is not None:
            raise _refuse(share_slug, "on", 409, "pot_exists")
        if not set(body.people) <= wallets._member_ids(conn, wallet_id):
            raise _refuse(share_slug, "on", 422, "unknown_member")
        trip = wallet_trip(conn, wallet_id)
        _due_ok(body.due_date, trip, share_slug, "on")
        name = None if trip is not None else body.name  # a trip's goal takes the trip's name (ux §2.2: no-trip only)
        conn.execute(
            "insert into wallet_pots (wallet_id, name, each_centavos, due_date, treasurer) values (%s, %s, %s, %s, %s)",
            (wallet_id, name, body.each_centavos, body.due_date, by),
        )
        for m in body.people:
            conn.execute("insert into pot_people (wallet_id, member_id) values (%s, %s)", (wallet_id, m))
        wallet_activity.record(conn, wallet_id, "pot_on", by=by, after={"each_centavos": body.each_centavos,
                                                        "due_date": body.due_date.isoformat(), "people": len(body.people)})
        wallet = _answer(conn, wallet_id, request)
    _done(response)
    logger.info("wallet pot on share_slug=%s each=%d people=%d due_in_days=%d trip=%s rev=%d", share_slug,
                body.each_centavos, len(body.people), (body.due_date - manila_today()).days,
                "yes" if trip else "no", wallet.rev)
    return wallet


@router.patch("/wallets/{share_slug}/pot", response_model=WalletOut, dependencies=[Depends(pot_on)])
def edit_pot(share_slug: str, body: PotPatch, request: Request, response: Response):
    """The treasurer changes the amount each, the due date or the name, with the version the form opened (B3, B4).
    Each changed field is its own activity line. Nothing changed is a no-op: no row, no rev."""
    wallets._limit(wallets.WRITE_LIMITER, request, "pot_edit")
    sent = body.model_fields_set
    with db.get_conn() as conn:
        wallet_id = wallets._wallet_id(conn, share_slug, lock=True)
        by = _by(conn, wallet_id, body.by, share_slug, "edit")
        pot = _pot(conn, wallet_id, share_slug, "edit")
        _treasurer(pot, by, share_slug, "edit")
        _fresh(pot, body.version, conn, wallet_id, request, share_slug, "edit")
        _open(pot, share_slug, "edit")
        changes = []
        trip = wallet_trip(conn, wallet_id)
        if "each_centavos" in sent and body.each_centavos is not None and body.each_centavos != pot["each_centavos"]:
            changes.append(("each", "each_centavos", body.each_centavos, {"field": "each_centavos",
                            "before": pot["each_centavos"], "after": body.each_centavos}))
        if "due_date" in sent and body.due_date is not None and body.due_date != pot["due_date"]:
            _due_ok(body.due_date, trip, share_slug, "edit")
            changes.append(("due", "due_date", body.due_date, {"field": "due_date", "before": pot["due_date"].isoformat(),
                                                                "after": body.due_date.isoformat()}))
        if "name" in sent and trip is None and body.name != pot["name"]:  # a trip's goal keeps the trip's name
            changes.append(("name", "name", body.name, {"field": "name"}))  # never the text: it's the group's own words
        if not changes:
            wallet = _answer(conn, wallet_id, request)
            _done(response)
            logger.info("wallet pot edit noop share_slug=%s version=%d rev=%d", share_slug, pot["version"], wallet.rev)
            return wallet
        for _, column, value, _ in changes:
            conn.execute(f"update wallet_pots set {column} = %s where wallet_id = %s", (value, wallet_id))  # noqa: S608 (fixed names)
        _bump(conn, wallet_id)
        for *_, after in changes:
            wallet_activity.record(conn, wallet_id, "pot_edit", by=by, after=after)
        wallet = _answer(conn, wallet_id, request)
    _done(response)
    logger.info("wallet pot edit share_slug=%s fields=%s version=%d rev=%d", share_slug, ",".join(c[0] for c in changes),
                pot["version"] + 1, wallet.rev)
    return wallet


@router.delete("/wallets/{share_slug}/pot", response_model=WalletOut, dependencies=[Depends(pot_on)])
def delete_pot(share_slug: str, request: Request, response: Response, version: int = Query(..., ge=1),
               by: UUID | None = Query(None)):
    """B5: only while it has no ambag and no pot spend (409 pot_in_use: close it instead)."""
    wallets._limit(wallets.WRITE_LIMITER, request, "pot_off")
    with db.get_conn() as conn:
        wallet_id = wallets._wallet_id(conn, share_slug, lock=True)
        by = _by(conn, wallet_id, by, share_slug, "off")
        pot = _pot(conn, wallet_id, share_slug, "off")
        _treasurer(pot, by, share_slug, "off")
        _fresh(pot, version, conn, wallet_id, request, share_slug, "off")
        used = conn.execute(
            """select exists (select 1 from pot_ambag where wallet_id = %s)
                      or exists (select 1 from expenses where wallet_id = %s and split_mode = 'pot') as used""",
            (wallet_id, wallet_id),
        ).fetchone()["used"]
        if used:
            raise _refuse(share_slug, "off", 409, "pot_in_use")
        conn.execute("delete from wallet_pots where wallet_id = %s", (wallet_id,))  # its people go with it
        wallet_activity.record(conn, wallet_id, "pot_off", by=by)
        wallet = _answer(conn, wallet_id, request)
    _done(response)
    logger.info("wallet pot off share_slug=%s rev=%d", share_slug, wallet.rev)
    return wallet


@router.put("/wallets/{share_slug}/pot/people/{member_id}", response_model=WalletOut, dependencies=[Depends(pot_on)])
def set_person(share_slug: str, member_id: UUID, body: PotPersonIn, request: Request, response: Response):
    """The treasurer changes one person's own amount (null: back to each), takes them out of the goal, or puts them
    back (B22). Taking out with give_back records a give-back of their whole part (`ambag_back`). A person who was never
    in the goal can only be put in."""
    wallets._limit(wallets.WRITE_LIMITER, request, "pot_person")
    sent = body.model_fields_set
    with db.get_conn() as conn:
        wallet_id = wallets._wallet_id(conn, share_slug, lock=True)
        by = _by(conn, wallet_id, body.by, share_slug, "person")
        pot = _pot(conn, wallet_id, share_slug, "person")
        _treasurer(pot, by, share_slug, "person")
        _fresh(pot, body.version, conn, wallet_id, request, share_slug, "person")
        _open(pot, share_slug, "person")
        if member_id not in wallets._member_ids(conn, wallet_id):
            raise _refuse(share_slug, "person", 422, "unknown_member")
        row = conn.execute("select target_centavos, in_goal from pot_people where wallet_id = %s and member_id = %s",
                           (wallet_id, member_id)).fetchone()
        if row is None:
            if body.in_goal is not True:
                raise _refuse(share_slug, "person", 422, "not_in_goal")
            conn.execute("insert into pot_people (wallet_id, member_id, in_goal) values (%s, %s, false)", (wallet_id, member_id))
            row = {"target_centavos": None, "in_goal": False}
        lines, words, back = [], [], None
        each = pot["each_centavos"]
        if "target_centavos" in sent and body.target_centavos != row["target_centavos"]:
            conn.execute("update pot_people set target_centavos = %s where wallet_id = %s and member_id = %s",
                         (body.target_centavos, wallet_id, member_id))
            before = each if row["target_centavos"] is None else row["target_centavos"]
            after = each if body.target_centavos is None else body.target_centavos
            lines.append(("pot_person", {"field": "target_centavos", "before": before, "after": after,
                                         "custom": body.target_centavos is not None}))
            words.append("amount")
        if body.in_goal is not None and body.in_goal != row["in_goal"]:
            conn.execute("update pot_people set in_goal = %s where wallet_id = %s and member_id = %s",
                         (body.in_goal, wallet_id, member_id))
            if body.in_goal is False and body.give_back:
                part = _contributed(conn, wallet_id, pot).contributed.get(member_id, 0)
                if part > 0:
                    back = conn.execute(
                        """insert into pot_ambag (wallet_id, member_id, kind, amount_centavos, status, received_at)
                           values (%s, %s, 'back', %s, 'received', now()) returning id, member_id, amount_centavos""",
                        (wallet_id, member_id, part),
                    ).fetchone()
            lines.append(("pot_person", {"field": "in_goal", "before": row["in_goal"], "after": body.in_goal}))
            words.append("in" if body.in_goal else "out")
        if not lines:
            wallet = _answer(conn, wallet_id, request)
            _done(response)
            logger.info("wallet pot person noop share_slug=%s rev=%d", share_slug, wallet.rev)
            return wallet
        _bump(conn, wallet_id)
        for action, after in lines:
            wallet_activity.record(conn, wallet_id, action, by=by, member_id=member_id, after=after)
        if back is not None:
            wallet_activity.record(conn, wallet_id, "ambag_back", by=by, member_id=member_id, after=_ambag_after(back))
        wallet = _answer(conn, wallet_id, request)
    _done(response)
    logger.info("wallet pot person share_slug=%s change=%s give_back=%d rev=%d", share_slug, ",".join(words),
                1 if back is not None else 0, wallet.rev)
    if back is not None:
        logger.info("wallet ambag back share_slug=%s amount=%d rev=%d", share_slug, back["amount_centavos"], wallet.rev)
    return wallet


def _ambag_replay(conn, wallet_id: UUID, ambag_id: UUID, share_slug: str) -> str | None:
    """TG-70's replay for an ambag: "live" if `ambag_id` is this wallet's, "deleted" if this wallet's activity has its
    send (the line stays after an undo), else None. Another wallet's id is 409 id_taken. With the wallet row locked."""
    row = conn.execute("select wallet_id from pot_ambag where id = %s", (ambag_id,)).fetchone()
    if row is not None:
        if row["wallet_id"] == wallet_id:
            return "live"
        raise _refuse(share_slug, "ambag", 409, "id_taken")
    seen = conn.execute(
        """select 1 from wallet_activity where wallet_id = %s and action in ('ambag_sent', 'ambag_received')
           and after ->> 'ambag_id' = %s limit 1""",
        (wallet_id, str(ambag_id)),
    ).fetchone()
    return "deleted" if seen is not None else None


@router.post("/wallets/{share_slug}/pot/ambag", status_code=201, response_model=WalletOut, dependencies=[Depends(pot_on)])
def send_ambag(share_slug: str, body: AmbagIn, request: Request, response: Response):
    """B7, B9, B12: "I sent ₱X" from the member is pending (sent); one the treasurer records, their own or cash in hand,
    is received at once. Anyone else recording someone's ambag is 403 not_treasurer. A resend of an `id` this wallet has
    seen answers 200 and writes nothing."""
    with db.get_conn() as conn:
        wallet_id = wallets._wallet_id(conn, share_slug, lock=True)
        if body.id is not None:
            found = _ambag_replay(conn, wallet_id, body.id, share_slug)
            if found is not None:
                wallet = _answer(conn, wallet_id, request)
                response.status_code = 200
                _done(response)
                logger.info("wallet ambag sent replay share_slug=%s found=%s rev=%d", share_slug, found, wallet.rev)
                return wallet
        wallets._limit(wallets.WRITE_LIMITER, request, "ambag")  # a refusal here rolls back and frees the lock
        by = _by(conn, wallet_id, body.by, share_slug, "ambag")
        pot = _pot(conn, wallet_id, share_slug, "ambag")
        _open(pot, share_slug, "ambag")
        if body.member_id not in wallets._member_ids(conn, wallet_id):
            raise _refuse(share_slug, "ambag", 422, "unknown_member")
        in_goal = conn.execute("select in_goal from pot_people where wallet_id = %s and member_id = %s",
                               (wallet_id, body.member_id)).fetchone()
        if in_goal is None or not in_goal["in_goal"]:
            raise _refuse(share_slug, "ambag", 422, "not_in_goal")
        treasurer = by == pot["treasurer"]
        if not treasurer and by != body.member_id:
            raise _refuse(share_slug, "ambag", 403, "not_treasurer")
        if conn.execute("select count(*) as n from pot_ambag where wallet_id = %s", (wallet_id,)).fetchone()["n"] >= MAX_AMBAG:
            raise _refuse(share_slug, "ambag", 409, "pot_full")
        status = "received" if treasurer else "sent"
        row = conn.execute(
            """insert into pot_ambag (id, wallet_id, member_id, amount_centavos, status, received_at)
               values (coalesce(%s::uuid, gen_random_uuid()), %s, %s, %s, %s, case when %s then now() end)
               returning id, member_id, amount_centavos""",
            (body.id, wallet_id, body.member_id, body.amount_centavos, status, treasurer),
        ).fetchone()
        wallet_activity.record(conn, wallet_id, "ambag_received" if treasurer else "ambag_sent", by=by, member_id=body.member_id,
               after=_ambag_after(row))
        wallet = _answer(conn, wallet_id, request)
    _done(response)
    pot_out = wallet.pot
    if treasurer:
        logger.info("wallet ambag received share_slug=%s amount=%d pending=%d received=%d direct=1 rev=%d", share_slug,
                    body.amount_centavos, pot_out.pending_count, pot_out.received_centavos, wallet.rev)
    else:
        logger.info("wallet ambag sent share_slug=%s amount=%d proof=0 replay=0 rev=%d", share_slug, body.amount_centavos,
                    wallet.rev)
    return wallet


def _ambag_row(conn, wallet_id: UUID, ambag_id: UUID, request: Request, share_slug: str, action: str) -> dict:
    row = conn.execute(
        "select id, member_id, kind, amount_centavos, status, proof_path from pot_ambag where id = %s and wallet_id = %s",
        (ambag_id, wallet_id),
    ).fetchone()
    if row is None:
        raise _refuse(share_slug, action, 404, "ambag_gone", _with_wallet("ambag_gone", conn, wallet_id, request))
    return row


@router.patch("/wallets/{share_slug}/pot/ambag/{ambag_id}", response_model=WalletOut, dependencies=[Depends(pot_on)])
def mark_ambag(share_slug: str, ambag_id: UUID, body: AmbagPatch, request: Request, response: Response):
    """B8: the treasurer marks a sent ambag Received, or undoes that (back to sent). The same status again is a no-op.
    A give-back can't be changed (409 ambag_received). Undoing a Received that a give-back already returned would leave
    that person below zero, so it's refused (409 ambag_given_back)."""
    wallets._limit(wallets.WRITE_LIMITER, request, "ambag_mark")
    with db.get_conn() as conn:
        wallet_id = wallets._wallet_id(conn, share_slug, lock=True)
        by = _by(conn, wallet_id, body.by, share_slug, "mark")
        pot = _pot(conn, wallet_id, share_slug, "mark")
        _treasurer(pot, by, share_slug, "mark")
        row = _ambag_row(conn, wallet_id, ambag_id, request, share_slug, "mark")
        _open(pot, share_slug, "mark")
        if row["kind"] == "back":
            raise _refuse(share_slug, "mark", 409, "ambag_received")
        if row["status"] == body.status:
            wallet = _answer(conn, wallet_id, request)
            _done(response)
            logger.info("wallet ambag mark noop share_slug=%s status=%s rev=%d", share_slug, body.status, wallet.rev)
            return wallet
        if body.status == "sent":
            part = _contributed(conn, wallet_id, pot).contributed.get(row["member_id"], 0)
            if part - row["amount_centavos"] < 0:
                raise _refuse(share_slug, "mark", 409, "ambag_given_back")
        conn.execute(
            "update pot_ambag set status = %s, received_at = case when %s = 'received' then now() end where id = %s",
            (body.status, body.status, ambag_id),
        )
        wallet_activity.record(conn, wallet_id, "ambag_received" if body.status == "received" else "ambag_unreceive", by=by,
               member_id=row["member_id"], after=_ambag_after(row))
        wallet = _answer(conn, wallet_id, request)
    _done(response)
    if body.status == "received":
        logger.info("wallet ambag received share_slug=%s amount=%d pending=%d received=%d rev=%d", share_slug,
                    row["amount_centavos"], wallet.pot.pending_count, wallet.pot.received_centavos, wallet.rev)
    else:
        logger.info("wallet ambag unreceive share_slug=%s amount=%d rev=%d", share_slug, row["amount_centavos"], wallet.rev)
    return wallet


@router.delete("/wallets/{share_slug}/pot/ambag/{ambag_id}", response_model=WalletOut, dependencies=[Depends(pot_on)])
def undo_ambag(share_slug: str, ambag_id: UUID, request: Request, response: Response, by: UUID | None = Query(None)):
    """B10: the sender or the treasurer takes back a pending send. A received one can't be withdrawn, only
    un-received (409 ambag_received); anyone else is 403 not_treasurer. Works on a closed pot too: a send that was
    never received isn't in the close-out."""
    wallets._limit(wallets.WRITE_LIMITER, request, "ambag_undo")
    with db.get_conn() as conn:
        wallet_id = wallets._wallet_id(conn, share_slug, lock=True)
        by = _by(conn, wallet_id, by, share_slug, "undo")
        pot = _pot(conn, wallet_id, share_slug, "undo")
        row = _ambag_row(conn, wallet_id, ambag_id, request, share_slug, "undo")
        if by != pot["treasurer"] and by != row["member_id"]:
            raise _refuse(share_slug, "undo", 403, "not_treasurer")
        if row["status"] != "sent":
            raise _refuse(share_slug, "undo", 409, "ambag_received")
        conn.execute("delete from pot_ambag where id = %s", (ambag_id,))
        wallet_activity.record(conn, wallet_id, "ambag_undo", by=by, member_id=row["member_id"], after=_ambag_after(row))
        wallet = _answer(conn, wallet_id, request)
    wallets.forget_proof(row["proof_path"], share_slug)  # A3's ambag proof, if it had one: bytes after the row
    _done(response)
    logger.info("wallet ambag undo share_slug=%s amount=%d proof=%d rev=%d", share_slug, row["amount_centavos"],
                1 if row["proof_path"] else 0, wallet.rev)
    return wallet
