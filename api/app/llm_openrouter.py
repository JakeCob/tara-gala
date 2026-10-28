"""OpenRouter adapter for the planner's LLMClient seam (owner decision 2026-10-28: key via OpenRouter).

Plain httpx against OpenRouter's OpenAI-compatible chat completions API. Shapes follow OpenRouter's docs
(checked 2026-10-28): structured outputs via `response_format` json_schema with `strict`, effort via
`reasoning.effort`, `provider.require_parameters` so only endpoints that honour the schema are used.
Errors can arrive as `{"error": {...}}` even on a 200; a 403 can be a provider-reported refusal.
"""

import httpx

from .llm import LLMReply, LLMUnavailable

BASE_URL = "https://openrouter.ai/api/v1"
_STOPS = {"stop": "complete", "length": "truncated", "content_filter": "refused"}


class OpenRouterClient:
    def __init__(self, *, api_key: str, effort: str, base_url: str = BASE_URL):
        # No retries (httpx has none by default): one complete() is one HTTP attempt, like the Anthropic adapter.
        self._client = httpx.Client(
            base_url=base_url,
            headers={"Authorization": f"Bearer {api_key}", "X-OpenRouter-Title": "Tara Gala"},
        )
        self._effort = effort

    def complete(self, *, model: str, system: str, user: str, schema: dict,
                 max_tokens: int, timeout: float) -> LLMReply:
        payload = {
            "model": model,
            "max_tokens": max_tokens,  # includes reasoning tokens
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "response_format": {"type": "json_schema", "json_schema": {"name": "plan", "strict": True, "schema": schema}},
            "reasoning": {"effort": self._effort, "exclude": True},  # still billed, just not returned
            "provider": {"require_parameters": True},
        }
        try:
            resp = self._client.post("/chat/completions", json=payload, timeout=timeout)
        except httpx.TimeoutException as e:
            raise LLMUnavailable("timeout") from e
        except httpx.TransportError as e:
            raise LLMUnavailable("connection") from e
        except httpx.HTTPError as e:  # e.g. too many redirects
            raise LLMUnavailable("api_error") from e

        # Error bodies are never read into messages: they can echo request data.
        if resp.status_code == 403:  # moderation flag or provider-reported refusal
            return LLMReply(None, "refused", "http_403", None, model, 0, 0, None)
        if resp.status_code == 429:
            raise LLMUnavailable("rate_limited", 429)
        if resp.status_code == 408:
            raise LLMUnavailable("timeout", 408)
        if resp.status_code >= 400:
            raise LLMUnavailable("api_error", resp.status_code)
        try:
            body = resp.json()
        except ValueError:
            raise LLMUnavailable("api_error", resp.status_code) from None
        if not isinstance(body, dict) or not body.get("choices"):
            error = body.get("error") if isinstance(body, dict) else None
            code = error.get("code") if isinstance(error, dict) else None
            request_id = body.get("id") if isinstance(body, dict) else None
            raise LLMUnavailable("api_error", code if isinstance(code, int) else resp.status_code, request_id)

        choice = body["choices"][0]
        message = choice.get("message") or {}
        finish = choice.get("finish_reason")
        if finish == "error":
            raise LLMUnavailable("api_error", resp.status_code, body.get("id"))
        stop = "refused" if message.get("refusal") else _STOPS.get(finish, "other")
        usage = body.get("usage") or {}
        return LLMReply(
            text=message.get("content") or None,
            stop=stop,
            raw_stop=choice.get("native_finish_reason") or finish,
            refusal_category=None,  # OpenRouter doesn't pass Anthropic's stop_details through
            model=body.get("model") or model,
            input_tokens=usage.get("prompt_tokens", 0),
            output_tokens=usage.get("completion_tokens", 0),
            request_id=body.get("id"),
        )
