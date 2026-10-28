# TG-19 LLM provider and model for the planner

- Status: accepted, owner decision 2026-10-28
- Research: tg-arch, 2026-10-28, from official docs (sources below)
- Used by: TG-20 (planner endpoint)

## Context
The AI planner (CLAUDE.md "Planner output shape") sends the model only database rows: trips for the dates, spots, last-mile legs and lodging. That is about 50 to 150 rows, or roughly 6k to 10k input tokens. The model returns the plan JSON, about 2k tokens. FastAPI checks every `trip_id`, `spot_id` and `last_mile_route_id` and retries a few times when a check fails. We expect a few dozen plans in total, so reliability matters more than price. Latency still matters because a person waits on the screen.

The provider needs reliable schema-conforming JSON, low latency and low cost. The key lives only in Railway environment variables.

## Decision
- **Primary model:** Anthropic Claude Haiku 5.5 (`claude-haiku-5-5`), with JSON-schema structured outputs (constrained decoding).
- **Fallback model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`). It uses the same key and code path and is selected by `LLM_FALLBACK_MODEL`.
- **Client:** the official `anthropic` Python SDK. The owner approved it as a new dependency. TG-20 adds it to `api/requirements.txt`, because that's where it's first used. This ticket doesn't add it.
- **Config:** env only, so the model can be changed without a code change.

| Var | Value | Where |
|---|---|---|
| `LLM_PROVIDER` | `anthropic` (the only value implemented) | Railway, `.env.example` |
| `LLM_MODEL` | `claude-haiku-5-5` | Railway, `.env.example` |
| `LLM_FALLBACK_MODEL` | `claude-sonnet-5-5` (empty means no fallback) | Railway, `.env.example` |
| `LLM_API_KEY` | secret, passed explicitly as `Anthropic(api_key=...)` | Railway env vars only, never committed |

TG-20 owns the tuning knobs: `LLM_EFFORT`, `LLM_MAX_TOKENS`, `LLM_TIMEOUT_SECONDS` and the daily spend cap.

## Options considered
Prices are USD per 1M tokens on the standard paid tier, as published on 2026-10-28. Cost per plan assumes 10k input and 4k output tokens (2k of JSON plus up to 2k of thinking).

| Option | Input / output | Per plan | Schema JSON | Verdict |
|---|---|---|---|---|
| **Claude Haiku 5.5** | $0.10 / $0.50 | ≈ $0.003 | Yes, constrained decoding | **Chosen** |
| Claude Sonnet 5.5 | $2 / $10 | ≈ $0.06 | Yes | **Fallback** |
| OpenAI `gpt-6-luna` | $0.10 / $0.50 | ≈ $0.003 | Yes, `strict` json_schema | Close second. Rejected because it adds a second adapter, key and data processor for no reliability gain |
| OpenAI `gpt-5.4-mini` | $0.75 / $4.50 | ≈ $0.026 | Not confirmed in docs | Rejected |
| Gemini `gemini-3.8-flash` | $0.75 / $3.75, then $1.50 / $7.50 from 2027-01-01 | ≈ $0.023 | Valid JSON is promised; some schema keywords are silently ignored | Rejected. The free tier uses our data to improve Google products |
| Gemini `gemini-3.5-flash-lite` | $0.30 / $2.50 | ≈ $0.013 | Same as 3.8 Flash | Rejected |
| Plain `httpx` instead of the SDK | n/a | n/a | n/a | Possible with no new dependency, but we would write retries, backoff, 429 handling and parsing ourselves |

## Consequences
- TG-20 adds `anthropic` to `api/requirements.txt`. A dry run resolves `anthropic` 2.3.0 plus 6 new packages (`httpx2`, `httpcore2`, `jiter`, `docstring_parser`, `opentelemetry-api`, `truststore`). It installs alongside our `httpx` 0.27 without a conflict.
- In return we get `messages.parse()` (Pydantic validation), typed errors, built-in retries and timeouts.
- The plan schema must avoid `minItems` above 1, `maxItems`, `minLength`/`maxLength` and recursion. The current plan shape needs none of them.
- The first request with a new schema is slower while the schema compiles. The compiled schema is cached for 24 hours.
- TG-20 checks `stop_reason` before parsing. On `refusal` it retries once on the fallback model, because Haiku 5.5 has no server-side fallback. On `max_tokens` it retries with a higher limit.
- Start Haiku 5.5 at effort `low` for latency, and raise it to `medium` only if validation retries are frequent.
- Optional, to try in TG-20's spike: put the allowed ids as `enum` lists in the per-request schema. The cost is a schema compile on every request. FastAPI's id validation stays the authority either way. Compare ids case-insensitively.
- Spend backstop: set a small monthly spend limit (e.g. $10) in the Anthropic Console, under TG-20's own daily cap.
- Switching from Haiku to Sonnet is a Railway env change plus a redeploy. Adding another provider later means writing a new adapter behind `LLM_PROVIDER`.
- Party names reach Anthropic. Anthropic deletes API data within 30 days.

## What we couldn't verify
- **Latency.** No provider publishes p50 for about 2k output tokens. Before TG-20, run a 10-call smoke test against Haiku 5.5 at effort `low` and `medium`, using the real schema and 150 made-up rows, and record p50 and p95.
- **Anthropic training policy.** The privacy page covers retention only. "Commercial API data is not used for training" comes from the Commercial Terms as quoted by secondary sources, and we didn't read the terms ourselves. Some third-party posts claim 7-day retention, which conflicts with the official page.
- **Anthropic limits for a new account.** The "Evaluation" tier limits and the free credit amount aren't published.
- **OpenAI.** The Tier 1 and free-tier limits for `gpt-6-luna` aren't published. Structured-outputs support for `gpt-5.4-mini` isn't confirmed.
- **Gemini.** Per-model RPM/TPM is shown only in AI Studio. The docs don't say whether 3.8 Flash thinking can be fully turned off, or what schema guarantees exist beyond valid JSON.
- **Raw `httpx` path.** We didn't verify the `anthropic-version` header value. The SDK avoids the question.
- **Quality.** We haven't tested how Haiku 5.5 does on our plan shape. TG-20's spike should run about 20 plans and count validation retries.

## Sources (fetched 2026-10-28)
- Anthropic pricing: https://platform.claude.com/docs/en/about-claude/pricing
- Anthropic rate limits and spend limits: https://platform.claude.com/docs/en/api/rate-limits
- Anthropic structured outputs: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- Anthropic data retention: https://privacy.claude.com/en/articles/7996866-is-my-data-used-for-model-training
- Claude model IDs and behaviour: the `claude-api` skill (model table cached 2026-10-06), cross-checked against the pricing page
- OpenAI pricing: https://developers.openai.com/api/docs/pricing
- OpenAI `gpt-6-luna`: https://developers.openai.com/api/docs/models/gpt-6-luna
- OpenAI structured outputs: https://developers.openai.com/api/docs/guides/structured-outputs
- OpenAI data controls: https://developers.openai.com/api/docs/guides/your-data
- Gemini pricing: https://ai.google.dev/gemini-api/docs/pricing
- Gemini models: https://ai.google.dev/gemini-api/docs/models and https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash
- Gemini structured output: https://ai.google.dev/gemini-api/docs/structured-output
- Gemini thinking: https://ai.google.dev/gemini-api/docs/thinking
- Gemini rate limits: https://ai.google.dev/gemini-api/docs/rate-limits
- SDK dependencies: `pip install --dry-run anthropic`, 2026-10-28
- Full comparison: tg-arch's decision note for TG-19 (team files, outside the repo)
