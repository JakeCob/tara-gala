"""Planner abuse and cost controls (TG-20): per-IP rate limit, daily spend cap, client IP.

Both limits live in process memory: they reset on every restart or redeploy and would be per-instance
if Railway ever ran two. Fine for one instance; move them to Postgres if that changes.
"""

import hashlib
import logging
import secrets
import threading
import time
from collections import deque
from collections.abc import Callable
from datetime import date as Date
from datetime import datetime
from zoneinfo import ZoneInfo

from starlette.requests import Request

logger = logging.getLogger("tara_gala.api")

MANILA_TZ = ZoneInfo("Asia/Manila")

# USD per million tokens (input, output), prompts up to 100k tokens (TG-19 ADR). Local models go in at 0.0.
PRICES_PER_MTOK: dict[str, tuple[float, float]] = {
    "claude-haiku-5-5": (0.10, 0.50),
    "claude-sonnet-5-5": (2.00, 10.00),
    "anthropic/claude-haiku-5.5": (0.10, 0.50),  # OpenRouter, same price (its models endpoint, 2026-10-28)
    "anthropic/claude-sonnet-5.5": (2.00, 10.00),
}
_HIGHEST_PRICE = (max(p[0] for p in PRICES_PER_MTOK.values()), max(p[1] for p in PRICES_PER_MTOK.values()))


class RateLimiter:
    """At most `limit` hits per key in any `window_s` seconds. Blocked hits don't use a slot."""

    def __init__(self, limit: int, window_s: float = 3600, clock: Callable[[], float] = time.monotonic):
        self.limit = limit
        self.window_s = window_s
        self._clock = clock
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()  # sync endpoints run in a threadpool

    def hit(self, key: str) -> float | None:
        """Record a hit. Returns None when allowed, otherwise the seconds until the next slot frees up."""
        with self._lock:
            now = self._clock()
            if len(self._hits) > 1000:
                self._sweep(now)
            hits = self._hits.setdefault(key, deque())
            while hits and hits[0] <= now - self.window_s:
                hits.popleft()
            if len(hits) >= self.limit:
                return hits[0] + self.window_s - now
            hits.append(now)
            return None

    def _sweep(self, now: float) -> None:
        for key in [k for k, hits in self._hits.items() if not hits or hits[-1] <= now - self.window_s]:
            del self._hits[key]


def manila_today() -> Date:
    return datetime.now(MANILA_TZ).date()


class SpendTracker:
    """Estimated LLM spend for the current Manila day, against a cap. Rolls over at Manila midnight."""

    def __init__(self, cap_usd: float, today: Callable[[], Date] = manila_today):
        self.cap_usd = cap_usd
        self._today = today
        self._day = today()
        self._spent = 0.0
        self._warned: set[str] = set()
        self._lock = threading.Lock()

    def _roll(self) -> None:
        day = self._today()
        if day != self._day:
            self._day, self._spent = day, 0.0

    def allowed(self) -> bool:
        with self._lock:
            self._roll()
            return self._spent < self.cap_usd

    def add(self, model: str, input_tokens: int, output_tokens: int) -> float:
        """Charge one call and return its estimated cost in USD."""
        with self._lock:
            prices = PRICES_PER_MTOK.get(model)
            if prices is None:
                prices = _HIGHEST_PRICE
                if model not in self._warned:
                    self._warned.add(model)
                    logger.warning("planner unknown price model=%s; charging the highest listed price", model)
            cost = (input_tokens * prices[0] + output_tokens * prices[1]) / 1_000_000
            self._roll()
            self._spent += cost
            return cost

    @property
    def spent_today(self) -> float:
        with self._lock:
            self._roll()
            return self._spent


def client_ip(request: Request) -> str:
    """The last X-Forwarded-For entry (the one Railway's edge wrote), else the peer address.

    Uvicorn only trusts proxy headers from 127.0.0.1, so on Railway request.client is the edge proxy.
    Earlier entries can be spoofed by the client, so they're ignored.
    """
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        last = forwarded.split(",")[-1].strip()
        if last:
            return last
    return request.client.host if request.client else "unknown"


_IP_SALT = secrets.token_bytes(16)  # per process: hashes correlate within a deploy but can't be brute-forced back


def ip_hash(ip: str) -> str:
    """Short salted hash for logs; raw IPs are never logged."""
    return hashlib.sha256(_IP_SALT + ip.encode()).hexdigest()[:8]
