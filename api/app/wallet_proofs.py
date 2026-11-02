"""Payment proofs (TG-53): one screenshot of a transfer, on its payment in a wallet.

Owner decisions (2026-11-02): a proof sits on its settlement, one per payment, and everyone with the wallet's link can
see it. It's deleted 14 days after the later of its upload (Manila date) and the wallet's latest trip home (sweep_proofs),
and the payment stays. proof_at tells a sweep from a removal: a path means there's a proof, no path with proof_at means
the sweep deleted it, and neither means there never was one, or someone removed it.

The bytes live under wallets/<wallet id>/ in the private bucket (storage.py). Uploads are the raw image as the request
body, as in trip_files.py. No connection is held during a Storage call: an upload mustn't stop the wallet's other writes,
the pool is 5, and Storage's timeout is 20 seconds. Logs carry the slug and sizes, never a name, a note or a path.
"""

import logging
from datetime import date
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool

from . import db, storage
from .limits import RateLimiter
from .sessions import RETAIN_DAYS
from .storage import MAX_BYTES, sniff
from .wallets import NOINDEX, WalletOut, _limit, _load, _private, _wallet_id, forget_proof

router = APIRouter(tags=["wallets"])
logger = logging.getLogger("tara_gala.api")

MAX_PROOFS = 50
UPLOADS_PER_HOUR = 120
PROOF_LIMITER = RateLimiter(UPLOADS_PER_HOUR)
NOT_FOUND = "Payment not found"
NO_PROOF = "Proof not found"


def _payment(conn, wallet_id: UUID, settlement_id: UUID):
    return conn.execute(
        "select proof_path, proof_type from settlements where id = %s and wallet_id = %s", (settlement_id, wallet_id)
    ).fetchone()


def _proofs(wallet: WalletOut) -> int:
    return sum(1 for s in wallet.settlements if s.has_proof)


def _not_found(share_slug: str, detail: str, **kwargs) -> HTTPException:
    logger.info("wallet proof not found share_slug=%s detail=%s", share_slug, detail)
    return HTTPException(404, detail, **kwargs)


def _save(share_slug: str, settlement_id: UUID, content_type: str, data: bytes) -> WalletOut:
    """Stores the bytes first and locks the wallet after, unlike trip_files._save: see the module docstring."""
    with db.get_conn() as conn:
        wallet_id = _wallet_id(conn, share_slug)
        if _payment(conn, wallet_id, settlement_id) is None:
            raise _not_found(share_slug, NOT_FOUND)
    path = f"wallets/{wallet_id}/{uuid4()}"
    try:
        storage.store().put(path, data, content_type)
    except storage.StorageError:
        logger.warning("wallet proof upload failed share_slug=%s bytes=%d", share_slug, len(data))
        raise HTTPException(503, "storage_unavailable") from None

    wallet = old = None
    with db.get_conn() as conn:
        wallet_id = _wallet_id(conn, share_slug, lock=True)
        payment = _payment(conn, wallet_id, settlement_id)
        full = payment is not None and conn.execute(
            "select count(*) as n from settlements where wallet_id = %s and proof_path is not null and id <> %s",
            (wallet_id, settlement_id),
        ).fetchone()["n"] >= MAX_PROOFS
        if payment is not None and not full:
            old = payment["proof_path"]
            conn.execute(
                "update settlements set proof_path = %s, proof_type = %s, proof_bytes = %s, proof_at = now() where id = %s",
                (path, content_type, len(data), settlement_id),
            )
            wallet = _load(conn, wallet_id)
    if wallet is None:  # undone or filled up during the upload: these bytes have no row
        forget_proof(path, share_slug)
        if payment is None:
            raise _not_found(share_slug, NOT_FOUND)
        logger.info("wallet proof refused share_slug=%s reason=too_many_proofs bytes=%d", share_slug, len(data))
        raise HTTPException(409, "too_many_proofs")
    forget_proof(old, share_slug)
    logger.info("wallet proof add share_slug=%s bytes=%d replaced=%d proofs=%d", share_slug, len(data), 1 if old else 0, _proofs(wallet))
    return wallet


@router.post("/wallets/{share_slug}/settlements/{settlement_id}/proof", status_code=201, response_model=WalletOut)
async def add_proof(share_slug: str, settlement_id: UUID, request: Request, response: Response) -> WalletOut:
    """Adds a proof to a payment, or replaces its proof. The body is the raw image."""
    _limit(PROOF_LIMITER, request, "proof-add")
    declared = request.headers.get("content-type", "").split(";")[0].strip().lower()
    length = request.headers.get("content-length", "")
    if length.isdigit() and int(length) > MAX_BYTES:  # before reading it; a chunked body is checked below
        logger.info("wallet proof refused share_slug=%s reason=too_big bytes=%d", share_slug, int(length))
        raise HTTPException(413, "too_big")
    data = await request.body()
    if len(data) > MAX_BYTES:
        logger.info("wallet proof refused share_slug=%s reason=too_big bytes=%d", share_slug, len(data))
        raise HTTPException(413, "too_big")
    sniffed = sniff(data)
    if sniffed is None or sniffed != declared:
        logger.info("wallet proof refused share_slug=%s reason=not_an_image bytes=%d", share_slug, len(data))
        raise HTTPException(422, "not_an_image")
    wallet = await run_in_threadpool(_save, share_slug, settlement_id, sniffed, data)
    _private(response)
    return wallet


@router.get("/wallets/{share_slug}/settlements/{settlement_id}/proof")
def get_proof(share_slug: str, settlement_id: UUID) -> Response:
    """Serves the picture. no-store, unlike get_file: proofs have no offline use, and no copy may outlive the sweep."""
    with db.get_conn() as conn:
        payment = _payment(conn, _wallet_id(conn, share_slug), settlement_id)
    if payment is None or payment["proof_path"] is None:
        raise _not_found(share_slug, NO_PROOF, headers=NOINDEX)
    try:
        data = storage.store().get(payment["proof_path"])
    except storage.StorageError:
        logger.warning("wallet proof read failed share_slug=%s", share_slug)
        raise HTTPException(503, "storage_unavailable") from None
    logger.info("wallet proof get share_slug=%s bytes=%d", share_slug, len(data))
    return Response(
        content=data,
        media_type=payment["proof_type"],
        headers={"Cache-Control": "private, no-store", "Content-Disposition": "inline", "X-Content-Type-Options": "nosniff", **NOINDEX},
    )


@router.delete("/wallets/{share_slug}/settlements/{settlement_id}/proof", response_model=WalletOut)
def delete_proof(share_slug: str, settlement_id: UUID, request: Request, response: Response) -> WalletOut:
    """Removes a proof and its bytes, and clears proof_at too, so the row doesn't read as swept. The payment stays."""
    _limit(PROOF_LIMITER, request, "proof-delete")
    with db.get_conn() as conn:
        wallet_id = _wallet_id(conn, share_slug, lock=True)
        payment = _payment(conn, wallet_id, settlement_id)
        if payment is None:
            raise _not_found(share_slug, NOT_FOUND)
        if payment["proof_path"] is None:  # a swept row keeps its proof_at, and still says Proof deleted.
            raise _not_found(share_slug, NO_PROOF)
        conn.execute(
            "update settlements set proof_path = null, proof_type = null, proof_bytes = null, proof_at = null where id = %s",
            (settlement_id,),
        )
        wallet = _load(conn, wallet_id)
    forget_proof(payment["proof_path"], share_slug)
    _private(response)
    logger.info("wallet proof delete share_slug=%s proofs=%d", share_slug, _proofs(wallet))
    return wallet


# ---------------------------------------------------------------- the sweep

def sweep_proofs(today: date) -> int:
    """Deletes proofs past their date, bytes first and the row after, the reverse of trip_files.sweep(): a Storage
    failure must not leave a receipt online with nothing pointing to it, so the next hour retries. Returns the count."""
    with db.get_conn() as conn:
        paths = [r["proof_path"] for r in conn.execute(
            """select s.proof_path
               from settlements s
               left join lateral (select max(return_date) as back from trip_sessions where wallet_id = s.wallet_id) t on true
               where s.proof_path is not null
                 and greatest((s.proof_at at time zone 'Asia/Manila')::date, t.back) + %s < %s""",
            (RETAIN_DAYS, today),
        )]
    if paths:
        try:
            storage.store().delete(paths)
        except storage.StorageError:
            logger.warning("wallet proof sweep cleanup failed count=%d", len(paths))
            return 0
        with db.get_conn() as conn:
            conn.execute("update settlements set proof_path = null, proof_type = null, proof_bytes = null where proof_path = any(%s)", (paths,))
    logger.info("wallet proof sweep deleted=%d", len(paths))
    return len(paths)
