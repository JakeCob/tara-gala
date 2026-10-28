"""Provider-neutral LLM seam for the planner (TG-20). See docs/decisions/TG-19-llm-provider.md.

The planner, prompt and retry code only use what's in this module. Each provider adapter maps its own
stop reasons and errors onto these types, so adding a provider (e.g. a local OpenAI-compatible server)
is one adapter file, one branch in make_llm_client and its model ids in limits.PRICES_PER_MTOK.
"""

import logging
import math
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Literal, Protocol

logger = logging.getLogger("tara_gala.api")

Stop = Literal["complete", "refused", "truncated", "other"]
EFFORTS = ("low", "medium", "high", "xhigh", "max")
MAX_TOKENS_CEILING = 16000  # non-streaming calls stay well under SDK timeouts at this size


@dataclass(frozen=True)
class LLMReply:
    text: str | None  # the JSON answer text; None if the reply has none
    stop: Stop  # neutral; each adapter maps its own stop reasons onto this
    raw_stop: str | None  # provider's own value, for logs only ("end_turn", "refusal", ...)
    refusal_category: str | None
    model: str  # model id that answered
    input_tokens: int
    output_tokens: int
    request_id: str | None


class LLMClient(Protocol):
    def complete(self, *, model: str, system: str, user: str, schema: dict,
                 max_tokens: int, timeout: float) -> LLMReply: ...


class LLMUnavailable(Exception):
    """The only error adapters raise for transport and API failures. Never carries provider error text."""

    def __init__(self, kind: Literal["timeout", "connection", "rate_limited", "api_error"],
                 status: int | None = None, request_id: str | None = None):
        super().__init__(f"LLM unavailable: kind={kind} status={status} request_id={request_id}")
        self.kind = kind
        self.status = status
        self.request_id = request_id


class LLMConfigError(Exception):
    """The planner can't run with the current env. The message names variables, never secret values."""


def _number(env: Mapping[str, str], name: str, default, cast, minimum, maximum=None):
    raw = (env.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = cast(raw)
    except ValueError:
        logger.warning("%s is not a valid number; using default %s", name, default)
        return default
    if not math.isfinite(value) or value < minimum or (maximum is not None and value > maximum):
        logger.warning("%s is out of range; using default %s", name, default)
        return default
    return value


@dataclass(frozen=True)
class LLMConfig:
    provider: str
    model: str
    fallback_model: str | None
    api_key: str = field(repr=False)  # never in repr, so never in a log line by accident
    effort: str
    max_tokens: int
    timeout_s: float
    max_attempts: int
    deadline_s: float
    daily_cap_usd: float
    rate_limit_per_hour: int

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> "LLMConfig":
        """Read the planner settings (README section 5). Bad numbers fall back to the default with a warning."""
        effort = (env.get("LLM_EFFORT") or "").strip().lower() or "low"
        if effort not in EFFORTS:
            logger.warning("LLM_EFFORT is not one of %s; using low", ", ".join(EFFORTS))
            effort = "low"
        max_tokens = _number(env, "LLM_MAX_TOKENS", 8000, int, 1)
        if max_tokens > MAX_TOKENS_CEILING:
            logger.warning("LLM_MAX_TOKENS is above %d; using %d", MAX_TOKENS_CEILING, MAX_TOKENS_CEILING)
            max_tokens = MAX_TOKENS_CEILING
        return cls(
            provider=env.get("LLM_PROVIDER", "anthropic").strip(),  # set but empty is an error, not the default
            model=(env.get("LLM_MODEL") or "").strip() or "claude-haiku-5-5",
            fallback_model=env.get("LLM_FALLBACK_MODEL", "claude-sonnet-5-5").strip() or None,
            api_key=(env.get("LLM_API_KEY") or "").strip(),
            effort=effort,
            max_tokens=max_tokens,
            timeout_s=_number(env, "LLM_TIMEOUT_SECONDS", 40.0, float, 1),
            max_attempts=_number(env, "PLANNER_MAX_ATTEMPTS", 3, int, 1, 10),
            deadline_s=_number(env, "PLANNER_DEADLINE_SECONDS", 100.0, float, 10),
            daily_cap_usd=_number(env, "PLANNER_DAILY_SPEND_CAP_USD", 1.00, float, 0),
            rate_limit_per_hour=_number(env, "PLANNER_RATE_LIMIT_PER_HOUR", 10, int, 1),
        )


def make_llm_client(cfg: LLMConfig) -> LLMClient:
    if cfg.provider == "anthropic":
        if not cfg.api_key:
            raise LLMConfigError("LLM_API_KEY is not set")
        from .llm_anthropic import AnthropicClient  # lazy: only the adapter imports anthropic

        return AnthropicClient(api_key=cfg.api_key, effort=cfg.effort)
    raise LLMConfigError(f"LLM_PROVIDER={cfg.provider!r} is not implemented (only 'anthropic')")
