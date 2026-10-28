"""TG-20: the OpenRouter adapter (llm_openrouter.py), against a local stub HTTP server on 127.0.0.1.

Request and response shapes follow OpenRouter's docs (chat completions, structured outputs, errors,
reasoning tokens, provider routing), checked 2026-10-28. Responses below are made up for tests only.
"""

import logging
import socket
import time

import pytest

from planner_data import MARKER_KEY
from test_llm import SCHEMA, Stub, assert_no_key_in_logs

OR_HAIKU = "anthropic/claude-haiku-5.5"
OR_SONNET = "anthropic/claude-sonnet-5.5"


def completion(content='{"a": "b"}', finish_reason="stop", native="end_turn", refusal=None, model=OR_HAIKU):
    return {
        "id": "gen-made-up-1", "object": "chat.completion", "created": 1761600000, "model": model,
        "choices": [{
            "index": 0, "finish_reason": finish_reason, "native_finish_reason": native,
            "message": {"role": "assistant", "content": content, "refusal": refusal},
        }],
        "usage": {"prompt_tokens": 1200, "completion_tokens": 340, "total_tokens": 1540, "cost": 0.00029},
    }


@pytest.fixture()
def stub(caplog):
    caplog.set_level(logging.DEBUG)  # root: capture httpx debug lines too
    s = Stub()
    s.body = completion()
    yield s
    s.close()
    assert_no_key_in_logs(caplog.get_records("call"))


def adapter(stub, effort="low"):
    from app.llm_openrouter import OpenRouterClient

    return OpenRouterClient(api_key=MARKER_KEY, effort=effort, base_url=f"{stub.url}/api/v1")


def call(client, **kw):
    args = dict(model=OR_HAIKU, system="SYSTEM made up", user="USER made up", schema=SCHEMA, max_tokens=8000, timeout=5)
    args.update(kw)
    return client.complete(**args)


# --- config and factory -------------------------------------------------------------------------

def test_openrouter_config_defaults_to_openrouter_slugs():
    from app.llm import LLMConfig

    cfg = LLMConfig.from_env({"LLM_PROVIDER": "openrouter"})
    assert (cfg.model, cfg.fallback_model) == (OR_HAIKU, OR_SONNET)
    assert LLMConfig.from_env({"LLM_PROVIDER": "openrouter", "LLM_MODEL": "x/y"}).model == "x/y"
    assert LLMConfig.from_env({}).model == "claude-haiku-5-5"  # anthropic defaults unchanged


def test_make_llm_client_openrouter():
    from app.llm import LLMConfig, LLMConfigError, make_llm_client
    from app.llm_openrouter import OpenRouterClient

    cfg = LLMConfig.from_env({"LLM_PROVIDER": "openrouter", "LLM_API_KEY": MARKER_KEY})
    assert isinstance(make_llm_client(cfg), OpenRouterClient)
    with pytest.raises(LLMConfigError, match="LLM_API_KEY"):
        make_llm_client(LLMConfig.from_env({"LLM_PROVIDER": "openrouter"}))


def test_openrouter_prices_match_anthropic():
    from app.limits import PRICES_PER_MTOK

    assert PRICES_PER_MTOK[OR_HAIKU] == PRICES_PER_MTOK["claude-haiku-5-5"]
    assert PRICES_PER_MTOK[OR_SONNET] == PRICES_PER_MTOK["claude-sonnet-5-5"]


def test_default_base_url_is_blocked_at_send(no_real_llm_calls):
    from app.llm import LLMUnavailable
    from app.llm_openrouter import OpenRouterClient

    client = OpenRouterClient(api_key=MARKER_KEY, effort="low")
    with pytest.raises(LLMUnavailable) as e:
        call(client)
    assert e.value.kind == "connection"
    assert no_real_llm_calls == ["openrouter.ai"]
    no_real_llm_calls.clear()  # expected here; any other test that does this fails at teardown


# --- request ------------------------------------------------------------------------------------

def test_sends_the_documented_request(stub):
    call(adapter(stub, effort="medium"))
    assert len(stub.requests) == 1
    req = stub.requests[0]
    assert req["path"] == "/api/v1/chat/completions"
    assert req["headers"].get("authorization") == f"Bearer {MARKER_KEY}"
    body = req["json"]
    assert body["model"] == OR_HAIKU
    assert body["max_tokens"] == 8000
    assert body["messages"] == [{"role": "system", "content": "SYSTEM made up"}, {"role": "user", "content": "USER made up"}]
    assert body["response_format"] == {"type": "json_schema", "json_schema": {"name": "plan", "strict": True, "schema": SCHEMA}}
    assert body["reasoning"] == {"effort": "medium", "exclude": True}
    assert body["provider"]["require_parameters"] is True  # only providers that honour response_format
    for banned in ("temperature", "top_p", "top_k", "stream", "tools"):
        assert banned not in body


# --- response mapping ---------------------------------------------------------------------------

def test_returns_content_and_metadata(stub):
    r = call(adapter(stub))
    assert (r.text, r.stop, r.raw_stop, r.refusal_category) == ('{"a": "b"}', "complete", "end_turn", None)
    assert (r.model, r.input_tokens, r.output_tokens, r.request_id) == (OR_HAIKU, 1200, 340, "gen-made-up-1")


@pytest.mark.parametrize("finish, native, stop", [
    ("stop", "end_turn", "complete"),
    ("length", "max_tokens", "truncated"),
    ("content_filter", "refusal", "refused"),
    ("tool_calls", "tool_use", "other"),
])
def test_maps_finish_reasons(stub, finish, native, stop):
    stub.body = completion(finish_reason=finish, native=native)
    r = call(adapter(stub))
    assert (r.stop, r.raw_stop) == (stop, native)


def test_refusal_field_means_refused(stub):
    stub.body = completion(content=None, finish_reason="stop", refusal="made-up refusal text")
    r = call(adapter(stub))
    assert (r.stop, r.text) == ("refused", None)


def test_empty_content_gives_none(stub):
    stub.body = completion(content="")
    assert call(adapter(stub)).text is None


def test_error_body_on_200_raises_unavailable(stub):
    from app.llm import LLMUnavailable

    stub.body = {"error": {"code": 502, "message": "made-up provider error"}}
    with pytest.raises(LLMUnavailable) as e:
        call(adapter(stub))
    assert (e.value.kind, e.value.status) == ("api_error", 502)


def test_finish_reason_error_raises_unavailable(stub):
    from app.llm import LLMUnavailable

    stub.body = completion(content=None, finish_reason="error", native=None)
    with pytest.raises(LLMUnavailable) as e:
        call(adapter(stub))
    assert e.value.kind == "api_error"


@pytest.mark.parametrize("status, kind", [
    (500, "api_error"), (502, "api_error"), (503, "api_error"), (402, "api_error"), (400, "api_error"),
    (429, "rate_limited"), (408, "timeout"),
])
def test_status_errors_raise_unavailable_after_one_request(stub, status, kind):
    from app.llm import LLMUnavailable

    stub.status = status
    stub.body = {"error": {"code": status, "message": "made up"}}
    with pytest.raises(LLMUnavailable) as e:
        call(adapter(stub))
    assert (e.value.kind, e.value.status) == (kind, status)
    assert len(stub.requests) == 1  # no retries: the planner's deadline holds


def test_403_is_a_refusal_reply(stub):
    stub.status = 403
    stub.body = {"error": {"code": 403, "message": "made-up moderation flag"}}
    r = call(adapter(stub))
    assert (r.stop, r.raw_stop, r.text, r.input_tokens, r.output_tokens) == ("refused", "http_403", None, 0, 0)


def test_auth_error_never_echoes_key(stub):
    from app.llm import LLMUnavailable

    stub.status = 401
    stub.body = {"error": {"code": 401, "message": f"bad key {MARKER_KEY}"}}
    with pytest.raises(LLMUnavailable) as e:
        call(adapter(stub))
    assert e.value.status == 401
    assert MARKER_KEY not in str(e.value) and MARKER_KEY not in repr(e.value)


def test_non_json_body_raises_unavailable(stub):
    from app.llm import LLMUnavailable

    stub.body = "not json"  # Stub json-encodes this into a JSON string, which isn't an object
    with pytest.raises(LLMUnavailable) as e:
        call(adapter(stub))
    assert e.value.kind == "api_error"


def test_timeout(stub):
    from app.llm import LLMUnavailable

    stub.delay = 2.0
    started = time.monotonic()
    with pytest.raises(LLMUnavailable) as e:
        call(adapter(stub), timeout=0.3)
    assert e.value.kind == "timeout"
    assert time.monotonic() - started < 1.5
    assert len(stub.requests) == 1


def test_connection_refused(caplog):
    from app.llm import LLMUnavailable
    from app.llm_openrouter import OpenRouterClient

    caplog.set_level(logging.DEBUG)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    client = OpenRouterClient(api_key=MARKER_KEY, effort="low", base_url=f"http://127.0.0.1:{port}/api/v1")
    with pytest.raises(LLMUnavailable) as e:
        call(client)
    assert e.value.kind == "connection"
    assert_no_key_in_logs(caplog.records)
