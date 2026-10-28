"""The API's one logging setup: root handler, level from LOG_LEVEL, uvicorn routed through it, secrets redacted.

Also the request middleware: one line per request, and unhandled errors logged with a
stack trace and turned into a generic 500 JSON. See README section 5.
"""

import logging
import os
import re
import sys
import time
from collections.abc import Iterable, Mapping
from urllib.parse import unquote, urlsplit

from starlette.responses import JSONResponse

LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")
FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"

# Env vars whose values are masked; shorter values are too likely to match ordinary text
SECRET_NAME = re.compile(r"KEY|SECRET|TOKEN|PASSWORD", re.I)
MIN_SECRET_LEN = 8
URL_PASSWORD = re.compile(r"(\b[a-z][a-z0-9+.-]*://[^\s:/@]+:)[^\s@]+@", re.I)
KV_PASSWORD = re.compile(r"\b(password=)\S+", re.I)

request_log = logging.getLogger("tara_gala.request")


class RedactingFormatter(logging.Formatter):
    """Masks secret env values and URL or key=value passwords in the final text, tracebacks included."""

    def __init__(self, secrets: Iterable[str]):
        super().__init__(FORMAT)
        self._secrets = sorted(set(secrets), key=len, reverse=True)

    def format(self, record: logging.LogRecord) -> str:
        text = super().format(record)  # includes exc_text and stack_info
        for s in self._secrets:
            text = text.replace(s, "***")
        text = URL_PASSWORD.sub(r"\1***@", text)
        return KV_PASSWORD.sub(r"\1***", text)


def secret_values(env: Mapping[str, str]) -> list[str]:
    """DATABASE_URL, its password (raw and URL-decoded), and any *KEY*/*SECRET*/*TOKEN*/*PASSWORD* var, longest first."""
    values = [v for k, v in env.items() if k == "DATABASE_URL" or SECRET_NAME.search(k)]
    if dsn := env.get("DATABASE_URL"):
        try:
            password = urlsplit(dsn).password
        except ValueError:
            password = None
        if password:
            values += [password, unquote(password)]
    return sorted({v for v in values if v and len(v) >= MIN_SECRET_LEN}, key=len, reverse=True)


def configure_logging(env: Mapping[str, str] = os.environ) -> None:
    """Idempotent. Call once from main.py at import, before anything logs."""
    raw = env.get("LOG_LEVEL", "INFO")
    level = raw.strip().upper()
    bad = level not in LEVELS
    if bad:
        level = "INFO"

    # Replace only our own handler, so pytest's capture handler (and anything else) survives
    root = logging.getLogger()
    for h in [h for h in root.handlers if getattr(h, "_tara_gala", False)]:
        root.removeHandler(h)
    handler = logging.StreamHandler(sys.stdout)  # stdout: Railway shows stderr lines as errors
    handler.setFormatter(RedactingFormatter(secret_values(env)))
    handler._tara_gala = True
    root.addHandler(handler)
    root.setLevel(level)

    # Uvicorn configures its loggers before importing the app, so this wins.
    # Its lines go through our handler and follow LOG_LEVEL; its access log is replaced by ours.
    for name in ("uvicorn", "uvicorn.error"):
        lg = logging.getLogger(name)
        lg.handlers.clear()
        lg.propagate = True
        lg.setLevel(logging.NOTSET)
    access = logging.getLogger("uvicorn.access")
    access.handlers.clear()
    access.propagate = False  # with no handlers, uvicorn 0.32 skips its access line entirely
    access.disabled = True

    if bad:
        logging.getLogger("tara_gala.api").warning("LOG_LEVEL=%r is not a log level; using INFO", raw)


class RequestLogMiddleware:
    """One line per request; unhandled errors logged with a stack trace and turned into a generic 500 JSON."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        start = time.perf_counter()
        status = None

        async def send_and_track(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
            await send(message)

        try:
            await self.app(scope, receive, send_and_track)
        except Exception:
            request_log.exception("unhandled error method=%s path=%r", scope["method"], scope["path"])
            # Once the response has started nothing more can be sent; the connection just closes
            if status is None:
                status = 500
                await JSONResponse({"detail": "Internal server error"}, status_code=500)(scope, receive, send)
        finally:
            request_log.info(
                "request method=%s path=%r status=%s duration_ms=%.1f",
                scope["method"], scope["path"], status, (time.perf_counter() - start) * 1000,
            )
