"""The API's one logging setup: root handler, level from LOG_LEVEL, uvicorn routed through it, secrets redacted.

Also the request middleware: one line per request, and unhandled errors logged with a
stack trace and turned into a generic 500 JSON. See README section 5.
"""

import logging
import os
import sys
import time
from collections.abc import Iterable, Mapping

from starlette.responses import JSONResponse

from .redact import KV_PASSWORD, MIN_SECRET_LEN, SECRET_NAME, URL_PASSWORD, redact, secret_values  # noqa: F401 (re-exported)

LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")
FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"

request_log = logging.getLogger("tara_gala.request")


class RedactingFormatter(logging.Formatter):
    """Masks secret env values and URL or key=value passwords in the final text, tracebacks included."""

    def __init__(self, secrets: Iterable[str]):
        super().__init__(FORMAT)
        self._secrets = sorted(set(secrets), key=len, reverse=True)

    def format(self, record: logging.LogRecord) -> str:
        return redact(super().format(record), self._secrets)  # includes exc_text and stack_info


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
        except Exception as exc:
            # class name only on this line (greppable); the message is in the redacted traceback below it
            request_log.exception("unhandled error method=%s path=%r error=%s", scope["method"], scope["path"], type(exc).__name__)
            # Once the response has started nothing more can be sent; the connection just closes
            if status is None:
                status = 500
                await JSONResponse({"detail": "Internal server error"}, status_code=500)(scope, receive, send)
        finally:
            request_log.info(
                "request method=%s path=%r status=%s duration_ms=%.1f",
                scope["method"], scope["path"], status, (time.perf_counter() - start) * 1000,
            )
