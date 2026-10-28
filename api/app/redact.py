"""The one place secrets are masked: the API's log formatter and the CLI scripts (scraper, loader) both use it.

Stdlib only, so scripts can import it without pulling in FastAPI.
"""

import os
import re
from collections.abc import Iterable, Mapping
from urllib.parse import unquote, urlsplit

# Env vars whose values are masked; shorter values are too likely to match ordinary text
SECRET_NAME = re.compile(r"KEY|SECRET|TOKEN|PASSWORD", re.I)
MIN_SECRET_LEN = 8
# Shorter parsed "passwords" are usually urlsplit misreads (e.g. 'p' from 'p@ss:w/rd'); the whole DSN is still masked
MIN_DSN_PASSWORD_LEN = 4
URL_PASSWORD = re.compile(r"(\b[a-z][a-z0-9+.-]*://[^\s:/@]+:)[^\s@]+@", re.I)
KV_PASSWORD = re.compile(r"\b(password=)('(?:[^'\\]|\\.)*'|\S+)", re.I)  # libpq quotes values with spaces


def _password(dsn: str) -> str | None:
    try:
        return urlsplit(dsn).password
    except ValueError:
        return None


def secret_values(env: Mapping[str, str]) -> list[str]:
    """DATABASE_URL, its password (raw and URL-decoded), and any *KEY*/*SECRET*/*TOKEN*/*PASSWORD* var, longest first."""
    values = [v for k, v in env.items() if k == "DATABASE_URL" or SECRET_NAME.search(k)]
    if dsn := env.get("DATABASE_URL"):
        if password := _password(dsn):
            values += [password, unquote(password)]
    return sorted({v for v in values if v and len(v) >= MIN_SECRET_LEN}, key=len, reverse=True)


def dsn_secrets(dsn: str | None) -> list[str]:
    """The DSN itself plus its password, raw and URL-decoded, longest first.

    Unlike secret_values there's no 8-character floor: this is the password actually in use.
    """
    if not dsn:
        return []
    values = [dsn]
    if password := _password(dsn):
        values += [p for p in (password, unquote(password)) if len(p) >= MIN_DSN_PASSWORD_LEN]
    return sorted(set(values), key=len, reverse=True)


def redact(text: str, secrets: Iterable[str]) -> str:
    """Literal secrets (longest first) -> '***', then URL and password= forms."""
    for s in sorted({s for s in secrets if s}, key=len, reverse=True):
        text = text.replace(s, "***")
    text = URL_PASSWORD.sub(r"\1***@", text)
    return KV_PASSWORD.sub(r"\1***", text)


def redact_error(exc: BaseException, dsn: str | None, env: Mapping[str, str] = os.environ) -> str:
    """'<ErrorClass>: <message>' on one line, with env secrets and the DSN in use masked. For CLI scripts."""
    text = redact(str(exc), [*secret_values(env), *dsn_secrets(dsn)])
    return f"{type(exc).__name__}: {' '.join(text.split())}"  # collapse after masking, so no secret is split
