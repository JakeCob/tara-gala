"""TG-20: POST /plan end to end with a fake LLM at the LLMClient seam.

Uses TG-24's validator (app.plan_validation, TG-24 plan section 2.2) as written; no second validator.
All trips, spots, legs and model replies are made up for tests only. "Today" is frozen (planner_data.TODAY).
"""

import ast
import logging
import os
import uuid
from datetime import timedelta
from pathlib import Path

import psycopg
import pytest
from psycopg.rows import dict_row

from planner_data import (
    D, HAIKU, MARKER_KEY, PARTY_NAME, RD, SONNET, TODAY, FakeClock, FakeLLM, load_planner_data, mutated, ok,
    request_body, stop, valid_plan,
)

APP = Path(__file__).resolve().parents[1] / "app"


# --- fixtures and helpers -----------------------------------------------------------------------

@pytest.fixture(autouse=True)
def frozen_today(monkeypatch):
    from app import planner

    monkeypatch.setattr(planner, "manila_today", lambda: TODAY)


@pytest.fixture()
def start(dsn, monkeypatch, request):
    """start(**env) boots the app with a clean LLM_*/PLANNER_* env plus `env`, and returns a TestClient."""
    from fastapi.testclient import TestClient

    def _start(**env):
        for k in list(os.environ):
            if k.startswith(("LLM_", "PLANNER_", "ANTHROPIC_")):
                monkeypatch.delenv(k)
        monkeypatch.setenv("DATABASE_URL", dsn)
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        from app import planner
        from app.flags import get_flags
        from app.main import app

        get_flags.cache_clear()
        planner._build_planner.cache_clear()
        tc = TestClient(app)
        tc.__enter__()

        def stop_client():
            tc.__exit__(None, None, None)
            app.dependency_overrides.clear()
            get_flags.cache_clear()
            planner._build_planner.cache_clear()

        request.addfinalizer(stop_client)
        return tc

    return _start


@pytest.fixture()
def api(start):
    return start(PLANNER_LIVE="true", LLM_API_KEY=MARKER_KEY)


@pytest.fixture()
def data(dsn, tmp_path):
    return load_planner_data(dsn, tmp_path)


def use(api, fake, clock=None, **env):
    """Serve POST /plan with a Planner around `fake`, built from env-style settings."""
    from app.limits import RateLimiter, SpendTracker
    from app.llm import LLMConfig
    from app.planner import Planner, get_planner

    cfg = LLMConfig.from_env({"LLM_API_KEY": MARKER_KEY, **env})
    clock = clock or FakeClock()
    planner = Planner(fake, cfg, RateLimiter(cfg.rate_limit_per_hour, clock=clock),
                      SpendTracker(cfg.daily_cap_usd, today=lambda: TODAY), clock=clock)
    api.app.dependency_overrides[get_planner] = lambda: planner
    return planner


def post(api, ip=None, **overrides):
    headers = {"X-Forwarded-For": ip} if ip else {}
    return api.post("/plan", json=request_body(**overrides), headers=headers)


def rows(dsn) -> list[dict]:
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        return conn.execute("select * from itineraries order by created_at").fetchall()


def expected_errors(dsn, plan, trip_date=D, return_date=RD):
    from app.plan_validation import validate_plan

    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        result = validate_plan(conn, plan, trip_date=trip_date, return_date=return_date)
    assert not result.ok
    return result.errors


def assert_error(r, status, code):
    assert r.status_code == status, r.text
    detail = r.json()["detail"]
    assert detail["code"] == code
    assert isinstance(detail["message"], str) and detail["message"]
    assert MARKER_KEY not in r.text and "Traceback" not in r.text


def set_trip(name):
    return lambda p, ids: p["outbound"].__setitem__("trip_id", ids.trips[name])


# --- happy path (B1, B2, B16) -------------------------------------------------------------------

def test_valid_plan_is_saved(api, data, dsn):
    plan = valid_plan(data)
    fake = FakeLLM(ok(plan))
    use(api, fake)
    r = post(api)
    assert r.status_code == 201, r.text
    body = r.json()
    assert set(body) == {"share_slug", "model", "attempts", "plan"}
    assert (body["model"], body["attempts"], body["plan"]) == (HAIKU, 1, plan)
    assert len(fake.calls) == 1
    saved = rows(dsn)
    assert len(saved) == 1
    row = saved[0]
    assert row["share_slug"] == body["share_slug"]
    assert len(row["share_slug"]) == 12  # the DB's random default
    assert (row["trip_date"], row["return_date"]) == (D, RD)
    assert row["party"] == request_body()["party"]  # stored as sent, names included
    assert float(row["budget_php"]) == 6000
    assert row["vibe"] == "food trip"
    assert row["plan"] == plan
    assert row["model"] == HAIKU


def test_model_sees_only_context_and_no_names(api, data):
    from app.planner_prompt import PLAN_SCHEMA, SYSTEM_PROMPT

    fake = FakeLLM(ok(valid_plan(data)))
    use(api, fake)
    assert post(api).status_code == 201
    call = fake.calls[0]
    assert call["system"] == SYSTEM_PROMPT
    assert call["schema"] == PLAN_SCHEMA
    assert call["model"] == HAIKU
    assert call["max_tokens"] == 8000
    assert call["timeout"] == 40
    assert PARTY_NAME not in call["user"] and PARTY_NAME not in call["system"]
    assert data.trips["out_weekend"] not in call["user"]
    assert data.trips["out_day"] in call["user"]


def test_uppercase_ids_are_accepted_and_stored_lowercase(api, data, dsn):
    plan = valid_plan(data)
    upper = mutated(plan, lambda p: p["outbound"].__setitem__("trip_id", p["outbound"]["trip_id"].upper()))
    use(api, FakeLLM(ok(upper)))
    r = post(api)
    assert r.status_code == 201, r.text
    assert rows(dsn)[0]["plan"]["outbound"]["trip_id"] == data.trips["out_day"]


# --- validation errors are fed back (B3, B4, B5, P28) -------------------------------------------

def _night_bus_too_early(p, ids):
    # 22:00 bus arrives 04:00 the next day, so day 1 is D+1 and there are 2 days; the first stop is at 03:30
    p["outbound"]["trip_id"] = ids.trips["out_night"]
    p["days"] = [
        {"day": 1, "stops": [stop(ids, "test-park", "03:30", "06:30", "vl-baguio>test-park")]},
        {"day": 2, "stops": [stop(ids, "test-market", "09:00", "10:00", "test-park>test-market")]},
    ]


MUTATIONS = {
    "unknown_trip": lambda p, ids: p["outbound"].__setitem__("trip_id", str(uuid.uuid4())),
    "unknown_spot": lambda p, ids: p["days"][0]["stops"][0].__setitem__("spot_id", str(uuid.uuid4())),
    "unknown_leg": lambda p, ids: p["days"][1]["stops"][0]["leg"].__setitem__("last_mile_route_id", str(uuid.uuid4())),
    "trip_not_running": set_trip("out_weekend"),  # weekends only; D is a Friday
    "before_bus_arrival": _night_bus_too_early,  # +1 day arrival
    "after_return": lambda p, ids: p["days"][2]["stops"][0].__setitem__("leave", "14:45"),  # bus 15:00, 30 min buffer
    "overlap": lambda p, ids: p["days"][0]["stops"][1].__setitem__("arrive", "14:30"),
    "closed": lambda p, ids: (p["days"][0]["stops"][0].__setitem__("leave", "18:30"),  # Test Park closes 18:00
                              p["days"][0]["stops"][1].update(arrive="18:45", leave="19:00"),
                              p["days"][0]["stops"][2].update(arrive="19:30")),
}


@pytest.mark.parametrize("code", list(MUTATIONS))
def test_validator_errors_reach_the_retry_prompt(api, data, dsn, code, caplog):
    plan = valid_plan(data)
    bad = mutated(plan, lambda p: MUTATIONS[code](p, data))
    errors = expected_errors(dsn, bad)
    assert code in {e.code for e in errors}
    fake = FakeLLM(ok(bad), ok(plan))
    use(api, fake)
    with caplog.at_level(logging.INFO):
        r = post(api)
    assert r.status_code == 201, r.text
    assert r.json()["attempts"] == 2
    retry = fake.calls[1]["user"]
    assert "Your previous answer had these problems:" in retry
    for e in errors[:20]:
        assert str(e) in retry
    previous = fake.calls[0]["user"]
    assert "previous answer" not in previous.lower()
    assert bad["outbound"]["trip_id"] in retry  # the previous answer is quoted back
    attempt_lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("planner attempt=1/")]
    assert attempt_lines and code in attempt_lines[0]
    assert len(rows(dsn)) == 1


def test_extra_field_is_a_shape_error_not_dropped(api, data, dsn):
    plan = valid_plan(data)
    bad = mutated(plan, lambda p: p.update(note="made up free text"))
    fake = FakeLLM(ok(bad), ok(plan))
    use(api, fake)
    r = post(api)
    assert r.status_code == 201, r.text
    assert r.json()["attempts"] == 2
    assert "note" not in rows(dsn)[0]["plan"]


@pytest.mark.parametrize("reply", [{"text": None, "stop": "other"}, {"text": "not json at all", "stop": "complete"}])
def test_reply_without_plan_json_is_retried(api, data, reply):
    fake = FakeLLM(reply, ok(valid_plan(data)))
    use(api, fake)
    r = post(api)
    assert r.status_code == 201, r.text
    assert r.json()["attempts"] == 2
    assert "Your previous answer had these problems:" in fake.calls[1]["user"]


def test_retries_exhausted_fails_cleanly(api, data, dsn, caplog):
    bad = mutated(valid_plan(data), lambda p: MUTATIONS["unknown_trip"](p, data))
    fake = FakeLLM(ok(bad), ok(bad), ok(bad))
    use(api, fake, PLANNER_MAX_ATTEMPTS="3")
    with caplog.at_level(logging.INFO):
        r = post(api)
    assert_error(r, 502, "no_valid_plan")
    assert len(fake.calls) == 3
    assert rows(dsn) == []
    failed = [r for r in caplog.records if r.getMessage().startswith("planner failed")]
    assert len(failed) == 1 and failed[0].levelno == logging.WARNING
    assert "code=no_valid_plan" in failed[0].getMessage() and "unknown_trip" in failed[0].getMessage()


def test_max_attempts_from_env(api, data):
    bad = mutated(valid_plan(data), lambda p: MUTATIONS["unknown_trip"](p, data))
    fake = FakeLLM(ok(bad), ok(bad))
    use(api, fake, PLANNER_MAX_ATTEMPTS="2")
    assert_error(post(api), 502, "no_valid_plan")
    assert len(fake.calls) == 2


# --- stop reasons and failures (B7 to B11) ------------------------------------------------------

def test_refusal_switches_to_fallback_once(api, data, dsn, caplog):
    fake = FakeLLM({"stop": "refused"}, ok(valid_plan(data)))
    use(api, fake)
    with caplog.at_level(logging.INFO):
        r = post(api)
    assert r.status_code == 201, r.text
    assert [c["model"] for c in fake.calls] == [HAIKU, SONNET]
    assert "previous answer" not in fake.calls[1]["user"].lower()  # no feedback after a refusal
    assert r.json()["model"] == SONNET
    assert rows(dsn)[0]["model"] == SONNET
    assert any(r.levelno == logging.WARNING and
               r.getMessage() == f"planner refused model={HAIKU} category=cyber fallback={SONNET}"
               for r in caplog.records)


def test_refusal_twice_fails_cleanly(api, data, dsn):
    fake = FakeLLM({"stop": "refused"}, {"stop": "refused"})
    use(api, fake)
    assert_error(post(api), 502, "refused")
    assert len(fake.calls) == 2
    assert rows(dsn) == []


def test_refusal_without_fallback_model(api, data, dsn):
    fake = FakeLLM({"stop": "refused"})
    use(api, fake, LLM_FALLBACK_MODEL="")
    assert_error(post(api), 502, "refused")
    assert len(fake.calls) == 1


def test_truncated_reply_retries_with_more_tokens_and_asks_for_shorter(api, data):
    fake = FakeLLM({"text": '{"outbound": ', "stop": "truncated"}, ok(valid_plan(data)))
    use(api, fake, LLM_MAX_TOKENS="5000")
    r = post(api)
    assert r.status_code == 201, r.text
    assert [c["max_tokens"] for c in fake.calls] == [5000, 10000]
    assert "Your previous answer was cut off. Return a shorter plan with fewer stops." in fake.calls[1]["user"]


def test_truncated_replies_stop_at_ceiling_and_count_as_attempts(api, data, dsn):
    fake = FakeLLM(*[{"text": None, "stop": "truncated"}] * 3)
    use(api, fake, LLM_MAX_TOKENS="6000")
    assert_error(post(api), 502, "no_valid_plan")
    assert [c["max_tokens"] for c in fake.calls] == [6000, 12000, 16000]
    assert rows(dsn) == []


def test_max_tokens_from_env(api, data):
    fake = FakeLLM(ok(valid_plan(data)))
    use(api, fake, LLM_MAX_TOKENS="1234")
    assert post(api).status_code == 201
    assert fake.calls[0]["max_tokens"] == 1234


@pytest.mark.parametrize("kind, status", [("timeout", None), ("connection", None), ("rate_limited", 429), ("api_error", 500)])
def test_llm_unavailable_is_503_without_retry(api, data, dsn, caplog, kind, status):
    from app.llm import LLMUnavailable

    fake = FakeLLM(LLMUnavailable(kind, status, "req_made_up"))
    use(api, fake)
    with caplog.at_level(logging.WARNING):
        r = post(api)
    assert_error(r, 503, "llm_unavailable")
    assert len(fake.calls) == 1
    assert rows(dsn) == []
    assert f"planner llm unavailable kind={kind}" in caplog.text


def test_deadline_caps_each_call_and_the_request(api, data, dsn):
    clock = FakeClock()
    bad = mutated(valid_plan(data), lambda p: MUTATIONS["unknown_trip"](p, data))
    fake = FakeLLM(ok(bad, advance=70), ok(bad, advance=70), ok(bad), clock=clock)
    use(api, fake, clock=clock, LLM_TIMEOUT_SECONDS="40", PLANNER_DEADLINE_SECONDS="100")
    assert_error(post(api), 504, "deadline")
    assert [c["timeout"] for c in fake.calls] == [40, 30]  # min(timeout, time left)
    assert rows(dsn) == []


# --- abuse and cost controls (B12, B13) ---------------------------------------------------------

def test_rate_limit_per_ip(api, data):
    fake = FakeLLM(*[ok(valid_plan(data))] * 3)
    use(api, fake, PLANNER_RATE_LIMIT_PER_HOUR="2")
    assert post(api, ip="203.0.113.5").status_code == 201
    assert post(api, ip="203.0.113.5").status_code == 201
    r = post(api, ip="203.0.113.5")
    assert_error(r, 429, "rate_limited")
    assert r.headers["retry-after"].isdigit() and int(r.headers["retry-after"]) > 0
    assert len(fake.calls) == 2  # no model call when limited
    assert post(api, ip="203.0.113.9").status_code == 201


def test_spoofed_forwarded_for_does_not_bypass_limit(api, data):
    use(api, FakeLLM(ok(valid_plan(data))), PLANNER_RATE_LIMIT_PER_HOUR="1")
    assert post(api, ip="1.1.1.1, 203.0.113.5").status_code == 201
    assert_error(post(api, ip="2.2.2.2, 203.0.113.5"), 429, "rate_limited")


def test_invalid_body_does_not_use_a_rate_limit_slot(api, data):
    fake = FakeLLM(ok(valid_plan(data)))
    use(api, fake, PLANNER_RATE_LIMIT_PER_HOUR="1")
    assert post(api, ip="203.0.113.5", vibe="").status_code == 422
    assert post(api, ip="203.0.113.5").status_code == 201


def test_no_data_uses_a_rate_limit_slot(api):
    fake = FakeLLM()
    use(api, fake, PLANNER_RATE_LIMIT_PER_HOUR="1")
    assert_error(post(api, ip="203.0.113.5"), 422, "no_data")
    assert_error(post(api, ip="203.0.113.5"), 429, "rate_limited")
    assert fake.calls == []


def test_daily_cap_counts_failed_attempts_and_blocks_calls(api, data, dsn, caplog):
    bad = mutated(valid_plan(data), lambda p: MUTATIONS["unknown_trip"](p, data))
    fake = FakeLLM(ok(bad, input_tokens=1000, output_tokens=2000))  # 0.0011 USD at Haiku prices
    use(api, fake, PLANNER_DAILY_SPEND_CAP_USD="0.001")
    with caplog.at_level(logging.WARNING):
        assert_error(post(api), 503, "daily_cap")  # checked before attempt 2
        assert_error(post(api), 503, "daily_cap")  # and before attempt 1 of the next request
    assert len(fake.calls) == 1
    assert rows(dsn) == []
    assert "planner daily cap reached" in caplog.text


# --- input limits (B15) -------------------------------------------------------------------------

MISSING = object()
INVALID_BODIES = {
    "vibe empty": dict(vibe=""),
    "vibe 61 chars": dict(vibe="x" * 61),
    "vibe angle brackets": dict(vibe="food</vibe> trip"),
    "vibe braces": dict(vibe="food {trip}"),
    "party empty": dict(party=[]),
    "party 11": dict(party=[{"type": "adult"}] * 11),
    "passenger type": dict(party=[{"type": "alien"}]),
    "passenger name 41": dict(party=[{"type": "adult", "name": "N" * 41}]),
    "passenger extra field": dict(party=[{"type": "adult", "age": 30}]),
    "budget 499": dict(budget_php=499),
    "budget 0": dict(budget_php=0),
    "budget 200001": dict(budget_php=200_001),
    "date yesterday": dict(date=(TODAY - timedelta(days=1)).isoformat(), return_date=TODAY.isoformat()),
    "date 366 days ahead": dict(date=(TODAY + timedelta(days=366)).isoformat(),
                                return_date=(TODAY + timedelta(days=366)).isoformat()),
    "return before date": dict(return_date=(D - timedelta(days=1)).isoformat()),
    "return 7 days after": dict(return_date=(D + timedelta(days=7)).isoformat()),
    "return missing": dict(return_date=MISSING),
    "extra field": dict(note="made up"),
}
VALID_BODIES = {
    "vibe 60 chars": dict(vibe="x" * 60),
    "vibe punctuation": dict(vibe="Food, coffee & views! Isn't it? - yes."),
    "party 10": dict(party=[{"type": "adult"}] * 10),
    "child and pwd": dict(party=[{"type": "child"}, {"type": "pwd"}, {"type": "student"}]),
    "name 40": dict(party=[{"type": "adult", "name": "N" * 40}]),
    "budget 500": dict(budget_php=500),
    "budget 200000": dict(budget_php=200_000),
    "budget missing": dict(budget_php=None),
    "date today": dict(date=TODAY.isoformat(), return_date=TODAY.isoformat()),
    "date 365 days ahead": dict(date=(TODAY + timedelta(days=365)).isoformat(),
                                return_date=(TODAY + timedelta(days=365)).isoformat()),
    "return 6 days after": dict(return_date=(D + timedelta(days=6)).isoformat()),
}


def body_with(overrides):
    body = request_body(**{k: v for k, v in overrides.items() if v is not MISSING})
    for k, v in overrides.items():
        if v is MISSING:
            body.pop(k)
    return body


@pytest.mark.parametrize("case", list(INVALID_BODIES))
def test_plan_request_rejects(case):
    from pydantic import ValidationError

    from app.planner import PlanRequest

    with pytest.raises(ValidationError):
        PlanRequest.model_validate(body_with(INVALID_BODIES[case]))


@pytest.mark.parametrize("case", list(VALID_BODIES))
def test_plan_request_accepts(case):
    from app.planner import PlanRequest

    PlanRequest.model_validate(body_with(VALID_BODIES[case]))


@pytest.mark.parametrize("case", list(INVALID_BODIES))
def test_invalid_body_is_422_with_no_model_call(api, data, case):
    fake = FakeLLM()
    use(api, fake)
    r = api.post("/plan", json=body_with(INVALID_BODIES[case]))
    assert r.status_code == 422, r.text
    assert fake.calls == []


# --- gating, config, data (B17 to B19; CORS B20 is in test_cors.py) ----------------------------------------------------

def test_flag_off_is_404(start, data, caplog):
    api = start(LLM_API_KEY=MARKER_KEY)  # PLANNER_LIVE unset: default off
    with caplog.at_level(logging.INFO):
        r = post(api)
    assert r.status_code == 404
    assert r.json() == {"detail": "Not Found"}
    assert "planner config" not in caplog.text  # config isn't even read


@pytest.mark.parametrize("env, names", [
    ({"PLANNER_LIVE": "true"}, "LLM_API_KEY"),
    ({"PLANNER_LIVE": "true", "LLM_API_KEY": MARKER_KEY, "LLM_PROVIDER": "openai"}, "LLM_PROVIDER"),
])
def test_not_configured_is_503(start, data, dsn, caplog, env, names):
    api = start(**env)  # the app still starts
    with caplog.at_level(logging.INFO):
        r = post(api)
    assert_error(r, 503, "not_configured")
    errors = [r.getMessage() for r in caplog.records if r.levelno == logging.ERROR]
    assert any(m.startswith("planner not configured") and names in m for m in errors)
    assert MARKER_KEY not in caplog.text
    assert rows(dsn) == []


def test_no_data_is_422_without_model_call(api):
    fake = FakeLLM()
    use(api, fake)
    assert_error(post(api), 422, "no_data")
    assert fake.calls == []


# --- logs (B21) ---------------------------------------------------------------------------------

def test_logs_cover_attempts_and_outcomes_but_never_secrets(start, data, monkeypatch, caplog):
    from app import planner
    from app.llm import LLMUnavailable

    plan = valid_plan(data)
    bad = mutated(plan, lambda p: MUTATIONS["unknown_trip"](p, data))
    fake = FakeLLM(
        ok(bad), ok(plan),  # request 1: retry then success
        {"stop": "refused"}, ok(bad), ok(bad),  # request 2: refusal, fallback, then out of attempts
        LLMUnavailable("timeout"),  # request 3
    )
    monkeypatch.setattr(planner, "make_llm_client", lambda cfg: fake)  # the real build path, with a fake client
    caplog.set_level(logging.DEBUG)
    api = start(PLANNER_LIVE="true", LLM_API_KEY=MARKER_KEY)
    vibe = "quiet pine walks"
    assert post(api, vibe=vibe).status_code == 201
    assert_error(post(api, vibe=vibe), 502, "no_valid_plan")
    assert_error(post(api, vibe=vibe), 503, "llm_unavailable")

    messages = [r.getMessage() for r in caplog.records]
    text = "\n".join(messages)
    for r in caplog.records:
        assert MARKER_KEY not in r.getMessage() and MARKER_KEY not in repr(r.args) and MARKER_KEY not in (r.exc_text or "")
    assert PARTY_NAME not in text
    assert vibe not in text
    assert "<vibe>" not in text  # no prompt text
    assert bad["outbound"]["trip_id"] not in text  # no answer text
    for call in fake.calls:
        assert PARTY_NAME not in call["user"] and PARTY_NAME not in call["system"]

    config = [m for m in messages if m.startswith("planner config ")]
    assert len(config) == 1
    assert f"provider=anthropic model={HAIKU} fallback={SONNET} effort=low" in config[0] and "key_set=True" in config[0]
    assert any(m.startswith(f"planner attempt=1/3 model={HAIKU} stop=complete") and "unknown_trip" in m for m in messages)
    assert any(m.startswith(f"planner attempt=2/3 model={HAIKU} stop=complete") and "errors=0" in m for m in messages)
    assert any(m.startswith("planner done share_slug=") and "attempts=2" in m for m in messages)
    assert any(m.startswith(f"planner refused model={HAIKU} category=cyber fallback={SONNET}") for m in messages)
    assert any(m.startswith("planner failed code=no_valid_plan attempts=3") for m in messages)
    assert any(m.startswith("planner llm unavailable kind=timeout") for m in messages)
    for m in messages:
        if m.startswith("planner attempt="):
            for part in ("raw_stop=", "input_tokens=", "output_tokens=", "cost_usd=", "duration_ms=", "request_id=", "codes="):
                assert part in m


# --- contracts with TG-24 and main.py -----------------------------------------------------------

def _resolve(node, defs):
    while "$ref" in node:
        node = defs[node["$ref"].split("/")[-1]]
    if "allOf" in node and len(node["allOf"]) == 1:
        return _resolve(node["allOf"][0], defs)
    return node


def _sample(node):
    if node.get("type") == "object":
        return {k: _sample(v) for k, v in node["properties"].items()}
    if node.get("type") == "array":
        return [_sample(node["items"])]
    if node.get("type") == "integer":
        return 1
    if node.get("format") == "uuid":
        return str(uuid.uuid4())
    if node.get("format") == "date":
        return D.isoformat()
    return "13:00"


def test_plan_schema_matches_plan_model():
    from app.plan_validation import Plan
    from app.planner_prompt import PLAN_SCHEMA

    theirs = Plan.model_json_schema(by_alias=True)
    defs = theirs.get("$defs", {})

    def compare(ours, other, path):
        other = _resolve(other, defs)
        if ours.get("type") == "object":
            assert set(ours["properties"]) == set(other["properties"]), path
            assert set(ours["required"]) == set(other.get("required", [])), path
            for k, v in ours["properties"].items():
                compare(v, other["properties"][k], f"{path}.{k}")
        elif ours.get("type") == "array":
            compare(ours["items"], other["items"], f"{path}[]")

    compare(PLAN_SCHEMA, theirs, "$")
    Plan.model_validate(_sample(PLAN_SCHEMA))  # anything shaped like the schema parses


def test_planner_reuses_tg24_validator():
    src = (APP / "planner.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    defined = {n.name for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.ClassDef))}
    assert not defined & {"validate_plan", "parse_plan", "check_plan", "Plan", "PlanError"}
    imported = {a.name for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module == "plan_validation"
                for a in n.names}
    assert "validate_plan" in imported


def _names(tree) -> set[str]:
    found = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Name):
            found.add(n.id)
        elif isinstance(n, ast.Attribute):
            found.add(n.attr)
        elif isinstance(n, ast.alias):
            found.add(n.name)
    return found


def test_get_flags_only_in_flags_and_main():
    # the planner reads request.app.state.flags, set once by TG-24's lifespan; no module adds its own call
    offenders = {p.name for p in APP.glob("*.py") if p.name not in {"flags.py", "main.py"}
                 and "get_flags" in _names(ast.parse(p.read_text(encoding="utf-8")))}
    assert offenders == set()
    assert (APP / "planner.py").exists()
