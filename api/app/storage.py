"""Supabase Storage for trip files (TG-52): one private bucket that only the API reads and writes, with the service
role key. Files are served to people with a trip's link through the API, never from Storage directly.

Object paths are "<session id>/<file id>" for trip files and "wallets/<wallet id>/<uuid>" for payment proofs
(wallet_proofs.py): no names, labels or slugs. Logs carry the path's file id and sizes only.
"""

import logging
import os

import httpx

logger = logging.getLogger("tara_gala.api")

BUCKET = "trip-files"
MAX_BYTES = 5 * 1024 * 1024  # the table's cap
TIMEOUT = httpx.Timeout(20.0, connect=5.0)


def sniff(data: bytes) -> str | None:
    """The image type the bytes really are, from their signature, or None. The Content-Type must agree."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


class StorageError(Exception):
    """Storage is off (no settings) or didn't answer as expected."""


class SupabaseStorage:
    def __init__(self, url: str, key: str):
        self.base = url.rstrip("/") + "/storage/v1"
        self.headers = {"Authorization": f"Bearer {key}", "apikey": key}

    def _call(self, method: str, path: str, **kw) -> httpx.Response:
        try:
            r = httpx.request(method, self.base + path, headers={**self.headers, **kw.pop("headers", {})}, timeout=TIMEOUT, **kw)
        except httpx.HTTPError as e:
            logger.warning("storage %s failed error=%s", method, type(e).__name__)
            raise StorageError("unreachable") from None
        return r

    def ensure_bucket(self) -> None:
        r = self._call("POST", "/bucket", json={"id": BUCKET, "name": BUCKET, "public": False})
        if r.status_code in (200, 201) or "already exists" in r.text.lower():
            return
        logger.warning("storage bucket check status=%d", r.status_code)
        raise StorageError("bucket")

    def put(self, path: str, data: bytes, content_type: str) -> None:
        r = self._call("POST", f"/object/{BUCKET}/{path}", content=data, headers={"content-type": content_type, "x-upsert": "true"})
        if r.status_code not in (200, 201):
            logger.warning("storage put status=%d bytes=%d", r.status_code, len(data))
            raise StorageError("put")

    def get(self, path: str) -> bytes:
        r = self._call("GET", f"/object/{BUCKET}/{path}")
        if r.status_code != 200:
            logger.warning("storage get status=%d", r.status_code)
            raise StorageError("get")
        return r.content

    def delete(self, paths: list[str]) -> None:
        if not paths:
            return
        r = self._call("DELETE", f"/object/{BUCKET}", json={"prefixes": paths})
        if r.status_code not in (200, 204):
            logger.warning("storage delete status=%d count=%d", r.status_code, len(paths))
            raise StorageError("delete")


_store: SupabaseStorage | None = None


def store() -> SupabaseStorage:
    """The storage client, or StorageError when SUPABASE_URL or SUPABASE_SERVICE_KEY isn't set. Tests swap it."""
    global _store
    if _store is None:
        url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_KEY")
        if not url or not key:
            raise StorageError("off")
        _store = SupabaseStorage(url, key)
    return _store


def set_store(s) -> None:
    global _store
    _store = s
