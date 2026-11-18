"""TG-66 A3b: re-save every multi-payer expense as one payer, for a code revert after WALLET_MULTI_PAYER (plan §6).

Usage:
    python data/wallet_one_payer.py            # dry run: counts and slugs, nothing written
    python data/wallet_one_payer.py --apply    # only with the owner's yes: balances shift between the payers

Why: the pre-TG-66 code reads `expenses.paid_by` and the final shares and ignores `expense_payers`, so after a revert a
multi-payer expense would count as paid wholly by `paid_by`. This makes that explicit and recorded: each multi-payer
expense keeps its amount, split and final shares, its payers are dropped, `paid_by` stays the first payer in wallet
order (TG-66 already stores it so), its version goes up by one, and an `expense_edit` row records before and after,
written by the API's own snapshot() and record(). The person who paid the rest is then owed it by the first payer, so
the balances shift: that's why it needs the owner's yes.

Prefer fixing forward (plan §6). With WALLET_MULTI_PAYER off and no revert, nothing needs this: such expenses stay
readable and deletable.

All or nothing: one transaction, and each wallet's row is locked as the API locks it. Prints counts and slugs only,
never a name, a note, an amount or an id. Reads DATABASE_URL like data/load_data.py.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "api"))

import load_data  # noqa: E402
from app import wallets  # noqa: E402
from app.wallet_activity import record  # noqa: E402

FIND = """
select w.id as wallet_id, w.share_slug, count(distinct p.expense_id) as expenses
from expense_payers p join expenses e on e.id = p.expense_id join wallets w on w.id = e.wallet_id
group by w.id, w.share_slug order by w.share_slug
"""


def _one_payer(conn, wallet_id) -> int:
    """Re-saves this wallet's multi-payer expenses. The caller holds the wallet's lock. Returns how many."""
    wallet = wallets._load(conn, wallet_id)
    order = [m.id for m in wallet.members]
    done = 0
    for old in wallet.expenses:
        if not old.payers:
            continue
        first = next(m for m in order if m in {p.member_id for p in old.payers})
        conn.execute("delete from expense_payers where expense_id = %s", (old.id,))
        conn.execute("update expenses set paid_by = %s, version = version + 1, updated_at = now() where id = %s",
                     (first, old.id))
        new = wallets._find(wallets._load(conn, wallet_id), old.id)
        record(conn, wallet_id, "expense_edit", expense_id=old.id, before=wallets.snapshot(old),
               after=wallets.snapshot(new))
        done += 1
    return done


def run(dsn: str, *, apply: bool = False) -> int:
    try:
        with psycopg.connect(dsn, row_factory=dict_row, prepare_threshold=None) as conn:
            found = conn.execute(FIND).fetchall()
            total = sum(r["expenses"] for r in found)
            if not found:
                print("No multi-payer expenses: nothing to do.")
                return 0
            for r in found:
                print(f"share_slug={r['share_slug']} expenses={r['expenses']}")
            if not apply:
                print(f"Dry run, nothing changed: {total} multi-payer expense(s) in {len(found)} wallet(s). "
                      "--apply re-saves each as one payer (the first in wallet order), with the same shares; "
                      "balances shift between the payers, so only with the owner's yes.")
                return 0
            done = 0
            for r in found:
                conn.execute("select id from wallets where id = %s for update", (r["wallet_id"],))
                done += _one_payer(conn, r["wallet_id"])
        print(f"Re-saved {done} expense(s) in {len(found)} wallet(s) as one payer.")
        return 0
    except psycopg.Error as e:  # one redacted line, no traceback: the message can hold the DSN
        print(load_data.db_failure(e, dsn), file=sys.stderr)  # "FAILED, nothing was written (database error): …"
        return 1


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--apply", action="store_true", help="write the changes (the owner's yes); without it, a dry run")
    p.add_argument("--database-url", default=None, help=load_data.DATABASE_URL_FLAG_HELP)
    args = p.parse_args(argv)
    dsn = load_data.database_url(args.database_url)
    if not dsn:
        print("DATABASE_URL is not set (env var or repo-root .env).", file=sys.stderr)
        return 2
    return run(dsn, apply=args.apply)


if __name__ == "__main__":
    sys.exit(main())
