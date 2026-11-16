"""The wallet's activity list and edit history (TG-66). Append-only: nothing in the API updates or deletes a row, and only
the wallet's own delete removes them (its cascade).

Every wallet write calls record() in its own transaction, so the activity row and the wallet's rev move together or not
at all. rev is the ordering rule's counter: a phone never lets an answer with a lower rev replace what's on screen.

Logs carry the wallet's slug, the action and the rev: never a name, a note, an item, a comment, a member or wallet id,
or the before/after.
"""

import logging
from uuid import UUID

from psycopg.types.json import Jsonb

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
