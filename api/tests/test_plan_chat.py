"""TG-61 PR 2: the chatbot proposes changes to a trip's plan, and a human taps Apply (plan.md §2.4, options.md §7).

Every model reply here is recorded (planner_data.FakeLLM): no test calls a real model. The trip is a made-up one on
the owner's plan file in a throwaway database, as in test_plan_edit.py. The ids are test-plan.md §7's, P1 to P8.
"""

import dataclasses
import json
import logging
import re
import uuid
from datetime import datetime, timedelta

import psycopg
import pytest

from app.llm import LLMUnavailable
from planner_data import FakeLLM
from test_guide import SLUG, barkada, trip  # noqa: F401  fixtures
from test_plan_edit import base_of, editing, edit, one, place_row, plan_of, retime, row, rows, save, stored, t  # noqa: F401

MARKER = "Zyxwvut"  # a made-up name: it must never reach the model, a log line or a table


# ---------------------------------------------------------------- helpers

def say(reply: str, ops=(), need_link=None) -> dict:
    """One recorded model answer, in the chat's output shape."""
    return {"text": {"reply": reply, "ops": list(ops), "need_link": need_link}}


def op(name: str, **fields) -> dict:
    return {"op": name, **fields}


class Clock:
    def __init__(self, t=0.0):
        self.t = t

    def __call__(self):
        return self.t


@pytest.fixture()
def chat(t, client, monkeypatch):  # noqa: F811
    """CHATBOT_LIVE on, and the chat's model replaced by `chat.script(...)`."""
    from app import plan_chat

    client.app.state.flags = dataclasses.replace(client.app.state.flags, chatbot_live=True)

    class Rig:
        llm = FakeLLM()
        settings = plan_chat.ChatSettings(model="claude-haiku-5-5", fallback_model="claude-sonnet-5-5", max_tokens=1000,
                                          timeout_s=20.0, max_attempts=3, daily_cap_usd=1.0, trip_per_hour=20, ip_per_hour=60)
        bot = None

        def script(self, *items, **settings):
            self.llm = FakeLLM(*items)
            self.bot = plan_chat.Chat(self.llm, dataclasses.replace(self.settings, **settings))
            client.app.dependency_overrides[plan_chat.get_chat] = lambda: self.bot
            return self

    rig = Rig()
    yield rig
    client.app.dependency_overrides.clear()


def ask(client, slug, text="move the strawberry farm to Sunday", base=None, history=(), focus=None):
    if base is None:
        base = base_of(plan_of(client, slug))
    messages = [*history, {"role": "user", "text": text}]
    return client.post(f"/sessions/{slug}/plan/chat", json={"base": base, "messages": messages, "focus": focus})


def spot_ids(dsn) -> list[str]:
    return [str(r["id"]) for r in rows(dsn, "select id from spots where city = 'Baguio' order by slug")]


# ---------------------------------------------------------------- P1: operations

@pytest.fixture()
def g(t, client):  # noqa: F811
    from app import guide as guides

    raw = stored(plan_of(client, t)["guide"])
    return guides.parse_guide(raw)[0]


def test_each_operation_applies(g, barkada):  # P1
    from app import plan_ops

    spot = spot_ids(barkada)[0]
    other_trip = str(g.getting_there.buses[1].trip_id)
    cases = [
        (op("add_row", day=2, after="d2-03", time="08:00", plan="Merienda", note="", spot_id=spot),
         lambda x: x["days"][1]["rows"][3]["key"] is None and x["days"][1]["rows"][3]["plan"] == "Merienda"),
        (op("remove_row", key="d2-05", why="You asked for a slower Day 2"), lambda x: "d2-05" not in [r["key"] for d in x["days"] for r in d["rows"]]),
        (op("move_row", key="d2-08", day=3, after=None), lambda x: x["days"][2]["rows"][0]["key"] == "d2-08"),
        (op("set_row", key="d2-08", time="16:00", note="Bring jackets"),
         lambda x: next(r for r in x["days"][1]["rows"] if r["key"] == "d2-08")["time"] == "16:00"),
        (op("swap_bus", table="getting_there", index=0, trip_id=other_trip), lambda x: x["getting_there"]["buses"][0]["trip_id"] == other_trip),
        (op("add_todo", text="Pack jackets"), lambda x: x["todo"][-1] == {"key": None, "text": "Pack jackets", "done": False}),
        (op("remove_todo", key="todo-01", why="Already done"), lambda x: "todo-01" not in [y["key"] for y in x["todo"]]),
        (op("set_budget", budget_rows=[{"item": "Food", "estimate": "PHP 2,000"}], budget_summary="About PHP 5,000 each"),
         lambda x: x["budget"]["rows"] == [{"item": "Food", "estimate": "PHP 2,000"}]),
    ]
    for o, ok in cases:
        out, codes = plan_ops.apply(g, [plan_ops.Op.model_validate(o)])
        assert codes == [] and ok(out), o["op"]
    new_row = plan_ops.apply(g, [plan_ops.Op.model_validate(cases[0][0])])[0]["days"][1]["rows"][3]
    assert new_row["place"] == {"spot_id": spot} and new_row.get("leg") is None


@pytest.mark.parametrize("bad, code", [
    (op("remove_row", key="d9-99"), "unknown_key"),
    (op("move_row", key="d2-08", day=3, after="d1-01"), "unknown_key"),  # after must be on that day
    (op("add_row", day=7, after=None, time="08:00", plan="x"), "bad_day"),
    (op("add_row", day=2, after=None, time="8am", plan="x"), "bad_op"),
    (op("add_row", day=2, after=None, time="08:00", plan="x", key="d2-50"), "bad_op"),  # the model never mints a key
    (op("swap_bus", table="getting_there", index=99, trip_id=str(uuid.uuid4())), "bad_op"),
    (op("remove_todo", key="todo-77"), "unknown_key"),
    (op("set_row", key="d2-08", spot_id=str(uuid.uuid4()), trip_place_id=str(uuid.uuid4())), "bad_op"),
])
def test_bad_operations_are_refused(g, bad, code):  # P1
    from app import plan_ops

    out, codes = plan_ops.apply(g, [plan_ops.Op.model_validate(bad)])
    assert out is None and codes == [code]


def test_an_operation_cant_carry_a_pin():  # P1
    from app import plan_ops

    with pytest.raises(ValueError):
        plan_ops.Op.model_validate(op("add_row", day=2, after=None, time="08:00", plan="x", lat=16.4, lng=120.6))
    props = plan_ops.REPLY_SCHEMA["properties"]["ops"]["items"]["properties"]
    assert not {"lat", "lng", "maps_url", "key_new"} & set(props), "the schema has no field for a pin"


# ---------------------------------------------------------------- P2: the loop and its limits

def test_a_good_reply_is_a_proposal_and_nothing_is_saved(chat, t, client, barkada):  # P2, B39
    it = plan_of(client, t)
    chat.script(say("Moved the strawberry farm to Day 3.", [op("move_row", key="d2-08", day=3, after="d3-03")]))
    r = ask(client, t)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["outcome"] == "proposal" and out["reply"] == "Moved the strawberry farm to Day 3."
    p = out["proposal"]
    assert p["base"] == base_of(it)
    assert p["changes"][0]["word"] == "Moved" and p["changes"][0]["day"] == 3 and set(p["changes"][0]) == {"word", "day", "text"}
    assert [r["key"] for r in p["guide"]["days"][2]["rows"]][3] == "d2-08"
    assert plan_of(client, t)["share_slug"] == SLUG, "nothing changes until Apply"
    assert one(barkada, "select count(*) as n from itinerary_versions")["n"] == 0
    applied = save(client, t, p["stored"], p["base"], source="chat")
    assert applied.status_code == 200, applied.text
    assert applied.json()["changes"] == p["changes"]
    assert client.get(f"/sessions/{t}").json()["plan_edits"]["versions"][0]["source"] == "chat"


def test_a_question_gets_an_answer_with_no_proposal(chat, t, client):  # P2
    chat.script(say("Day 2 starts with sunrise, then breakfast."))
    out = ask(client, t, "ano ang una sa Day 2?").json()
    assert out == {"reply": "Day 2 starts with sunrise, then breakfast.", "proposal": None, "outcome": "answer", "need_link": None}


def test_a_bad_id_is_retried_with_its_code(chat, t, client):  # P2, B40
    made_up = str(uuid.uuid4())
    chat.script(say("Swapped it.", [op("set_row", key="d2-08", spot_id=made_up)]),
                say("Moved it.", [op("set_row", key="d2-08", time="16:00")]))
    out = ask(client, t).json()
    assert out["outcome"] == "proposal" and out["reply"] == "Moved it."
    assert len(chat.llm.calls) == 2
    second = chat.llm.calls[1]["user"]
    assert "unknown_id" in second and "<feedback>" in second


def test_three_bad_replies_give_the_plain_reply(chat, t, client):  # P2, B40
    bad = say("Done.", [op("remove_row", key="d9-99")])
    chat.script(bad, bad, bad)
    out = ask(client, t).json()
    assert out["outcome"] == "no_fit" and out["proposal"] is None
    assert out["reply"] == "The chatbot couldn't make a change that fits the plan. Try asking another way."
    assert len(chat.llm.calls) == 3


def test_a_refusal_tries_the_fallback_once(chat, t, client):  # P2
    chat.script({"stop": "refused"}, say("Ok."))
    out = ask(client, t).json()
    assert out["outcome"] == "answer" and [c["model"] for c in chat.llm.calls] == ["claude-haiku-5-5", "claude-sonnet-5-5"]
    chat.script({"stop": "refused"}, {"stop": "refused"})
    out = ask(client, t).json()
    assert out["outcome"] == "no_fit" and len(chat.llm.calls) == 2


def test_the_provider_down_is_chat_failed(chat, t, client):  # P2
    chat.script(LLMUnavailable("connection"))
    r = ask(client, t)
    assert r.status_code == 502 and r.json() == {"detail": "chat_failed"}


def manila_midnight() -> str:
    from app.limits import MANILA_TZ

    now = datetime.now(MANILA_TZ)
    return (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0).isoformat()


def test_the_daily_cap(chat, t, client):  # P2
    chat.script(say("Ok."), daily_cap_usd=0.0)
    r = ask(client, t)
    assert r.status_code == 429 and r.json() == {"detail": "chat_cap", "retry_at": manila_midnight()}
    assert int(r.headers["Retry-After"]) >= 1
    assert chat.llm.calls == [], "the cap is checked before any call"


def test_twenty_an_hour_per_trip_and_sixty_per_ip(chat, t, client):  # P2, B42
    chat.script(*[say("Ok.")] * 25, trip_per_hour=20)
    for _ in range(20):
        assert ask(client, t).status_code == 200
    r = ask(client, t)
    assert r.status_code == 429 and r.json()["detail"] == "chat_busy"
    assert int(r.headers["Retry-After"]) >= 1
    assert datetime.fromisoformat(r.json()["retry_at"]).utcoffset() == timedelta(hours=8)
    chat.script(*[say("Ok.")] * 5, trip_per_hour=100, ip_per_hour=2)
    other = client.post("/sessions", json={"name": "Two", "start_date": "2026-11-06", "return_date": "2026-11-08"}).json()["share_slug"]
    assert client.put(f"/sessions/{other}/itinerary", json={"share_slug": SLUG}).status_code == 200
    assert ask(client, t).status_code == 200 and ask(client, other).status_code == 200
    assert ask(client, other).json()["detail"] == "chat_busy", "per IP, across trips"


def test_the_owners_limits_are_the_defaults():  # P2, P8 (test-audit-pr2 G2)
    from app.llm import LLMConfig
    from app.plan_chat import ChatSettings

    s = ChatSettings.from_env(LLMConfig.from_env({}), {})
    assert (s.model, s.fallback_model) == ("claude-haiku-5-5", "claude-sonnet-5-5")
    assert s.daily_cap_usd == 1.00 and s.max_tokens == 1000 and s.trip_per_hour == 20
    assert s.ip_per_hour == 60 and s.max_attempts == 3
    planner = {"PLANNER_DAILY_SPEND_CAP_USD": "5", "LLM_MAX_TOKENS": "16000", "PLANNER_RATE_LIMIT_PER_HOUR": "99"}
    s = ChatSettings.from_env(LLMConfig.from_env(planner), planner)
    assert (s.daily_cap_usd, s.max_tokens, s.trip_per_hour) == (1.00, 1000, 20), "the planner's settings aren't the chat's"
    assert ChatSettings.from_env(LLMConfig.from_env({}), {"CHAT_MAX_TOKENS": "99999"}).max_tokens == 1000, "out of range"
    assert ChatSettings.from_env(LLMConfig.from_env({}), {"CHAT_MAX_TOKENS": "4000"}).max_tokens == 4000


def test_chat_off_and_plan_editing_off(t, client, monkeypatch):  # P2
    from app import plan_chat

    assert client.app.state.flags.chatbot_live is False
    monkeypatch.setenv("LLM_API_KEY", "sk-test-not-a-key")  # so only the flag can answer chat_off (test-audit-pr2 G3)
    plan_chat._build_chat.cache_clear()
    r = ask(client, t)
    assert r.status_code == 503 and r.json() == {"detail": "chat_off"}
    assert plan_chat._build_chat.cache_info().misses == 0, "the flag answers before a client is built"
    client.app.state.flags = dataclasses.replace(client.app.state.flags, chatbot_live=True)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    plan_chat._build_chat.cache_clear()
    r = ask(client, t)
    assert r.status_code == 503 and r.json() == {"detail": "chat_off"}, "on, with no key configured"
    plan_chat._build_chat.cache_clear()
    client.app.state.flags = dataclasses.replace(client.app.state.flags, plan_editing=False)
    assert ask(client, t, base={"itinerary_slug": SLUG, "seq": 0}).status_code == 404


def test_a_stale_base_is_a_clash(chat, t, client):  # P2
    chat.script(say("Ok."))
    edit(client, t, retime("d2-08", "15:30"))
    r = ask(client, t, base={"itinerary_slug": SLUG, "seq": 0})
    assert r.status_code == 409 and r.json()["detail"] == "plan_changed" and r.json()["seq"] == 1
    assert chat.llm.calls == []


def test_the_request_shape(chat, t, client):
    chat.script(say("Ok."))
    base = base_of(plan_of(client, t))
    url = f"/sessions/{t}/plan/chat"
    too_many = [{"role": "user", "text": "x"}] * 11
    for body in ({"base": base, "messages": too_many, "focus": None},
                 {"base": base, "messages": [{"role": "user", "text": "x" * 1001}], "focus": None},
                 {"base": base, "messages": [{"role": "assistant", "text": "x"}], "focus": None},
                 {"base": base, "messages": [], "focus": None},
                 {"base": base, "messages": [{"role": "system", "text": "x"}], "focus": None}):
        assert client.post(url, json=body).status_code == 422
    assert chat.llm.calls == []


# ---------------------------------------------------------------- P3: nothing kept, nothing logged

def table_counts(dsn) -> dict:
    names = [r["table_name"] for r in rows(dsn, "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'")]
    return {n: one(dsn, f"select count(*) as n from {n}")["n"] for n in names}


def test_no_chat_text_in_logs_or_tables(chat, t, client, barkada, caplog):  # P3, B44
    caplog.set_level(logging.DEBUG)
    before = table_counts(barkada)
    chat.script(say(f"Sige, {MARKER} reply", [op("set_row", key="d2-08", note=f"{MARKER} note")]))
    r = ask(client, t, f"{MARKER} asks to change the note", focus={"key": "d2-08"})
    assert r.status_code == 200 and r.json()["outcome"] == "proposal"
    assert table_counts(barkada) == before
    assert MARKER not in caplog.text
    names = {row(plan_of(client, t)["guide"], "d2-08")["plan"]}
    assert not any(n in caplog.text for n in names)
    assert "plan chat share_slug=" in caplog.text and "proposal=yes" in caplog.text and "ops=1" in caplog.text


# ---------------------------------------------------------------- P4: a stale proposal

def test_applying_a_stale_proposal_is_a_clash(chat, t, client):  # P4, B41
    chat.script(say("Moved it.", [op("set_row", key="d2-08", time="16:00")]))
    p = ask(client, t).json()["proposal"]
    edit(client, t, retime("d2-09", "18:30"))  # a hand edit in between
    r = save(client, t, p["stored"], p["base"], source="chat")
    assert r.status_code == 409 and r.json()["detail"] == "plan_changed"


# ---------------------------------------------------------------- P5: times and fares

@pytest.mark.parametrize("text", ["at 4:10", "at 16:10", "at 4pm", "at 4 PM", "at 4.10pm", "₱600", "P600", "PHP 600", "600 pesos"])
def test_each_time_and_fare_form_is_caught(text):  # P5
    from app.plan_chat import check_text

    codes = check_text(f"The bus is {text}.", allowed_times=set(), allowed_amounts=set())
    assert codes and set(codes) <= {"made_up_time", "made_up_fare"}


def test_given_times_and_fares_pass(chat, t, client, barkada):  # P5
    from app.plan_chat import check_text

    assert check_text("Leave at 4:10 PM, about ₱762.", allowed_times={16 * 60 + 10}, allowed_amounts={762.0}) == []
    assert check_text("Alis tayo alas-kwatro.", allowed_times=set(), allowed_amounts=set()) == [], "the stated gap (plan §11)"
    it = plan_of(client, t)
    home = next(b for b in it["guide"]["getting_home"]["buses"] if b["booked"])["trip"]
    h, m = (int(x) for x in home["departure_time"].split(":"))
    fare = int(home["fare_php"])
    told = f"The bus home leaves at {h % 12 or 12}:{m:02d} {'PM' if h >= 12 else 'AM'} and costs ₱{fare}."
    chat.script(say(told))
    out = ask(client, t, "when is our bus home?").json()
    assert out["outcome"] == "answer" and out["reply"] == told


def test_a_made_up_bus_time_in_a_reply_is_retried_then_refused(chat, t, client):  # P5, B49
    lie = say("The last bus home is at 11 PM, ₱600")
    chat.script(lie, lie, lie)
    out = ask(client, t, "anong oras ang last bus?").json()
    assert out["outcome"] == "no_fit" and "11 PM" not in out["reply"]
    feedback = chat.llm.calls[1]["user"]
    assert "made_up_time" in feedback and "made_up_fare" in feedback


def test_a_made_up_time_in_a_note_is_retried(chat, t, client):  # P5, M5
    chat.script(say("Added a note.", [op("set_row", key="d2-08", note="The jeep leaves at 3:35 PM")]),
                say("Added a note.", [op("set_row", key="d2-08", note="Ask the guard for the jeep stop")]))
    out = ask(client, t).json()
    assert out["outcome"] == "proposal" and "made_up_time" in chat.llm.calls[1]["user"]


# ---------------------------------------------------------------- P6: Taglish

def test_a_taglish_reply_is_passed_through_as_written(chat, t, client):  # P6, B43
    reply = "Sige! Inilipat ko ang strawberry farm sa Day 3, para mas chill ang Day 2."
    chat.script(say(reply, [op("move_row", key="d2-08", day=3, after=None)]))
    out = ask(client, t, "pwede bang ilipat ang strawberry farm sa Linggo?").json()
    assert out["reply"] == reply and out["outcome"] == "proposal"


# ---------------------------------------------------------------- P7: no names in the context

def test_the_context_holds_no_party_or_attendee_names(chat, t, client, barkada):  # P7, review S4
    with psycopg.connect(barkada, autocommit=True) as conn:
        conn.execute("update itineraries set party = %s where share_slug = %s",
                     (json.dumps([{"type": "adult", "name": MARKER}, {"type": "adult", "name": "Ana"}]), SLUG))
    assert client.post(f"/sessions/{t}/attendees", json={"name": MARKER + "b"}).status_code == 201
    chat.script(say("Ok."))
    ask(client, t, "hello")
    sent = chat.llm.calls[0]["system"] + chat.llm.calls[0]["user"]
    assert MARKER not in sent
    assert "party: 2 adult" in sent, "the party size only"


def test_the_context_lists_only_what_the_model_may_use(chat, t, client, barkada):
    mine = place_row(barkada, t, name="Cafe Ozark")
    place_row(barkada, client.post("/sessions", json={"name": "X", "start_date": "2026-11-06", "return_date": "2026-11-08"}).json()["share_slug"],
              name="Not ours")
    chat.script(say("Ok."))
    ask(client, t, "hello", focus={"key": "d2-08"})
    user = chat.llm.calls[0]["user"]
    assert mine in user and "Cafe Ozark" in user and "Not ours" not in user
    assert "<focus>d2-08</focus>" in user
    assert "d2-08" in user and "<buses>" in user and "<spots>" in user and "<routes>" in user
    assert "https://" not in user, "no links, not even the trip place's"


# ---------------------------------------------------------------- P8: tokens and the cap per attempt

def test_max_tokens_is_the_chats_own_and_a_timeout_is_charged_at_it(chat, t, client):  # P8, review S3
    chat.script(say("Done.", [op("remove_row", key="d9-99")]), LLMUnavailable("timeout"), max_tokens=900)
    r = ask(client, t)
    assert r.status_code == 502
    assert [c["max_tokens"] for c in chat.llm.calls] == [900, 900]
    from app.limits import PRICES_PER_MTOK

    first = (1000 * PRICES_PER_MTOK["claude-haiku-5-5"][0] + 500 * PRICES_PER_MTOK["claude-haiku-5-5"][1]) / 1e6
    timeout = 900 * PRICES_PER_MTOK["claude-haiku-5-5"][1] / 1e6
    assert chat.bot.spend.spent_today == pytest.approx(first + timeout)


def test_the_cap_is_checked_before_every_attempt(chat, t, client):  # P8
    bad = say("Done.", [op("remove_row", key="d9-99")])
    chat.script(bad, bad, bad, daily_cap_usd=0.00039)  # the first attempt costs $0.00035
    chat.bot.spend.add("claude-haiku-5-5", 0, 100)  # a little spent already
    out = ask(client, t)
    assert out.status_code == 429 and out.json()["detail"] == "chat_cap"
    assert len(chat.llm.calls) == 1, "stopped before the second attempt"


# ---------------------------------------------------------------- a place it can't pin

def test_a_place_it_cant_pin_asks_for_a_link(chat, t, client):
    chat.script(say("Hill Station isn't on Tara Gala yet. Paste its Google Maps link.",
                    need_link={"name": "Hill Station", "after": "d2-05", "replace": None, "first_of_day": None}))
    out = ask(client, t, "add Hill Station after the park").json()
    assert out["outcome"] == "answer" and out["need_link"] == {"name": "Hill Station", "at": {"after": "d2-05"}}
    chat.script(say("Paste its link.", need_link={"name": "Hill Station", "after": "d9-99", "replace": None, "first_of_day": None}))
    assert ask(client, t).json()["need_link"] == {"name": "Hill Station", "at": None}, "a key that isn't in the plan"


def test_a_trip_place_the_group_added_can_be_used(chat, t, client, barkada):
    mine = place_row(barkada, t, name="Cafe Ozark")
    chat.script(say("Added Cafe Ozark.", [op("add_row", day=2, after="d2-08", time="16:30", plan="Cafe Ozark", note="", trip_place_id=mine)]))
    out = ask(client, t).json()
    assert out["outcome"] == "proposal"
    new = next(r for r in out["proposal"]["guide"]["days"][1]["rows"] if r["plan"] == "Cafe Ozark")
    assert new["place"]["kind"] == "trip_place" and new["place"]["id"] == mine
    theirs = place_row(barkada, client.post("/sessions", json={"name": "X", "start_date": "2026-11-06", "return_date": "2026-11-08"}).json()["share_slug"])
    bad = say("Added it.", [op("add_row", day=2, after="d2-08", time="16:30", plan="x", note="", trip_place_id=theirs)])
    chat.script(bad, bad, bad)
    assert ask(client, t).json()["outcome"] == "no_fit", "another trip's place is never offered"


def test_the_chat_route_is_behind_both_flags_in_the_route_audit():
    from app.main import app

    served = {(m, r.path) for r in app.routes for m in (getattr(r, "methods", None) or set())}
    assert ("POST", "/sessions/{share_slug}/plan/chat") in served
    assert re.search(r"chatbot_live", (__import__("pathlib").Path(__file__).parents[1] / "app" / "plan_chat.py").read_text())


def test_a_proposal_gets_every_check_a_hand_edit_gets(chat, t, client):  # B40: plan_edit.prepare on every proposal
    it = plan_of(client, t)
    home = it["guide"]["getting_home"]["buses"][0]["trip_id"]
    chat.script(say("Swapped the bus.", [op("swap_bus", table="getting_there", index=0, trip_id=home)]),
                say("Moved it.", [op("set_row", key="d2-08", time="16:00")]))
    out = ask(client, t).json()
    assert out["outcome"] == "proposal" and out["reply"] == "Moved it."
    assert "wrong_direction" in chat.llm.calls[1]["user"], "a bus going the other way, refused as a hand edit would be"


# ---------------------------------------------------------------- P9: why a stop goes (owner feedback 2026-11-15)

WHY = "You asked for a slower Day 2"


@pytest.mark.parametrize("o, code", [
    (op("remove_row", key="d2-05"), "no_why"),
    (op("remove_row", key="d2-05", why="   "), "no_why"),
    (op("remove_todo", key="todo-01"), "no_why"),
    (op("remove_row", key="d2-05", why="x" * 121), "long_why"),
    (op("remove_row", key="d2-05", why="x" * 600), "long_why"),  # review N2: any length is long_why, never bad_json
    (op("move_row", key="d2-08", day=3, after=None, why="x" * 121), "long_why"),
    (op("remove_row", key="d9-99"), "unknown_key"),  # a key it made up is that, first
])
def test_a_removal_needs_a_short_why(g, o, code):  # P9
    from app import plan_ops

    assert plan_ops.apply(g, [plan_ops.Op.model_validate(o)]) == (None, [code])


def test_a_why_is_optional_on_a_move_a_change_or_a_swap(g):  # P9
    from app import plan_ops

    other_trip = str(g.getting_there.buses[1].trip_id)
    ops = [plan_ops.Op.model_validate(o) for o in (
        op("move_row", key="d2-08", day=3, after=None),
        op("set_row", key="d2-09", time="18:30", why="Dinner after the market"),
        op("swap_bus", table="getting_there", index=0, trip_id=other_trip, why="An earlier start"),
        op("remove_todo", key="todo-01", why="Already done"),
    )]
    assert plan_ops.apply(g, ops)[1] == []
    assert plan_ops.whys(ops) == {"row:d2-09": "Dinner after the market", "bus:getting_there:0": "An earlier start",
                                  "todo:01": "Already done"}
    four = ops + [plan_ops.Op.model_validate(op("remove_row", key="d2-05", why=WHY))]
    assert plan_ops.apply(g, four) == (None, ["too_many_whys"]), "a version holds 4 lines, and a why is never in More"


def test_a_why_is_on_the_first_line_its_row_makes_only(chat, t, client):  # P9: never on a second or ripple line
    chat.script(say("Done.", [op("set_row", key="d2-09", time="18:30", note="After the market", why="Dinner after the market")]))
    p = ask(client, t).json()["proposal"]
    assert [(c["word"], c.get("why")) for c in p["changes"]] == [("Later", "Dinner after the market"), ("Changed", None)]


def other_spot(g, dsn, key="d2-08") -> str:
    here = next(r for d in g.days for r in d.rows if r.key == key).place
    return next(s for s in spot_ids(dsn) if not here or str(here.spot_id) != s)


def test_a_place_swap_needs_a_why(g, barkada):  # P9, owner decision 2026-11-15 (review N3)
    from app import plan_ops

    spot = other_spot(g, barkada)
    here = next(r for d in g.days for r in d.rows if r.key == "d2-08").place

    def codes(o):
        return plan_ops.apply(g, [plan_ops.Op.model_validate(o)])[1]

    assert codes(op("set_row", key="d2-08", spot_id=spot)) == ["no_why"], "Out/In takes a stop out, like a removal"
    assert codes(op("set_row", key="d2-08", spot_id=spot, why="  ")) == ["no_why"]
    assert codes(op("set_row", key="d2-08", spot_id=spot, why="Closer to the market")) == []
    assert codes(op("set_row", key="d2-08", time="16:00", note="Bring jackets")) == [], "no new place: the why stays optional"
    if here and here.spot_id:
        assert codes(op("set_row", key="d2-08", spot_id=str(here.spot_id))) == [], "the same place isn't a swap"


def test_a_place_swap_without_a_why_is_retried(chat, t, client, g, barkada):  # P9, owner decision 2026-11-15
    spot = other_spot(g, barkada)
    chat.script(say("Pinalitan ko.", [op("set_row", key="d2-08", spot_id=spot)]),
                say("Pinalitan ko.", [op("set_row", key="d2-08", spot_id=spot, why="Closer to the market")]))
    out = ask(client, t, "palitan natin ang strawberry farm").json()
    assert out["outcome"] == "proposal" and "no_why" in chat.llm.calls[1]["user"]
    assert (out["proposal"]["changes"][0]["word"], out["proposal"]["changes"][0].get("why")) == ("Out", "Closer to the market")


def test_a_line_with_a_why_is_never_folded_into_more(chat, t, client):  # P9, ux.md §10
    chat.script(say("Done.", [op("set_row", key="d1-01", note="a"), op("set_row", key="d1-02", note="b"),
                              op("set_row", key="d1-03", note="c"), op("remove_row", key="d2-05", why=WHY)]))
    p = ask(client, t).json()["proposal"]
    assert [c["word"] for c in p["changes"]] == ["Changed", "Changed", "Dropped", "More"]
    assert p["changes"][2]["why"] == WHY and p["changes"][3]["text"] == "and 1 more change"


def test_the_prompt_and_schema_ask_for_a_why():  # P9
    from app import plan_ops
    from app.plan_chat_prompt import FEEDBACK, SYSTEM_PROMPT

    props = plan_ops.REPLY_SCHEMA["properties"]["ops"]["items"]
    assert "why" in props["properties"] and "why" in props["required"]
    assert "remove_row, remove_todo, and set_row that changes a row's place" in SYSTEM_PROMPT and "plain English" in SYSTEM_PROMPT and "At most 3 whys" in SYSTEM_PROMPT
    assert {"no_why", "long_why", "too_many_whys"} <= set(FEEDBACK)


def test_a_removal_without_a_why_is_retried_then_refused(chat, t, client):  # P9
    bare = say("Tinanggal ko ang park.", [op("remove_row", key="d2-05")])
    chat.script(bare, bare, bare)
    out = ask(client, t, "gawin nating chill ang Day 2").json()
    assert out["outcome"] == "no_fit" and out["proposal"] is None
    assert len(chat.llm.calls) == 3
    assert all("no_why" in c["user"] and "<feedback>" in c["user"] for c in chat.llm.calls[1:]), "retried with its code"


def test_a_removals_why_is_on_its_line_and_kept_after_apply(chat, t, client):  # P9
    chat.script(say("Tinanggal ko ang park.", [op("remove_row", key="d2-05")]),
                say("Tinanggal ko ang park.", [op("remove_row", key="d2-05", why=WHY),
                                               op("move_row", key="d2-08", day=3, after=None)]))
    out = ask(client, t, "gawin nating chill ang Day 2").json()
    assert out["outcome"] == "proposal" and "no_why" in chat.llm.calls[1]["user"]
    p = out["proposal"]
    dropped = next(c for c in p["changes"] if c["word"] == "Dropped")
    moved = next(c for c in p["changes"] if c["word"] == "Moved")
    assert dropped["why"] == WHY and "why" not in moved, "a line with no why has no why field"
    assert p["whys"] == {"row:d2-05": WHY}
    applied = save_chat(client, t, p)
    assert applied.status_code == 200, applied.text
    assert applied.json()["changes"] == p["changes"]
    assert client.get(f"/sessions/{t}").json()["plan_edits"]["versions"][0]["changes"] == p["changes"], "Changes keeps it"


def save_chat(client, slug, p):
    return client.put(f"/sessions/{slug}/plan", json={"base": p["base"], "guide": p["stored"], "source": "chat", "whys": p["whys"]})


def test_a_why_goes_on_a_to_do_and_a_bus_line(chat, t, client, g):  # P9
    other_trip = str(g.getting_there.buses[1].trip_id)
    chat.script(say("Done.", [op("remove_todo", key="todo-01", why="Already done"),
                              op("swap_bus", table="getting_there", index=0, trip_id=other_trip, why="An earlier start")]))
    p = ask(client, t).json()["proposal"]
    assert [(c["word"], c.get("why")) for c in p["changes"]] == [("Bus", "An earlier start"), ("To-do", "Already done")]


def test_a_why_follows_the_time_and_fare_rule(chat, t, client):  # P9, check_text
    chat.script(say("Tinanggal ko.", [op("remove_row", key="d2-05", why="The jeep leaves at 3:35 PM")]),
                say("Tinanggal ko.", [op("remove_row", key="d2-05", why="It costs ₱999 now")]),
                say("Tinanggal ko.", [op("remove_row", key="d2-05", why=WHY)]))
    out = ask(client, t).json()
    assert out["outcome"] == "proposal"
    assert "made_up_time" in chat.llm.calls[1]["user"] and "made_up_fare" in chat.llm.calls[2]["user"]


def test_a_why_is_never_logged(chat, t, client, caplog):  # P9
    caplog.set_level(logging.DEBUG)
    chat.script(say("Tinanggal ko.", [op("remove_row", key="d2-05", why=f"{MARKER} why")]))
    p = ask(client, t).json()["proposal"]
    assert save_chat(client, t, p).status_code == 200
    assert MARKER not in caplog.text
    assert "whys=1 codes=-" in caplog.text and re.search(r"plan save share_slug=\S+ source=chat .* whys=1", caplog.text), "the count only"


def test_a_hand_edit_carries_no_why(t, client):  # P9: whys only come with a chat proposal
    it = plan_of(client, t)
    g = stored(it["guide"])
    g["days"][1]["rows"] = [r for r in g["days"][1]["rows"] if r["key"] != "d2-05"]
    body = {"base": base_of(it), "guide": g, "whys": {"row:d2-05": WHY}}
    assert client.put(f"/sessions/{t}/plan", json={**body, "source": "hand"}).status_code == 422
    four = {f"row:d2-0{n}": WHY for n in range(1, 5)}
    for whys in ({"row:d2-05": "x" * 121}, {"row:d2-05": ""}, {"row:d2-05": "   "}, {"nope": WHY}, four):  # review N2: blank
        assert client.put(f"/sessions/{t}/plan", json={**body, "source": "chat", "whys": whys}).status_code == 422, whys
    r = client.put(f"/sessions/{t}/plan", json={**body, "source": "chat", "whys": {"row:d2-05": f"  {WHY} "}})
    assert r.status_code == 200 and r.json()["changes"][0]["why"] == WHY, "stored stripped"
    it = plan_of(client, t)
    g = stored(it["guide"])
    g["days"][1]["rows"] = [r for r in g["days"][1]["rows"] if r["key"] != "d2-06"]
    r = client.put(f"/sessions/{t}/plan", json={"base": base_of(it), "guide": g, "source": "chat", "whys": None})
    assert r.status_code == 200 and "why" not in r.json()["changes"][0], "whys are optional on the PUT"


# ---------------------------------------------------------------- TG-67 S3: the chat stays Baguio's (T67-C1 to C5)

from test_plan_edit import sg_trip  # noqa: E402,F401  fixture: a made-up trip on a made-up Sagada plan


@pytest.fixture()
def sg_chat(sg_trip, client, monkeypatch):  # noqa: F811
    """CHATBOT_LIVE on for a made-up Sagada trip, with the chat's model replaced (as `chat` does for Baguio)."""
    from app import plan_chat

    client.app.state.flags = dataclasses.replace(client.app.state.flags, chatbot_live=True)
    settings = plan_chat.ChatSettings(model="claude-haiku-5-5", fallback_model="claude-sonnet-5-5", max_tokens=1000,
                                      timeout_s=20.0, max_attempts=3, daily_cap_usd=1.0, trip_per_hour=20, ip_per_hour=60)
    llm = FakeLLM(say("Done."))
    bot = plan_chat.Chat(llm, settings)
    client.app.dependency_overrides[plan_chat.get_chat] = lambda: bot
    yield sg_trip, llm, bot
    client.app.dependency_overrides.clear()


def test_t67_c1_a_sagada_plan_is_refused_before_any_model_call(sg_chat, client, caplog, monkeypatch):  # B13
    from app import plan_chat_context

    slug, llm, bot = sg_chat

    def never(*a, **k):
        raise AssertionError("the chat context must not load for a Sagada plan")

    monkeypatch.setattr(plan_chat_context, "load", never)
    spent = bot.spend.spent_today
    caplog.set_level(logging.INFO, logger="tara_gala.api")
    r = ask(client, slug, text="what else is near?")
    assert r.status_code == 422 and r.json() == {"detail": "chat_not_here"}, r.text
    assert llm.calls == [] and bot.spend.spent_today == spent
    lines = [x.getMessage() for x in caplog.records if x.getMessage().startswith("plan chat refused")]
    assert lines == [f"plan chat refused share_slug={slug} reason=not_baguio city=Sagada"]


def test_t67_c2_a_stale_base_on_a_sagada_plan_still_gets_chat_not_here(sg_chat, client):  # F5
    slug, llm, _ = sg_chat
    r = ask(client, slug, base={"itinerary_slug": "not-the-plan", "seq": 7})
    assert r.status_code == 422 and r.json() == {"detail": "chat_not_here"}, r.text
    assert llm.calls == []


def test_t67_c4_a_refused_call_uses_one_trip_slot(sg_chat, client):  # F5 (pinned: changing it is a decision)
    slug, _, bot = sg_chat
    ask(client, slug)
    assert len(bot.trips._hits.get(slug, ())) == 1, "the limiter runs in the route, before the guard"


def test_t67_c5_with_the_chat_off_a_sagada_plan_gets_chat_off(sg_trip, client):  # F5  # noqa: F811
    assert client.app.state.flags.chatbot_live is False
    r = ask(client, sg_trip)
    assert r.status_code == 503 and r.json() == {"detail": "chat_off"}


# ---------------------------------------------------------------- CHAT_ALL_CITIES: the chat on a Sagada plan (T76-A1 to A6)

def all_cities(client, on=True):
    client.app.state.flags = dataclasses.replace(client.app.state.flags, chat_all_cities=on)


def names(dsn, city) -> list[str]:
    return [r["name"] for r in rows(dsn, "select name from spots where city = %s order by slug", city)]


def test_t76_a1_with_all_cities_on_a_sagada_plan_gets_sagadas_chat(sg_chat, client, dsn, caplog):
    slug, llm, _ = sg_chat
    all_cities(client)
    caplog.set_level(logging.INFO, logger="tara_gala.api")
    r = ask(client, slug, text="what time does our bus leave?")
    assert r.status_code == 200 and r.json()["outcome"] == "answer", r.text
    call = llm.calls[0]
    assert "trip plan for Sagada, Philippines" in call["system"] and "Baguio" not in call["system"]
    user = call["user"]
    spots = user.split("<spots>")[1].split("</spots>")[0]
    assert names(dsn, "Baguio") and names(dsn, "Sagada")
    assert all(n in spots for n in names(dsn, "Sagada")), "the plan city's spots"
    assert not any(n in spots for n in names(dsn, "Baguio")), "never the other town's"
    buses = json.loads(user.split("<buses>")[1].split("</buses>")[0])
    assert {(b["table"], b["departs"]) for b in buses} == {("getting_there", "22:30"), ("getting_there", "21:00"), ("getting_home", "14:30")}
    lines = [x.getMessage() for x in caplog.records if x.getMessage().startswith("plan chat city ")]
    assert lines == [f"plan chat city share_slug={slug} city=Sagada spots=2 buses=3"]


def test_t76_a2_a_baguio_spot_on_a_sagada_plan_is_an_unknown_id(sg_chat, client, dsn):
    slug, _, bot = sg_chat
    all_cities(client)
    baguio = str(rows(dsn, "select id from spots where city = 'Baguio' order by slug limit 1")[0]["id"])
    sagada = str(rows(dsn, "select id from spots where slug = 'test-sg-lodge'")[0]["id"])
    bot.client = llm = FakeLLM(say("Swapped it.", [op("set_row", key="d2-01", spot_id=baguio, why="You asked")]),
                               say("Swapped it.", [op("set_row", key="d2-01", spot_id=sagada, why="You asked")]))
    out = ask(client, slug, text="register at the lodge instead").json()
    assert out["outcome"] == "proposal", out
    assert "unknown_id" in llm.calls[1]["user"]
    row0 = out["proposal"]["stored"]["days"][1]["rows"][0]
    assert row0["key"] == "d2-01" and row0["place"]["spot_id"] == sagada


def test_t76_a3_a_sagada_proposal_applies_as_a_chat_version(sg_chat, client):
    slug, _, bot = sg_chat
    all_cities(client)
    bot.client = FakeLLM(say("Moved registering to 10:40.", [op("set_row", key="d2-01", time="10:40")]))
    out = ask(client, slug, text="pwede bang 10:40 na lang mag-register?").json()
    assert out["outcome"] == "proposal", out
    p = out["proposal"]
    applied = save(client, slug, p["stored"], p["base"], source="chat")
    assert applied.status_code == 200, applied.text
    assert applied.json()["itinerary"]["city"] == "Sagada"


def test_t76_a4_baguio_is_byte_for_byte_the_same_with_all_cities_on(chat, t, client):
    from app.plan_chat_prompt import SYSTEM_PROMPT

    chat.script(say("Ok."))
    ask(client, t, "hello")
    off = chat.llm.calls[0]
    all_cities(client)
    chat.script(say("Ok."))
    ask(client, t, "hello")
    on = chat.llm.calls[0]
    assert on["system"] == off["system"] == SYSTEM_PROMPT and "trip plan for Baguio, Philippines" in SYSTEM_PROMPT
    assert on["user"] == off["user"]


def test_t76_a5_with_all_cities_off_a_sagada_plan_is_still_refused(sg_chat, client):
    slug, llm, _ = sg_chat
    all_cities(client, on=False)
    r = ask(client, slug)
    assert r.status_code == 422 and r.json() == {"detail": "chat_not_here"} and llm.calls == []


def test_t76_a6_another_citys_prompt_changes_its_name_and_ties_the_language_to_the_last_turn():
    from app.plan_chat_prompt import SYSTEM_PROMPT, system_prompt

    assert system_prompt("Baguio") == SYSTEM_PROMPT and "Only their last <turn>" not in SYSTEM_PROMPT
    sagada = system_prompt("Sagada")
    assert "Baguio" not in sagada and "trip plan for Sagada, Philippines" in sagada
    extra = (" Only their last <turn> decides the language: the city, its place names and the plan's notes don't, "
             "so an English message gets an English reply.")
    assert sagada == SYSTEM_PROMPT.replace("Baguio", "Sagada").replace("Filipino or Taglish.", "Filipino or Taglish." + extra, 1)
