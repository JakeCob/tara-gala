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
        (op("remove_row", key="d2-05"), lambda x: "d2-05" not in [r["key"] for d in x["days"] for r in d["rows"]]),
        (op("move_row", key="d2-08", day=3, after=None), lambda x: x["days"][2]["rows"][0]["key"] == "d2-08"),
        (op("set_row", key="d2-08", time="16:00", note="Bring jackets"),
         lambda x: next(r for r in x["days"][1]["rows"] if r["key"] == "d2-08")["time"] == "16:00"),
        (op("swap_bus", table="getting_there", index=0, trip_id=other_trip), lambda x: x["getting_there"]["buses"][0]["trip_id"] == other_trip),
        (op("add_todo", text="Pack jackets"), lambda x: x["todo"][-1] == {"key": None, "text": "Pack jackets", "done": False}),
        (op("remove_todo", key="todo-01"), lambda x: "todo-01" not in [y["key"] for y in x["todo"]]),
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


def test_chat_off_and_plan_editing_off(t, client, monkeypatch):  # P2
    from app import plan_chat

    assert client.app.state.flags.chatbot_live is False
    r = ask(client, t)
    assert r.status_code == 503 and r.json() == {"detail": "chat_off"}
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
