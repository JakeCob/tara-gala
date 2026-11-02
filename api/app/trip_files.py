"""Files a trip's party shares (TG-52 PR 2): bus tickets, each person's payout QR, and the hotel's booking screenshot.
PR 4 adds the trip's photos: shrunk on the phone, tagged with the checklist row the group was at, seen and deletable by
anyone with the link, and kept until someone deletes them (owner, 2026-11-01).

Owner decision (2026-11-01, "share both"): tickets and payout QRs are uploaded to the trip, reversing TG-50's
on-phone rule, so everyone with the trip's link sees them. To keep that exposure short, tickets, QRs and the hotel's
screenshot are deleted 14 days after the trip comes home (sweep()). The bytes live in a private Storage bucket that
only this API reads (storage.py); the files are served here, under the trip's exact slug.

An upload is the raw image as the request body, with its Content-Type, and the rest in the query: no multipart, so no
new dependency. Logs carry the slug, the kind and the size, never a label or a person.
"""

import logging
import re
import threading
from datetime import date, datetime, timedelta
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Query, Request, Response
from fastapi.concurrency import run_in_threadpool

from . import db, storage, wallet_proofs
from .limits import RateLimiter
from .sessions import EXPIRING, NOINDEX, RETAIN_DAYS, SessionOut, _limit, _load, _private, _session_id
from .storage import MAX_BYTES, sniff

router = APIRouter(tags=["trip-files"])
logger = logging.getLogger("tara_gala.api")

MANILA = ZoneInfo("Asia/Manila")
KINDS = ("ticket", "payout_qr", "hotel_proof", "photo")
ROW_KEY = re.compile(r"^d[1-9]-[0-9]{2}$")
MAX_TICKETS = 30
MAX_PHOTOS = 300  # about 90 MB at the phone's ~300 KB each: inside the free 1 GB
NOT_FOUND = "File not found"
UPLOADS_PER_HOUR = 120
UPLOAD_LIMITER = RateLimiter(UPLOADS_PER_HOUR)
PHOTOS_PER_HOUR = 400  # above MAX_PHOTOS: a group on one wifi can add the whole album in one go
PHOTO_LIMITER = RateLimiter(PHOTOS_PER_HOUR)
SWEEP_EVERY_SECONDS = 3600


def _save(share_slug: str, kind: str, label: str, member_id: UUID | None, content_type: str, data: bytes, row_key: str | None = None) -> SessionOut:
    replaced: list[str] = []
    with db.get_conn() as conn:
        session_id = _session_id(conn, share_slug, lock=True)
        trip = conn.execute("select wallet_id, return_date from trip_sessions where id = %s", (session_id,)).fetchone()
        if kind == "payout_qr":
            # Only someone in the trip's wallet has a payout QR here
            ok = trip["wallet_id"] and conn.execute(
                "select 1 from wallet_members where id = %s and wallet_id = %s", (member_id, trip["wallet_id"])
            ).fetchone()
            if not ok:
                logger.info("trip file refused share_slug=%s kind=%s reason=unknown_member", share_slug, kind)
                raise HTTPException(422, "unknown_member")
            replaced = [r["storage_path"] for r in conn.execute(
                "delete from session_files where session_id = %s and kind = 'payout_qr' and member_id = %s returning storage_path",
                (session_id, member_id),
            )]
        elif kind == "hotel_proof":
            replaced = [r["storage_path"] for r in conn.execute(
                "delete from session_files where session_id = %s and kind = 'hotel_proof' returning storage_path", (session_id,)
            )]
        else:
            cap, detail = (MAX_PHOTOS, "too_many_photos") if kind == "photo" else (MAX_TICKETS, "too_many_tickets")
            count = conn.execute("select count(*) as n from session_files where session_id = %s and kind = %s", (session_id, kind)).fetchone()["n"]
            if count >= cap:
                logger.info("trip file refused share_slug=%s kind=%s reason=too_many", share_slug, kind)
                raise HTTPException(422, detail)
        file_id = uuid4()
        path = f"{session_id}/{file_id}"
        try:
            storage.store().put(path, data, content_type)
        except storage.StorageError:
            logger.warning("trip file upload failed share_slug=%s kind=%s bytes=%d", share_slug, kind, len(data))
            raise HTTPException(503, "storage_unavailable") from None
        conn.execute(
            """insert into session_files (id, session_id, kind, member_id, label, storage_path, content_type, bytes, delete_after, row_key)
               values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (file_id, session_id, kind, member_id, label, path, content_type, len(data),
             None if kind == "photo" else trip["return_date"] + timedelta(days=RETAIN_DAYS), row_key),
        )
        session = _load(conn, session_id)
    _forget(replaced, share_slug)
    logger.info("trip file add share_slug=%s kind=%s bytes=%d replaced=%d files=%d", share_slug, kind, len(data), len(replaced), len(session.files))
    return session


def _forget(paths: list[str], share_slug: str) -> None:
    """Deletes objects whose rows are gone. A failure only leaves bytes nothing points to, so it's logged, not raised."""
    if not paths:
        return
    try:
        storage.store().delete(paths)
    except storage.StorageError:
        logger.warning("trip file storage cleanup failed share_slug=%s count=%d", share_slug, len(paths))


@router.post("/sessions/{share_slug}/files", status_code=201, response_model=SessionOut)
async def add_file(
    share_slug: str,
    request: Request,
    response: Response,
    kind: str = Query(..., description="ticket, payout_qr, hotel_proof or photo"),
    label: str = Query("", max_length=200),
    member_id: UUID | None = Query(None, description="whose payout QR"),
    row_key: str | None = Query(None, description="a photo's checklist row, e.g. d2-05"),
) -> SessionOut:
    _limit(PHOTO_LIMITER if kind == "photo" else UPLOAD_LIMITER, request, "file-add")
    if kind not in KINDS:
        raise HTTPException(422, "bad_kind")
    label = label.strip()
    if kind == "ticket" and not 1 <= len(label) <= 40:
        raise HTTPException(422, "bad_label")
    if kind == "photo" and len(label) > 40:
        logger.info("trip file refused share_slug=%s kind=%s reason=bad_label", share_slug, kind)
        raise HTTPException(422, "bad_label")
    if kind not in ("ticket", "photo"):
        label = ""
    if row_key is not None and (kind != "photo" or not ROW_KEY.fullmatch(row_key)):
        logger.info("trip file refused share_slug=%s kind=%s reason=bad_row_key", share_slug, kind)
        raise HTTPException(422, "bad_row_key")
    if (kind == "payout_qr") != (member_id is not None):
        raise HTTPException(422, "unknown_member")
    declared = request.headers.get("content-type", "").split(";")[0].strip().lower()
    size = int(request.headers.get("content-length") or 0)
    if size > MAX_BYTES:
        raise HTTPException(413, "too_big")
    data = await request.body()
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "too_big")
    sniffed = sniff(data)
    if sniffed is None or sniffed != declared:
        logger.info("trip file refused share_slug=%s kind=%s reason=not_an_image bytes=%d", share_slug, kind, len(data))
        raise HTTPException(422, "not_an_image")
    session = await run_in_threadpool(_save, share_slug, kind, label, member_id, sniffed, data, row_key)
    _private(response)
    return session


@router.get("/sessions/{share_slug}/files/{file_id}", responses={404: {"description": NOT_FOUND}})
def get_file(share_slug: str, file_id: UUID) -> Response:
    with db.get_conn() as conn:
        session_id = _session_id(conn, share_slug)
        f = conn.execute(
            "select kind, storage_path, content_type from session_files where id = %s and session_id = %s", (file_id, session_id)
        ).fetchone()
    if f is None:
        logger.info("trip file not found share_slug=%s", share_slug)
        raise HTTPException(404, NOT_FOUND, headers=NOINDEX)
    try:
        data = storage.store().get(f["storage_path"])
    except storage.StorageError:
        raise HTTPException(503, "storage_unavailable") from None
    logger.info("trip file get share_slug=%s kind=%s bytes=%d", share_slug, f["kind"], len(data))
    return Response(
        content=data,
        media_type=f["content_type"],
        headers={"Cache-Control": "private, no-cache", "Content-Disposition": "inline", "X-Content-Type-Options": "nosniff", **NOINDEX},
    )


@router.delete("/sessions/{share_slug}/files/{file_id}", response_model=SessionOut)
def delete_file(share_slug: str, file_id: UUID, request: Request, response: Response) -> SessionOut:
    _limit(UPLOAD_LIMITER, request, "file-delete")
    with db.get_conn() as conn:
        session_id = _session_id(conn, share_slug, lock=True)
        row = conn.execute(
            "delete from session_files where id = %s and session_id = %s returning kind, storage_path", (file_id, session_id)
        ).fetchone()
        if row is None:
            raise HTTPException(404, NOT_FOUND, headers=NOINDEX)
        session = _load(conn, session_id)
    _forget([row["storage_path"]], share_slug)
    logger.info("trip file delete share_slug=%s kind=%s files=%d", share_slug, row["kind"], len(session.files))
    _private(response)
    return session


# ---------------------------------------------------------------- the 14-day sweep

def manila_today() -> date:
    return datetime.now(MANILA).date()


def sweep(today: date | None = None) -> int:
    """Deletes tickets, payout QRs and hotel screenshots past their delete_after, rows and bytes. Returns the count."""
    today = today or manila_today()
    with db.get_conn() as conn:
        paths = [r["storage_path"] for r in conn.execute(
            "delete from session_files where kind = any(%s) and delete_after < %s returning storage_path", (list(EXPIRING), today)
        )]
    if paths:
        try:
            storage.store().delete(paths)
        except storage.StorageError:
            logger.warning("trip file sweep storage cleanup failed count=%d", len(paths))
    logger.info("trip file sweep deleted=%d", len(paths))
    return len(paths)


def start_sweeper(stop: threading.Event) -> threading.Thread | None:
    """Sweeps now and then hourly, on a daemon thread, while Storage is set up. Returns the thread, or None."""
    try:
        storage.store()
    except storage.StorageError:
        logger.info("trip file sweep off: storage not configured")
        return None

    def run() -> None:
        while not stop.is_set():
            try:
                sweep()
            except Exception as e:  # keep sweeping next hour whatever went wrong
                logger.warning("trip file sweep failed error=%s", type(e).__name__)
            try:
                wallet_proofs.sweep_proofs(manila_today())
            except Exception as e:  # its own try: one sweep failing doesn't stop the other
                logger.warning("wallet proof sweep failed error=%s", type(e).__name__)
            stop.wait(SWEEP_EVERY_SECONDS)

    t = threading.Thread(target=run, name="trip-file-sweep", daemon=True)
    t.start()
    return t
