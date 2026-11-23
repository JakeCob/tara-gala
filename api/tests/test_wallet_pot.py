"""TG-73 A1: the Ipon goal, who's in it and each ambag (plan §1 B1 to B10, B12; test-plan §3). Behind WALLET_POT.

Routes under test (wallet_pot.py), all under /wallets/{slug}:
- POST /pot, PATCH /pot, DELETE /pot?by&version, PUT /pot/people/{member_id}
- POST /pot/ambag, PATCH /pot/ambag/{id}, DELETE /pot/ambag/{id}?by
and WalletOut.pot on every wallet answer. Made-up wallets and names only; the database is the local throwaway one.
"""

import dataclasses
import logging
from datetime import date
from uuid import uuid4

import psycopg
import pytest
from psycopg.rows import dict_row

from app import wallet_pot
from app import wallets as w
from app.limits import RateLimiter

NAMES = ("Ana Testname", "Ben Testname", "Carlo Testname", "Bea Testname", "Di Testname")
TODAY = date(2026, 11, 23)
DUE = "2026-12-20"


@pytest.fixture(autouse=True)
def fresh_limiters(monkeypatch):
    monkeypatch.setattr(w, "CREATE_LIMITER", RateLimiter(w.CREATE_PER_HOUR))
    monkeypatch.setattr(w, "WRITE_LIMITER", RateLimiter(w.WRITES_PER_HOUR))


@pytest.fixture(autouse=True)
def frozen_today(monkeypatch):
    monkeypatch.setattr(wallet_pot, "manila_today", lambda: TODAY)


@pytest.fixture()
def flags(client):
    before = client.app.state.flags
    base = dataclasses.replace(before, wallet_pot=False)
    client.app.state.flags = base

    def set_flags(**kw):
        client.app.state.flags = dataclasses.replace(base, **kw)

    yield set_flags
    client.app.state.flags = before


@pytest.fixture()
def on(client, flags):
    flags(wallet_pot=True)
    return client


def sql(dsn, statement, params=None):
    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        cur = conn.execute(statement, params)
        return cur.fetchall() if cur.description else None


def new_wallet(client, n=5):
    r = client.post("/wallets", json={"name": "Test trip", "members": list(NAMES[:n])})
    assert r.status_code == 201, r.text
    return r.json()["share_slug"], [m["id"] for m in r.json()["members"]]


def start(client, slug, by, people, each=800000, due=DUE, **extra):
    return client.post(f"/wallets/{slug}/pot", json={"by": by, "each_centavos": each, "due_date": due, "people": people, **extra})


def started(client, n=5, **kw):
    slug, ids = new_wallet(client, n)
    r = start(client, slug, ids[0], ids, **kw)
    assert r.status_code == 201, r.text
    return slug, ids, r.json()


def send(client, slug, by, member, amount, **extra):
    return client.post(f"/wallets/{slug}/pot/ambag", json={"by": by, "member_id": member, "amount_centavos": amount, **extra})


def mark(client, slug, ambag_id, by, status):
    return client.patch(f"/wallets/{slug}/pot/ambag/{ambag_id}", json={"by": by, "status": status})


def person(client, slug, member, by, version, **body):
    return client.put(f"/wallets/{slug}/pot/people/{member}", json={"by": by, "version": version, **body})


def activity(dsn, slug):
    return sql(dsn, """select a.action, a.actor::text as actor, a.member_id::text as member_id, a.after
                       from wallet_activity a join wallets x on x.id = a.wallet_id
                       where x.share_slug = %s order by a.id""", (slug,))


def lane(wallet, member):
    return next(p for p in wallet["pot"]["people"] if p["member_id"] == member)


# ---------------------------------------------------------------- the flag (B30's API half)

ROUTES = [
    ("post", "/pot", {"each_centavos": "x"}),
    ("patch", "/pot", {"version": "x"}),
    ("delete", "/pot", None),
    ("put", f"/pot/people/{uuid4()}", {"version": "x"}),
    ("post", "/pot/ambag", {"amount_centavos": "x"}),
    ("patch", f"/pot/ambag/{uuid4()}", {"status": "lost"}),
    ("delete", f"/pot/ambag/{uuid4()}", None),
]


@pytest.mark.parametrize("method, path, body", ROUTES)
def test_flag_off_every_route_is_feature_off_before_the_body_is_judged(client, flags, method, path, body):
    slug, _ids = new_wallet(client, 2)
    kwargs = {} if body is None else {"json": body}
    r = getattr(client, method)(f"/wallets/{slug}{path}", **kwargs) if method != "delete" else client.delete(f"/wallets/{slug}{path}")
    assert (r.status_code, r.json()) == (404, {"detail": "feature_off"})


def test_flag_off_the_wallet_answer_has_no_pot_key_and_ignores_pot_rows(client, dsn, flags):
    """Byte for byte: the same wallet reads the same with or without pot rows, and with exactly today's keys."""
    slug, ids = new_wallet(client, 3)
    client.post(f"/wallets/{slug}/expenses", json={"paid_by": ids[0], "amount_centavos": 90000, "note": "Dinner", "split_among": ids})
    plain = client.get(f"/wallets/{slug}")
    assert "pot" not in plain.json()
    assert set(plain.json()) == {"share_slug", "name", "created_at", "members", "expenses", "settlements", "balances",
                                 "transfers", "total_centavos", "rev", "budget"}
    wid = sql(dsn, "select id from wallets where share_slug = %s", (slug,))[0]["id"]
    sql(dsn, "insert into wallet_pots (wallet_id, each_centavos, due_date, treasurer) values (%s, 800000, %s, %s)", (wid, DUE, ids[0]))
    sql(dsn, "insert into pot_people (wallet_id, member_id) values (%s, %s)", (wid, ids[1]))
    sql(dsn, "insert into pot_ambag (wallet_id, member_id, amount_centavos, status, received_at) values (%s, %s, 500000, 'received', now())", (wid, ids[1]))
    again = client.get(f"/wallets/{slug}")
    assert again.content == plain.content
    assert again.headers["cache-control"] == plain.headers["cache-control"]


def test_flag_on_a_wallet_with_no_goal_answers_pot_null(on):
    slug, _ = new_wallet(on, 2)
    assert on.get(f"/wallets/{slug}").json()["pot"] is None


def test_flag_on_then_off_then_on_shows_the_same_goal(client, flags):
    flags(wallet_pot=True)
    slug, ids, first = started(client)
    flags(wallet_pot=False)
    assert "pot" not in client.get(f"/wallets/{slug}").json()
    flags(wallet_pot=True)
    assert client.get(f"/wallets/{slug}").json()["pot"] == first["pot"]


# ---------------------------------------------------------------- B1, B2: start the goal

def test_b1_start_the_goal(on, dsn, caplog):
    slug, ids = new_wallet(on)
    rev = on.get(f"/wallets/{slug}").json()["rev"]
    with caplog.at_level(logging.INFO, logger="tara_gala.api"):
        r = start(on, slug, ids[0], ids)
    assert r.status_code == 201, r.text
    assert r.headers["cache-control"] == "private, no-cache" and r.headers["x-robots-tag"] == "noindex"
    pot = r.json()["pot"]
    assert (pot["each_centavos"], pot["due_date"], pot["treasurer"], pot["version"], pot["closed_at"]) == (800000, DUE, ids[0], 1, None)
    assert pot["name"] == "Test trip" and pot["trip"] is None
    assert [(p["member_id"], p["target_centavos"], p["custom"], p["in_goal"], p["received_centavos"], p["sent_centavos"])
            for p in pot["people"]] == [(m, 800000, False, True, 0, 0) for m in ids]
    assert (pot["received_centavos"], pot["spent_centavos"], pot["balance_centavos"], pot["target_centavos"]) == (0, 0, 0, 4000000)
    assert (pot["pending_centavos"], pot["pending_count"], pot["ambag"]) == (0, 0, [])
    assert pot["close_out"] == {"refunds": [], "shortfall": []}
    assert r.json()["rev"] == rev + 1
    assert activity(dsn, slug)[-1] == {"action": "pot_on", "actor": ids[0], "member_id": None,
                                       "after": {"each_centavos": 800000, "due_date": DUE, "people": 5}}
    line = next(m for m in caplog.messages if m.startswith("wallet pot on"))
    assert line == f"wallet pot on share_slug={slug} each=800000 people=5 due_in_days=27 trip=no rev={rev + 1}"
    for m in caplog.messages:
        assert "Testname" not in m and not any(i in m for i in ids)


def test_b1_a_no_trip_goal_keeps_its_own_name_and_only_the_people_picked(on):
    slug, ids = new_wallet(on, 3)
    pot = start(on, slug, ids[1], ids[1:], name="Boracay 2027").json()["pot"]
    assert pot["name"] == "Boracay 2027" and pot["treasurer"] == ids[1]
    assert [p["member_id"] for p in pot["people"]] == ids[1:] and pot["target_centavos"] == 1600000


def _trip(dsn, slug, start="2026-12-05", back="2026-12-08", name="Sagada, Dec 5"):
    wid = sql(dsn, "select id from wallets where share_slug = %s", (slug,))[0]["id"]
    sql(dsn, "insert into trip_sessions (name, start_date, return_date, wallet_id) values (%s, %s, %s, %s)", (name, start, back, wid))


def test_b2_a_trip_wallet_takes_the_trip_and_refuses_a_due_date_after_its_start(on, dsn):
    slug, ids = new_wallet(on)
    _trip(dsn, slug)
    r = start(on, slug, ids[0], ids, due="2026-12-06")
    assert (r.status_code, r.json()) == (422, {"detail": "due_after_trip"})
    r = start(on, slug, ids[0], ids, due="2026-12-05", name="ignored on a trip")
    assert r.status_code == 201, r.text
    pot = r.json()["pot"]
    assert pot["trip"] == {"name": "Sagada, Dec 5", "start_date": "2026-12-05", "return_date": "2026-12-08"}
    assert pot["name"] == "Sagada, Dec 5"


def test_b2_two_trips_on_one_wallet_is_no_trip(on, dsn):
    slug, ids = new_wallet(on)
    _trip(dsn, slug)
    _trip(dsn, slug, name="Second trip")
    r = start(on, slug, ids[0], ids, due="2027-01-30")
    assert r.status_code == 201 and r.json()["pot"]["trip"] is None


def test_b2_a_past_due_date_is_refused(on):
    slug, ids = new_wallet(on)
    r = start(on, slug, ids[0], ids, due="2026-11-22")
    assert (r.status_code, r.json()) == (422, {"detail": "due_past"})
    assert start(on, slug, ids[0], ids, due="2026-11-23").status_code == 201  # Manila today is fine


@pytest.mark.parametrize("change, code", [
    ({"by": None}, "by_required"),
    ({"by": "stranger"}, "unknown_member"),
    ({"people": "stranger"}, "unknown_member"),
])
def test_start_refusals(on, change, code):
    slug, ids = new_wallet(on, 2)
    stranger = new_wallet(on, 1)[1][0]
    by = stranger if change.get("by") == "stranger" else (None if "by" in change else ids[0])
    people = [ids[0], stranger] if change.get("people") == "stranger" else ids
    r = start(on, slug, by, people)
    assert (r.status_code, r.json()) == (422, {"detail": code})
    assert on.get(f"/wallets/{slug}").json()["pot"] is None


def test_start_twice_is_pot_exists(on):
    slug, ids, _ = started(on, 2)
    r = start(on, slug, ids[1], ids)
    assert (r.status_code, r.json()) == (409, {"detail": "pot_exists"})


@pytest.mark.parametrize("bad", [{"each_centavos": 99}, {"each_centavos": 10000001}, {"people": []}, {"name": ""},
                                 {"name": "x" * 41}, {"extra": 1}])
def test_start_body_bounds(on, bad):
    slug, ids = new_wallet(on, 2)
    body = {"by": ids[0], "each_centavos": 800000, "due_date": DUE, "people": ids, **bad}
    assert on.post(f"/wallets/{slug}/pot", json=body).status_code == 422


def test_start_a_person_twice_is_refused(on):
    slug, ids = new_wallet(on, 2)
    assert start(on, slug, ids[0], [ids[0], ids[0]]).status_code == 422


# ---------------------------------------------------------------- B3, B4: the treasurer and the version

def _t_only_calls(on, slug, ids, wallet):
    """(name, call(by)) for every treasurer-only route in A1."""
    bea_send = send(on, slug, ids[3], ids[3], 500000).json()
    ambag_id = bea_send["pot"]["ambag"][0]["id"]
    v = bea_send["pot"]["version"]
    return [
        ("edit", lambda by: on.patch(f"/wallets/{slug}/pot", json={"by": by, "version": v, "each_centavos": 700000})),
        ("off", lambda by: on.delete(f"/wallets/{slug}/pot?version={v}&by={by}")),
        ("person", lambda by: person(on, slug, ids[2], by, v, target_centavos=500000)),
        ("mark", lambda by: mark(on, slug, ambag_id, by, "received")),
    ]


def test_b3_anyone_but_the_treasurer_is_refused_and_nothing_is_written(on, dsn):
    slug, ids, wallet = started(on)
    for name, call in _t_only_calls(on, slug, ids, wallet):
        before = on.get(f"/wallets/{slug}").json()
        r = call(ids[1])
        assert (r.status_code, r.json()) == (403, {"detail": "not_treasurer"}), name
        assert on.get(f"/wallets/{slug}").json() == before, name


def test_b4_a_stale_version_is_pot_changed_with_the_wallet(on):
    slug, ids, wallet = started(on)
    r = on.patch(f"/wallets/{slug}/pot", json={"by": ids[0], "version": 1, "each_centavos": 700000})
    assert r.status_code == 200 and r.json()["pot"]["version"] == 2
    for call in (lambda: on.patch(f"/wallets/{slug}/pot", json={"by": ids[0], "version": 1, "each_centavos": 600000}),
                 lambda: on.delete(f"/wallets/{slug}/pot?version=1&by={ids[0]}"),
                 lambda: person(on, slug, ids[1], ids[0], 1, in_goal=False)):
        r = call()
        assert r.status_code == 409
        assert r.json()["detail"]["code"] == "pot_changed"
        assert r.json()["detail"]["wallet"]["pot"]["version"] == 2


def test_edit_each_due_and_name_one_activity_line_per_field(on, dsn):
    slug, ids, wallet = started(on)
    rev = wallet["rev"]
    r = on.patch(f"/wallets/{slug}/pot", json={"by": ids[0], "version": 1, "each_centavos": 750000, "due_date": "2026-12-18",
                                              "name": "Boracay 2027"})
    assert r.status_code == 200, r.text
    pot = r.json()["pot"]
    assert (pot["each_centavos"], pot["due_date"], pot["name"], pot["version"]) == (750000, "2026-12-18", "Boracay 2027", 2)
    assert r.json()["rev"] == rev + 3
    assert [a["after"] for a in activity(dsn, slug)[-3:]] == [
        {"field": "each_centavos", "before": 800000, "after": 750000},
        {"field": "due_date", "before": DUE, "after": "2026-12-18"},
        {"field": "name"},  # never the text
    ]
    cleared = on.patch(f"/wallets/{slug}/pot", json={"by": ids[0], "version": 2, "name": None}).json()["pot"]
    assert cleared["name"] == "Test trip" and cleared["version"] == 3


def test_edit_with_nothing_changed_is_a_no_op(on, dsn):
    slug, ids, wallet = started(on)
    r = on.patch(f"/wallets/{slug}/pot", json={"by": ids[0], "version": 1, "each_centavos": 800000, "due_date": DUE})
    assert r.status_code == 200 and r.json()["rev"] == wallet["rev"] and r.json()["pot"]["version"] == 1


def test_edit_a_due_date_in_the_past_or_after_the_trip_is_refused(on, dsn):
    slug, ids = new_wallet(on)
    _trip(dsn, slug)
    start(on, slug, ids[0], ids, due="2026-12-01")
    for due, code in (("2026-11-01", "due_past"), ("2026-12-06", "due_after_trip")):
        r = on.patch(f"/wallets/{slug}/pot", json={"by": ids[0], "version": 1, "due_date": due})
        assert (r.status_code, r.json()) == (422, {"detail": code})


def test_writes_with_no_goal_are_no_pot(on):
    slug, ids = new_wallet(on, 2)
    for r in (on.patch(f"/wallets/{slug}/pot", json={"by": ids[0], "version": 1}),
              on.delete(f"/wallets/{slug}/pot?version=1&by={ids[0]}"),
              person(on, slug, ids[1], ids[0], 1, in_goal=True),
              send(on, slug, ids[0], ids[0], 100)):
        assert (r.status_code, r.json()) == (404, {"detail": "no_pot"})


def test_by_is_required_on_every_pot_write(on):
    slug, ids, wallet = started(on, 2)
    aid = send(on, slug, ids[1], ids[1], 100).json()["pot"]["ambag"][0]["id"]
    for r in (on.patch(f"/wallets/{slug}/pot", json={"version": 1, "each_centavos": 700000}),
              on.delete(f"/wallets/{slug}/pot?version=1"),
              on.put(f"/wallets/{slug}/pot/people/{ids[1]}", json={"version": 1, "in_goal": False}),
              on.post(f"/wallets/{slug}/pot/ambag", json={"member_id": ids[1], "amount_centavos": 100}),
              on.patch(f"/wallets/{slug}/pot/ambag/{aid}", json={"status": "received"}),
              on.delete(f"/wallets/{slug}/pot/ambag/{aid}")):
        assert (r.status_code, r.json()) == (422, {"detail": "by_required"})


# ---------------------------------------------------------------- B5: delete the goal

def test_b5_delete_with_nothing_in_it(on, dsn):
    slug, ids, wallet = started(on)
    r = on.delete(f"/wallets/{slug}/pot?version=1&by={ids[0]}")
    assert r.status_code == 200 and r.json()["pot"] is None and r.json()["rev"] == wallet["rev"] + 1
    assert activity(dsn, slug)[-1]["action"] == "pot_off"
    assert sql(dsn, "select count(*) as n from pot_people")[0]["n"] == 0


def test_b5_delete_with_an_ambag_or_a_pot_spend_is_pot_in_use(on, dsn):
    slug, ids, _ = started(on)
    send(on, slug, ids[1], ids[1], 100)
    r = on.delete(f"/wallets/{slug}/pot?version=1&by={ids[0]}")
    assert (r.status_code, r.json()) == (409, {"detail": "pot_in_use"})
    slug, ids, _ = started(on)
    wid = sql(dsn, "select id from wallets where share_slug = %s", (slug,))[0]["id"]
    eid = sql(dsn, "insert into expenses (wallet_id, paid_by, amount_centavos, note, split_mode) values (%s, %s, 1200, 'Dinner', 'pot') returning id",
              (wid, ids[0]))[0]["id"]
    sql(dsn, "insert into expense_shares (expense_id, member_id, share_centavos) values (%s, %s, 1200)", (eid, ids[0]))
    r = on.delete(f"/wallets/{slug}/pot?version=1&by={ids[0]}")
    assert (r.status_code, r.json()) == (409, {"detail": "pot_in_use"})
    assert r.status_code == 409 and on.get(f"/wallets/{slug}").json()["pot"]["spent_centavos"] == 1200


# ---------------------------------------------------------------- B6: a newcomer joins an open goal

def test_b6_a_new_member_joins_an_open_goal_at_the_amount_each(on, dsn, caplog):
    slug, ids, _ = started(on, 2)
    with caplog.at_level(logging.INFO, logger="tara_gala.api"):
        r = on.post(f"/wallets/{slug}/members?by={ids[0]}", json={"name": "Carlo Testname"})
    assert r.status_code == 201
    new = r.json()["members"][-1]["id"]
    assert lane(r.json(), new) == {"member_id": new, "target_centavos": 800000, "custom": False, "in_goal": True,
                                   "received_centavos": 0, "sent_centavos": 0}
    assert any(m.startswith(f"wallet member add share_slug={slug} pot=joined") for m in caplog.messages)


def test_b6_a_closed_goal_or_no_goal_takes_no_newcomer(on, dsn):
    slug, ids, _ = started(on, 2)
    sql(dsn, "update wallet_pots set closed_at = now()")
    r = on.post(f"/wallets/{slug}/members", json={"name": "Carlo Testname"})
    assert [p["member_id"] for p in r.json()["pot"]["people"]] == ids
    slug2, _ = new_wallet(on, 1)
    assert on.post(f"/wallets/{slug2}/members", json={"name": "Carlo Testname"}).status_code == 201


# ---------------------------------------------------------------- B7 to B10, B12: each ambag

def test_b7_a_member_sends_and_it_is_pending(on, dsn, caplog):
    slug, ids, wallet = started(on)
    with caplog.at_level(logging.INFO, logger="tara_gala.api"):
        r = send(on, slug, ids[3], ids[3], 500000)
    assert r.status_code == 201, r.text
    pot = r.json()["pot"]
    assert (pot["received_centavos"], pot["pending_centavos"], pot["pending_count"]) == (0, 500000, 1)
    a = pot["ambag"][0]
    assert (a["member_id"], a["kind"], a["amount_centavos"], a["status"], a["received_at"], a["has_proof"]) == (
        ids[3], "in", 500000, "sent", None, False)
    assert lane(r.json(), ids[3])["sent_centavos"] == 500000
    assert r.json()["rev"] == wallet["rev"] + 1
    assert activity(dsn, slug)[-1] == {"action": "ambag_sent", "actor": ids[3], "member_id": ids[3],
                                       "after": {"ambag_id": a["id"], "member_id": ids[3], "amount_centavos": 500000}}
    assert f"wallet ambag sent share_slug={slug} amount=500000 proof=0 replay=0 rev={wallet['rev'] + 1}" in caplog.messages


def test_b8_received_fills_the_pot_and_undo_puts_it_back(on, dsn):
    slug, ids, _ = started(on)
    aid = send(on, slug, ids[3], ids[3], 500000).json()["pot"]["ambag"][0]["id"]
    r = mark(on, slug, aid, ids[0], "received")
    assert r.status_code == 200
    pot = r.json()["pot"]
    assert (pot["received_centavos"], pot["pending_count"], pot["balance_centavos"]) == (500000, 0, 500000)
    assert pot["ambag"][0]["status"] == "received" and pot["ambag"][0]["received_at"] is not None
    assert lane(r.json(), ids[3])["received_centavos"] == 500000
    r = mark(on, slug, aid, ids[0], "sent")
    assert r.json()["pot"]["received_centavos"] == 0 and r.json()["pot"]["ambag"][0]["received_at"] is None
    assert [a["action"] for a in activity(dsn, slug)[-3:]] == ["ambag_sent", "ambag_received", "ambag_unreceive"]
    assert activity(dsn, slug)[-1]["actor"] == ids[0]


def test_b8_marking_the_same_status_again_is_a_no_op(on):
    slug, ids, _ = started(on)
    aid = send(on, slug, ids[3], ids[3], 500000).json()["pot"]["ambag"][0]["id"]
    rev = mark(on, slug, aid, ids[0], "received").json()["rev"]
    assert mark(on, slug, aid, ids[0], "received").json()["rev"] == rev


def test_b9_the_treasurers_own_ambag_and_cash_in_hand_count_at_once(on, dsn):
    slug, ids, _ = started(on)
    r = send(on, slug, ids[0], ids[0], 800000)
    assert r.json()["pot"]["ambag"][0]["status"] == "received" and r.json()["pot"]["received_centavos"] == 800000
    r = send(on, slug, ids[0], ids[2], 300000)  # Carlo handed cash to the treasurer
    assert r.json()["pot"]["received_centavos"] == 1100000
    assert [(a["action"], a["actor"], a["member_id"]) for a in activity(dsn, slug)[-2:]] == [
        ("ambag_received", ids[0], ids[0]), ("ambag_received", ids[0], ids[2])]


def test_someone_else_cannot_record_another_persons_ambag(on):
    slug, ids, _ = started(on)
    r = send(on, slug, ids[1], ids[2], 300000)
    assert (r.status_code, r.json()) == (403, {"detail": "not_treasurer"})


def test_b10_withdraw_a_pending_send(on, dsn):
    slug, ids, _ = started(on)
    aid = send(on, slug, ids[3], ids[3], 500000).json()["pot"]["ambag"][0]["id"]
    r = on.delete(f"/wallets/{slug}/pot/ambag/{aid}?by={ids[2]}")
    assert (r.status_code, r.json()) == (403, {"detail": "not_treasurer"})
    r = on.delete(f"/wallets/{slug}/pot/ambag/{aid}?by={ids[3]}")
    assert r.status_code == 200 and r.json()["pot"]["ambag"] == [] and r.json()["pot"]["pending_count"] == 0
    assert activity(dsn, slug)[-1]["action"] == "ambag_undo"
    aid = send(on, slug, ids[3], ids[3], 500000).json()["pot"]["ambag"][0]["id"]
    assert on.delete(f"/wallets/{slug}/pot/ambag/{aid}?by={ids[0]}").status_code == 200  # the treasurer may too


def test_b10_a_received_one_cannot_be_withdrawn(on):
    slug, ids, _ = started(on)
    aid = send(on, slug, ids[3], ids[3], 500000).json()["pot"]["ambag"][0]["id"]
    mark(on, slug, aid, ids[0], "received")
    r = on.delete(f"/wallets/{slug}/pot/ambag/{aid}?by={ids[3]}")
    assert (r.status_code, r.json()) == (409, {"detail": "ambag_received"})


def test_an_ambag_that_is_gone_answers_ambag_gone_with_the_wallet(on):
    slug, ids, _ = started(on)
    for r in (mark(on, slug, uuid4(), ids[0], "received"), on.delete(f"/wallets/{slug}/pot/ambag/{uuid4()}?by={ids[0]}")):
        assert r.status_code == 404
        assert r.json()["detail"]["code"] == "ambag_gone" and r.json()["detail"]["wallet"]["share_slug"] == slug


def test_another_wallets_ambag_is_gone_here(on):
    slug, ids, _ = started(on)
    other, oids, _ = started(on)
    aid = send(on, other, oids[1], oids[1], 100).json()["pot"]["ambag"][0]["id"]
    r = mark(on, slug, aid, ids[0], "received")
    assert r.status_code == 404 and r.json()["detail"]["code"] == "ambag_gone"


def test_b12_someone_not_in_the_goal_cannot_send(on):
    slug, ids = new_wallet(on, 3)
    start(on, slug, ids[0], ids[:2])
    r = send(on, slug, ids[2], ids[2], 100)
    assert (r.status_code, r.json()) == (422, {"detail": "not_in_goal"})
    stranger = new_wallet(on, 1)[1][0]
    assert send(on, slug, ids[0], stranger, 100).json() == {"detail": "unknown_member"}


@pytest.mark.parametrize("amount", [0, 10000001, 1.5])
def test_ambag_amount_bounds(on, amount):
    slug, ids, _ = started(on, 2)
    assert send(on, slug, ids[1], ids[1], amount).status_code == 422


def test_replay_one_id_twice_is_one_row(on, dsn, caplog):
    slug, ids, _ = started(on)
    key = str(uuid4())
    first = send(on, slug, ids[3], ids[3], 500000, id=key)
    assert first.status_code == 201 and first.json()["pot"]["ambag"][0]["id"] == key
    with caplog.at_level(logging.INFO, logger="tara_gala.api"):
        again = send(on, slug, ids[3], ids[3], 999999, id=key)  # whatever changed, the resend writes nothing
    assert again.status_code == 200 and again.json() == first.json()
    assert sql(dsn, "select count(*) as n from pot_ambag")[0]["n"] == 1
    assert f"wallet ambag sent replay share_slug={slug} found=live rev={first.json()['rev']}" in caplog.messages
    on.delete(f"/wallets/{slug}/pot/ambag/{key}?by={ids[3]}")
    gone = send(on, slug, ids[3], ids[3], 500000, id=key)
    assert gone.status_code == 200 and gone.json()["pot"]["ambag"] == []  # sent, then withdrawn: still a replay


def test_replay_of_another_wallets_id_is_id_taken(on):
    slug, ids, _ = started(on)
    other, oids, _ = started(on)
    key = str(uuid4())
    send(on, other, oids[1], oids[1], 100, id=key)
    r = send(on, slug, ids[1], ids[1], 100, id=key)
    assert (r.status_code, r.json()) == (409, {"detail": "id_taken"})


def test_a_goal_holds_at_most_max_ambag_rows(on, dsn, monkeypatch):
    monkeypatch.setattr(wallet_pot, "MAX_AMBAG", 2)
    slug, ids, _ = started(on)
    send(on, slug, ids[1], ids[1], 100)
    send(on, slug, ids[2], ids[2], 100)
    assert send(on, slug, ids[3], ids[3], 100).json() == {"detail": "pot_full"}


def test_a_closed_pot_takes_no_new_ambag_and_no_change(on, dsn):
    slug, ids, _ = started(on)
    aid = send(on, slug, ids[3], ids[3], 500000).json()["pot"]["ambag"][0]["id"]
    sql(dsn, "update wallet_pots set closed_at = now()")
    for r in (send(on, slug, ids[1], ids[1], 100), mark(on, slug, aid, ids[0], "received"),
              on.patch(f"/wallets/{slug}/pot", json={"by": ids[0], "version": 1, "each_centavos": 1000}),
              person(on, slug, ids[1], ids[0], 1, in_goal=False)):
        assert (r.status_code, r.json()) == (409, {"detail": "pot_closed"})
    assert on.delete(f"/wallets/{slug}/pot/ambag/{aid}?by={ids[3]}").status_code == 200  # a pending send can still go


# ---------------------------------------------------------------- the people (B22's routes; the close-out is A2's)

def test_a_persons_own_amount_and_back_to_each(on, dsn):
    slug, ids, _ = started(on)
    r = person(on, slug, ids[3], ids[0], 1, target_centavos=500000)
    assert r.status_code == 200
    assert (lane(r.json(), ids[3])["target_centavos"], lane(r.json(), ids[3])["custom"]) == (500000, True)
    assert r.json()["pot"]["target_centavos"] == 3700000 and r.json()["pot"]["version"] == 2
    assert activity(dsn, slug)[-1] == {"action": "pot_person", "actor": ids[0], "member_id": ids[3],
                                       "after": {"field": "target_centavos", "before": 800000, "after": 500000, "custom": True}}
    r = person(on, slug, ids[3], ids[0], 2, target_centavos=None)
    assert (lane(r.json(), ids[3])["target_centavos"], lane(r.json(), ids[3])["custom"]) == (800000, False)


def test_b22_take_out_with_give_back_writes_a_back_row_for_everything_in(on, dsn):
    slug, ids, _ = started(on)
    for amount in (300000, 200000):
        send(on, slug, ids[0], ids[3], amount)  # received at once (the treasurer records it)
    aid = send(on, slug, ids[3], ids[3], 100000).json()["pot"]["ambag"][0]["id"]  # still pending: not given back
    r = person(on, slug, ids[3], ids[0], 1, in_goal=False, give_back=True)
    assert r.status_code == 200, r.text
    bea = lane(r.json(), ids[3])
    assert (bea["in_goal"], bea["received_centavos"], bea["sent_centavos"]) == (False, 0, 100000)
    back = r.json()["pot"]["ambag"][0]
    assert (back["kind"], back["amount_centavos"], back["status"]) == ("back", 500000, "received")
    assert r.json()["pot"]["received_centavos"] == 0 and r.json()["pot"]["target_centavos"] == 3200000
    assert [a["action"] for a in activity(dsn, slug)[-2:]] == ["pot_person", "ambag_back"]
    assert activity(dsn, slug)[-1]["after"] == {"ambag_id": back["id"], "member_id": ids[3], "amount_centavos": 500000}
    r = mark(on, slug, back["id"], ids[0], "sent")
    assert (r.status_code, r.json()) == (409, {"detail": "ambag_received"})  # a give-back can't be toggled
    assert aid


def test_b22_take_out_without_give_back_keeps_their_part(on, dsn):
    slug, ids, _ = started(on)
    send(on, slug, ids[0], ids[3], 500000)
    r = person(on, slug, ids[3], ids[0], 1, in_goal=False)
    bea = lane(r.json(), ids[3])
    assert (bea["in_goal"], bea["received_centavos"]) == (False, 500000)
    assert all(a["kind"] == "in" for a in r.json()["pot"]["ambag"])
    assert send(on, slug, ids[3], ids[3], 100).json() == {"detail": "not_in_goal"}
    r = person(on, slug, ids[3], ids[0], 2, in_goal=True)
    assert lane(r.json(), ids[3])["in_goal"] is True
    assert [a["after"]["field"] for a in activity(dsn, slug)[-2:]] == ["in_goal", "in_goal"]


def test_give_back_with_nothing_in_writes_no_row(on):
    slug, ids, _ = started(on)
    r = person(on, slug, ids[3], ids[0], 1, in_goal=False, give_back=True)
    assert r.status_code == 200 and r.json()["pot"]["ambag"] == []


def test_undoing_a_received_that_was_given_back_is_refused(on):
    slug, ids, _ = started(on)
    aid = send(on, slug, ids[3], ids[3], 500000).json()["pot"]["ambag"][0]["id"]
    mark(on, slug, aid, ids[0], "received")
    person(on, slug, ids[3], ids[0], 1, in_goal=False, give_back=True)
    r = mark(on, slug, aid, ids[0], "sent")
    assert (r.status_code, r.json()) == (409, {"detail": "ambag_given_back"})


def test_someone_never_in_the_goal_can_only_be_put_in(on, dsn):
    slug, ids = new_wallet(on, 3)
    start(on, slug, ids[0], ids[:2])
    assert person(on, slug, ids[2], ids[0], 1, target_centavos=100).json() == {"detail": "not_in_goal"}
    r = person(on, slug, ids[2], ids[0], 1, in_goal=True, target_centavos=500000)
    assert lane(r.json(), ids[2]) == {"member_id": ids[2], "target_centavos": 500000, "custom": True, "in_goal": True,
                                      "received_centavos": 0, "sent_centavos": 0}
    stranger = new_wallet(on, 1)[1][0]
    assert person(on, slug, stranger, ids[0], 2, in_goal=True).json() == {"detail": "unknown_member"}


def test_a_person_change_that_changes_nothing_is_a_no_op(on):
    slug, ids, wallet = started(on)
    r = person(on, slug, ids[1], ids[0], 1, in_goal=True, target_centavos=None)
    assert r.json()["rev"] == wallet["rev"] and r.json()["pot"]["version"] == 1


def test_the_treasurer_can_be_taken_out_and_still_records(on):
    slug, ids, _ = started(on)
    r = person(on, slug, ids[0], ids[0], 1, in_goal=False)
    assert lane(r.json(), ids[0])["in_goal"] is False and r.json()["pot"]["treasurer"] == ids[0]
    assert send(on, slug, ids[0], ids[1], 100).status_code == 201


# ---------------------------------------------------------------- the numbers on the answer, and the preview

def test_the_pot_numbers_follow_the_rows_and_the_close_preview_is_v2(on, dsn):
    """Plan §4.3 (V2) through the routes: the preview's refunds are the vector's, with a pot spend added by SQL (A2
    adds the route)."""
    slug, ids, _ = started(on)  # Ana, Ben, Carlo, Bea, Di
    person(on, slug, ids[3], ids[0], 1, target_centavos=500000)
    for m, amount in zip(ids, (800000, 800000, 800000, 500000, 800000)):
        send(on, slug, ids[0], m, amount)
    wid = sql(dsn, "select id from wallets where share_slug = %s", (slug,))[0]["id"]
    for amount in (1200000, 2245003):
        eid = sql(dsn, "insert into expenses (wallet_id, paid_by, amount_centavos, note, split_mode) values (%s, %s, %s, 'Dinner', 'pot') returning id",
                  (wid, ids[0], amount))[0]["id"]
        sql(dsn, "insert into expense_shares (expense_id, member_id, share_centavos) values (%s, %s, %s)", (eid, ids[0], amount))
    wallet = on.get(f"/wallets/{slug}").json()
    pot = wallet["pot"]
    assert (pot["received_centavos"], pot["spent_centavos"], pot["balance_centavos"]) == (3700000, 3445003, 254997)
    assert pot["close_out"] == {"refunds": [{"member_id": m, "amount_centavos": v} for m, v in
                                            zip(ids, (55135, 55135, 55134, 34459, 55134))], "shortfall": []}
    # an open pot leaves the nets alone (B16's A1 half): the pot spends are one self-share each
    assert {b["net_centavos"] for b in wallet["balances"]} == {0} and wallet["transfers"] == []


def test_a_short_pot_with_no_one_in_the_goal_has_no_preview(on, dsn):
    slug, ids, _ = started(on, 2)
    for m in ids:
        person(on, slug, m, ids[0], on.get(f"/wallets/{slug}").json()["pot"]["version"], in_goal=False)
    wid = sql(dsn, "select id from wallets where share_slug = %s", (slug,))[0]["id"]
    eid = sql(dsn, "insert into expenses (wallet_id, paid_by, amount_centavos, note, split_mode) values (%s, %s, 100, 'Taxi', 'pot') returning id",
              (wid, ids[0]))[0]["id"]
    sql(dsn, "insert into expense_shares (expense_id, member_id, share_centavos) values (%s, %s, 100)", (eid, ids[0]))
    assert on.get(f"/wallets/{slug}").json()["pot"]["close_out"] is None


def test_the_ambag_list_is_newest_first(on):
    slug, ids, _ = started(on)
    for amount in (100, 200, 300):
        send(on, slug, ids[1], ids[1], amount)
    assert [a["amount_centavos"] for a in on.get(f"/wallets/{slug}").json()["pot"]["ambag"]] == [300, 200, 100]


def test_every_wallet_answer_carries_the_pot_with_the_flag_on(on, dsn):
    slug, ids, wallet = started(on, 2)
    r = on.post(f"/wallets/{slug}/expenses", json={"paid_by": ids[0], "amount_centavos": 1000, "note": "Taxi", "split_among": ids})
    assert r.json()["pot"]["treasurer"] == ids[0]
    r = on.post(f"/wallets/{slug}/settlements?by={ids[1]}", json={"from_member": ids[1], "to_member": ids[0], "amount_centavos": 500})
    assert r.json()["pot"]["treasurer"] == ids[0]


def test_no_log_line_names_a_person_or_carries_a_member_id(on, caplog):
    with caplog.at_level(logging.INFO, logger="tara_gala.api"):
        slug, ids, _ = started(on)
        aid = send(on, slug, ids[3], ids[3], 500000).json()["pot"]["ambag"][0]["id"]
        mark(on, slug, aid, ids[0], "received")
        mark(on, slug, aid, ids[0], "sent")
        person(on, slug, ids[3], ids[0], 1, in_goal=False, give_back=True)
        send(on, slug, ids[2], ids[1], 100)  # refused
        on.patch(f"/wallets/{slug}/pot", json={"by": ids[0], "version": 2, "name": "Secret Island Testname"})
        on.delete(f"/wallets/{slug}/pot/ambag/{aid}?by={ids[3]}")
    api = [r.getMessage() for r in caplog.records if r.name == "tara_gala.api"]  # the request log's path is TG-20's
    assert any(m.startswith("wallet pot refused") for m in api)
    for m in api:
        assert "Testname" not in m and "Secret" not in m, m
        assert not any(i in m for i in [*ids, aid]), m
