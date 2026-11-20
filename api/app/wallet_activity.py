"""The wallet's activity list and edit history (TG-66). Append-only: nothing in the API updates or deletes a row, and only
the wallet's own delete removes them (its cascade).

Every wallet write calls record() in its own transaction, so the activity row and the wallet's rev move together or not
at all. rev is the ordering rule's counter: a phone never lets an answer with a lower rev replace what's on screen.

Logs carry the wallet's slug, the action and the rev: never a name, a note, an item, a comment, a member or wallet id,
or the before/after.
"""

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from psycopg.types.json import Jsonb

from .wallet_models import ActivityOut, ActivityRowOut, CommentIn, CommentOut, CommentsOut, CommentWriteOut

logger = logging.getLogger("tara_gala.api")

ACTIONS = frozenset({
    "expense_add", "expense_edit", "expense_delete", "comment_add", "comment_delete", "settle", "settle_undo",
    "proof_add", "proof_change", "proof_remove", "member_join",
})


def record(conn, wallet_id: UUID, action: str, *, by: UUID | None = None, expense_id: UUID | None = None,
           settlement_id: UUID | None = None, member_id: UUID | None = None, before: dict | None = None,
           after: dict | None = None) -> int:
    """One activity row, and the wallet's rev + 1, in the caller's transaction. Returns the new rev.

    `by` is the phone's picked person, already checked by the route to be this wallet's member (or None: "Someone").
    `before` and `after` are the expense snapshots (options §5) or a payment's {from_member, to_member, amount_centavos}.
    """
    if action not in ACTIONS:
        raise ValueError(f"unknown wallet activity: {action}")
    conn.execute(
        """insert into wallet_activity (wallet_id, actor, action, expense_id, settlement_id, member_id, before, after)
           values (%s, %s, %s, %s, %s, %s, %s, %s)""",
        (wallet_id, by, action, expense_id, settlement_id, member_id,
         None if before is None else Jsonb(before), None if after is None else Jsonb(after)),
    )
    row = conn.execute("update wallets set rev = rev + 1 where id = %s returning rev, share_slug", (wallet_id,)).fetchone()
    rev, slug = (row["rev"], row["share_slug"]) if isinstance(row, dict) else row
    logger.info("wallet activity share_slug=%s action=%s rev=%d", slug, action, rev)  # rev is per wallet: the slug ties it to one
    return rev


# ---------------------------------------------------------------- the routes (TG-66 A2): the activity list and comments
#
# WALLET_ACTIVITY off: all four answer 404 feature_off, before the body is judged, so the phone picks ux.md §9's line
# from what it sent. Each read takes its rev and its list in one statement, one snapshot (S1): a phone never gets a
# rev that doesn't match the list beside it. Each write locks the wallet row first, as every wallet write does.

# Imported here, below record(), and read at call time: wallets.py imports record() from this module (A3), so either
# module can load first without a cycle. The tests' wallets.* monkeypatches (the rate limiters) reach these routes too.
from . import db, wallets  # noqa: E402

router = APIRouter(tags=["wallets"])

PAGE = 15  # the web's page (ux.md: 15, then Show more)
MAX_PAGE = 50
MAX_COMMENTS = 50  # per expense (options §4)
EXPENSE_NOT_FOUND = "Expense not found"
COMMENT_NOT_FOUND = "Comment not found"


def _logged(share_slug: str) -> str:
    return share_slug if wallets.SLUG.fullmatch(share_slug) else "<invalid>"


def activity_on(request: Request, share_slug: str) -> None:
    """WALLET_ACTIVITY off: 404 feature_off. Runs before the body is validated."""
    if not request.app.state.flags.wallet_activity:
        logger.info("wallet activity refused share_slug=%s reason=feature_off", _logged(share_slug))
        raise HTTPException(404, "feature_off")


def check_by(conn, wallet_id: UUID, by: UUID | None, share_slug: str, what: str) -> None:
    """`by` is the phone's own pick: it must be one of this wallet's people (422 unknown_member). None is "Someone"."""
    if by is not None and by not in wallets._member_ids(conn, wallet_id):
        logger.info("wallet %s refused share_slug=%s reason=unknown_member", what, share_slug)
        raise HTTPException(422, "unknown_member")


def _expense_here(conn, wallet_id: UUID, expense_id: UUID, share_slug: str) -> None:
    if conn.execute("select 1 from expenses where id = %s and wallet_id = %s", (expense_id, wallet_id)).fetchone() is None:
        logger.info("wallet comment expense not found share_slug=%s", share_slug)
        raise HTTPException(404, EXPENSE_NOT_FOUND)


def _comments(conn, expense_id: UUID) -> list[CommentOut]:
    """Oldest first."""
    return [
        CommentOut(**r)
        for r in conn.execute(
            "select id, expense_id, author, body, created_at from expense_comments where expense_id = %s order by created_at, id",
            (expense_id,),
        )
    ]


@router.get("/wallets/{share_slug}/activity", response_model=ActivityOut, dependencies=[Depends(activity_on)])
def get_activity(
    share_slug: str,
    response: Response,
    before: int | None = Query(None, ge=1),  # the oldest row's id on screen
    limit: int = Query(PAGE, ge=1, le=MAX_PAGE),
    expense_id: UUID | None = Query(None),  # plan §2 addendum 1: one expense's rows only
) -> ActivityOut:
    """Newest first. With expense_id, only that expense's rows in this wallet; none is an empty page, never a 404."""
    where, params = ["x.wallet_id = w.id"], {"w": None, "before": before, "expense": expense_id, "limit": limit}
    if expense_id is not None:
        where.append("x.expense_id = %(expense)s")
    if before is not None:
        where.append("x.id < %(before)s")
    with db.get_conn() as conn:
        params["w"] = wallets._wallet_id(conn, share_slug)
        found = conn.execute(
            f"""select w.rev, a.id, a.at, a.actor, a.action, a.expense_id, a.settlement_id, a.member_id, a.before, a.after
                from wallets w
                left join lateral (
                  select x.* from wallet_activity x where {" and ".join(where)} order by x.id desc limit %(limit)s
                ) a on true
                where w.id = %(w)s
                order by a.id desc""",
            params,
        ).fetchall()
    if not found:  # the wallet went between the two statements
        logger.info("wallet not found share_slug=%s", share_slug)
        raise HTTPException(404, wallets.NOT_FOUND, headers=wallets.NOINDEX)
    rows = [ActivityRowOut(**{k: v for k, v in r.items() if k != "rev"}) for r in found if r["id"] is not None]
    page = ActivityOut(rev=found[0]["rev"], rows=rows)
    wallets._private(response)
    logger.info(
        "wallet activity get share_slug=%s rows=%d rev=%d expense=%s paged=%s",
        share_slug, len(rows), page.rev, "yes" if expense_id else "no", "yes" if before else "no",
    )
    return page


@router.get("/wallets/{share_slug}/expenses/{expense_id}/comments", response_model=CommentsOut, dependencies=[Depends(activity_on)])
def get_comments(share_slug: str, expense_id: UUID, response: Response) -> CommentsOut:
    with db.get_conn() as conn:
        wallet_id = wallets._wallet_id(conn, share_slug)
        found = conn.execute(
            """select w.rev, c.id, c.expense_id, c.author, c.body, c.created_at
               from wallets w
               join expenses e on e.wallet_id = w.id and e.id = %s
               left join expense_comments c on c.expense_id = e.id
               where w.id = %s
               order by c.created_at, c.id""",
            (expense_id, wallet_id),
        ).fetchall()
    if not found:
        logger.info("wallet comment expense not found share_slug=%s", share_slug)
        raise HTTPException(404, EXPENSE_NOT_FOUND)
    answer = CommentsOut(
        rev=found[0]["rev"],
        comments=[CommentOut(**{k: v for k, v in r.items() if k != "rev"}) for r in found if r["id"] is not None],
    )
    wallets._private(response)
    logger.info("wallet comments get share_slug=%s comments=%d rev=%d", share_slug, len(answer.comments), answer.rev)
    return answer


@router.post(
    "/wallets/{share_slug}/expenses/{expense_id}/comments",
    status_code=201,
    response_model=CommentWriteOut,
    dependencies=[Depends(activity_on)],
)
def add_comment(share_slug: str, expense_id: UUID, body: CommentIn, request: Request, response: Response) -> CommentWriteOut:
    wallets._limit(wallets.WRITE_LIMITER, request, "comment")
    with db.get_conn() as conn:
        wallet_id = wallets._wallet_id(conn, share_slug, lock=True)
        _expense_here(conn, wallet_id, expense_id, share_slug)
        check_by(conn, wallet_id, body.by, share_slug, "comment")
        count = conn.execute("select count(*) as n from expense_comments where expense_id = %s", (expense_id,)).fetchone()["n"]
        if count >= MAX_COMMENTS:
            logger.info("wallet comment refused share_slug=%s reason=comments_full", share_slug)
            raise HTTPException(409, "comments_full")
        conn.execute(
            "insert into expense_comments (expense_id, author, body) values (%s, %s, %s)", (expense_id, body.by, body.body)
        )
        record(conn, wallet_id, "comment_add", by=body.by, expense_id=expense_id)  # never the text
        answer = CommentWriteOut(wallet=wallets._load(conn, wallet_id, budget=request.app.state.flags.budget_lines), comments=_comments(conn, expense_id))
    wallets._private(response)
    logger.info(
        "wallet comment add share_slug=%s comments=%d rev=%d by=%s",
        share_slug, len(answer.comments), answer.wallet.rev, "yes" if body.by else "no",
    )
    return answer


@router.delete(
    "/wallets/{share_slug}/expenses/{expense_id}/comments/{comment_id}",
    response_model=CommentWriteOut,
    dependencies=[Depends(activity_on)],
)
def delete_comment(
    share_slug: str, expense_id: UUID, comment_id: UUID, request: Request, response: Response, by: UUID | None = Query(None)
) -> CommentWriteOut:
    """Anyone with the link, as with expenses. The activity row keeps the expense id only: no text, no comment id."""
    wallets._limit(wallets.WRITE_LIMITER, request, "comment_delete")
    with db.get_conn() as conn:
        wallet_id = wallets._wallet_id(conn, share_slug, lock=True)
        check_by(conn, wallet_id, by, share_slug, "comment")
        gone = conn.execute(
            """delete from expense_comments c using expenses e
               where c.id = %s and c.expense_id = %s and e.id = c.expense_id and e.wallet_id = %s returning c.id""",
            (comment_id, expense_id, wallet_id),
        ).fetchone()
        if gone is None:
            logger.info("wallet comment delete not found share_slug=%s", share_slug)
            raise HTTPException(404, COMMENT_NOT_FOUND)
        record(conn, wallet_id, "comment_delete", by=by, expense_id=expense_id)
        answer = CommentWriteOut(wallet=wallets._load(conn, wallet_id, budget=request.app.state.flags.budget_lines), comments=_comments(conn, expense_id))
    wallets._private(response)
    logger.info(
        "wallet comment delete share_slug=%s comments=%d rev=%d by=%s",
        share_slug, len(answer.comments), answer.wallet.rev, "yes" if by else "no",
    )
    return answer
