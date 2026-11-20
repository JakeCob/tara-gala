"""TG-62 GA1: an expense's budget line in wallets.py (plan §2 and §3: G5 to G10a, Revision 1 M2 and N2).

- POST and PATCH /wallets/{slug}/expenses take `budget_key` on the v2 body: a line of the wallet's one trip (G7) or
  "_none" ("Not in the budget"); null is "Not sorted yet". A line needs the line's own category (G6).
- WalletOut.budget is the one trip's keyed lines (trip name, key, item, category), or null.
- BUDGET_LINES off: adds drop the key, edits keep the stored one, and `budget` is null. A patch that leaves the field
  out keeps the stored line (M2), unless its category no longer matches that line (G9c).
- The key is never logged: it's a slug of the group's own line text (N2).
Made-up wallets, trips and lines only.
"""

import json
import logging
import re
from datetime import date

import psycopg
import pytest
from psycopg.rows import dict_row

from conftest import TEST_DSN
from test_wallets_v2 import (  # noqa: F401  fixtures: flags and the autouse fresh_limiters
    NAMES,
    add,
    edit,
    equal,
    expense,
    flags,
    fresh_limiters,
    legacy_equal,
    new_wallet,
    rev,
    rows,
    sql,
    stored,
)
from app import wallets as w
from app.wallet_models import WalletBudget

BIRTHDAY = "Ana's birthday dinner"
ROWS = [
    {"item": "Meals", "estimate": "1,500 to 2,200", "key": "meals", "category": "food"},
    {"item": "Van to La Trinidad", "estimate": "350", "key": "van", "category": "transport"},
    {"item": "Pasalubong", "estimate": "depends"},  # no key yet (a plan from before the backfill): not a line
    {"item": "Tips", "estimate": "200", "key": "tips"},  # no category: counts as other
    {"item": BIRTHDAY, "estimate": "800", "key": "ana-s-birthday-dinner", "category": "food"},
]
LINES = [{"key": r["key"], "item": r["item"], "category": r.get("category")} for r in ROWS if "key" in r]


@pytest.fixture
def on(client, flags):
    """WALLET_SPLITS and BUDGET_LINES on."""
    flags(wallet_splits=True, budget_lines=True)
    return client


def trip(dsn, slug, rows=ROWS, name="Baguio test trip", plan=None):
    """A trip on this wallet whose plan's guide has these budget rows. Returns the itinerary's id."""
    wallet_id = sql(dsn, "select id from wallets where share_slug = %s", (slug,))[0]["id"]
    body = plan if plan is not None else {"guide": {"budget": {"summary": "", "rows": rows, "excluded": ""}}}
    itinerary = sql(dsn, """insert into itineraries (trip_date, return_date, party, plan, model)
                            values ('2026-11-06', '2026-11-08', '[]', %s, 'trip-edit') returning id""",
                    (json.dumps(body),))[0]["id"]
    sql(dsn, """insert into trip_sessions (name, start_date, return_date, itinerary_id, wallet_id)
                values (%s, %s, %s, %s, %s)""", (name, date(2026, 11, 6), date(2026, 11, 8), itinerary, wallet_id))
    return itinerary


def set_rows(dsn, itinerary, rows):
    sql(dsn, "update itineraries set plan = %s where id = %s",
        (json.dumps({"guide": {"budget": {"summary": "", "rows": rows, "excluded": ""}}}), itinerary))


def on_line(people, key="meals", category="food", amount=1000, **extra):
    return equal(people, amount=amount, category=category, budget_key=key, **extra)


def key_of(dsn, eid):
    return sql(dsn, "select budget_key from expenses where id = %s", (eid,))[0]["budget_key"]


def detail(r):
    return r.json()["detail"]


# ---------------------------------------------------------------- G7: the wallet's budget lines

def test_g7_one_trip_gives_its_keyed_lines_in_plan_order(on, dsn):
    slug, _ = new_wallet(on)
    trip(dsn, slug, name="Baguio barkada")
    budget = on.get(f"/wallets/{slug}").json()["budget"]
    assert budget == {"trip_name": "Baguio barkada", "lines": LINES}
    assert "estimate" not in json.dumps(budget) and "1,500" not in json.dumps(budget), "lines only, never estimates"


def test_g7_budget_lines_is_a_public_helper(on, dsn):
    slug, _ = new_wallet(on)
    trip(dsn, slug)
    with psycopg.connect(TEST_DSN, row_factory=dict_row) as conn:
        wid = conn.execute("select id from wallets where share_slug = %s", (slug,)).fetchone()["id"]
        got = w.budget_lines(conn, wid)
    assert isinstance(got, WalletBudget) and [line.key for line in got.lines] == [x["key"] for x in LINES]


@pytest.mark.parametrize("case", ["no trip", "two trips", "no itinerary", "no guide", "no budget", "keyless rows",
                                  "a broken budget"])
def test_g7_anything_but_one_trip_with_keyed_lines_is_null(on, dsn, case):
    slug, _ = new_wallet(on)
    if case == "two trips":
        trip(dsn, slug)
        trip(dsn, slug, name="Another trip")
    elif case == "no itinerary":
        itinerary = trip(dsn, slug)
        sql(dsn, "update trip_sessions set itinerary_id = null where itinerary_id = %s", (itinerary,))
    elif case == "no guide":
        trip(dsn, slug, plan={"outbound": None})
    elif case == "no budget":
        trip(dsn, slug, plan={"guide": {"title": "x"}})
    elif case == "keyless rows":
        trip(dsn, slug, rows=[{"item": "Meals", "estimate": "500"}])
    elif case == "a broken budget":
        trip(dsn, slug, rows=[{"item": "Meals", "estimate": "500", "key": "Not A Key"}])
    assert on.get(f"/wallets/{slug}").json()["budget"] is None


def test_g7_budget_is_null_with_the_flag_off(client, flags, dsn):
    flags(wallet_splits=True)
    slug, _ = new_wallet(client)
    trip(dsn, slug)
    assert client.get(f"/wallets/{slug}").json()["budget"] is None
    flags(wallet_splits=True, budget_lines=True)
    assert client.get(f"/wallets/{slug}").json()["budget"]["lines"] == LINES


def test_g7_every_wallet_write_answers_with_the_budget(on, dsn):
    slug, (a, b, *_) = new_wallet(on)
    trip(dsn, slug)
    answers = [add(on, slug, on_line([a, b]))]
    eid = answers[0].json()["expenses"][0]["id"]
    answers.append(edit(on, slug, eid, {**on_line([a, b], amount=1200), "version": 1}))
    answers.append(on.post(f"/wallets/{slug}/members", json={"name": "Gina Testname"}))
    answers.append(on.post(f"/wallets/{slug}/settlements", json={"from_member": b, "to_member": a, "amount_centavos": 100}))
    sid = answers[-1].json()["settlements"][0]["id"]
    answers.append(on.delete(f"/wallets/{slug}/settlements/{sid}"))
    answers.append(on.delete(f"/wallets/{slug}/expenses/{eid}"))
    for r in answers:
        assert r.status_code in (200, 201), r.text
        assert r.json()["budget"] == {"trip_name": "Baguio test trip", "lines": LINES}


@pytest.mark.parametrize("budget_on", [True, False])
def test_g7_comment_and_proof_answers_carry_the_same_budget_as_get(client, flags, dsn, budget_on):
    """A2's routes answer the wallet too, and under the rev rule that answer replaces the screen, so it must carry the
    same budget as GET, whatever the flag (manager OK: one-line edits in wallet_activity.py and wallet_proofs.py)."""
    from app import storage
    from test_wallet_proofs import PNG, ProofStore

    flags(wallet_splits=True, wallet_activity=True, budget_lines=budget_on)
    storage.set_store(ProofStore())
    try:
        slug, (a, b, *_) = new_wallet(client)
        trip(dsn, slug)
        eid = add(client, slug, on_line([a, b])).json()["expenses"][0]["id"]
        sid = client.post(f"/wallets/{slug}/settlements", json={"from_member": b, "to_member": a,
                                                               "amount_centavos": 100}).json()["settlements"][0]["id"]
        expected = client.get(f"/wallets/{slug}").json()["budget"]
        assert (expected is not None) == budget_on
        posted = client.post(f"/wallets/{slug}/expenses/{eid}/comments", json={"body": "TESTCOMMENT"})
        assert posted.status_code == 201, posted.text
        cid = posted.json()["comments"][0]["id"]
        deleted = client.delete(f"/wallets/{slug}/expenses/{eid}/comments/{cid}")
        proof = client.post(f"/wallets/{slug}/settlements/{sid}/proof", content=PNG, headers={"content-type": "image/png"})
        assert proof.status_code == 201, proof.text
        unproof = client.delete(f"/wallets/{slug}/settlements/{sid}/proof")
        assert posted.json()["wallet"]["budget"] == expected
        assert deleted.json()["wallet"]["budget"] == expected
        assert proof.json()["budget"] == expected
        assert unproof.json()["budget"] == expected
    finally:
        storage.set_store(None)


# ---------------------------------------------------------------- G5, G6: the key on add and edit

def test_g5_an_add_stores_and_returns_the_line(on, dsn):
    slug, (a, b, *_) = new_wallet(on)
    trip(dsn, slug)
    r = add(on, slug, on_line([a, b]))
    assert r.status_code == 201, r.text
    e = r.json()["expenses"][0]
    assert e["budget_key"] == "meals" == key_of(dsn, e["id"])


@pytest.mark.parametrize("category", ["food", "hotel", None])
def test_g5_none_goes_with_any_category(on, dsn, category):
    slug, (a, b, *_) = new_wallet(on)
    trip(dsn, slug)
    r = add(on, slug, on_line([a, b], key="_none", category=category))
    assert r.status_code == 201, r.text
    assert r.json()["expenses"][0]["budget_key"] == "_none"


def test_g5_a_key_that_isnt_a_line_is_unknown_budget_line(on, dsn):
    slug, (a, b, *_) = new_wallet(on)
    trip(dsn, slug)
    r = add(on, slug, on_line([a, b], key="taxi"))
    assert (r.status_code, detail(r)) == (422, "unknown_budget_line")
    assert rev(dsn, slug) == 0 and rows(dsn, slug) == []


@pytest.mark.parametrize("trips", [0, 2])
@pytest.mark.parametrize("key", ["meals", "_none"])
def test_g5_without_one_trip_an_add_takes_only_null(on, dsn, trips, key):
    slug, (a, b, *_) = new_wallet(on)
    for n in range(trips):
        trip(dsn, slug, name=f"Trip {n}")
    r = add(on, slug, on_line([a, b], key=key))
    assert (r.status_code, detail(r)) == (422, "unknown_budget_line")
    assert add(on, slug, on_line([a, b], key=None)).status_code == 201


def test_g5_an_edit_stores_a_new_line_and_null_clears_it(on, dsn):
    slug, (a, b, *_) = new_wallet(on)
    trip(dsn, slug)
    eid = add(on, slug, on_line([a, b])).json()["expenses"][0]["id"]
    r = edit(on, slug, eid, {**on_line([a, b], key="van", category="transport"), "version": 1})
    assert r.status_code == 200, r.text
    assert expense(r.json(), eid)["budget_key"] == "van" == key_of(dsn, eid)
    r = edit(on, slug, eid, {**on_line([a, b], key=None, category="transport"), "version": 2})
    assert expense(r.json(), eid)["budget_key"] is None and key_of(dsn, eid) is None


@pytest.mark.parametrize("why", ["line removed", "two trips"])
def test_g5_resending_the_stored_key_is_always_accepted(on, dsn, why):
    """M2: the form reopens with the saved line (G25); saving it again mustn't fail, even when it's no longer a line."""
    slug, (a, b, *_) = new_wallet(on)
    itinerary = trip(dsn, slug)
    eid = add(on, slug, on_line([a, b])).json()["expenses"][0]["id"]
    if why == "line removed":
        set_rows(dsn, itinerary, [r for r in ROWS if r.get("key") != "meals"])
    else:
        trip(dsn, slug, name="Another trip")
    r = edit(on, slug, eid, {**on_line([a, b], note="Dinner, really"), "version": 1})
    assert r.status_code == 200, r.text
    assert key_of(dsn, eid) == "meals"
    r = edit(on, slug, eid, {**on_line([a, b], key="taxi", category="transport"), "version": 2})
    assert (r.status_code, detail(r)) == (422, "unknown_budget_line"), "a key that's new to it is still checked"


def test_g6_a_line_needs_its_own_category(on, dsn):
    slug, (a, b, *_) = new_wallet(on)
    trip(dsn, slug)
    for category in ("transport", None):
        r = add(on, slug, on_line([a, b], category=category))
        assert (r.status_code, detail(r)) == (422, "budget_line_category"), category
    assert rev(dsn, slug) == 0


def test_g6_a_line_with_no_category_counts_as_other(on, dsn):
    slug, (a, b, *_) = new_wallet(on)
    trip(dsn, slug)
    assert add(on, slug, on_line([a, b], key="tips", category="other")).status_code == 201
    r = add(on, slug, on_line([a, b], key="tips", category="food"))
    assert (r.status_code, detail(r)) == (422, "budget_line_category")


def test_g6_an_edit_that_sends_a_line_checks_its_category(on, dsn):
    slug, (a, b, *_) = new_wallet(on)
    trip(dsn, slug)
    eid = add(on, slug, on_line([a, b])).json()["expenses"][0]["id"]
    r = edit(on, slug, eid, {**on_line([a, b], key="meals", category="hotel"), "version": 1})
    assert (r.status_code, detail(r)) == (422, "budget_line_category")
    assert stored(dsn, eid)["version"] == 1


# ---------------------------------------------------------------- G8: a key-only edit is a change

def test_g8_an_edit_of_only_the_line_is_a_change(on, dsn):
    slug, (a, b, *_) = new_wallet(on)
    trip(dsn, slug)
    eid = add(on, slug, on_line([a, b])).json()["expenses"][0]["id"]
    n = rev(dsn, slug)
    r = edit(on, slug, eid, {**on_line([a, b], key="_none"), "version": 1})
    assert r.status_code == 200, r.text
    assert rev(dsn, slug) == n + 1 and stored(dsn, eid)["version"] == 2
    row = rows(dsn, slug)[-1]
    assert (row["action"], row["before"]["budget_key"], row["after"]["budget_key"]) == ("expense_edit", "meals", "_none")


def test_g8_the_snapshot_carries_the_line_and_a_no_op_still_writes_nothing(on, dsn):
    assert "budget_key" in w.SNAPSHOT_FIELDS
    slug, (a, b, *_) = new_wallet(on)
    trip(dsn, slug)
    eid = add(on, slug, on_line([a, b])).json()["expenses"][0]["id"]
    assert rows(dsn, slug)[-1]["after"]["budget_key"] == "meals"
    n, before = rev(dsn, slug), rows(dsn, slug)
    assert edit(on, slug, eid, {**on_line([b, a], payer=a), "version": 1}).status_code == 200  # people reordered
    assert (rev(dsn, slug), rows(dsn, slug)) == (n, before)



@pytest.mark.parametrize("flag", ["on", "off"])
def test_g8_an_unchanged_edit_without_the_field_writes_nothing(client, flags, dsn, flag):
    """tg-test F1 (G8 with G9a): a W3 phone without GW1 saves an expense unchanged, with no budget_key in the body. The
    kept line is the stored one, so it's a no-op: no version, rev or expense_edit row, and the line stays."""
    flags(wallet_splits=True, budget_lines=True)
    slug, (a, b, *_) = new_wallet(client)
    trip(dsn, slug)
    eid = add(client, slug, on_line([a, b])).json()["expenses"][0]["id"]
    if flag == "off":
        flags(wallet_splits=True)
    body = {**equal([a, b], amount=1000, category="food"), "version": 1}
    assert "budget_key" not in body
    n, before = rev(dsn, slug), rows(dsn, slug)
    r = edit(client, slug, eid, body)
    assert r.status_code == 200, r.text
    assert (rev(dsn, slug), rows(dsn, slug)) == (n, before)
    assert stored(dsn, eid)["version"] == 1 and key_of(dsn, eid) == "meals"


# ---------------------------------------------------------------- G9: the flags, and the kept line

def test_g9_budget_lines_off_drops_the_key_on_an_add(client, flags, dsn):
    flags(wallet_splits=True)
    slug, (a, b, *_) = new_wallet(client)
    trip(dsn, slug)
    r = add(client, slug, on_line([a, b], key="not-a-line"))
    assert r.status_code == 201, r.text
    e = r.json()["expenses"][0]
    assert (e["budget_key"], key_of(dsn, e["id"]), r.json()["budget"]) == (None, None, None)


def test_g9_wallet_splits_off_drops_the_key_with_the_category(client, flags, dsn):
    flags(budget_lines=True)
    slug, (a, b, *_) = new_wallet(client)
    trip(dsn, slug)
    r = add(client, slug, on_line([a, b]))
    assert r.status_code == 201, r.text
    e = r.json()["expenses"][0]
    assert (e["category"], e["budget_key"]) == (None, None)


@pytest.mark.parametrize("sent", ["van", None, "not-a-line"])
def test_g9_budget_lines_off_keeps_the_stored_key_on_an_edit(client, flags, dsn, sent):
    flags(wallet_splits=True, budget_lines=True)
    slug, (a, b, *_) = new_wallet(client)
    trip(dsn, slug)
    eid = add(client, slug, on_line([a, b])).json()["expenses"][0]["id"]
    flags(wallet_splits=True)
    r = edit(client, slug, eid, {**on_line([a, b], key=sent, note="Dinner, really"), "version": 1})
    assert r.status_code == 200, r.text
    assert key_of(dsn, eid) == "meals" and stored(dsn, eid)["version"] == 2


def note_only(people, **extra):
    """An edit from a bundle with TG-66 W3 but not GW1: no budget_key in the body at all."""
    return {**equal(people, amount=1000, category="food", note="Dinner at TESTPLACE"), "version": 1, **extra}


def test_g9a_an_edit_without_the_field_keeps_the_line(on, dsn):
    slug, (a, b, *_) = new_wallet(on)
    trip(dsn, slug)
    eid = add(on, slug, on_line([a, b])).json()["expenses"][0]["id"]
    body = note_only([a, b])
    assert "budget_key" not in body
    r = edit(on, slug, eid, body)
    assert r.status_code == 200, r.text
    assert expense(r.json(), eid)["budget_key"] == "meals" == key_of(dsn, eid)
    row = rows(dsn, slug)[-1]
    assert row["before"]["budget_key"] == row["after"]["budget_key"] == "meals", "no Changes line for the budget"


def test_g9b_the_same_edit_with_the_flag_off_keeps_it_and_it_shows_again(client, flags, dsn):
    flags(wallet_splits=True, budget_lines=True)
    slug, (a, b, *_) = new_wallet(client)
    trip(dsn, slug)
    eid = add(client, slug, on_line([a, b])).json()["expenses"][0]["id"]
    flags(wallet_splits=True)
    assert edit(client, slug, eid, note_only([a, b])).status_code == 200
    assert key_of(dsn, eid) == "meals"
    flags(wallet_splits=True, budget_lines=True)
    wallet = client.get(f"/wallets/{slug}").json()
    assert expense(wallet, eid)["budget_key"] == "meals" and wallet["budget"]["lines"] == LINES


@pytest.mark.parametrize("flag", ["on", "off"])
def test_g9c_a_kept_line_whose_category_changes_is_cleared_not_refused(client, flags, dsn, flag):
    flags(wallet_splits=True, budget_lines=True)
    slug, (a, b, *_) = new_wallet(client)
    trip(dsn, slug)
    eid = add(client, slug, on_line([a, b])).json()["expenses"][0]["id"]
    if flag == "off":
        flags(wallet_splits=True)
    r = edit(client, slug, eid, note_only([a, b], category="hotel"))
    assert r.status_code == 200, r.text
    assert key_of(dsn, eid) is None and stored(dsn, eid)["category"] == "hotel"
    row = rows(dsn, slug)[-1]
    assert (row["before"]["budget_key"], row["after"]["budget_key"]) == ("meals", None), "Changes reads the line going"


@pytest.mark.parametrize("flag", ["on", "off"])
def test_g9c_a_line_the_plan_moved_is_kept_when_the_edit_keeps_the_category(client, flags, dsn, flag):
    """tg-review S1 (G8, G9c, §6): the plan moves `meals` from food to hotel. A save that leaves the field out and
    doesn't change the category (an old phone, or BUDGET_LINES off) didn't move the expense away from its line, so the
    line stays: an unchanged save writes nothing, and a note edit keeps `meals` on both sides of its activity row."""
    flags(wallet_splits=True, budget_lines=True)
    slug, (a, b, *_) = new_wallet(client)
    itinerary = trip(dsn, slug)
    eid = add(client, slug, on_line([a, b])).json()["expenses"][0]["id"]
    set_rows(dsn, itinerary, [{**r, "category": "hotel"} if r.get("key") == "meals" else r for r in ROWS])
    if flag == "off":
        flags(wallet_splits=True)
    unchanged = {**equal([a, b], amount=1000, category="food"), "version": 1}
    n, before = rev(dsn, slug), rows(dsn, slug)
    r = edit(client, slug, eid, unchanged)
    assert r.status_code == 200, r.text
    assert (rev(dsn, slug), rows(dsn, slug)) == (n, before), "an unchanged save writes nothing"
    assert stored(dsn, eid)["version"] == 1 and key_of(dsn, eid) == "meals"
    r = edit(client, slug, eid, note_only([a, b]))
    assert r.status_code == 200, r.text
    assert key_of(dsn, eid) == "meals" and stored(dsn, eid)["version"] == 2
    row = rows(dsn, slug)[-1]
    assert row["before"]["budget_key"] == row["after"]["budget_key"] == "meals", "no Changes line for the budget"


@pytest.mark.parametrize("why", ["line removed", "two trips"])
def test_g9c_a_kept_key_that_isnt_a_line_any_more_stays(on, dsn, why):
    slug, (a, b, *_) = new_wallet(on)
    itinerary = trip(dsn, slug)
    eid = add(on, slug, on_line([a, b])).json()["expenses"][0]["id"]
    if why == "line removed":
        set_rows(dsn, itinerary, [r for r in ROWS if r.get("key") != "meals"])
    else:
        trip(dsn, slug, name="Another trip")
    assert edit(on, slug, eid, note_only([a, b], category="hotel")).status_code == 200
    assert key_of(dsn, eid) == "meals", "no line to compare with, so it's kept"


@pytest.mark.parametrize("why", ["two trips", "line removed"])
def test_g9c_gw1s_hidden_row_resends_the_stored_key_with_a_new_category_and_it_is_kept(on, dsn, why):
    """tg-test F1 / GW1 N1: with no line to show, the form's row is hidden and `lineAfterCategory` keeps the line, so the
    body resends the stored key unchanged beside the new category. G5 (M2) accepts it and G9c has no category to compare
    with, so the key is kept: no 422, not cleared."""
    slug, (a, b, *_) = new_wallet(on)
    itinerary = trip(dsn, slug)
    eid = add(on, slug, on_line([a, b])).json()["expenses"][0]["id"]
    if why == "two trips":
        trip(dsn, slug, name="Another trip")
    else:
        set_rows(dsn, itinerary, [r for r in ROWS if r.get("key") != "meals"])
    body = {**on_line([a, b], key="meals", category="hotel"), "version": 1}
    r = edit(on, slug, eid, body)
    assert r.status_code == 200, r.text
    assert expense(r.json(), eid)["budget_key"] == "meals" == key_of(dsn, eid)
    assert stored(dsn, eid)["category"] == "hotel" and stored(dsn, eid)["version"] == 2
    row = rows(dsn, slug)[-1]
    assert (row["before"]["budget_key"], row["after"]["budget_key"]) == ("meals", "meals"), "Changes shows no line"


def test_g9c_none_is_kept_with_any_category(on, dsn):
    slug, (a, b, *_) = new_wallet(on)
    trip(dsn, slug)
    eid = add(on, slug, on_line([a, b], key="_none")).json()["expenses"][0]["id"]
    assert edit(on, slug, eid, note_only([a, b], category="hotel")).status_code == 200
    assert key_of(dsn, eid) == "_none"


# ---------------------------------------------------------------- G10, G10a: the old shape, and the logs

def test_g10_an_old_shape_add_stores_null(on, dsn):
    slug, (a, b, *_) = new_wallet(on)
    trip(dsn, slug)
    r = add(on, slug, legacy_equal([a, b], amount=1000))
    assert r.status_code == 201, r.text
    e = r.json()["expenses"][0]
    assert e["budget_key"] is None and key_of(dsn, e["id"]) is None
    assert r.json()["budget"]["lines"] == LINES


def test_g10a_logs_say_line_none_or_null_and_never_the_key(on, dsn, caplog):
    caplog.set_level(logging.DEBUG)
    slug, (a, b, *_) = new_wallet(on)
    trip(dsn, slug)
    e1 = add(on, slug, on_line([a, b], key="ana-s-birthday-dinner")).json()["expenses"][0]["id"]
    e2 = add(on, slug, on_line([a, b], key="_none")).json()["expenses"][0]["id"]
    add(on, slug, on_line([a, b], key=None))
    assert add(on, slug, legacy_equal([a, b], amount=1000)).status_code == 201  # tg-test S1: today's shape says null
    edit(on, slug, e1, {**on_line([a, b], key="_none", amount=1100), "version": 1})
    edit(on, slug, e2, {**on_line([a, b], key="meals", amount=1100), "version": 1})
    on.get(f"/wallets/{slug}")
    lines = [r.getMessage() for r in caplog.records if r.name.startswith("tara_gala")]
    text = "\n".join(lines)
    for secret in ("ana-s-birthday-dinner", BIRTHDAY, "birthday", "meals", "Meals", "Van to La Trinidad", *NAMES):
        assert secret not in text, secret
    adds = [x for x in lines if x.startswith("wallet expense add ")]
    edits = [x for x in lines if x.startswith("wallet expense edit ")]
    assert [re.search(r"\bbudget=(\w+)", x).group(1) for x in adds] == ["line", "none", "null", "null"]
    assert [re.search(r"\bbudget=(\w+)", x).group(1) for x in edits] == ["none", "line"], "the value after the edit"


def test_g10a_a_refused_key_is_never_logged(on, dsn, caplog):
    """tg-test F2 (N2): a key the server refuses is the group's own text too. The refusal logs its reason, not the key."""
    caplog.set_level(logging.DEBUG)
    slug, (a, b, *_) = new_wallet(on)
    trip(dsn, slug)
    eid = add(on, slug, on_line([a, b])).json()["expenses"][0]["id"]
    caplog.clear()
    for key, category, code in (("ana-s-surprise-gift", "food", "unknown_budget_line"),
                                ("ana-s-birthday-dinner", "hotel", "budget_line_category")):
        r = add(on, slug, on_line([a, b], key=key, category=category))
        assert (r.status_code, detail(r)) == (422, code), ("add", key)
        r = edit(on, slug, eid, {**on_line([a, b], key=key, category=category), "version": 1})
        assert (r.status_code, detail(r)) == (422, code), ("edit", key)
    lines = [r.getMessage() for r in caplog.records if r.name.startswith("tara_gala")]
    text = "\n".join(lines)
    for secret in ("ana-s-surprise-gift", "ana-s-birthday-dinner", "surprise", "birthday", BIRTHDAY, *NAMES):
        assert secret not in text, secret
    refusals = [x for x in lines if " refused " in x]
    assert [re.search(r"\breason=(\w+)", x).group(1) for x in refusals] == [
        "unknown_budget_line", "unknown_budget_line", "budget_line_category", "budget_line_category"]
