"""Payment proofs (TG-53): one screenshot of a transfer, on its payment in a wallet.

Owner decisions (2026-11-02): a proof sits on its settlement, one per payment, and everyone with the wallet's link can
see it. It's deleted 14 days after the later of its upload (Manila date) and the wallet's latest trip home (sweep_proofs),
and the payment stays. proof_at tells a sweep from a removal: a path means there's a proof, no path with proof_at means
the sweep deleted it, and neither means there never was one, or someone removed it.

The bytes live under wallets/<wallet id>/ in the private bucket (storage.py). Uploads are the raw image as the request
body, as in trip_files.py. No connection is held during a Storage call: an upload mustn't stop the wallet's other writes,
the pool is 5, and Storage's timeout is 20 seconds. Logs carry the slug and sizes, never a name, a note or a path.

TG-66: each add, change and remove records proof_add, proof_change or proof_remove (wallet_activity.record) in the same
transaction as its row change, so the wallet's rev moves with it. The row's `after` is the payment itself, so the line
still reads once the payment is undone. `?by=` is who's writing (the body of an add is the image). The sweep isn't a
person's write and records nothing.

TG-73 A3: an ambag's proof (pot_ambag's own four proof columns) is added, changed, removed and swept exactly as a
payment's, on its own routes behind WALLET_POT (plan B11). The steps are one set of helpers over a `Rows` (which table,
which activity lines, which words in the logs), so the settlements' answers, codes and log lines are unchanged.
"""

import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.concurrency import run_in_threadpool

from . import db, storage
from .limits import RateLimiter
from .sessions import RETAIN_DAYS
from .storage import MAX_BYTES, sniff
from .wallet_activity import check_by, record
from .wallets import NOINDEX, WalletOut, _limit, _load, _private, _wallet_id, forget_proof, load_opts

router = APIRouter(tags=["wallets"])
logger = logging.getLogger("tara_gala.api")

MAX_PROOFS = 50
MAX_AMBAG_PROOFS = 100  # TG-73: per goal; a group of 20 sending a few times each, not every one of its 500 rows
UPLOADS_PER_HOUR = 120
PROOF_LIMITER = RateLimiter(UPLOADS_PER_HOUR)
NOT_FOUND = "Payment not found"
NO_PROOF = "Proof not found"
AMBAG_NOT_FOUND = "ambag_gone"  # TG-73: ux §14's code, as A1's ambag routes


@dataclass(frozen=True)
class Rows:
    """A table whose rows each hold one proof: settlements (TG-53) or pot_ambag (TG-73)."""

    table: str
    columns: str  # read with proof_path and proof_type: what the activity line's `after` is made of
    not_found: str  # the 404 detail when the row isn't this wallet's
    actions: tuple[str, str, str]  # add, change, remove
    log: str  # the log lines' first words
    cap: Callable[[], int]  # read at call time, so a test can lower it
    after: Callable[[dict], dict]  # the activity line's `after`: ids and centavos, never names
    ref: Callable[[UUID, dict], dict]  # record()'s row keyword: the settlement, or the ambag's member
    count: Callable[[WalletOut], int]  # proofs in the answer, for the log


def _payment_after(p) -> dict:
    return {"from_member": str(p["from_member"]), "to_member": str(p["to_member"]), "amount_centavos": p["amount_centavos"]}


def _ambag_after(a) -> dict:
    return {"ambag_id": str(a["id"]), "member_id": str(a["member_id"]), "amount_centavos": a["amount_centavos"]}


def _proofs(wallet: WalletOut) -> int:
    return sum(1 for s in wallet.settlements if s.has_proof)


def _ambag_proofs(wallet: WalletOut) -> int:
    return sum(1 for a in wallet.pot.ambag if a.has_proof) if getattr(wallet, "pot", None) else 0


SETTLEMENTS = Rows(
    table="settlements", columns="from_member, to_member, amount_centavos", not_found=NOT_FOUND,
    actions=("proof_add", "proof_change", "proof_remove"), log="wallet proof", cap=lambda: MAX_PROOFS,
    after=_payment_after, ref=lambda row_id, _row: {"settlement_id": row_id}, count=_proofs,
)
AMBAG = Rows(
    table="pot_ambag", columns="id, member_id, amount_centavos", not_found=AMBAG_NOT_FOUND,
    actions=("ambag_proof_add", "ambag_proof_change", "ambag_proof_remove"), log="wallet ambag proof",
    cap=lambda: MAX_AMBAG_PROOFS, after=_ambag_after, ref=lambda _row_id, row: {"member_id": row["member_id"]},
    count=_ambag_proofs,
)


def _row(conn, rows: Rows, wallet_id: UUID, row_id: UUID):
    return conn.execute(
        f"select proof_path, proof_type, {rows.columns} from {rows.table} where id = %s and wallet_id = %s",  # noqa: S608 (fixed names)
        (row_id, wallet_id),
    ).fetchone()


def _payment(conn, wallet_id: UUID, settlement_id: UUID):
    return _row(conn, SETTLEMENTS, wallet_id, settlement_id)


def _record(conn, wallet_id: UUID, action: str, by: UUID | None, row_id: UUID, row, rows: Rows = SETTLEMENTS) -> None:
    """The activity row: ids, never names. JSON, so the ids are strings."""
    record(conn, wallet_id, action, by=by, after=rows.after(row), **rows.ref(row_id, row))


def _not_found(share_slug: str, detail: str, rows: Rows = SETTLEMENTS, **kwargs) -> HTTPException:
    logger.info("%s not found share_slug=%s detail=%s", rows.log, share_slug, detail)
    return HTTPException(404, detail, **kwargs)


def _save(share_slug: str, settlement_id: UUID, content_type: str, data: bytes, by: UUID | None = None, opts: dict | None = None,
          rows: Rows = SETTLEMENTS) -> WalletOut:
    """Stores the bytes first and locks the wallet after, unlike trip_files._save: see the module docstring."""
    with db.get_conn() as conn:
        wallet_id = _wallet_id(conn, share_slug)
        if _row(conn, rows, wallet_id, settlement_id) is None:
            raise _not_found(share_slug, rows.not_found, rows)
        check_by(conn, wallet_id, by, share_slug, "proof")  # before Storage: a refusal stores nothing
    path = f"wallets/{wallet_id}/{uuid4()}"
    try:
        storage.store().put(path, data, content_type)
    except storage.StorageError:
        logger.warning("%s upload failed share_slug=%s bytes=%d", rows.log, share_slug, len(data))
        raise HTTPException(503, "storage_unavailable") from None

    wallet = old = None
    try:
        with db.get_conn() as conn:
            wallet_id = _wallet_id(conn, share_slug, lock=True)
            payment = _row(conn, rows, wallet_id, settlement_id)
            full = payment is not None and conn.execute(
                f"select count(*) as n from {rows.table} where wallet_id = %s and proof_path is not null and id <> %s",  # noqa: S608
                (wallet_id, settlement_id),
            ).fetchone()["n"] >= rows.cap()
            if payment is not None and not full:
                old = payment["proof_path"]
                conn.execute(
                    f"update {rows.table} set proof_path = %s, proof_type = %s, proof_bytes = %s, proof_at = now() where id = %s",  # noqa: S608
                    (path, content_type, len(data), settlement_id),
                )
                _record(conn, wallet_id, rows.actions[1] if old else rows.actions[0], by, settlement_id, payment, rows)
                wallet = _load(conn, wallet_id, **(opts or {}))
    except Exception:  # no row took these bytes, so nothing would ever find them
        forget_proof(path, share_slug)
        raise
    if wallet is None:  # undone or filled up during the upload: these bytes have no row
        forget_proof(path, share_slug)
        if payment is None:
            raise _not_found(share_slug, rows.not_found, rows)
        logger.info("%s refused share_slug=%s reason=too_many_proofs bytes=%d", rows.log, share_slug, len(data))
        raise HTTPException(409, "too_many_proofs")
    forget_proof(old, share_slug)
    logger.info("%s add share_slug=%s bytes=%d replaced=%d proofs=%d", rows.log, share_slug, len(data), 1 if old else 0,
                rows.count(wallet))
    return wallet


async def _add(rows: Rows, share_slug: str, row_id: UUID, request: Request, response: Response, by: UUID | None) -> WalletOut:
    _limit(PROOF_LIMITER, request, "proof-add")
    declared = request.headers.get("content-type", "").split(";")[0].strip().lower()
    length = request.headers.get("content-length", "")
    if length.isdigit() and int(length) > MAX_BYTES:  # before reading it; a chunked body is checked below
        logger.info("%s refused share_slug=%s reason=too_big bytes=%d", rows.log, share_slug, int(length))
        raise HTTPException(413, "too_big")
    data = await request.body()
    if len(data) > MAX_BYTES:
        logger.info("%s refused share_slug=%s reason=too_big bytes=%d", rows.log, share_slug, len(data))
        raise HTTPException(413, "too_big")
    sniffed = sniff(data)
    if sniffed is None or sniffed != declared:
        logger.info("%s refused share_slug=%s reason=not_an_image bytes=%d", rows.log, share_slug, len(data))
        raise HTTPException(422, "not_an_image")
    wallet = await run_in_threadpool(_save, share_slug, row_id, sniffed, data, by, load_opts(request.app.state.flags), rows)
    _private(response)
    return wallet


def _get(rows: Rows, share_slug: str, row_id: UUID) -> Response:
    with db.get_conn() as conn:
        payment = _row(conn, rows, _wallet_id(conn, share_slug), row_id)
    if payment is None or payment["proof_path"] is None:
        raise _not_found(share_slug, NO_PROOF, rows, headers=NOINDEX)
    try:
        data = storage.store().get(payment["proof_path"])
    except storage.StorageError:
        logger.warning("%s read failed share_slug=%s", rows.log, share_slug)
        raise HTTPException(503, "storage_unavailable") from None
    logger.info("%s get share_slug=%s bytes=%d", rows.log, share_slug, len(data))
    return Response(
        content=data,
        media_type=payment["proof_type"],
        headers={"Cache-Control": "private, no-store", "Content-Disposition": "inline", "X-Content-Type-Options": "nosniff", **NOINDEX},
    )


def _delete(rows: Rows, share_slug: str, row_id: UUID, request: Request, response: Response, by: UUID | None) -> WalletOut:
    _limit(PROOF_LIMITER, request, "proof-delete")
    with db.get_conn() as conn:
        wallet_id = _wallet_id(conn, share_slug, lock=True)
        check_by(conn, wallet_id, by, share_slug, "proof")
        payment = _row(conn, rows, wallet_id, row_id)
        if payment is None:
            raise _not_found(share_slug, rows.not_found, rows)
        if payment["proof_path"] is None:  # a swept row keeps its proof_at, and still says Proof deleted.
            raise _not_found(share_slug, NO_PROOF, rows)
        conn.execute(
            f"update {rows.table} set proof_path = null, proof_type = null, proof_bytes = null, proof_at = null where id = %s",  # noqa: S608
            (row_id,),
        )
        _record(conn, wallet_id, rows.actions[2], by, row_id, payment, rows)
        wallet = _load(conn, wallet_id, **load_opts(request.app.state.flags))
    forget_proof(payment["proof_path"], share_slug)
    _private(response)
    logger.info("%s delete share_slug=%s proofs=%d", rows.log, share_slug, rows.count(wallet))
    return wallet


# ---------------------------------------------------------------- a payment's proof (TG-53)

@router.post("/wallets/{share_slug}/settlements/{settlement_id}/proof", status_code=201, response_model=WalletOut)
async def add_proof(
    share_slug: str, settlement_id: UUID, request: Request, response: Response, by: UUID | None = Query(None)
) -> WalletOut:
    """Adds a proof to a payment, or replaces its proof. The body is the raw image; `by` is who's adding it."""
    return await _add(SETTLEMENTS, share_slug, settlement_id, request, response, by)


@router.get("/wallets/{share_slug}/settlements/{settlement_id}/proof")
def get_proof(share_slug: str, settlement_id: UUID) -> Response:
    """Serves the picture. no-store, unlike get_file: proofs have no offline use, and no copy may outlive the sweep."""
    return _get(SETTLEMENTS, share_slug, settlement_id)


@router.delete("/wallets/{share_slug}/settlements/{settlement_id}/proof", response_model=WalletOut)
def delete_proof(
    share_slug: str, settlement_id: UUID, request: Request, response: Response, by: UUID | None = Query(None)
) -> WalletOut:
    """Removes a proof and its bytes, and clears proof_at too, so the row doesn't read as swept. The payment stays."""
    return _delete(SETTLEMENTS, share_slug, settlement_id, request, response, by)


# ---------------------------------------------------------------- an ambag's proof (TG-73 A3, behind WALLET_POT)

def _pot_on(request: Request, share_slug: str) -> None:
    from .wallet_pot import pot_on  # read at call time: wallet_pot imports wallets, which may still be loading

    pot_on(request, share_slug)


@router.post("/wallets/{share_slug}/pot/ambag/{ambag_id}/proof", status_code=201, response_model=WalletOut,
             dependencies=[Depends(_pot_on)])
async def add_ambag_proof(
    share_slug: str, ambag_id: UUID, request: Request, response: Response, by: UUID | None = Query(None)
) -> WalletOut:
    """B11: "I sent ₱X" with a screenshot, or one added later. As a payment's proof, on the ambag's own row."""
    return await _add(AMBAG, share_slug, ambag_id, request, response, by)


@router.get("/wallets/{share_slug}/pot/ambag/{ambag_id}/proof", dependencies=[Depends(_pot_on)])
def get_ambag_proof(share_slug: str, ambag_id: UUID) -> Response:
    return _get(AMBAG, share_slug, ambag_id)


@router.delete("/wallets/{share_slug}/pot/ambag/{ambag_id}/proof", response_model=WalletOut, dependencies=[Depends(_pot_on)])
def delete_ambag_proof(
    share_slug: str, ambag_id: UUID, request: Request, response: Response, by: UUID | None = Query(None)
) -> WalletOut:
    return _delete(AMBAG, share_slug, ambag_id, request, response, by)


# ---------------------------------------------------------------- the sweep

def _sweep(rows: Rows, today: date) -> int:
    with db.get_conn() as conn:
        paths = [r["proof_path"] for r in conn.execute(
            f"""select s.proof_path
               from {rows.table} s
               left join lateral (select max(return_date) as back from trip_sessions where wallet_id = s.wallet_id) t on true
               where s.proof_path is not null
                 and greatest((s.proof_at at time zone 'Asia/Manila')::date, t.back) + %s < %s""",  # noqa: S608
            (RETAIN_DAYS, today),
        )]
    if paths:
        try:
            storage.store().delete(paths)
        except storage.StorageError:
            logger.warning("%s sweep cleanup failed count=%d", rows.log, len(paths))
            return 0
        with db.get_conn() as conn:
            conn.execute(f"update {rows.table} set proof_path = null, proof_type = null, proof_bytes = null where proof_path = any(%s)",  # noqa: S608
                         (paths,))
    logger.info("%s sweep deleted=%d", rows.log, len(paths))
    return len(paths)


def sweep_proofs(today: date) -> int:
    """Deletes proofs past their date, bytes first and the row after, the reverse of trip_files.sweep(): a Storage
    failure must not leave a receipt online with nothing pointing to it, so the next hour retries. Returns the count.
    TG-73: the ambag proofs go by the same rule (their own log line); the count is the payments' and the ambag's."""
    return _sweep(SETTLEMENTS, today) + _sweep(AMBAG, today)
