# TG-25: live planner proof (2026-10-29)

This is a local-only proof of the live AI planner end to end on `main` at `f24fb2a`: form → `POST /plan` → validated plan → share link → overworld. It was never run against Railway, where `PLANNER_LIVE` stays `false`.
- The full log and the 380px screenshots are in the team folder (`_team/tickets/TG-25/`).
- No check found a bug, so this PR changes no code.

## Setup
- **Database:** a throwaway database (`tg_build3` on 127.0.0.1:55432) holding TG-20's made-up planner rows (`api/tests/planner_data.py`), plus one made-up pre-made itinerary built from those rows. It was wiped afterwards.
- **API:** 127.0.0.1:8030. **Web:** a production build (`next start`) on localhost:3030. Each check used a fresh headless Chrome at a 380px viewport, driven over CDP.
- **The key:** it came from the repo-root `.env` straight into the API's environment, with `LLM_PROVIDER=openrouter`, and was never printed. Afterwards, a search of every log for the key (in full, and its first 12 characters) found nothing.

## Results
| Check | Settings | Result |
|---|---|---|
| **M1: one live call** | `PLANNER_LIVE=true`, `PLANNER_MAX_ATTEMPTS=1`, `PLANNER_DAILY_SPEND_CAP_USD=0.10`, `PLANNER_RATE_LIMIT_PER_HOUR=2`; web `NEXT_PUBLIC_PLANNER_LIVE=true` | A single `POST /plan` → **201** in 13.7 s, then the browser went to `/i/a5ac7b255c18`. The log had one `planner attempt=1/1` line and one `planner done` line. Model `anthropic/claude-haiku-5.5`, 2,593 input / 3,083 output tokens, **$0.0018**. During planning, the loading state showed "Planning..." (disabled) and the "up to 2 minutes" line. |
| **M5: overworld** | M1's share link | The overworld renders the saved plan: the party, both bus legs with "Checked Oct 24", 3 days of stops and rides on the path with their sprites, and the return-bus call to action. |
| **B16: reload** | reload `/i/a5ac7b255c18` | The same plan comes back (refetched from the API, 200). The text and the screenshot are identical. |
| **M2: flag mismatch** | API `PLANNER_LIVE=false`, web flag on | `POST /plan` → 404, then the generic "Something went wrong…" notice with Try again and "See ready-made trips". The list loads. This matches TG-21's ux §5.2 for any unlisted status. |
| **M2: not configured** | API planner on, no key | 503 `not_configured`: TG-20's "The planner isn't available right now." with no Try again, then the ready-made list. The API logs the missing variable's name, never a value. |
| **M2: 429** | dummy key aimed at a closed **local** port, rate limit 1 | Submit → 503 `llm_unavailable` (connection refused locally; nothing reached any provider). Try again → **429** `rate_limited`: the API's message, no retry button, and the ready-made list offered, as TG-21's ux §5.2 specifies. |
| **M3a: planner off** | web `NEXT_PUBLIC_PLANNER_LIVE=false` (tonight's deploy) | "Tara, show trip ideas", then the list. The CDP log shows **0 `POST /plan`**. |
| **M3b: both off** | web planner and pre-made flags both false | No submit button, a "Search buses" action, and no calls to `/plan` or `/premade-itineraries`. |
| **M4: keyboard** | the not-configured fallback view | The "See this trip" link takes focus with a visible 3px ring. It's 44px tall, and is described by the card title. There's no horizontal scroll at 380px. |

**Live spend:** M1's $0.0018 brings the overnight total to about $0.11 of the ~$1 cap, counting TG-20's spike and its check. **Not run:** the deploy confirmation on Railway, because the brief limits TG-25 to local runs.
