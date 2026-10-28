"""TG-20: the provider-neutral LLM seam (llm.py) and the Anthropic adapter (llm_anthropic.py).

The adapter is tested against a local stub HTTP server on 127.0.0.1; nothing here reaches the network.
Responses below are made up for tests only.
"""

import ast
import json
import logging
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from planner_data import HAIKU, MARKER_KEY, SONNET

APP = Path(__file__).resolve().parents[1] / "app"
SCHEMA = {"type": "object", "properties": {"a": {"type": "string"}}, "required": ["a"], "additionalProperties": False}


# --- LLMConfig.from_env (plan 2.7) --------------------------------------------------------------

def test_config_defaults():
    from app.llm import LLMConfig

    cfg = LLMConfig.from_env({})
    assert cfg.provider == "anthropic"
    assert cfg.model == HAIKU
    assert cfg.fallback_model == SONNET
    assert cfg.api_key == ""
    assert cfg.effort == "low"
    assert cfg.max_tokens == 8000
    assert cfg.timeout_s == 40
    assert cfg.max_attempts == 3
    assert cfg.deadline_s == 100
    assert cfg.daily_cap_usd == 1.00
    assert cfg.rate_limit_per_hour == 10


def test_config_reads_every_var():
    from app.llm import LLMConfig

    cfg = LLMConfig.from_env({
        "LLM_PROVIDER": "anthropic", "LLM_MODEL": "m1", "LLM_FALLBACK_MODEL": "m2", "LLM_API_KEY": MARKER_KEY,
        "LLM_EFFORT": "medium", "LLM_MAX_TOKENS": " 1234 ", "LLM_TIMEOUT_SECONDS": "7", "PLANNER_MAX_ATTEMPTS": "5",
        "PLANNER_DEADLINE_SECONDS": "60", "PLANNER_DAILY_SPEND_CAP_USD": "0.25", "PLANNER_RATE_LIMIT_PER_HOUR": "4",
    })
    assert (cfg.model, cfg.fallback_model, cfg.api_key, cfg.effort) == ("m1", "m2", MARKER_KEY, "medium")
    assert (cfg.max_tokens, cfg.timeout_s, cfg.max_attempts, cfg.deadline_s) == (1234, 7, 5, 60)
    assert (cfg.daily_cap_usd, cfg.rate_limit_per_hour) == (0.25, 4)


def test_config_empty_fallback_means_none():
    from app.llm import LLMConfig

    assert LLMConfig.from_env({"LLM_FALLBACK_MODEL": ""}).fallback_model is None


def test_config_max_tokens_clamped_to_ceiling():
    from app.llm import LLMConfig

    assert LLMConfig.from_env({"LLM_MAX_TOKENS": "99999"}).max_tokens == 16000


@pytest.mark.parametrize("var, raw, attr, default", [
    ("LLM_MAX_TOKENS", "lots-xyz", "max_tokens", 8000),
    ("LLM_TIMEOUT_SECONDS", "soon-xyz", "timeout_s", 40),
    ("PLANNER_MAX_ATTEMPTS", "many-xyz", "max_attempts", 3),
    ("PLANNER_DEADLINE_SECONDS", "later-xyz", "deadline_s", 100),
    ("PLANNER_DAILY_SPEND_CAP_USD", "free-xyz", "daily_cap_usd", 1.00),
    ("PLANNER_DAILY_SPEND_CAP_USD", "-5", "daily_cap_usd", 1.00),  # never unlimited by accident
    ("PLANNER_RATE_LIMIT_PER_HOUR", "fast-xyz", "rate_limit_per_hour", 10),
    ("LLM_EFFORT", "turbo-xyz", "effort", "low"),
])
def test_config_bad_value_falls_back_and_warns_without_the_value(caplog, var, raw, attr, default):
    from app.llm import LLMConfig

    with caplog.at_level(logging.WARNING):
        cfg = LLMConfig.from_env({var: raw})
    assert getattr(cfg, attr) == default
    assert var in caplog.text
    if raw.endswith("-xyz"):
        assert raw not in caplog.text


def test_config_repr_hides_key():
    from app.llm import LLMConfig

    cfg = LLMConfig.from_env({"LLM_API_KEY": MARKER_KEY})
    assert MARKER_KEY not in repr(cfg)
    assert MARKER_KEY not in str(cfg)


# --- make_llm_client (B24) ----------------------------------------------------------------------

def test_make_llm_client_anthropic():
    from app.llm import LLMConfig, make_llm_client
    from app.llm_anthropic import AnthropicClient

    client = make_llm_client(LLMConfig.from_env({"LLM_API_KEY": MARKER_KEY}))
    assert isinstance(client, AnthropicClient)


@pytest.mark.parametrize("provider", ["openai", "ollama", ""])
def test_make_llm_client_other_provider_is_config_error(provider):
    from app.llm import LLMConfig, LLMConfigError, make_llm_client

    with pytest.raises(LLMConfigError):
        make_llm_client(LLMConfig.from_env({"LLM_PROVIDER": provider, "LLM_API_KEY": MARKER_KEY}))


def _anthropic_imports(path: Path) -> list[str]:
    found = []
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            found += [a.name for a in node.names if a.name.split(".")[0] == "anthropic"]
        elif isinstance(node, ast.ImportFrom) and node.module and node.module.split(".")[0] == "anthropic":
            found.append(node.module)
    return found


def test_only_the_adapter_imports_anthropic():
    for name in ("llm.py", "llm_anthropic.py", "limits.py", "planner.py", "planner_prompt.py", "planner_context.py"):
        assert (APP / name).exists(), f"missing app/{name}"
    assert _anthropic_imports(APP / "llm_anthropic.py")
    offenders = {p.name for p in APP.glob("*.py") if p.name != "llm_anthropic.py" and _anthropic_imports(p)}
    assert offenders == set()


# --- the network guard (review should-fix 2) ----------------------------------------------------

def test_default_base_url_is_blocked_at_send(no_real_llm_calls, monkeypatch):
    from app.llm import LLMUnavailable
    from app.llm_anthropic import AnthropicClient

    for var in ("ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"):
        monkeypatch.delenv(var, raising=False)
    client = AnthropicClient(api_key=MARKER_KEY, effort="low")  # building a client is fine
    with pytest.raises(LLMUnavailable) as e:
        client.complete(model=HAIKU, system="s", user="u", schema=SCHEMA, max_tokens=100, timeout=5)
    assert e.value.kind == "connection"
    assert no_real_llm_calls == ["api.anthropic.com"]
    no_real_llm_calls.clear()  # expected here; any other test that does this fails at teardown


# --- the adapter against a stub server (B22, B23, review should-fixes 3 and 5) -----------------

def message(text='{"a": "b"}', stop_reason="end_turn", stop_details=None, content=None, model=HAIKU):
    if content is None:
        content = [{"type": "thinking", "thinking": "", "signature": "sig-made-up"}, {"type": "text", "text": text}]
    return {
        "id": "msg_made_up", "type": "message", "role": "assistant", "model": model, "content": content,
        "stop_reason": stop_reason, "stop_sequence": None, "stop_details": stop_details,
        "usage": {"input_tokens": 1200, "output_tokens": 340},
    }


class Stub:
    """A tiny Messages API stand-in. Set .status, .body, .headers, .delay; read .requests."""

    def __init__(self):
        self.status, self.body, self.headers, self.delay = 200, message(), {}, 0.0
        self.requests: list[dict] = []
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                raw = self.rfile.read(int(self.headers.get("content-length", 0)))
                stub.requests.append({"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()},
                                      "json": json.loads(raw)})
                if stub.delay:
                    time.sleep(stub.delay)
                payload = json.dumps(stub.body).encode()
                try:
                    self.send_response(stub.status)
                    self.send_header("content-type", "application/json")
                    self.send_header("request-id", "req_stub_1")
                    for k, v in stub.headers.items():
                        self.send_header(k, v)
                    self.send_header("content-length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture()
def stub(monkeypatch, caplog):
    for var in ("ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"):
        monkeypatch.delenv(var, raising=False)
    caplog.set_level(logging.DEBUG)  # root: capture SDK and transport debug lines too
    s = Stub()
    yield s
    s.close()
    assert_no_key_in_logs(caplog.get_records("call"))  # caplog.records at teardown holds only teardown records


def assert_no_key_in_logs(records):
    for r in records:
        assert MARKER_KEY not in r.getMessage()
        assert MARKER_KEY not in repr(r.args)
        assert MARKER_KEY not in (r.exc_text or "")


def adapter(stub, effort="low"):
    from app.llm_anthropic import AnthropicClient

    return AnthropicClient(api_key=MARKER_KEY, effort=effort, base_url=stub.url)  # default max_retries on purpose


def call(client, **kw):
    args = dict(model=HAIKU, system="SYSTEM made up", user="USER made up", schema=SCHEMA, max_tokens=8000, timeout=5)
    args.update(kw)
    return client.complete(**args)


def test_adapter_sends_the_documented_request(stub):
    call(adapter(stub, effort="medium"))
    assert len(stub.requests) == 1
    req = stub.requests[0]
    assert req["path"] == "/v1/messages"
    assert req["headers"].get("authorization") == f"Bearer {MARKER_KEY}"  # SDK 2.x sends api_key= as a Bearer token
    assert "x-api-key" not in req["headers"]  # sent once, not twice
    body = req["json"]
    assert body["model"] == HAIKU
    assert body["max_tokens"] == 8000
    assert body["system"] == "SYSTEM made up"
    assert body["messages"] == [{"role": "user", "content": "USER made up"}]
    assert body["output_config"] == {"effort": "medium", "format": {"type": "json_schema", "schema": SCHEMA}}
    for banned in ("temperature", "top_p", "top_k", "thinking", "fallbacks", "stream"):
        assert banned not in body


def test_adapter_returns_first_text_block_and_metadata(stub):
    r = call(adapter(stub))
    assert r.text == '{"a": "b"}'  # the leading thinking block is skipped
    assert (r.stop, r.raw_stop, r.refusal_category) == ("complete", "end_turn", None)
    assert (r.model, r.input_tokens, r.output_tokens, r.request_id) == (HAIKU, 1200, 340, "req_stub_1")


@pytest.mark.parametrize("raw, stop", [("end_turn", "complete"), ("max_tokens", "truncated"), ("pause_turn", "other"), ("stop_sequence", "other")])
def test_adapter_maps_stop_reasons(stub, raw, stop):
    stub.body = message(stop_reason=raw)
    r = call(adapter(stub))
    assert (r.stop, r.raw_stop) == (stop, raw)


def test_adapter_maps_refusal_with_category(stub):
    stub.body = message(stop_reason="refusal", content=[],
                        stop_details={"type": "refusal", "category": "cyber", "explanation": "made up"})
    r = call(adapter(stub))
    assert (r.stop, r.raw_stop, r.refusal_category, r.text) == ("refused", "refusal", "cyber", None)


def test_adapter_refusal_without_details(stub):
    stub.body = message(stop_reason="refusal", content=[], stop_details=None)
    r = call(adapter(stub))
    assert (r.stop, r.refusal_category) == ("refused", None)


def test_adapter_no_text_block_gives_none(stub):
    stub.body = message(content=[{"type": "thinking", "thinking": "", "signature": "sig-made-up"}])
    assert call(adapter(stub)).text is None


@pytest.mark.parametrize("status, kind", [(500, "api_error"), (529, "api_error"), (429, "rate_limited")])
def test_adapter_status_errors_raise_unavailable_after_one_request(stub, status, kind):
    from app.llm import LLMUnavailable

    stub.status = status
    stub.body = {"type": "error", "error": {"type": "made_up_error", "message": "made up"}}
    stub.headers = {"retry-after": "0"}
    with pytest.raises(LLMUnavailable) as e:
        call(adapter(stub))
    assert (e.value.kind, e.value.status, e.value.request_id) == (kind, status, "req_stub_1")
    assert len(stub.requests) == 1  # no SDK retries: the planner's deadline holds (review should-fix 3)


def test_adapter_auth_error_never_echoes_key(stub):
    from app.llm import LLMUnavailable

    stub.status = 401
    stub.body = {"type": "error", "error": {"type": "authentication_error", "message": f"invalid x-api-key {MARKER_KEY}"}}
    with pytest.raises(LLMUnavailable) as e:
        call(adapter(stub))
    assert e.value.status == 401
    assert MARKER_KEY not in str(e.value)
    assert MARKER_KEY not in repr(e.value)


def test_adapter_timeout(stub):
    from app.llm import LLMUnavailable

    stub.delay = 2.0
    started = time.monotonic()
    with pytest.raises(LLMUnavailable) as e:
        call(adapter(stub), timeout=0.3)
    assert e.value.kind == "timeout"
    assert time.monotonic() - started < 1.5  # one attempt, not retried
    assert len(stub.requests) == 1


def test_adapter_connection_refused(monkeypatch, caplog):
    from app.llm import LLMUnavailable
    from app.llm_anthropic import AnthropicClient

    monkeypatch.delenv("ANTHROPIC_BASE_URL", raising=False)
    caplog.set_level(logging.DEBUG)
    with socket.socket() as s:  # grab a free port, then close it so nothing listens
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    client = AnthropicClient(api_key=MARKER_KEY, effort="low", base_url=f"http://127.0.0.1:{port}")
    with pytest.raises(LLMUnavailable) as e:
        call(client)
    assert e.value.kind == "connection"
    assert_no_key_in_logs(caplog.records)
