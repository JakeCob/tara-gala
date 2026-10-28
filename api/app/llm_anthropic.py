"""Anthropic adapter for the planner's LLMClient seam. The only module that imports `anthropic`.

Calls follow the claude-api skill for Claude Haiku 5.5: `messages.create` with `output_config.effort` and a
json_schema `output_config.format`; no `thinking`, sampling params, prefill or server-side `fallbacks`
(each is a 400 on Haiku 5.5). The reply can start with a thinking block, so we take the first text block.
"""

import anthropic

from .llm import LLMReply, LLMUnavailable

_STOPS = {"end_turn": "complete", "refusal": "refused", "max_tokens": "truncated"}


class AnthropicClient:
    def __init__(self, *, api_key: str, effort: str, base_url: str | None = None):
        # No SDK retries: one complete() is one HTTP attempt, so the planner's deadline holds
        # (a retry could double the timeout or sleep on retry-after). The planner retries instead.
        self._client = anthropic.Anthropic(api_key=api_key, base_url=base_url, max_retries=0)
        self._effort = effort

    def complete(self, *, model: str, system: str, user: str, schema: dict,
                 max_tokens: int, timeout: float) -> LLMReply:
        try:
            msg = self._client.with_options(timeout=timeout).messages.create(
                model=model,
                max_tokens=max_tokens,
                system=system,
                messages=[{"role": "user", "content": user}],
                output_config={"effort": self._effort, "format": {"type": "json_schema", "schema": schema}},
            )
        # Status errors are re-raised `from None`: their body can echo request data, and a chained
        # traceback in a log line would carry it along.
        except anthropic.APITimeoutError as e:  # subclass of APIConnectionError: catch first
            raise LLMUnavailable("timeout") from e
        except anthropic.APIConnectionError as e:
            raise LLMUnavailable("connection") from e
        except anthropic.RateLimitError as e:
            raise LLMUnavailable("rate_limited", 429, e.request_id) from None
        except anthropic.APIStatusError as e:
            raise LLMUnavailable("api_error", e.status_code, e.request_id) from None
        except anthropic.APIError:  # e.g. a response that doesn't validate
            raise LLMUnavailable("api_error") from None

        text = next((b.text for b in msg.content if b.type == "text"), None)
        category = msg.stop_details.category if msg.stop_reason == "refusal" and msg.stop_details else None
        return LLMReply(
            text=text,
            stop=_STOPS.get(msg.stop_reason, "other"),
            raw_stop=msg.stop_reason,
            refusal_category=category,
            model=msg.model,
            input_tokens=msg.usage.input_tokens,
            output_tokens=msg.usage.output_tokens,
            request_id=msg._request_id,
        )
