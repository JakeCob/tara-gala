"""TG-63 RA1: pictures through the LLM seam (plan.md section 2 "RA1, the seam", BDD R4 to R6, review S1 and S3).

Both adapters run against the local stub servers from test_llm.py / test_llm_openrouter.py on 127.0.0.1.
Nothing here reaches the network: conftest blocks any other host, and receipt_fakes' guard removes the LLM key
and blocks the real client factory. The pictures are made-up bytes, not real receipts.

R5 follows the plan review's S1 (2026-11-18), not the plan's first wording: the owner agreed to send pictures
to Anthropic's API (ticket decision 2), so the OpenRouter adapter refuses pictures instead of pinning a provider.
"""

import base64
import inspect
import logging
import socket
import traceback

import pytest

from planner_data import HAIKU, MARKER_KEY
from receipt_fakes import JPEG, PNG, RealClientBlocked, no_real_receipt_llm  # noqa: F401 (autouse guard)
from test_llm import SCHEMA, Stub, message
from test_llm_openrouter import OR_HAIKU, completion

B64_JPEG = base64.b64encode(JPEG).decode()
B64_PNG = base64.b64encode(PNG).decode()
PREFIX = B64_JPEG[:32]  # R6: never in an exception or a log record
RAW_MARK = "TG63-made-up-jpeg"  # the raw bytes' filler, in case a repr of the bytes leaks


@pytest.fixture()
def astub(monkeypatch, caplog):
    for var in ("ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"):
        monkeypatch.delenv(var, raising=False)
    caplog.set_level(logging.DEBUG)  # root: SDK and transport debug lines too
    s = Stub()
    yield s
    s.close()


@pytest.fixture()
def orstub(caplog):
    caplog.set_level(logging.DEBUG)
    s = Stub()
    s.body = completion()
    yield s
    s.close()


def anthropic_client(stub):
    from app.llm_anthropic import AnthropicClient

    return AnthropicClient(api_key=MARKER_KEY, effort="low", base_url=stub.url)


def openrouter_client(stub):
    from app.llm_openrouter import OpenRouterClient

    return OpenRouterClient(api_key=MARKER_KEY, effort="low", base_url=f"{stub.url}/api/v1")


def call(client, model=HAIKU, **kw):
    args = dict(model=model, system="SYSTEM made up", user="USER made up", schema=SCHEMA, max_tokens=300, timeout=5)
    args.update(kw)
    return client.complete(**args)


def assert_no_image_in(records, exc=None):
    """R6: no exception text, traceback or log record carries the picture (base64 prefix or raw bytes)."""
    texts = []
    if exc is not None:
        texts += [str(exc), repr(exc), "".join(traceback.format_exception(exc))]
    formatter = logging.Formatter("%(name)s %(message)s")
    for r in records:
        texts += [r.getMessage(), repr(r.args), formatter.format(r), r.exc_text or ""]
    for t in texts:
        assert PREFIX not in t
        assert RAW_MARK not in t


# --- the guard itself (review S3) ---------------------------------------------------------------

def test_guard_removes_the_key_and_blocks_the_real_factory():
    import os

    import app.llm

    assert "LLM_API_KEY" not in os.environ
    with pytest.raises(RealClientBlocked):
        app.llm.make_llm_client(app.llm.LLMConfig.from_env({"LLM_API_KEY": MARKER_KEY}))


# --- the Protocol (plan section 2) --------------------------------------------------------------

@pytest.mark.parametrize("target", ["app.llm:LLMClient", "app.llm_anthropic:AnthropicClient",
                                    "app.llm_openrouter:OpenRouterClient"])
def test_complete_takes_images_keyword_defaulting_to_empty(target):
    import importlib

    module, name = target.split(":")
    params = inspect.signature(getattr(importlib.import_module(module), name).complete).parameters
    assert "images" in params
    assert params["images"].kind is inspect.Parameter.KEYWORD_ONLY
    assert tuple(params["images"].default) == ()  # additive: the planner and the chat never pass it


# --- R4: Anthropic ------------------------------------------------------------------------------

def test_anthropic_sends_the_image_block_before_the_text(astub):
    call(anthropic_client(astub), images=[("image/jpeg", JPEG)])
    assert len(astub.requests) == 1
    body = astub.requests[0]["json"]
    assert body["messages"] == [{"role": "user", "content": [
        {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": B64_JPEG}},
        {"type": "text", "text": "USER made up"},
    ]}]
    assert body["system"] == "SYSTEM made up"
    assert body["max_tokens"] == 300
    assert body["output_config"] == {"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}}


def test_anthropic_sends_several_images_in_order_then_the_text(astub):
    call(anthropic_client(astub), images=[("image/jpeg", JPEG), ("image/png", PNG)])
    content = astub.requests[0]["json"]["messages"][0]["content"]
    assert [b["type"] for b in content] == ["image", "image", "text"]
    assert [(b["source"]["media_type"], b["source"]["data"]) for b in content[:2]] == [
        ("image/jpeg", B64_JPEG), ("image/png", B64_PNG)]


def test_anthropic_base64_is_exactly_the_given_bytes(astub):
    call(anthropic_client(astub), images=[("image/jpeg", JPEG)])
    data = astub.requests[0]["json"]["messages"][0]["content"][0]["source"]["data"]
    assert base64.b64decode(data, validate=True) == JPEG


def test_anthropic_without_images_sends_todays_request(astub):
    client = anthropic_client(astub)
    call(client)  # as the planner and the chat call it
    call(client, images=())
    without, empty = (r["json"] for r in astub.requests)
    assert without == empty
    assert without["messages"] == [{"role": "user", "content": "USER made up"}]  # a plain string, as today


def test_anthropic_reply_mapping_is_unchanged_with_images(astub):
    astub.body = message(text='{"a": "receipt"}')
    r = call(anthropic_client(astub), images=[("image/jpeg", JPEG)])
    assert (r.text, r.stop, r.model, r.input_tokens, r.output_tokens) == ('{"a": "receipt"}', "complete", HAIKU, 1200, 340)


# --- R5 (review S1): OpenRouter refuses pictures ------------------------------------------------

def test_openrouter_refuses_images_without_sending_anything(orstub):
    from app.llm import LLMUnavailable

    with pytest.raises(LLMUnavailable) as e:
        call(openrouter_client(orstub), model=OR_HAIKU, images=[("image/jpeg", JPEG)])
    assert e.value.kind == "images_unsupported"
    assert orstub.requests == []  # the picture never leaves the server for a second company
    assert_no_image_in([], e.value)


def test_openrouter_without_images_sends_todays_request(orstub):
    client = openrouter_client(orstub)
    call(client, model=OR_HAIKU)
    call(client, model=OR_HAIKU, images=())
    without, empty = (r["json"] for r in orstub.requests)
    assert without == empty
    assert without["messages"][1] == {"role": "user", "content": "USER made up"}
    assert without["provider"] == {"require_parameters": True}  # no pin, no extra routing


# --- R6: no picture in an exception or a log line -----------------------------------------------

def test_anthropic_success_logs_no_image(astub, caplog):
    call(anthropic_client(astub), images=[("image/jpeg", JPEG)])
    assert_no_image_in(caplog.get_records("call"))


@pytest.mark.parametrize("status", [400, 401, 413, 429, 500, 529])
def test_anthropic_status_errors_carry_no_image(astub, caplog, status):
    from app.llm import LLMUnavailable

    astub.status = status
    # a made-up error body that echoes the request back, as a proxy or a validation error might
    astub.body = {"type": "error", "error": {"type": "made_up_error", "message": f"bad image {B64_JPEG[:64]}"}}
    astub.headers = {"retry-after": "0"}
    with pytest.raises(LLMUnavailable) as e:
        call(anthropic_client(astub), images=[("image/jpeg", JPEG)])
    assert e.value.status == status
    assert_no_image_in(caplog.get_records("call"), e.value)


def test_anthropic_timeout_carries_no_image(astub, caplog):
    from app.llm import LLMUnavailable

    astub.delay = 2.0
    with pytest.raises(LLMUnavailable) as e:
        call(anthropic_client(astub), images=[("image/jpeg", JPEG)], timeout=0.3)
    assert e.value.kind == "timeout"
    assert_no_image_in(caplog.get_records("call"), e.value)


def test_anthropic_connection_refused_carries_no_image(monkeypatch, caplog):
    from app.llm import LLMUnavailable
    from app.llm_anthropic import AnthropicClient

    monkeypatch.delenv("ANTHROPIC_BASE_URL", raising=False)
    caplog.set_level(logging.DEBUG)
    with socket.socket() as s:  # a free port with nothing listening
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    client = AnthropicClient(api_key=MARKER_KEY, effort="low", base_url=f"http://127.0.0.1:{port}")
    with pytest.raises(LLMUnavailable) as e:
        call(client, images=[("image/jpeg", JPEG)])
    assert e.value.kind == "connection"
    assert_no_image_in(caplog.records, e.value)
