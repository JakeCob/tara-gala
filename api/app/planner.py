"""POST /plan: the live AI planner (TG-20).

The model only sees DB rows (planner_context), answers in the CLAUDE.md plan shape (planner_prompt), and
every answer goes through TG-24's validator before it's saved. Invalid answers are retried with the errors
fed back, up to PLANNER_MAX_ATTEMPTS model calls, within PLANNER_DEADLINE_SECONDS. Gated by PLANNER_LIVE.
"""

import logging
import math
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date as Date
from datetime import datetime, timedelta
from functools import lru_cache
from typing import Any, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Request
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from . import db
from .limits import RateLimiter, SpendTracker, client_ip, ip_hash
from .llm import MAX_TOKENS_CEILING, LLMClient, LLMConfig, LLMConfigError, LLMUnavailable, make_llm_client
from .planner_context import load_context
from .planner_prompt import PLAN_SCHEMA, SYSTEM_PROMPT, Feedback, build_user_message

router = APIRouter(tags=["planner"])
logger = logging.getLogger("tara_gala.api")

MANILA_TZ = ZoneInfo("Asia/Manila")
MAX_DAYS_AHEAD = 365
MAX_TRIP_DAYS = 6  # return_date at most this many days after date
MIN_CALL_SECONDS = 5  # don't start a model call with less time than this left
CONFIG_STATUSES = {400, 401, 402, 403, 404}  # a broken deploy (key, credits, model id, request shape), not an outage

MESSAGES = {
    "no_valid_plan": "We couldn't build a plan from the trips and spots on file. Try again, or pick a pre-made itinerary.",
    "refused": "We couldn't build a plan for this request. Try a different vibe, or pick a pre-made itinerary.",
    "llm_unavailable": "The planner can't be reached right now. Try again in a few minutes.",
    "deadline": "Planning took too long. Try again, or pick a pre-made itinerary.",
    "daily_cap": "The planner has reached today's limit. Try again tomorrow, or pick a pre-made itinerary.",
    "rate_limited": "You've asked for a lot of plans. Try again in a little while.",
    "no_data": "There aren't enough trips, spots or routes on file for these dates yet.",
    "not_configured": "The planner isn't available right now.",
}


def manila_today() -> Date:
    """Today in Manila. Module-level so tests can freeze it."""
    return datetime.now(MANILA_TZ).date()


class Passenger(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["adult", "student", "senior", "pwd", "child"]
    name: str | None = Field(None, max_length=40)  # stored with the plan, never sent to the model


class PlanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    date: Date
    return_date: Date
    party: list[Passenger] = Field(min_length=1, max_length=10)
    budget_php: int | None = Field(None, ge=500, le=200_000)
    # No < > { }: the vibe sits inside a <vibe> tag in the prompt and must not be able to close it
    vibe: str = Field(min_length=1, max_length=60, pattern=r"^[\w ,.'&!?-]+$")

    @field_validator("vibe", mode="before")
    @classmethod
    def _one_line(cls, v: Any) -> Any:
        return " ".join(v.split()) if isinstance(v, str) else v

    @model_validator(mode="after")
    def _dates(self) -> "PlanRequest":
        today = manila_today()
        if self.date < today:
            raise ValueError("date is in the past")
        if self.date > today + timedelta(days=MAX_DAYS_AHEAD):
            raise ValueError(f"date is more than {MAX_DAYS_AHEAD} days ahead")
        if self.return_date < self.date:
            raise ValueError("return_date is before date")
        if self.return_date > self.date + timedelta(days=MAX_TRIP_DAYS):
            raise ValueError(f"return_date is more than {MAX_TRIP_DAYS} days after date")
        return self


class PlanResponse(BaseModel):
    share_slug: str
    model: str
    attempts: int
    plan: dict


@dataclass(frozen=True)
class Saved:
    share_slug: str
    model: str
    attempts: int
    plan: dict


@dataclass(frozen=True)
class Failed:
    status: int
    code: str


def _validate_with_tg24(conn, raw, *, trip_date: Date, return_date: Date):
    from .plan_validation import validate_plan  # TG-24 owns the validator

    return validate_plan(conn, raw, trip_date=trip_date, return_date=return_date)


def _no_plan_json():
    from .plan_validation import PlanError

    return PlanError("shape", "", "The reply had no plan JSON.")


class Planner:
    def __init__(self, client: LLMClient, cfg: LLMConfig, limiter: RateLimiter, spend: SpendTracker,
                 clock: Callable[[], float] = time.monotonic, validate: Callable[..., Any] = _validate_with_tg24):
        self.client = client
        self.cfg = cfg
        self.limiter = limiter
        self.spend = spend
        self._clock = clock
        self._validate = validate  # (conn, raw, *, trip_date, return_date) -> result with .ok, .plan, .errors

    def run(self, req: PlanRequest) -> Saved | Failed:
        cfg = self.cfg
        started = self._clock()
        with db.get_conn() as conn:  # short-lived: no connection is held during a model call
            ctx = load_context(conn, req.date, req.return_date)
        if ctx.empty_reason:
            return self._failed("no_data", 422, 0, [ctx.empty_reason], started)

        model, max_tokens, used_fallback, feedback = cfg.model, cfg.max_tokens, False, None
        last_codes: list[str] = []
        for attempt in range(1, cfg.max_attempts + 1):
            if not self.spend.allowed():
                logger.warning("planner daily cap reached spent_usd=%.4f cap_usd=%.2f", self.spend.spent_today, cfg.daily_cap_usd)
                return self._failed("daily_cap", 503, attempt - 1, last_codes, started)
            left = cfg.deadline_s - (self._clock() - started)
            if left < MIN_CALL_SECONDS:
                return self._failed("deadline", 504, attempt - 1, last_codes, started)

            call_started = self._clock()
            try:
                reply = self.client.complete(
                    model=model, system=SYSTEM_PROMPT, user=build_user_message(ctx, req, feedback),
                    schema=PLAN_SCHEMA, max_tokens=max_tokens, timeout=min(cfg.timeout_s, left),
                )
            except LLMUnavailable as e:
                if e.kind == "timeout":
                    self.spend.add(model, 0, max_tokens)  # the server probably still generated (and billed) it
                level = logging.ERROR if e.status in CONFIG_STATUSES else logging.WARNING
                logger.log(level, "planner llm unavailable kind=%s status=%s request_id=%s", e.kind, e.status, e.request_id)
                return self._failed("llm_unavailable", 503, attempt, [e.kind], started)
            cost = self.spend.add(reply.model, reply.input_tokens, reply.output_tokens)

            result, errors = None, []
            if reply.stop in ("refused", "truncated"):
                pass  # their output can break the schema; handled below without parsing
            elif reply.stop != "complete" or reply.text is None:
                errors = [_no_plan_json()]
            else:
                with db.get_conn() as conn:
                    result = self._validate(conn, reply.text, trip_date=req.date, return_date=req.return_date)
                errors = list(result.errors)
            codes = list(dict.fromkeys(e.code for e in errors))
            logger.info(
                "planner attempt=%d/%d model=%s stop=%s raw_stop=%s input_tokens=%d output_tokens=%d "
                "cost_usd=%.4f duration_ms=%.0f request_id=%s errors=%d codes=%s",
                attempt, cfg.max_attempts, reply.model, reply.stop, reply.raw_stop, reply.input_tokens,
                reply.output_tokens, cost, (self._clock() - call_started) * 1000, reply.request_id,
                len(errors), ",".join(codes) or "-",
            )

            if result is not None and result.ok:
                plan = result.plan.to_json()
                share_slug = self._save(plan, req, reply.model)
                logger.info("planner done share_slug=%s model=%s attempts=%d duration_ms=%.0f spent_today_usd=%.4f",
                            share_slug, reply.model, attempt, (self._clock() - started) * 1000, self.spend.spent_today)
                return Saved(share_slug, reply.model, attempt, plan)
            if reply.stop == "refused":
                fallback = cfg.fallback_model if not used_fallback else None
                logger.warning("planner refused model=%s category=%s fallback=%s", model, reply.refusal_category, fallback)
                if not fallback:
                    return self._failed("refused", 502, attempt, ["refused"], started)
                model, used_fallback, feedback, last_codes = fallback, True, None, ["refused"]
            elif reply.stop == "truncated":
                max_tokens = min(max_tokens * 2, MAX_TOKENS_CEILING)
                feedback, last_codes = Feedback.truncated(), ["truncated"]
            else:
                feedback, last_codes = Feedback(previous=reply.text, errors=errors), codes
        return self._failed("no_valid_plan", 502, cfg.max_attempts, last_codes, started)

    def _failed(self, code: str, status: int, attempts: int, last_codes: list[str], started: float) -> Failed:
        logger.warning("planner failed code=%s attempts=%d last_codes=%s duration_ms=%.0f",
                       code, attempts, ",".join(last_codes) or "-", (self._clock() - started) * 1000)
        return Failed(status, code)

    def _save(self, plan: dict, req: PlanRequest, model: str) -> str:
        party = [p.model_dump(exclude_none=True) for p in req.party]  # names kept for the share page (TG-23)
        with db.get_conn() as conn:
            row = conn.execute(
                """
                insert into itineraries (trip_date, return_date, party, budget_php, vibe, plan, model)
                values (%s, %s, %s, %s, %s, %s, %s)
                returning share_slug
                """,
                [req.date, req.return_date, Jsonb(party), req.budget_php, req.vibe, Jsonb(plan), model],
            ).fetchone()
        return row["share_slug"]


def _error(status: int, code: str, headers: dict | None = None, **extra) -> HTTPException:
    return HTTPException(status, {"code": code, "message": MESSAGES[code], **extra}, headers=headers)


_build_lock = threading.Lock()  # two first requests at once must not build two limiters


@lru_cache(maxsize=1)
def _build_planner() -> Planner:
    """Read the config and build the client once, on the first planner request. Raises LLMConfigError."""
    cfg = LLMConfig.from_env()
    client = make_llm_client(cfg)
    logger.info(
        "planner config provider=%s model=%s fallback=%s effort=%s max_tokens=%d timeout_s=%g attempts=%d "
        "deadline_s=%g cap_usd=%.2f rate_per_hour=%d key_set=%s",
        cfg.provider, cfg.model, cfg.fallback_model, cfg.effort, cfg.max_tokens, cfg.timeout_s, cfg.max_attempts,
        cfg.deadline_s, cfg.daily_cap_usd, cfg.rate_limit_per_hour, bool(cfg.api_key),
    )
    return Planner(client, cfg, RateLimiter(cfg.rate_limit_per_hour), SpendTracker(cfg.daily_cap_usd))


def get_planner(request: Request) -> Planner:
    if not request.app.state.flags.planner_live:  # set once in the lifespan (TG-24); same 404 as an unknown route
        raise HTTPException(404)
    try:
        with _build_lock:
            return _build_planner()
    except LLMConfigError as e:
        logger.error("planner not configured: %s", e)
        raise _error(503, "not_configured")


@router.post("/plan", status_code=201, response_model=PlanResponse)
def create_plan(body: PlanRequest, request: Request, planner: Planner = Depends(get_planner)) -> PlanResponse:
    ip = client_ip(request)
    wait = planner.limiter.hit(ip)
    if wait is not None:
        retry_after = max(1, math.ceil(wait))
        logger.warning("planner rate limited ip_hash=%s retry_after_s=%d", ip_hash(ip), retry_after)
        # retry_after_s is in the body too: CORS hides Retry-After from fetch()
        raise _error(429, "rate_limited", headers={"Retry-After": str(retry_after)}, retry_after_s=retry_after)
    outcome = planner.run(body)
    if isinstance(outcome, Failed):
        raise _error(outcome.status, outcome.code)
    return PlanResponse(share_slug=outcome.share_slug, model=outcome.model, attempts=outcome.attempts, plan=outcome.plan)
