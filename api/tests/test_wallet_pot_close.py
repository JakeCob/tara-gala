"""TG-73 A2: pot spends (mode=pot), hand-over, close and reopen, and the close-out in the nets (plan §1 B13 to B22,
§4; test-plan §4). Behind WALLET_POT. The money vectors run through the routes here; pot_math's own are P0's.
Made-up wallets and names only; the database is the local throwaway one.
"""

import logging

import pytest

from app import wallets as w
from test_wallet_pot import (  # noqa: F401  (fixtures: flags, on, and the autouse limiters and frozen today)
    activity,
    flags,
    fresh_limiters,
    frozen_today,
    lane,
    mark,
    new_wallet,
    on,
    person,
    send,
    sql,
    start,
    started,
)


def pot_spend(client, slug, by, amount, note="Dinner at TESTPLACE", **extra):
    body = {"mode": "pot", "amount_centavos": amount, "note": note, **extra}
    if by is not None:
        body["by"] = by
    return client.post(f"/wallets/{slug}/expenses", json=body)


def equal(people, amount, payer, note="Taxi"):
    return {"mode": "equal", "paid_by": payer, "amount_centavos": amount, "note": note,
            "inputs": [{"member_id": m, "value": 1} for m in people]}


def version(client, slug):
    return client.get(f"/wallets/{slug}").json()["pot"]["version"]


def close(client, slug, by, v=None):
    return client.post(f"/wallets/{slug}/pot/close", json={"by": by, "version": v or version(client, slug)})


def reopen(client, slug, by, v=None):
    return client.post(f"/wallets/{slug}/pot/reopen", json={"by": by, "version": v or version(client, slug)})


def hand_over(client, slug, by, to, v=None):
    return client.post(f"/wallets/{slug}/pot/handover", json={"by": by, "version": v or version(client, slug), "to_member": to})


def nets(wallet):
    return [b["net_centavos"] for b in wallet["balances"]]


def transfers(wallet):
    return [(t["from_member"], t["to_member"], t["amount_centavos"]) for t in wallet["transfers"]]


def fill(client, slug, treasurer, amounts):
    """The treasurer records each person's ambag (received at once)."""
    for member, amount in amounts:
        assert send(client, slug, treasurer, member, amount).status_code == 201


# ---------------------------------------------------------------- B13 to B15: pot spends

def test_b13_a_pot_spend_is_the_treasurers_one_share_and_moves_no_net(on, dsn, caplog):
    slug, ids, _ = started(on)
    fill(on, slug, ids[0], [(m, 800000) for m in ids])
    before = on.get(f"/wallets/{slug}").json()
    with caplog.at_level(logging.INFO, logger="tara_gala.api"):
        r = pot_spend(on, slug, ids[1], 120000, category="food")
    assert r.status_code == 201, r.text
    wallet = r.json()
    e = wallet["expenses"][0]
    assert (e["mode"], e["paid_by"], e["amount_centavos"], e["shares"], e["payers"], e["inputs"]) == (
        "pot", ids[0], 120000, [{"member_id": ids[0], "share_centavos": 120000}], [], [])
    assert e["category"] is None  # WALLET_SPLITS is off here: dropped as for any add
    assert nets(wallet) == nets(before) and transfers(wallet) == transfers(before)
    assert [(b["paid_centavos"], b["share_centavos"]) for b in wallet["balances"]] == [(0, 0)] * 5  # left out of Balances
    assert wallet["total_centavos"] == 120000
    assert wallet["pot"]["spent_centavos"] == 120000 and wallet["pot"]["balance_centavos"] == 4000000 - 120000
    row = activity(dsn, slug)[-1]
    assert (row["action"], row["actor"], row["after"]["mode"], row["after"]["paid_by"]) == ("expense_add", ids[1], "pot", ids[0])
    line = next(m for m in caplog.messages if m.startswith("wallet expense add"))
    assert line.startswith(f"wallet expense add share_slug={slug} mode=pot payers=1 people=1 items=0 amount=120000")


def test_b13_a_pot_spend_with_the_splits_on_keeps_its_category(on, flags):
    flags(wallet_pot=True, wallet_splits=True)
    slug, ids, _ = started(on)
    assert pot_spend(on, slug, ids[1], 5000, category="food").json()["expenses"][0]["category"] == "food"


def test_b13_by_is_required(on):
    slug, ids, _ = started(on)
    r = pot_spend(on, slug, None, 5000)
    assert (r.status_code, r.json()) == (422, {"detail": "by_required"})


def test_b13_a_pot_spend_never_takes_a_payer(on):
    slug, ids, _ = started(on)
    for extra in ({"paid_by": ids[1]}, {"payers": [{"member_id": ids[1], "paid_centavos": 5000}]},
                  {"inputs": [{"member_id": ids[1], "value": 1}]}):
        assert pot_spend(on, slug, ids[1], 5000, **extra).status_code == 422


def test_b13_on_a_closed_pot_too(on):
    slug, ids, _ = started(on, 2)
    fill(on, slug, ids[0], [(ids[0], 100000), (ids[1], 100000)])
    close(on, slug, ids[0])
    assert pot_spend(on, slug, ids[1], 5000).status_code == 201


def test_b15_no_goal_is_no_pot(on):
    slug, ids = new_wallet(on, 2)
    r = pot_spend(on, slug, ids[0], 5000)
    assert (r.status_code, r.json()) == (422, {"detail": "no_pot"})


def test_a_pot_spend_with_the_flag_off_is_feature_off(client, flags):
    flags(wallet_pot=True)
    slug, ids, _ = started(client, 2)
    flags(wallet_pot=False)
    r = pot_spend(client, slug, ids[0], 5000)
    assert (r.status_code, r.json()) == (404, {"detail": "feature_off"})


def test_a_pot_spend_replays_by_id_as_any_v2_add(on, dsn):
    slug, ids, _ = started(on, 2)
    key = "3f2d0c1e-0000-4000-8000-00000000a173"
    assert pot_spend(on, slug, ids[1], 5000, id=key).status_code == 201
    again = pot_spend(on, slug, ids[1], 5000, id=key)
    assert again.status_code == 200 and len(again.json()["expenses"]) == 1


def test_b14_a_pot_spend_edits_and_deletes_as_any_expense(on, flags, dsn):
    flags(wallet_pot=True, wallet_splits=True)
    slug, ids, _ = started(on, 3)
    eid = pot_spend(on, slug, ids[1], 5000).json()["expenses"][0]["id"]
    r = on.patch(f"/wallets/{slug}/expenses/{eid}", json={"mode": "pot", "amount_centavos": 7000, "note": "Dinner", "by": ids[2],
                                                          "version": 1})
    assert r.status_code == 200, r.text
    assert (r.json()["expenses"][0]["amount_centavos"], r.json()["pot"]["spent_centavos"]) == (7000, 7000)
    # to a personal expense: it leaves the pot and joins the nets
    r = on.patch(f"/wallets/{slug}/expenses/{eid}", json={**equal(ids, 9000, ids[1]), "by": ids[1], "version": 2})
    assert r.status_code == 200, r.text
    assert r.json()["pot"]["spent_centavos"] == 0 and nets(r.json()) == [-3000, 6000, -3000]
    # and back into the pot
    r = on.patch(f"/wallets/{slug}/expenses/{eid}", json={"mode": "pot", "amount_centavos": 9000, "note": "Dinner", "by": ids[1],
                                                          "version": 3})
    assert r.json()["expenses"][0]["paid_by"] == ids[0] and nets(r.json()) == [0, 0, 0]
    assert activity(dsn, slug)[-1]["action"] == "expense_edit"
    r = on.delete(f"/wallets/{slug}/expenses/{eid}?version=4&by={ids[1]}")
    assert r.status_code == 200 and r.json()["pot"]["spent_centavos"] == 0


def test_b14_an_edit_into_a_pot_spend_needs_the_flag(client, flags):
    flags(wallet_pot=True, wallet_splits=True)
    slug, ids, _ = started(client, 2)
    eid = client.post(f"/wallets/{slug}/expenses", json=equal(ids, 1000, ids[0])).json()["expenses"][0]["id"]
    flags(wallet_pot=False, wallet_splits=True)
    r = client.patch(f"/wallets/{slug}/expenses/{eid}", json={"mode": "pot", "amount_centavos": 1000, "note": "Taxi", "by": ids[0],
                                                              "version": 1})
    assert (r.status_code, r.json()) == (404, {"detail": "feature_off"})


# ---------------------------------------------------------------- B16 to B20: the close-out in the nets

def test_b16_an_open_pot_leaves_the_nets_and_transfers_as_without_it(on, dsn):
    slug, ids, _ = started(on, 3)
    on.post(f"/wallets/{slug}/expenses", json=equal(ids, 90000, ids[1]))
    on.post(f"/wallets/{slug}/expenses", json=equal(ids[:2], 40001, ids[2], note="Snacks"))
    fill(on, slug, ids[0], [(ids[0], 100000), (ids[1], 50000)])
    send(on, slug, ids[2], ids[2], 70000)  # pending
    pot_spend(on, slug, ids[2], 30000)
    with_pot = on.get(f"/wallets/{slug}").json()
    sql(dsn, "delete from expenses where split_mode = 'pot'")
    sql(dsn, "delete from wallet_pots")
    without = on.get(f"/wallets/{slug}").json()
    assert (nets(with_pot), transfers(with_pot)) == (nets(without), transfers(without))
    assert {b["pot_centavos"] for b in with_pot["balances"]} == {0}


def _v1(on):
    """V1 through the routes: 5 × ₱8,000 in, ₱37,450.00 of pot spends, plus one personal expense."""
    slug, ids, _ = started(on)
    fill(on, slug, ids[0], [(m, 800000) for m in ids])
    pot_spend(on, slug, ids[2], 3000000)
    pot_spend(on, slug, ids[3], 745000)
    on.post(f"/wallets/{slug}/expenses", json=equal(ids, 100000, ids[1], note="Pasalubong"))
    return slug, ids


def test_b17_close_with_a_leftover_folds_the_refunds_into_the_nets(on, dsn, caplog):
    slug, ids = _v1(on)
    personal = on.get(f"/wallets/{slug}").json()
    assert nets(personal) == [-20000, 80000, -20000, -20000, -20000]
    with caplog.at_level(logging.INFO, logger="tara_gala.api"):
        r = close(on, slug, ids[0])
    assert r.status_code == 200, r.text
    wallet = r.json()
    delta = [-204000, 51000, 51000, 51000, 51000]
    assert [b["pot_centavos"] for b in wallet["balances"]] == delta
    assert nets(wallet) == [p + d for p, d in zip(nets(personal), delta)]
    assert transfers(wallet) == _as_ids(w.settle_up(dict(zip(map(_uuid, ids), nets(wallet))), [_uuid(m) for m in ids]))
    assert transfers(wallet) != transfers(personal)
    assert wallet["pot"]["closed_at"] is not None and wallet["pot"]["version"] == version(on, slug)
    assert activity(dsn, slug)[-1]["after"] == {"refund_centavos": 255000, "short_centavos": 0, "people": 5}
    line = next(m for m in caplog.messages if m.startswith("wallet pot close "))
    assert line == (f"wallet pot close share_slug={slug} received=4000000 spent=3745000 refund=255000 short=0 people=5 "
                    f"pending=0 rev={wallet['rev']}")
    for m in caplog.messages:
        assert not any(i in m for i in ids) and "Testname" not in m and "TESTPLACE" not in m


def _uuid(s):
    from uuid import UUID
    return UUID(s)


def _as_ids(pairs):
    return [(str(f), str(t), a) for f, t, a in pairs]


def test_b17_the_answer_transfers_are_settle_up_over_everything(on):
    slug, ids = _v1(on)
    wallet = close(on, slug, ids[0]).json()
    want = w.settle_up({_uuid(b["member_id"]): b["net_centavos"] for b in wallet["balances"]}, [_uuid(m) for m in ids])
    assert transfers(wallet) == _as_ids(want)


def test_b17_v2_rounding_through_the_routes(on):
    slug, ids, _ = started(on)
    person(on, slug, ids[3], ids[0], 1, target_centavos=500000)
    fill(on, slug, ids[0], list(zip(ids, (800000, 800000, 800000, 500000, 800000))))
    pot_spend(on, slug, ids[1], 1200000)
    pot_spend(on, slug, ids[1], 2245003)
    wallet = close(on, slug, ids[0]).json()
    assert [b["pot_centavos"] for b in wallet["balances"]] == [-199862, 55135, 55134, 34459, 55134]
    assert sum(nets(wallet)) == 0


def test_b18_close_short_v6_owed_to_the_treasurer(on, dsn):
    slug, ids, _ = started(on, 3, each=1000000)
    fill(on, slug, ids[0], [(m, 1000000) for m in ids])
    pot_spend(on, slug, ids[1], 2000000)
    pot_spend(on, slug, ids[2], 1100001)
    wallet = close(on, slug, ids[0]).json()
    assert [b["pot_centavos"] for b in wallet["balances"]] == [66667, -33334, -33333]
    assert transfers(wallet) == [(ids[1], ids[0], 33334), (ids[2], ids[0], 33333)]
    assert activity(dsn, slug)[-1]["after"] == {"refund_centavos": 0, "short_centavos": 100001, "people": 3}


def test_b19_reopen_takes_it_out_and_close_puts_the_same_numbers_back(on, dsn):
    slug, ids = _v1(on)
    open_nets = nets(on.get(f"/wallets/{slug}").json())
    first = close(on, slug, ids[0]).json()
    r = reopen(on, slug, ids[0])
    assert r.status_code == 200 and r.json()["pot"]["closed_at"] is None
    assert nets(r.json()) == open_nets and {b["pot_centavos"] for b in r.json()["balances"]} == {0}
    again = close(on, slug, ids[0]).json()
    assert (nets(again), transfers(again)) == (nets(first), transfers(first))
    reopen(on, slug, ids[0])
    pot_spend(on, slug, ids[1], 5000)  # a row changed in between
    changed = close(on, slug, ids[0]).json()
    assert nets(changed) != nets(first)
    assert [a["action"] for a in activity(dsn, slug) if a["action"].startswith("pot_")][-5:] == [
        "pot_close", "pot_reopen", "pot_close", "pot_reopen", "pot_close"]


def test_b19_an_edit_after_the_close_changes_the_numbers(on, flags):
    flags(wallet_pot=True, wallet_splits=True)
    slug, ids = _v1(on)
    first = close(on, slug, ids[0]).json()
    eid = next(e["id"] for e in first["expenses"] if e["mode"] == "pot" and e["amount_centavos"] == 745000)
    r = on.patch(f"/wallets/{slug}/expenses/{eid}", json={"mode": "pot", "amount_centavos": 645000, "note": "Dinner",
                                                          "by": ids[3], "version": 1})
    assert [b["pot_centavos"] for b in r.json()["balances"]] == [-284000, 71000, 71000, 71000, 71000]


def test_b20_a_pending_send_at_close_doesnt_count(on, caplog):
    slug, ids, _ = started(on, 3, each=100000)
    fill(on, slug, ids[0], [(ids[0], 100000), (ids[1], 100000)])
    send(on, slug, ids[2], ids[2], 100000)
    pot_spend(on, slug, ids[1], 140000)
    with caplog.at_level(logging.INFO, logger="tara_gala.api"):
        wallet = close(on, slug, ids[0]).json()
    assert wallet["pot"]["pending_count"] == 1
    assert [b["pot_centavos"] for b in wallet["balances"]] == [-30000, 30000, 0]
    assert any(" pending=1 " in m for m in caplog.messages if m.startswith("wallet pot close "))


def test_a_closed_pot_with_the_flag_off_is_personal_only_and_the_same_again_when_on(client, flags):
    flags(wallet_pot=True)
    slug, ids = _v1(client)
    personal = client.get(f"/wallets/{slug}").json()
    closed = close(client, slug, ids[0]).json()
    flags(wallet_pot=False)
    off = client.get(f"/wallets/{slug}").json()
    assert (nets(off), transfers(off)) == (nets(personal), transfers(personal))
    assert all("pot_centavos" not in b for b in off["balances"]) and "pot" not in off
    flags(wallet_pot=True)
    back = client.get(f"/wallets/{slug}").json()
    assert (nets(back), transfers(back)) == (nets(closed), transfers(closed))


def test_close_refusals(on):
    slug, ids, _ = started(on, 2)
    assert close(on, slug, ids[1]).json() == {"detail": "not_treasurer"}
    assert reopen(on, slug, ids[0]).json() == {"detail": "pot_open"}
    close(on, slug, ids[0])
    assert close(on, slug, ids[0]).json() == {"detail": "pot_closed"}
    assert reopen(on, slug, ids[1]).json() == {"detail": "not_treasurer"}
    r = close(on, slug, ids[0], v=1)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "pot_changed"


def test_v16_short_with_everyone_taken_out_is_no_one_in_goal(on):
    slug, ids, _ = started(on, 2, each=100000)
    fill(on, slug, ids[0], [(ids[0], 100000), (ids[1], 100000)])
    for m in ids:
        person(on, slug, m, ids[0], version(on, slug), in_goal=False)
    pot_spend(on, slug, ids[0], 300000)
    r = close(on, slug, ids[0])
    assert (r.status_code, r.json()) == (409, {"detail": "no_one_in_goal"})


def test_v13b_v15_a_person_given_back_is_out_of_the_shortfall_split(on):
    slug, ids = new_wallet(on, 3)  # Ana (T), Ben, Bea
    start(on, slug, ids[0], ids, each=500000)
    fill(on, slug, ids[0], [(m, 500000) for m in ids])
    person(on, slug, ids[2], ids[0], 1, in_goal=False, give_back=True)
    pot_spend(on, slug, ids[1], 1200000)
    wallet = close(on, slug, ids[0]).json()
    assert [b["pot_centavos"] for b in wallet["balances"]] == [100000, -100000, 0]


def test_v14_a_person_who_kept_their_part_shares_the_refunds(on):
    slug, ids = new_wallet(on, 3)
    start(on, slug, ids[0], ids)
    fill(on, slug, ids[0], [(ids[0], 800000), (ids[1], 800000), (ids[2], 500000)])
    person(on, slug, ids[2], ids[0], 1, in_goal=False)
    pot_spend(on, slug, ids[1], 1890000)
    wallet = close(on, slug, ids[0]).json()
    assert [b["pot_centavos"] for b in wallet["balances"]] == [-130000, 80000, 50000]


# ---------------------------------------------------------------- B21: hand-over

def test_b21_hand_over_changes_only_the_treasurer_and_makes_no_settlement(on, dsn, caplog):
    slug, ids, _ = started(on, 3, each=100000)
    fill(on, slug, ids[0], [(m, 100000) for m in ids])
    pot_spend(on, slug, ids[1], 60000)
    pending = send(on, slug, ids[2], ids[2], 1000).json()["pot"]["ambag"][0]["id"]
    before = on.get(f"/wallets/{slug}").json()
    with caplog.at_level(logging.INFO, logger="tara_gala.api"):
        r = hand_over(on, slug, ids[0], ids[2])
    assert r.status_code == 200, r.text
    wallet = r.json()
    assert wallet["pot"]["treasurer"] == ids[2] and wallet["pot"]["version"] == before["pot"]["version"] + 1
    assert wallet["settlements"] == before["settlements"] == [] and nets(wallet) == nets(before)
    assert activity(dsn, slug)[-1] == {"action": "pot_handover", "actor": ids[0], "member_id": ids[2],
                                       "after": {"from": ids[0], "to": ids[2], "balance_centavos": 240000}}
    assert f"wallet pot handover share_slug={slug} balance=240000 short=no pending=1 rev={wallet['rev']}" in caplog.messages
    # the new treasurer marks the pending one, the old one can't any more
    assert mark(on, slug, pending, ids[0], "received").json() == {"detail": "not_treasurer"}
    assert mark(on, slug, pending, ids[2], "received").status_code == 200


def test_b21_v11_a_later_close_uses_the_new_treasurer(on):
    slug, ids, _ = started(on, 3, each=100000)
    fill(on, slug, ids[0], [(m, 100000) for m in ids])
    pot_spend(on, slug, ids[1], 60000)
    hand_over(on, slug, ids[0], ids[2])
    pot_spend(on, slug, ids[1], 40000)
    wallet = close(on, slug, ids[2]).json()
    assert [b["pot_centavos"] for b in wallet["balances"]] == [66667, 66666, -133333]


def test_b21_v12_hand_over_while_short_is_not_counted_twice(on, caplog):
    slug, ids, _ = started(on, 3, each=100000)
    fill(on, slug, ids[0], [(m, 100000) for m in ids])
    pot_spend(on, slug, ids[1], 360000)
    with caplog.at_level(logging.INFO, logger="tara_gala.api"):
        hand_over(on, slug, ids[0], ids[2])
    assert any(" short=yes " in m for m in caplog.messages if m.startswith("wallet pot handover"))
    wallet = close(on, slug, ids[2]).json()
    assert [b["pot_centavos"] for b in wallet["balances"]] == [-20000, -20000, 40000]
    assert wallet["settlements"] == []


def test_hand_over_refusals(on, dsn):
    slug, ids = new_wallet(on, 3)
    start(on, slug, ids[0], ids[:2])
    assert hand_over(on, slug, ids[1], ids[1]).json() == {"detail": "not_treasurer"}
    assert hand_over(on, slug, ids[0], ids[2]).json() == {"detail": "not_in_goal"}
    stranger = new_wallet(on, 1)[1][0]
    assert hand_over(on, slug, ids[0], stranger).json() == {"detail": "unknown_member"}
    r = hand_over(on, slug, ids[0], ids[0])
    assert r.status_code == 200 and r.json()["pot"]["version"] == 1  # to yourself: a no-op
    close(on, slug, ids[0])
    assert hand_over(on, slug, ids[0], ids[1]).json() == {"detail": "pot_closed"}


@pytest.mark.parametrize("path, body", [("/pot/handover", {"to_member": "x"}), ("/pot/close", {"version": "x"}),
                                        ("/pot/reopen", {})])
def test_flag_off_the_a2_routes_are_feature_off(client, flags, path, body):
    slug, _ = new_wallet(client, 2)
    r = client.post(f"/wallets/{slug}{path}", json=body)
    assert (r.status_code, r.json()) == (404, {"detail": "feature_off"})
