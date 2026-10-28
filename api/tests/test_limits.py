"""TG-20: in-memory rate limit, daily spend cap and client IP (limits.py). Fake clocks, no sleeps."""

import logging
import threading
from datetime import timedelta

import pytest
from starlette.requests import Request

from planner_data import HAIKU, SONNET, TODAY, FakeClock


# --- RateLimiter (B12) --------------------------------------------------------------------------

def test_rate_limiter_allows_up_to_limit_then_blocks():
    from app.limits import RateLimiter

    clock = FakeClock()
    rl = RateLimiter(2, window_s=3600, clock=clock)
    assert rl.hit("a") is None
    clock.t += 600
    assert rl.hit("a") is None
    clock.t += 600
    wait = rl.hit("a")
    assert wait == pytest.approx(3600 - 1200)  # until the oldest hit leaves the window


def test_rate_limiter_is_per_key():
    from app.limits import RateLimiter

    rl = RateLimiter(1, clock=FakeClock())
    assert rl.hit("a") is None
    assert rl.hit("a") is not None
    assert rl.hit("b") is None


def test_rate_limiter_allows_again_after_window():
    from app.limits import RateLimiter

    clock = FakeClock()
    rl = RateLimiter(1, window_s=3600, clock=clock)
    assert rl.hit("a") is None
    assert rl.hit("a") is not None
    clock.t += 3600
    assert rl.hit("a") is None


def test_rate_limiter_blocked_hits_do_not_use_slots():
    from app.limits import RateLimiter

    clock = FakeClock()
    rl = RateLimiter(1, window_s=3600, clock=clock)
    assert rl.hit("a") is None
    clock.t += 3000
    assert rl.hit("a") is not None  # blocked; must not push the window out
    clock.t += 600
    assert rl.hit("a") is None


def test_rate_limiter_is_thread_safe():
    from app.limits import RateLimiter

    rl = RateLimiter(5, clock=FakeClock())
    results, start = [], threading.Barrier(20)

    def worker():
        start.wait()
        results.append(rl.hit("same-ip"))

    threads = [threading.Thread(target=worker) for _ in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sum(1 for r in results if r is None) == 5


# --- SpendTracker and prices (B13, B14) ---------------------------------------------------------

def test_prices_match_adr():
    from app.limits import PRICES_PER_MTOK

    assert PRICES_PER_MTOK[HAIKU] == (0.10, 0.50)
    assert PRICES_PER_MTOK[SONNET] == (2.00, 10.00)


def test_spend_cost_from_tokens():
    from app.limits import SpendTracker

    st = SpendTracker(100.0, today=lambda: TODAY)
    assert st.add(HAIKU, 1_000_000, 1_000_000) == pytest.approx(0.60)
    assert st.add(SONNET, 500_000, 100_000) == pytest.approx(2.00)
    assert st.spent_today == pytest.approx(2.60)


def test_unknown_model_charged_at_highest_price_and_warns_once(caplog):
    from app.limits import SpendTracker

    st = SpendTracker(100.0, today=lambda: TODAY)
    with caplog.at_level(logging.WARNING):
        assert st.add("made-up-model", 1_000_000, 1_000_000) == pytest.approx(12.00)
        st.add("made-up-model", 10, 10)
    assert sum("made-up-model" in r.getMessage() for r in caplog.records if r.levelno == logging.WARNING) == 1


def test_spend_cap_blocks_once_reached():
    from app.limits import SpendTracker

    st = SpendTracker(0.001, today=lambda: TODAY)
    assert st.allowed()
    st.add(HAIKU, 1000, 1000)  # 0.0001 + 0.0005
    assert st.allowed()
    st.add(HAIKU, 1000, 1000)  # 0.0012 total, over the cap
    assert not st.allowed()


def test_spend_resets_when_manila_day_changes():
    from app.limits import SpendTracker

    day = {"d": TODAY}
    st = SpendTracker(0.001, today=lambda: day["d"])
    st.add(HAIKU, 10_000, 10_000)
    assert not st.allowed()
    day["d"] = TODAY + timedelta(days=1)
    assert st.allowed()
    assert st.spent_today == 0


# --- client_ip (plan 2.8) -----------------------------------------------------------------------

def req(headers: dict | None = None, host: str = "10.0.0.1") -> Request:
    raw = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    return Request({"type": "http", "method": "POST", "path": "/plan", "headers": raw, "client": (host, 50000)})


def test_client_ip_uses_last_forwarded_entry():
    from app.limits import client_ip

    assert client_ip(req({"X-Forwarded-For": "1.1.1.1, 203.0.113.5"})) == "203.0.113.5"
    assert client_ip(req({"X-Forwarded-For": " 203.0.113.9 "})) == "203.0.113.9"


def test_client_ip_spoofed_first_entry_does_not_change_bucket():
    from app.limits import client_ip

    a = client_ip(req({"X-Forwarded-For": "1.1.1.1, 203.0.113.5"}))
    b = client_ip(req({"X-Forwarded-For": "2.2.2.2, 203.0.113.5"}))
    assert a == b


def test_client_ip_falls_back_to_peer():
    from app.limits import client_ip

    assert client_ip(req()) == "10.0.0.1"
