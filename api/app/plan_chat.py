"""TG-61 PR 2: POST /sessions/{slug}/plan/chat, the chatbot (plan.md §2.4, options.md §7). It proposes, and a human
taps Apply. The model answers with operations (plan_ops); the server applies them and checks the result exactly as
it checks a hand edit (plan_edit.prepare), and runs the time and fare rule on the reply and on every text it adds
(review M5). A failure is retried with its codes, as the planner does, and after the last attempt the answer is a
plain "couldn't" reply with no proposal. Nothing is saved: Apply is the usual PUT /plan with source "chat".

The chat log stays on the phone. The server keeps no row of it and logs no text from it, only slugs, counts, codes and
token costs. Behind CHATBOT_LIVE (503 chat_off when it's off), inside PLAN_EDITING's routers. Its own spend cap and
limits: CHAT_DAILY_SPEND_CAP_USD, 20 an hour per trip and 60 per IP, all in process memory (limits.py).
"""

import logging
import math
import os
import re
import threading
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta
from functools import lru_cache
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError, model_validator

from . import db, plan_chat_context, plan_edit, plan_ops
from . import guide as guides
from . import itineraries as its
from .guide import ROW_KEY
from .limits import MANILA_TZ, RateLimiter, SpendTracker, client_ip, ip_hash
from .llm import LLMClient, LLMConfig, LLMConfigError, LLMUnavailable, _number, make_llm_client
from .plan_diff import ChangeLine
from .plan_chat_prompt import SYSTEM_PROMPT, Turn, build_user_message
from .schedule import to_minutes
from .sessions import NOINDEX, SLUG, _session_id

router = APIRouter(tags=["plan-chat"])
logger = logging.getLogger("tara_gala.api")

NO_FIT = "The chatbot couldn't make a change that fits the plan. Try asking another way."
CONFIG_STATUSES = {400, 401, 402, 403, 404}  # a broken deploy, as the planner logs it


# ---------------------------------------------------------------- the time and fare rule (review M5)

_TIME = re.compile(r"\b([01]?\d|2[0-3])[:.]([0-5]\d)\s?([ap])?\.?(?:m\.?)?\b", re.I)
_HOUR = re.compile(r"\b(1[0-2]|0?[1-9])\s?([ap])\.?m\.?\b", re.I)
_PESO_BEFORE = re.compile(r"(?:₱|\bphp|\bp)\s?(\d[\d,]*(?:\.\d+)?)", re.I)
_PESO_AFTER = re.compile(r"\b(\d[\d,]*(?:\.\d+)?)\s?(?:php|pesos?)\b", re.I)
_NUMBER = re.compile(r"\d[\d,]*(?:\.\d+)?")


def _clock(h: int, m: int, half: str | None) -> set[int]:
    """The minutes a written time can mean: with AM/PM one, without it both (4:10 is 04:10 or 16:10)."""
    if half:
        return {((h % 12) + (12 if half.lower() == "p" else 0)) * 60 + m} if h <= 12 else {h * 60 + m}
    return {h * 60 + m, (h + 12) * 60 + m} if h < 12 else {h * 60 + m}


def _amount(s: str) -> float:
    return float(s.rstrip(".,").replace(",", ""))


def amounts_in(text: str) -> set[float]:
    return {_amount(x) for x in _NUMBER.findall(text or "")}


def check_text(text: str, allowed_times: set[int], allowed_amounts: set[float]) -> list[str]:
    """made_up_time and made_up_fare: every time and peso amount written in `text` must be one it was given.
    Spelled-out ones ("alas-kwatro") pass: the stated gap (plan.md §11), which the prompt forbids."""
    codes, spans = [], []
    for m in _TIME.finditer(text):
        spans.append(m.span())
        if not _clock(int(m[1]), int(m[2]), m[3]) & allowed_times:
            codes.append("made_up_time")
    for m in _HOUR.finditer(text):
        if any(a <= m.start() < b for a, b in spans):
            continue  # the "10pm" inside "4:10pm"
        if not _clock(int(m[1]), 0, m[2]) & allowed_times:
            codes.append("made_up_time")
    for m in [*_PESO_BEFORE.finditer(text), *_PESO_AFTER.finditer(text)]:
        if _amount(m[1]) not in allowed_amounts:
            codes.append("made_up_fare")
    return list(dict.fromkeys(codes))


def _guide_times(g: guides.Guide) -> set[int]:
    return {to_minutes(r.time) for d in g.days for r in d.rows} | {to_minutes(o.leave) for d in g.days if d.pick for o in d.pick.options}


def _budget_amounts(g: guides.Guide) -> set[float]:
    return amounts_in(g.budget.summary) | {a for b in g.budget.rows for a in amounts_in(b.estimate)}


# ---------------------------------------------------------------- shapes

class Message(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Literal["user", "assistant"]  # an assistant turn is the plain reply text the phone showed
    text: Annotated[str, StringConstraints(min_length=1, max_length=1000)]


class Focus(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: Annotated[str, StringConstraints(pattern=ROW_KEY)]  # "Ask the chatbot" from a stop's menu


class ChatIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    base: plan_edit.Base
    messages: list[Message] = Field(min_length=1, max_length=10)  # the phone sends at most its last 10 turns
    focus: Focus | None = None

    @model_validator(mode="after")
    def _last_is_users(self) -> "ChatIn":
        if self.messages[-1].role != "user":
            raise ValueError("the last message is the user's")
        return self


class Proposal(BaseModel):
    """A change nobody has applied: the guide to show, the GuideIn that Apply sends, its lines, and its base."""
    guide: guides.GuideOut
    stored: plan_edit.GuideIn
    changes: list[ChangeLine]
    base: plan_edit.Base


class NeedLinkOut(BaseModel):
    name: str  # never a pin: the phone asks for the place's Google Maps link
    at: dict[str, str | int] | None  # {after: key} | {replace: key} | {first_of_day: n}, or null


class ChatOut(BaseModel):
    reply: str
    proposal: Proposal | None
    outcome: Literal["proposal", "answer", "no_fit"]
    need_link: NeedLinkOut | None


# ---------------------------------------------------------------- the loop

@dataclass(frozen=True)
class ChatSettings:
    model: str
    fallback_model: str | None
    max_tokens: int
    timeout_s: float
    max_attempts: int
    daily_cap_usd: float
    trip_per_hour: int
    ip_per_hour: int

    @classmethod
    def from_env(cls, cfg: LLMConfig, env: Mapping[str, str] = os.environ) -> "ChatSettings":
        """The planner's provider, models, key and timeout; the chat's own cap, limits and tokens (review S3)."""
        return cls(
            model=cfg.model, fallback_model=cfg.fallback_model, timeout_s=cfg.timeout_s,
            max_tokens=_number(env, "CHAT_MAX_TOKENS", 1000, int, 100, 4000),
            max_attempts=_number(env, "CHAT_MAX_ATTEMPTS", 3, int, 1, 5),
            daily_cap_usd=_number(env, "CHAT_DAILY_SPEND_CAP_USD", 1.00, float, 0),
            trip_per_hour=_number(env, "CHAT_RATE_LIMIT_PER_HOUR", 20, int, 1),
            ip_per_hour=_number(env, "CHAT_IP_RATE_LIMIT_PER_HOUR", 60, int, 1),
        )


def _flat(status: int, detail: str, headers: dict | None = None, **extra) -> JSONResponse:
    return JSONResponse({"detail": detail, **extra}, status_code=status, headers={"Cache-Control": "private, no-cache", **NOINDEX, **(headers or {})})


def _manila_now() -> datetime:
    return datetime.now(MANILA_TZ)


class Chat:
    def __init__(self, client: LLMClient, settings: ChatSettings):
        self.client, self.settings = client, settings
        self.spend = SpendTracker(settings.daily_cap_usd)
        self.trips = RateLimiter(settings.trip_per_hour)  # keyed by trip slug, as the owner asked
        self.ips = RateLimiter(settings.ip_per_hour)  # so one phone can't drain many trips

    # ---- limits

    def limit(self, share_slug: str, ip: str) -> JSONResponse | None:
        for reason, limiter, key in (("trip", self.trips, share_slug), ("ip", self.ips, ip)):
            wait = limiter.hit(key)
            if wait is not None:
                retry = max(1, math.ceil(wait))
                logger.warning("plan chat limited share_slug=%s reason=%s retry_after=%d ip=%s", share_slug, reason, retry, ip_hash(ip))
                at = (_manila_now() + timedelta(seconds=retry)).replace(microsecond=0).isoformat()
                return _flat(429, "chat_busy", {"Retry-After": str(retry)}, retry_at=at)
        return None

    def _cap(self, share_slug: str) -> JSONResponse:
        now = _manila_now()
        midnight = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        logger.warning("plan chat limited share_slug=%s reason=cap spent_today_usd=%.4f", share_slug, self.spend.spent_today)
        return _flat(429, "chat_cap", {"Retry-After": str(max(1, math.ceil((midnight - now).total_seconds())))}, retry_at=midnight.isoformat())

    # ---- one turn

    def run(self, share_slug: str, body: ChatIn) -> ChatOut | JSONResponse:
        s = self.settings
        try:
            with db.get_conn() as conn:  # short-lived: no connection is held during a model call
                session_id = _session_id(conn, share_slug)
                cur = plan_edit.current(conn, session_id)
                if (body.base.itinerary_slug, body.base.seq) != (cur.row["share_slug"], cur.seq):
                    logger.info("plan chat refused share_slug=%s reason=plan_changed base_seq=%d seq=%d", share_slug, body.base.seq, cur.seq)
                    return _flat(409, "plan_changed", itinerary_slug=cur.row["share_slug"], seq=cur.seq)
                ctx = plan_chat_context.load(conn, session_id, cur.row, cur.guide, body.focus.key if body.focus else None)
        except plan_edit.Refused as r:
            return _flat(r.status, r.body["detail"])
        turns = [Turn(m.role, m.text) for m in body.messages]
        model, used_fallback, codes = s.model, False, []
        for attempt in range(1, s.max_attempts + 1):
            if not self.spend.allowed():  # before every attempt, not once a message (review S3)
                return self._cap(share_slug)
            try:
                reply = self.client.complete(model=model, system=SYSTEM_PROMPT, user=build_user_message(ctx.text, turns, codes),
                                             schema=plan_ops.REPLY_SCHEMA, max_tokens=s.max_tokens, timeout=s.timeout_s)
            except LLMUnavailable as e:
                if e.kind == "timeout":
                    self.spend.add(model, 0, s.max_tokens)  # it was probably still generated, and billed
                level = logging.ERROR if e.status in CONFIG_STATUSES else logging.WARNING
                logger.log(level, "plan chat failed share_slug=%s code=chat_failed kind=%s status=%s attempts=%d", share_slug, e.kind, e.status, attempt)
                return _flat(502, "chat_failed")
            cost = self.spend.add(reply.model, reply.input_tokens, reply.output_tokens)
            out, codes_now, n_ops = self._judge(reply, session_id, cur, ctx, body.base)
            logger.info(
                "plan chat share_slug=%s attempt=%d/%d model=%s stop=%s input_tokens=%d output_tokens=%d cost_usd=%.4f "
                "spent_today_usd=%.4f ops=%d proposal=%s codes=%s",
                share_slug, attempt, s.max_attempts, reply.model, reply.stop, reply.input_tokens, reply.output_tokens, cost,
                self.spend.spent_today, n_ops, "yes" if out and out.proposal else "no", ",".join(codes_now) or "-",
            )
            if out is not None:
                return out
            if reply.stop == "refused":
                if used_fallback or not s.fallback_model:
                    break
                model, used_fallback, codes = s.fallback_model, True, []
            else:
                codes = codes_now
        logger.warning("plan chat failed share_slug=%s code=no_fit attempts=%d last_codes=%s", share_slug, attempt, ",".join(codes) or "-")
        return ChatOut(reply=NO_FIT, proposal=None, outcome="no_fit", need_link=None)

    def _judge(self, reply, session_id, cur: plan_edit.Current, ctx, base: plan_edit.Base) -> tuple[ChatOut | None, list[str], int]:
        """The answer, if this reply is good; else None and the codes to retry with."""
        if reply.stop == "refused":
            return None, ["refused"], 0
        if reply.stop == "truncated":
            return None, ["truncated"], 0
        if reply.stop != "complete" or reply.text is None:
            return None, ["bad_json"], 0
        try:
            answer = plan_ops.Reply.model_validate_json(reply.text)
        except ValidationError:
            return None, ["bad_json"], 0
        ops = answer.ops
        if any((o.spot_id and o.spot_id not in ctx.spot_ids) or (o.trip_place_id and o.trip_place_id not in ctx.trip_place_ids)
               or (o.trip_id and o.trip_id not in ctx.trip_ids) for o in ops):
            return None, ["unknown_id"], len(ops)  # only ids it was given
        stored, codes = plan_ops.apply(cur.guide, ops) if ops else (None, [])
        if codes:
            return None, codes, len(ops)
        times, amounts = ctx.times | _guide_times(cur.guide), ctx.amounts | _budget_amounts(cur.guide)
        proposal = None
        if ops:
            try:
                guide_in = plan_edit.GuideIn.model_validate(stored)
            except ValidationError:
                return None, ["bad_op"], len(ops)
            try:
                with db.get_conn() as conn:
                    p = plan_edit.prepare(conn, session_id, cur, guide_in)
                    shown = its.guide_out(conn, p.guide, session_id)
            except plan_edit.Refused as r:
                return None, r.body.get("codes", [r.body["detail"]]), len(ops)
            times |= _guide_times(p.guide)
            amounts |= _budget_amounts(p.guide)
            proposal = Proposal(guide=shown, stored=guide_in, changes=p.changes, base=base)
        codes = check_text(answer.reply, times, amounts)
        for t in plan_ops.texts(ops):
            codes += check_text(t, times, amounts)
        if codes:
            return None, list(dict.fromkeys(codes)), len(ops)
        outcome = "proposal" if proposal else "answer"
        return ChatOut(reply=answer.reply, proposal=proposal, outcome=outcome, need_link=self._need_link(answer.need_link, cur.guide)), [], len(ops)

    @staticmethod
    def _need_link(n: plan_ops.NeedLink | None, g: guides.Guide) -> NeedLinkOut | None:
        if n is None:
            return None
        keys, days = {r.key for d in g.days for r in d.rows}, {d.day for d in g.days}
        at = ({"replace": n.replace} if n.replace in keys else {"after": n.after} if n.after in keys
              else {"first_of_day": n.first_of_day} if n.first_of_day in days else None)
        return NeedLinkOut(name=n.name, at=at)


# ---------------------------------------------------------------- route

_build_lock = threading.Lock()


@lru_cache(maxsize=1)
def _build_chat() -> Chat:
    """Read the config and build the client once, on the first chat. Raises LLMConfigError."""
    cfg = LLMConfig.from_env()
    client = make_llm_client(cfg)
    s = ChatSettings.from_env(cfg)
    logger.info(
        "plan chat config provider=%s model=%s fallback=%s max_tokens=%d timeout_s=%g attempts=%d cap_usd=%.2f "
        "trip_per_hour=%d ip_per_hour=%d key_set=%s",
        cfg.provider, s.model, s.fallback_model, s.max_tokens, s.timeout_s, s.max_attempts, s.daily_cap_usd,
        s.trip_per_hour, s.ip_per_hour, bool(cfg.api_key),
    )
    return Chat(client, s)


def chat_live(request: Request) -> None:
    if not request.app.state.flags.chatbot_live:
        raise HTTPException(503, "chat_off")


def get_chat() -> Chat:
    try:
        with _build_lock:
            return _build_chat()
    except LLMConfigError as e:
        logger.error("plan chat not configured reason=%s", e)
        raise HTTPException(503, "chat_off") from None


@router.post("/sessions/{share_slug}/plan/chat", response_model=ChatOut, dependencies=[Depends(chat_live)],
             responses={409: {"description": "plan_changed"}, 429: {"description": "chat_busy or chat_cap"},
                        502: {"description": "chat_failed"}, 503: {"description": "chat_off"}})
def plan_chat(share_slug: str, body: ChatIn, request: Request, bot: Chat = Depends(get_chat)):
    if not SLUG.fullmatch(share_slug):
        raise HTTPException(404, "Trip not found", headers=NOINDEX)
    limited = bot.limit(share_slug, client_ip(request))
    if limited is not None:
        return limited
    out = bot.run(share_slug, body)
    if isinstance(out, ChatOut):
        return JSONResponse(out.model_dump(mode="json", by_alias=True), headers={"Cache-Control": "private, no-cache", **NOINDEX})
    return out
