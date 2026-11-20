"""TG-62 GA2: the trip page's Budget panel, `GET /sessions/{slug}/budget` (plan §2 SessionBudgetOut, §3 G11 to G16).

- **The lines** are the trip's own plan's keyed budget rows, in plan order: the guide that trip_marks reads (the trip's
  linked itinerary, TG-61's copy once edited). A row without a key isn't a line yet.
- **What each line spent** is the sum of the trip's wallet's expenses on that key. `_none` is "Not in the budget". Null,
  and a key no current row has (its row was removed), are "Not sorted yet" (`removed` counts the second kind).
- **`state`:** `no_wallet`; `two_trips` when the wallet is on another trip too (GA1's one-trip rule: the lines would be
  ambiguous); `no_budget` without a readable guide with keyed rows; else `ok`. Every state but `no_wallet` carries the
  wallet's `member_count` and `total_centavos` (the Shared expenses card line).
- **Behind BUDGET_LINES:** 404 `feature_off` while it's off, before the slug is looked at. A bad or unknown slug is
  TG-58's 404.
- **Logs:** the trip's slug, the state and counts. Never a name, note, line text or key (the group's own words, N2), a
  member id or an amount.
"""

import logging
import re
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request, Response

from . import db
from .budget_models import BudgetLineSpend, MemberSpend, NotInBudget, SessionBudgetOut, Unsorted
from .sessions import NOINDEX, NOT_FOUND, SLUG, _private, _session_id
from .trip_marks import _guide

router = APIRouter(tags=["session budget"])
logger = logging.getLogger("tara_gala.api")

NONE = "_none"
_AMOUNT = r"₱?\s*(\d{1,3}(?:,\d{3})+|\d+)"
_ESTIMATE = re.compile(rf"^\s*{_AMOUNT}(?:\s*(?:to|-|–|—)\s*{_AMOUNT})?\s*$", re.IGNORECASE)


def parse_estimate(text: str) -> tuple[int, int] | None:
    """G11: an estimate as whole pesos (min, max): one amount, or two joined by "to", "-", "–" or "—", each with an
    optional ₱ and thousands commas, with min <= max. Anything else is None, so the panel shows the text with no word."""
    m = _ESTIMATE.fullmatch(text)
    if m is None:
        return None
    low = int(m.group(1).replace(",", ""))
    high = int(m.group(2).replace(",", "")) if m.group(2) else low
    return (low, high) if low <= high else None


def _each(spent: int, members: int) -> int:
    """spent / members in centavos, half rounding up (plan §2). No members: 0."""
    return (spent + members // 2) // members if members else 0


def _lines(conn, session_id: UUID) -> list | None:
    """The trip's keyed budget rows in plan order, or None without a readable guide with one."""
    g = _guide(conn, session_id)
    rows = [r for r in g.budget.rows if r.key is not None] if g is not None else []
    return rows or None


@router.get("/sessions/{share_slug}/budget", response_model=SessionBudgetOut, responses={404: {"description": NOT_FOUND}})
def get_session_budget(share_slug: str, request: Request, response: Response) -> SessionBudgetOut:
    if not request.app.state.flags.budget_lines:
        logger.info("session budget refused share_slug=%s reason=feature_off",
                    share_slug if SLUG.fullmatch(share_slug) else "<invalid>")
        raise HTTPException(404, "feature_off", headers=NOINDEX)
    with db.get_conn() as conn:
        session_id = _session_id(conn, share_slug)
        out = _budget(conn, session_id)
    _private(response)
    ok = out.state == "ok"
    logger.info("session budget share_slug=%s state=%s lines=%d unreadable=%d unsorted=%d", share_slug, out.state,
                len(out.lines), sum(1 for x in out.lines if not x.readable), out.unsorted.count if ok else 0)
    return out


def _budget(conn, session_id: UUID) -> SessionBudgetOut:
    wallet_id = conn.execute("select wallet_id from trip_sessions where id = %s", (session_id,)).fetchone()["wallet_id"]
    if wallet_id is None:
        return SessionBudgetOut(state="no_wallet")
    members = conn.execute("select id, name from wallet_members where wallet_id = %s order by seq", (wallet_id,)).fetchall()
    expenses = conn.execute("select id, amount_centavos, budget_key from expenses where wallet_id = %s",
                            (wallet_id,)).fetchall()
    counts = {"member_count": len(members), "total_centavos": sum(e["amount_centavos"] for e in expenses)}
    trips = conn.execute("select count(*) as n from trip_sessions where wallet_id = %s", (wallet_id,)).fetchone()["n"]
    if trips > 1:
        return SessionBudgetOut(state="two_trips", **counts)
    rows = _lines(conn, session_id)
    if rows is None:
        return SessionBudgetOut(state="no_budget", **counts)

    keys = {r.key for r in rows}
    spent = {k: 0 for k in keys}
    none = NotInBudget(count=0, spent=0)
    unsorted = Unsorted(count=0, spent=0, removed=0)
    on_line: set[UUID] = set()
    for e in expenses:
        key, amount = e["budget_key"], e["amount_centavos"]
        if key in keys:
            spent[key] += amount
            on_line.add(e["id"])
        elif key == NONE:
            none.count += 1
            none.spent += amount
        else:  # null, or a key whose row was removed
            unsorted.count += 1
            unsorted.spent += amount
            unsorted.removed += key is not None

    shares = conn.execute(
        """select x.member_id, x.expense_id, x.share_centavos from expense_shares x
           join expenses e on e.id = x.expense_id where e.wallet_id = %s""", (wallet_id,)).fetchall()
    lines_by, total_by = {}, {}
    for s in shares:
        total_by[s["member_id"]] = total_by.get(s["member_id"], 0) + s["share_centavos"]
        if s["expense_id"] in on_line:
            lines_by[s["member_id"]] = lines_by.get(s["member_id"], 0) + s["share_centavos"]

    lines = []
    for r in rows:
        est = parse_estimate(r.estimate)
        lines.append(BudgetLineSpend(key=r.key, item=r.item, estimate=r.estimate, min=est[0] if est else None,
                                     max=est[1] if est else None, readable=est is not None, spent=spent[r.key],
                                     spent_each=_each(spent[r.key], len(members))))
    return SessionBudgetOut(
        state="ok", **counts, lines=lines, not_in_budget=none, unsorted=unsorted,
        members=[MemberSpend(member_id=m["id"], name=m["name"], share_lines=lines_by.get(m["id"], 0),
                             share_total=total_by.get(m["id"], 0)) for m in members])
