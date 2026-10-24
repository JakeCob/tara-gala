"""Database access. One connection pool for the app, opened on startup."""

import os
from contextlib import contextmanager

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

_pool: ConnectionPool | None = None


def open_pool(dsn: str | None = None) -> ConnectionPool:
    global _pool
    dsn = dsn or os.environ.get("DATABASE_URL")
    if not dsn:
        raise RuntimeError("DATABASE_URL is not set")
    # prepare_threshold=None keeps it compatible with Supabase's pooler
    _pool = ConnectionPool(
        dsn,
        min_size=1,
        max_size=5,
        kwargs={"row_factory": dict_row, "prepare_threshold": None},
        open=True,
    )
    return _pool


def close_pool() -> None:
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


@contextmanager
def get_conn():
    if _pool is None:
        raise RuntimeError("Database pool is not open")
    with _pool.connection() as conn:
        yield conn
