"""TG-63 test helpers: a fake LLM client for the receipt scan, made-up model replies, made-up pictures,
and the guard that stops any receipt test from reaching a real provider (plan review S3).

Every reply, name and number here is made up for tests only. None of it is a real receipt, person or account.
The pictures are a few magic bytes plus filler, not real images: the adapters and the route only pass bytes on.
"""

import json

import pytest

# --- made-up pictures (magic bytes first, as the route checks them) -----------------------------
JPEG = b"\xff\xd8\xff\xe0" + b"TG63-made-up-jpeg-" * 8
PNG = b"\x89PNG\r\n\x1a\n" + b"TG63-made-up-png-" * 8
WEBP = b"RIFF\x00\x00\x00\x00WEBP" + b"TG63-made-up-webp-" * 8
NOT_AN_IMAGE = b"this is text pretending to be a .jpg (made up)"

# --- made-up personal data a reply might carry; none of it may reach a log, a reply or an error ---
MADE_UP_NAME = "Juana Dela Prueba"
MADE_UP_ACCOUNT = "123456789012"  # 12 digits
MADE_UP_PHONE = "0917 123 4567"


def model_reply(kind="receipt", amount_php=1280.0, amount_confident=True, what_for="Lunch at Good Taste Cafe",
                budget_key=None, currency_php=True) -> dict:
    """The model's JSON answer (options.md section 2 step 3), before the server's post-processing."""
    return {"kind": kind, "amount_php": amount_php, "amount_confident": amount_confident, "what_for": what_for,
            "budget_key": budget_key, "currency_php": currency_php}


def leaky_reply(**kw) -> dict:
    """A reply whose note carries a made-up name, account number and phone, as a careless model might write."""
    return model_reply(what_for=f"Sent to {MADE_UP_NAME} acct {MADE_UP_ACCOUNT} {MADE_UP_PHONE}", **kw)


class FakeReceiptLLM:
    """Implements LLMClient, `images` included. Each script item is an exception to raise or a dict of LLMReply fields.

    `text` may be a dict (dumped to JSON). `model` defaults to the model that was asked for. Records every call,
    with the images it was given, so a test can check what was sent without any network.
    """

    def __init__(self, *script):
        self.script = list(script)
        self.calls: list[dict] = []

    def complete(self, *, model, system, user, schema, max_tokens, timeout, images=()):
        from app.llm import LLMReply

        self.calls.append(dict(model=model, system=system, user=user, schema=schema, max_tokens=max_tokens,
                               timeout=timeout, images=list(images)))
        if not self.script:
            raise AssertionError("FakeReceiptLLM called more times than scripted")
        item = self.script.pop(0)
        if isinstance(item, BaseException):
            raise item
        item = dict(item)
        text = item.pop("text", None)
        if isinstance(text, dict):
            text = json.dumps(text)
        stop = item.pop("stop", "complete")
        raw = {"complete": "end_turn", "refused": "refusal", "truncated": "max_tokens", "other": "pause_turn"}[stop]
        fields = dict(text=text, stop=stop, raw_stop=raw, refusal_category=None, model=model,
                      input_tokens=2300, output_tokens=120, request_id="req_fake_receipt")
        fields.update(item)
        return LLMReply(**fields)


class RealClientBlocked(AssertionError):
    pass


def _blocked(*args, **kwargs):
    raise RealClientBlocked("a TG-63 test tried to build a real LLM client; use FakeReceiptLLM")


@pytest.fixture(autouse=True)
def no_real_receipt_llm(monkeypatch):
    """Plan review S3. Autouse in every module that imports it (`from receipt_fakes import no_real_receipt_llm`).

    No LLM key in the environment, and building a real client fails loudly, so a test that forgets the fake
    can't make a paid call. conftest's network guard is the second line: it blocks any non-local host.
    """
    for var in ("LLM_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENROUTER_API_KEY"):
        monkeypatch.delenv(var, raising=False)
    import app.llm

    monkeypatch.setattr(app.llm, "make_llm_client", _blocked)
    try:  # the route's module, once it exists (RA2), may hold its own reference to the factory
        import app.receipt_scan as route
    except ModuleNotFoundError as e:
        if e.name != "app.receipt_scan":
            raise  # a broken import inside the module is a real failure, not "not built yet"
        route = None
    if route is not None and hasattr(route, "make_llm_client"):
        monkeypatch.setattr(route, "make_llm_client", _blocked)
    yield
