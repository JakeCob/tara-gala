"""TG-70 O1: a v2 add can carry the phone's own expense `id`, so a resend is safe (plan §2 B1 to B9, B2a, B12a).

- POST /wallets/{slug}/expenses with a v2 body and `id`: the first send stores the expense under that id (201). A
  resend of an id this wallet has seen answers 200 with the wallet as it is now and writes nothing. "Seen" is a live
  expense of this wallet (`found=live`) or an `expense_add` row in this wallet's activity (`found=deleted`).
- The replay check runs first, before the rate limit and both `feature_off` checks (F1), so a replay is never 429 or
  `feature_off`, and it doesn't use up the limit.
- An id that's another wallet's expense is 409 `id_taken`, also when two inserts race (only `expenses_pkey`, N1).
- An edit can't carry `id` (B6). A body without `id` runs today's path (B7), unedited suites included.
- CORS exposes `Retry-After`, so the phone can read a 429's wait (F2).

Test ids are test-plan.md's T70-A1 to A12. Made-up wallets, names and notes only, on tg-testpg.
"""

import logging
import re
import threading
from uuid import UUID, uuid4

import pytest
from fastapi.middleware.cors import CORSMiddleware
from pydantic import ValidationError

from app import wallet_models as models
from app import wallets as w
from app.limits import RateLimiter
from test_wallet_budget_key import trip  # a made-up trip whose guide has budget lines
from test_wallets_v2 import (  # noqa: F401  fixtures: flags and the autouse fresh_limiters
    NAMES,
    VECTORS,
    add,
    delete,
    detail,
    edit,
    equal,
    expense,
    flags,
    fresh_limiters,
    new_wallet,
    rev,
    rows,
    shares,
    sql,
    vector_body,
)

NOTE = "Taxi to TESTPLACE"
LOGGER = "tara_gala.api"
MODES = ("equal", "exact", "percent", "shares", "adjust", "itemized")
OK_CASES = {m: next(c for c in VECTORS["cases"] if c["mode"] == m and "shares" in c["expect"]) for m in MODES}
SPLIT_REFUSALS = {}
for _c in VECTORS["cases"]:
    if "error" in _c["expect"]:
        SPLIT_REFUSALS.setdefault(_c["mode"], _c)  # one split code per mode that has one (equal has none)


@pytest.fixture()
def on(client, flags):
    """WALLET_SPLITS and WALLET_MULTI_PAYER on (BUDGET_LINES stays off unless a test turns it on)."""
    flags(wallet_splits=True, wallet_multi_payer=True)
    return client


def with_id(body, eid=None):
    return {**body, "id": str(eid or uuid4())}


def count(dsn, slug):
    return sql(dsn, """select count(*) as n from expenses e join wallets w on w.id = e.wallet_id
                       where w.share_slug = %s""", (slug,))[0]["n"]


def adds_for(dsn, eid):
    return sql(dsn, "select count(*) as n from wallet_activity where expense_id = %s and action = 'expense_add'",
               (eid,))[0]["n"]


def state(dsn, slug):
    """Everything an add can move in one wallet, read from the database, never from the answer."""
    return {"expenses": count(dsn, slug), "rev": rev(dsn, slug), "rows": rows(dsn, slug),
            "shares": sql(dsn, """select s.expense_id, s.member_id, s.share_centavos from expense_shares s
                                  join expenses e on e.id = s.expense_id join wallets w on w.id = e.wallet_id
                                  where w.share_slug = %s order by 1, 2""", (slug,))}


def lines(caplog, start):
    return [r.getMessage() for r in caplog.records if r.getMessage().startswith(start)]


def multi_payer(ids, amount=1000):
    a, b, *_ = ids
    body = equal(ids[:2], amount=amount, note=NOTE)
    del body["paid_by"]
    body["payers"] = [{"member_id": a, "paid_centavos": 300}, {"member_id": b, "paid_centavos": amount - 300}]
    return body


def percent(ids, note=NOTE):
    a, b, *_ = ids
    return {"mode": "percent", "paid_by": a, "amount_centavos": 1000, "note": note,
            "inputs": [{"member_id": a, "value": 5000}, {"member_id": b, "value": 5000}]}


# ---------------------------------------------------------------- A1 (B1): the first send

@pytest.mark.parametrize("mode", MODES)
def test_a1_a_first_send_stores_the_expense_under_the_phones_id(on, dsn, mode):
    slug, ids = new_wallet(on, 6)
    body, expect = vector_body(OK_CASES[mode], ids)
    eid = uuid4()
    r = add(on, slug, with_id(body, eid))
    assert r.status_code == 201, r.text
    e = expense(on.get(f"/wallets/{slug}").json(), str(eid))
    assert shares(e) == expect["shares"] and e["mode"] == mode
    assert adds_for(dsn, eid) == 1 and rev(dsn, slug) == 1 and count(dsn, slug) == 1


def test_a1_a_multi_payer_body_and_a_budget_line_body_store_under_the_id(on, dsn, flags):
    flags(wallet_splits=True, wallet_multi_payer=True, budget_lines=True)
    slug, ids = new_wallet(on)
    trip(dsn, slug)
    mp, line = uuid4(), uuid4()
    assert add(on, slug, with_id(multi_payer(ids), mp)).status_code == 201
    r = add(on, slug, with_id(equal(ids, amount=1000, category="food", budget_key="meals"), line))
    assert r.status_code == 201, r.text
    wallet = r.json()
    assert [p["paid_centavos"] for p in expense(wallet, str(mp))["payers"]] == [300, 700]
    assert expense(wallet, str(line))["budget_key"] == "meals"
    assert adds_for(dsn, mp) == adds_for(dsn, line) == 1 and rev(dsn, slug) == 2


# ---------------------------------------------------------------- A2 (B2): the lost answer

def test_a2_a_resend_is_200_with_the_wallet_as_it_is_and_writes_nothing(on, dsn, caplog):
    slug, ids = new_wallet(on)
    body = with_id(equal(ids, amount=4500, note=NOTE))
    assert add(on, slug, body).status_code == 201
    before = state(dsn, slug)
    caplog.set_level(logging.INFO, logger=LOGGER)
    for _ in range(2):  # the second resend gives the same answer
        r = add(on, slug, body)
        assert r.status_code == 200, r.text
        assert r.json() == on.get(f"/wallets/{slug}").json()
        assert state(dsn, slug) == before
    assert adds_for(dsn, body["id"]) == 1
    assert lines(caplog, "wallet expense add replay") == [f"wallet expense add replay share_slug={slug} found=live rev=1"] * 2
    assert r.headers["cache-control"] == "private, no-cache" and r.headers["x-robots-tag"] == "noindex"


def test_a2b_a_replay_answers_from_the_id_alone_and_keeps_the_first_expense(on, dsn):  # B9
    slug, ids = new_wallet(on)
    eid = uuid4()
    assert add(on, slug, with_id(equal(ids, amount=4500, note=NOTE), eid)).status_code == 201
    first = expense(on.get(f"/wallets/{slug}").json(), str(eid))
    r = add(on, slug, with_id(equal(ids[:2], amount=9900, note="Something else"), eid))
    assert r.status_code == 200, r.text
    e = expense(r.json(), str(eid))
    assert (e["amount_centavos"], e["note"], shares(e)) == (4500, NOTE, shares(first))


def test_a2c_a_replay_loads_the_budget_lines_as_the_add_does(client, dsn, flags):
    flags(wallet_splits=True, budget_lines=True)
    slug, ids = new_wallet(client)
    trip(dsn, slug)
    body = with_id(equal(ids, amount=1000, category="food", budget_key="meals"))
    assert add(client, slug, body).status_code == 201
    r = add(client, slug, body)
    assert r.status_code == 200, r.text
    assert r.json()["budget"] is not None and r.json()["budget"] == client.get(f"/wallets/{slug}").json()["budget"]


def test_a2d_a_full_wallets_replay_is_still_200_not_wallet_full(on, dsn, monkeypatch):
    slug, ids = new_wallet(on)
    body = with_id(equal(ids, amount=1000))
    assert add(on, slug, body).status_code == 201
    monkeypatch.setattr(w, "MAX_EXPENSES", 1)
    r = add(on, slug, body)
    assert r.status_code == 200, r.text
    r = add(on, slug, with_id(equal(ids, amount=1000)))
    assert (r.status_code, detail(r)) == (409, "wallet_full"), "a new id still gets today's refusal"


# ---------------------------------------------------------------- A3 (B3): sent, then deleted

def test_a3_a_resend_of_a_deleted_expense_is_200_without_it_and_doesnt_bring_it_back(on, dsn, caplog):
    slug, ids = new_wallet(on)
    body = with_id(equal(ids, amount=4500, note=NOTE))
    assert add(on, slug, body).status_code == 201
    assert delete(on, slug, body["id"], version=1).status_code == 200
    before = state(dsn, slug)
    assert [r["action"] for r in before["rows"]] == ["expense_add", "expense_delete"]
    caplog.set_level(logging.INFO, logger=LOGGER)
    r = add(on, slug, body)
    assert r.status_code == 200, r.text
    assert body["id"] not in [e["id"] for e in r.json()["expenses"]]
    assert r.json() == on.get(f"/wallets/{slug}").json()
    assert state(dsn, slug) == before
    assert lines(caplog, "wallet expense add replay") == [f"wallet expense add replay share_slug={slug} found=deleted rev=2"]


def test_a3b_the_deleted_since_check_reads_only_this_wallets_activity(on, dsn):
    x, xs = new_wallet(on)
    y, ys = new_wallet(on)
    eid = uuid4()
    assert add(on, x, with_id(equal(xs, amount=1000), eid)).status_code == 201
    assert delete(on, x, str(eid), version=1).status_code == 200
    r = add(on, y, with_id(equal(ys, amount=1000), eid))
    assert r.status_code == 201, r.text
    assert str(eid) in [e["id"] for e in r.json()["expenses"]]


def test_a3c_only_an_expense_add_row_counts_as_seen(on, dsn):
    """A pin for the activity check's `action = 'expense_add'`: another action naming an id isn't a past add."""
    slug, ids = new_wallet(on)
    eid = uuid4()
    sql(dsn, """insert into wallet_activity (wallet_id, action, expense_id)
                select id, 'expense_edit', %s from wallets where share_slug = %s""", (eid, slug))
    r = add(on, slug, with_id(equal(ids, amount=1000), eid))
    assert r.status_code == 201, r.text


# ---------------------------------------------------------------- A4 (B4): another wallet's id

def test_a4_another_wallets_live_id_is_409_id_taken_and_nothing_moves(on, dsn, caplog):
    x, xs = new_wallet(on)
    y, ys = new_wallet(on)
    eid = uuid4()
    assert add(on, x, with_id(equal(xs, amount=1000, note=NOTE), eid)).status_code == 201
    before = state(dsn, x), state(dsn, y)
    caplog.set_level(logging.INFO, logger=LOGGER)
    r = add(on, y, with_id(equal(ys, amount=1000), eid))
    assert r.status_code == 409, r.text
    assert r.json() == {"detail": "id_taken"}
    assert (state(dsn, x), state(dsn, y)) == before
    assert lines(caplog, "wallet expense add refused") == [f"wallet expense add refused share_slug={y} reason=id_taken"]


def test_a4b_the_insert_race_is_409_id_taken_with_nothing_half_written(on, dsn, monkeypatch):
    x, xs = new_wallet(on)
    y, ys = new_wallet(on)
    eid = uuid4()
    assert add(on, x, with_id(equal(xs, amount=1000), eid)).status_code == 201
    before = state(dsn, x), state(dsn, y)
    monkeypatch.setattr(w, "_replay", lambda *a, **k: None)  # the pre-check misses, as in a race
    r = add(on, y, with_id(equal(ys, amount=1000), eid))
    assert (r.status_code, r.json()) == (409, {"detail": "id_taken"}), r.text
    assert (state(dsn, x), state(dsn, y)) == before
    monkeypatch.undo()
    assert on.get(f"/wallets/{y}").status_code == 200, "the pool's next request works"
    assert add(on, y, with_id(equal(ys, amount=1000))).status_code == 201


def test_a4c_a_unique_violation_on_a_child_row_is_not_id_taken(on, dsn, monkeypatch, caplog):  # N1
    slug, ids = new_wallet(on)
    real = w._store_split

    def twice(conn, expense_id, body, shares, payers):
        real(conn, expense_id, body, shares, payers)
        real(conn, expense_id, body, shares, payers)  # a bug: the child rows' unique keys, not expenses_pkey

    monkeypatch.setattr(w, "_store_split", twice)
    caplog.set_level(logging.ERROR, logger="tara_gala.request")
    r = add(on, slug, with_id(equal(ids, amount=1000)))
    assert (r.status_code, r.json()) == (500, {"detail": "Internal server error"}), "not 409 id_taken"
    assert count(dsn, slug) == 0
    assert any("error=UniqueViolation" in x.getMessage() for x in caplog.records if x.name == "tara_gala.request")


# ---------------------------------------------------------------- A5 (B5): two sends at once

def test_a5_two_sends_at_once_give_201_and_200_and_one_expense(on, dsn):
    slug, ids = new_wallet(on)
    for _ in range(5):
        body = with_id(equal(ids, amount=1000))
        gate = threading.Barrier(2)
        got = []

        def send():
            gate.wait()
            got.append(add(on, slug, body).status_code)

        threads = [threading.Thread(target=send) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(30)
        assert sorted(got) == [200, 201]
        assert sql(dsn, "select count(*) as n from expenses where id = %s", (body["id"],))[0]["n"] == 1
        assert adds_for(dsn, body["id"]) == 1


# ---------------------------------------------------------------- A6 (B6): an edit can't carry an id

def _model_body(mode):
    body, _ = vector_body(OK_CASES[mode], [str(uuid4()) for _ in range(6)])
    return body


@pytest.mark.parametrize("mode", MODES)
def test_a6_every_add_model_takes_an_id_and_every_patch_model_refuses_it(mode):
    add_cls = {"equal": models.EqualIn, "exact": models.ExactIn, "percent": models.PercentIn,
               "shares": models.SharesIn, "adjust": models.AdjustIn, "itemized": models.ItemizedIn}[mode]
    patch_cls = {"equal": models.EqualPatch, "exact": models.ExactPatch, "percent": models.PercentPatch,
                 "shares": models.SharesPatch, "adjust": models.AdjustPatch, "itemized": models.ItemizedPatch}[mode]
    body = _model_body(mode)
    eid = uuid4()
    assert add_cls.model_validate({**body, "id": str(eid)}).id == eid
    assert add_cls.model_validate(body).id is None
    assert patch_cls.model_validate({**body, "version": 1}).version == 1
    with pytest.raises(ValidationError):
        patch_cls.model_validate({**body, "version": 1, "id": str(eid)})


def test_a6_a_patch_with_an_id_is_422_and_changes_nothing(on, dsn):
    slug, ids = new_wallet(on)
    eid = add(on, slug, equal(ids, amount=1000)).json()["expenses"][0]["id"]
    before = state(dsn, slug)
    r = edit(on, slug, eid, {**equal(ids, amount=2000), "version": 1, "id": eid})
    assert r.status_code == 422, r.text
    assert state(dsn, slug) == before
    assert expense(on.get(f"/wallets/{slug}").json(), eid)["version"] == 1


# ---------------------------------------------------------------- A8 (B8): a refusal with a new id is today's refusal

def _refusal(case, on, dsn, flags, monkeypatch, slug, ids):
    """(the refused body, a fix that makes it valid, the valid body)."""
    if case == "unknown_member":
        return equal(ids[:2] + [str(uuid4())], amount=1000), lambda: None, equal(ids, amount=1000)
    if case == "payers_mismatch":
        bad = multi_payer(ids)
        bad["payers"][1]["paid_centavos"] += 1
        return bad, lambda: None, multi_payer(ids)
    if case.startswith("split:"):
        body, _ = vector_body(SPLIT_REFUSALS[case[6:]], ids)
        good, _ = vector_body(OK_CASES[case[6:]], ids)
        return body, lambda: None, good
    if case == "wallet_full":
        assert add(on, slug, equal(ids, amount=1000)).status_code == 201
        monkeypatch.setattr(w, "MAX_EXPENSES", 1)
        return equal(ids, amount=1000), lambda: monkeypatch.setattr(w, "MAX_EXPENSES", 500), equal(ids, amount=1000)
    if case == "feature_off:multi_payer":
        flags(wallet_splits=True, wallet_multi_payer=False)
        return multi_payer(ids), lambda: flags(wallet_splits=True, wallet_multi_payer=True), multi_payer(ids)
    if case == "feature_off:splits":
        flags(wallet_splits=False, wallet_multi_payer=True)
        return percent(ids), lambda: flags(wallet_splits=True, wallet_multi_payer=True), percent(ids)
    flags(wallet_splits=True, wallet_multi_payer=True, budget_lines=True)
    trip(dsn, slug)
    if case == "unknown_budget_line":
        return (equal(ids, amount=1000, category="food", budget_key="not-a-line"), lambda: None,
                equal(ids, amount=1000, category="food", budget_key="meals"))
    assert case == "budget_line_category"
    return (equal(ids, amount=1000, category="transport", budget_key="meals"), lambda: None,
            equal(ids, amount=1000, category="food", budget_key="meals"))


REFUSAL_CASES = (["unknown_member", "payers_mismatch"] + [f"split:{m}" for m in SPLIT_REFUSALS]
                 + ["wallet_full", "feature_off:multi_payer", "feature_off:splits", "unknown_budget_line",
                    "budget_line_category"])


@pytest.mark.parametrize("case", REFUSAL_CASES)
def test_a8_a_refused_body_with_a_new_id_gets_todays_status_and_code(on, dsn, flags, monkeypatch, case):
    slug, ids = new_wallet(on, 6)
    bad, fix, good = _refusal(case, on, dsn, flags, monkeypatch, slug, ids)
    before = state(dsn, slug)
    today = add(on, slug, bad)
    assert today.status_code in (404, 409, 422) and isinstance(detail(today), (str, dict)), today.text
    eid = uuid4()
    r = add(on, slug, with_id(bad, eid))
    assert (r.status_code, r.json()) == (today.status_code, today.json())
    assert state(dsn, slug) == before
    fix()
    r = add(on, slug, with_id(good, eid))
    assert r.status_code == 201, f"a refused id was never stored: {r.text}"
    assert str(eid) in [e["id"] for e in r.json()["expenses"]]


# ---------------------------------------------------------------- A9 (B7): the legacy body; A9b (F1): the replay first

def test_a9_a_legacy_body_with_an_id_is_422_as_today(on, dsn):
    slug, (a, b, *_) = new_wallet(on)
    r = add(on, slug, {"paid_by": a, "amount_centavos": 1000, "note": NOTE, "split_among": [a, b], "id": str(uuid4())})
    assert r.status_code == 422, r.text
    assert count(dsn, slug) == 0


@pytest.mark.parametrize("deleted", [False, True], ids=["live", "deleted"])
@pytest.mark.parametrize("off", ["multi_payer", "splits"])
def test_a9b_a_replay_beats_a_flag_switched_off_since(on, dsn, flags, caplog, off, deleted):
    slug, ids = new_wallet(on)
    body = with_id(multi_payer(ids) if off == "multi_payer" else percent(ids))
    assert add(on, slug, body).status_code == 201
    if deleted:
        assert delete(on, slug, body["id"], version=1).status_code == 200
    flags(wallet_splits=off != "splits", wallet_multi_payer=off != "multi_payer")
    before = state(dsn, slug)
    caplog.set_level(logging.INFO, logger=LOGGER)
    r = add(on, slug, body)
    assert r.status_code == 200, r.text
    assert state(dsn, slug) == before
    found = "deleted" if deleted else "live"
    assert lines(caplog, "wallet expense add replay") == [
        f"wallet expense add replay share_slug={slug} found={found} rev={before['rev']}"]
    r = add(on, slug, with_id(multi_payer(ids) if off == "multi_payer" else percent(ids)))
    assert (r.status_code, detail(r)) == (404, "feature_off"), "a new id still gets today's feature_off"


# ---------------------------------------------------------------- A10 (B2a, B12a): the limit and CORS

def test_a10_a_replay_with_the_limit_used_up_is_200_and_a_new_id_is_429(on, dsn, monkeypatch):
    slug, ids = new_wallet(on)
    body = with_id(equal(ids, amount=1000))
    assert add(on, slug, body).status_code == 201
    monkeypatch.setattr(w, "WRITE_LIMITER", RateLimiter(1))
    assert add(on, slug, equal(ids, amount=500)).status_code == 201  # uses the one slot
    before = state(dsn, slug)
    r = add(on, slug, body)
    assert r.status_code == 200, r.text
    r = add(on, slug, with_id(equal(ids, amount=700)))
    assert r.status_code == 429, r.text
    assert int(r.headers["retry-after"]) >= 1
    assert state(dsn, slug) == before, "a new id over the limit stores nothing (N2)"


def test_a10_replays_dont_use_up_the_limit(on, dsn, monkeypatch):
    slug, ids = new_wallet(on)
    monkeypatch.setattr(w, "WRITE_LIMITER", RateLimiter(3))
    body = with_id(equal(ids, amount=1000))
    assert add(on, slug, body).status_code == 201  # slot 1
    for _ in range(5):
        assert add(on, slug, body).status_code == 200
    assert add(on, slug, equal(ids, amount=500)).status_code == 201  # slot 2
    assert add(on, slug, equal(ids, amount=500)).status_code == 201  # slot 3
    assert add(on, slug, equal(ids, amount=500)).status_code == 429


def test_a10_a_body_without_an_id_keeps_todays_order_limit_first(on, flags, monkeypatch):
    """Plan §3: no `id`, today's order exactly: `_limit`, then the flag checks, then the wallet (a bad slug's 404)."""
    slug, ids = new_wallet(on)
    monkeypatch.setattr(w, "WRITE_LIMITER", RateLimiter(1))
    assert add(on, slug, equal(ids, amount=500)).status_code == 201  # uses the one slot
    flags(wallet_splits=False, wallet_multi_payer=False)
    for target, body in ((slug, multi_payer(ids)), (slug, percent(ids)), ("0" * 32, equal(ids, amount=500))):
        r = add(on, target, body)
        assert (r.status_code, detail(r)) == (429, "rate_limited"), r.text


def _origin(client):
    cors = next(m for m in client.app.user_middleware if m.cls is CORSMiddleware)
    return cors.kwargs["allow_origins"][0]


def test_a10_a_cross_origin_429_exposes_retry_after(on, monkeypatch):  # F2
    slug, ids = new_wallet(on)
    origin = _origin(on)
    r = on.post(f"/wallets/{slug}/expenses", json=equal(ids, amount=1000), headers={"Origin": origin})
    assert r.status_code == 201 and r.headers["access-control-allow-origin"] == origin, "today's CORS headers stay"
    monkeypatch.setattr(w, "WRITE_LIMITER", RateLimiter(1))
    on.post(f"/wallets/{slug}/expenses", json=equal(ids, amount=1000), headers={"Origin": origin})
    r = on.post(f"/wallets/{slug}/expenses", json=equal(ids, amount=1000), headers={"Origin": origin})
    assert r.status_code == 429
    assert r.headers["access-control-allow-origin"] == origin
    exposed = [h.strip().lower() for h in r.headers.get("access-control-expose-headers", "").split(",")]
    assert "retry-after" in exposed and int(r.headers["retry-after"]) >= 1


# ---------------------------------------------------------------- A11 (§7): the logs

def test_a11_an_add_with_an_id_says_client_id_yes_and_one_without_is_todays_line(on, caplog):
    slug, ids = new_wallet(on)
    caplog.set_level(logging.INFO, logger=LOGGER)
    assert add(on, slug, equal(ids[:2], amount=1000)).status_code == 201
    assert add(on, slug, with_id(equal(ids[:2], amount=1000))).status_code == 201
    today, with_client = lines(caplog, "wallet expense add share_slug=")
    head = (f"wallet expense add share_slug={slug} mode=equal payers=1 people=2 items=0 amount=1000 category=None "
            f"budget=null members=4 expenses=")
    assert today == head + "1 settlements=0 open=1 proofs=0 rev=1"
    assert with_client == head + "2 settlements=0 open=1 proofs=0 rev=2 client_id=yes"


def test_a11_the_logs_never_carry_the_id_the_note_or_a_name(on, dsn, caplog):
    caplog.set_level(logging.INFO, logger=LOGGER)
    x, xs = new_wallet(on)
    y, ys = new_wallet(on)
    eid = uuid4()
    body = with_id(equal(xs, amount=1000, note=NOTE), eid)
    add(on, x, body)  # A1
    add(on, x, body)  # A2
    delete(on, x, str(eid), version=1)
    add(on, x, body)  # A3
    other = uuid4()
    add(on, x, with_id(equal(xs, amount=1000, note=NOTE), other))
    add(on, y, with_id(equal(ys, amount=1000, note=NOTE), other))  # A4
    text = "\n".join(r.getMessage() for r in caplog.records if r.name == LOGGER)  # the request log's path is main's
    assert "replay" in text and "id_taken" in text
    for secret in (str(eid), eid.hex, str(other), other.hex, NOTE, *NAMES, *xs, *ys):
        assert secret not in text, secret


# ---------------------------------------------------------------- A12: the codes and the id's shape

def test_a12_id_taken_is_a_refusal_code_and_walletrefusal_is_unchanged():
    assert "id_taken" in models.REFUSALS
    assert models.WalletRefusal.model_fields["code"].annotation.__args__ == ("expense_changed", "expense_gone")


@pytest.mark.parametrize("bad", ["not-a-uuid", "", 7, None])
def test_a12_an_id_that_isnt_a_uuid_is_422(on, dsn, bad):
    slug, ids = new_wallet(on)
    r = add(on, slug, {**equal(ids, amount=1000), "id": bad})
    if bad is None:  # null is the same as leaving it out: today's add
        assert r.status_code == 201, r.text
        return
    assert r.status_code == 422, r.text
    assert count(dsn, slug) == 0
