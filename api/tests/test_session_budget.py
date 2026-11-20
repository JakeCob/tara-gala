"""TG-62 GA2: the trip page's Budget panel, `GET /sessions/{slug}/budget` (plan §2 SessionBudgetOut; §3 G12 to G16).

- The lines are the trip's own plan's keyed budget rows, in plan order, each with what the trip's wallet spent on it.
- `state`: no_wallet, two_trips (the wallet is on another trip too), no_budget (no plan, guide or keyed rows), or ok.
  `member_count` and `total_centavos` whenever there's a wallet; lines, not_in_budget, unsorted and members only on ok.
- Behind BUDGET_LINES (404 feature_off while it's off). A bad or unknown slug is TG-58's 404.
- Logs: state and counts only, never a name, note, line text, line key, member id or amount (N2).
Made-up trips, wallets and lines only.
"""

import json
import logging
import re
from datetime import date

import pytest

from test_wallets_v2 import (  # noqa: F401  fixtures: flags and the autouse fresh_limiters
    NAMES,
    add,
    equal,
    exact,
    flags,
    fresh_limiters,
    new_wallet,
    sql,
)

BIRTHDAY = "Ana's birthday dinner"
ROWS = [
    {"item": "Meals", "estimate": "1,500 to 2,200", "key": "meals", "category": "food"},
    {"item": "Van to La Trinidad", "estimate": "350", "key": "van", "category": "transport"},
    {"item": "Pasalubong", "estimate": "depends"},  # no key: not a line
    {"item": "Tips", "estimate": "free", "key": "tips"},  # no category: other; unreadable
    {"item": BIRTHDAY, "estimate": "₱300 - 500", "key": "ana-s-birthday-dinner", "category": "food"},
]
HEADERS = {"cache-control": "private, no-cache", "x-robots-tag": "noindex"}
NOTE = "Dinner at TESTPLACE"


@pytest.fixture
def on(client, flags):
    """WALLET_SPLITS (to add expenses with a line) and BUDGET_LINES on."""
    flags(wallet_splits=True, budget_lines=True)
    return client


def guide_of(rows):
    """The smallest valid guide (the panel reads the trip's guide as trip_marks does), with these budget rows."""
    return {"title": "Test trip", "getting_there": {"title": "There", "buses": []},
            "days": [{"day": 1, "title": "Day 1", "rows": []}], "getting_home": {"title": "Home", "buses": []},
            "budget": {"summary": "", "rows": rows, "excluded": ""}}


def guide_plan(rows):
    return {"guide": guide_of(rows)}


def trip(dsn, wallet_slug=None, rows=ROWS, name="Baguio test trip", plan=None, itinerary=True):
    """A made-up trip, with this wallet and a plan whose guide has these budget rows. Returns (trip slug, itinerary id)."""
    itinerary_id = None
    if itinerary:
        body = plan if plan is not None else guide_plan(rows)
        itinerary_id = sql(dsn, """insert into itineraries (trip_date, return_date, party, plan, model)
                                   values ('2026-11-06', '2026-11-08', '[]', %s, 'trip-edit') returning id""",
                           (json.dumps(body),))[0]["id"]
    wallet_id = sql(dsn, "select id from wallets where share_slug = %s", (wallet_slug,))[0]["id"] if wallet_slug else None
    slug = sql(dsn, """insert into trip_sessions (name, start_date, return_date, itinerary_id, wallet_id)
                       values (%s, %s, %s, %s, %s) returning share_slug""",
               (name, date(2026, 11, 6), date(2026, 11, 8), itinerary_id, wallet_id))[0]["share_slug"]
    return slug, itinerary_id


def set_rows(dsn, itinerary_id, rows):
    sql(dsn, "update itineraries set plan = %s where id = %s", (json.dumps(guide_plan(rows)), itinerary_id))


def budget(client, slug):
    return client.get(f"/sessions/{slug}/budget")


def spend(client, dsn):
    """The G13/G14 trip: 4 people and six made-up expenses, one on a line the plan then removes.

    meals 1000 (equal, 4) and 2000 (Ana and Ben); van 1002 (Ana 500, Ben 502); _none 500 (Ana);
    null 700 (Ben 300, Carla 400); ana-s-birthday-dinner 300 (Dan), whose row is then removed. Total 5502.
    """
    wallet, (a, b, c, d) = new_wallet(client)
    slug, itinerary_id = trip(dsn, wallet)
    for body in (equal([a, b, c, d], amount=1000, category="food", budget_key="meals", note=NOTE),
                 equal([a, b], amount=2000, category="food", budget_key="meals", note=NOTE),
                 exact([(a, 500), (b, 502)], a, category="transport", budget_key="van", note=NOTE),
                 exact([(a, 500)], a, category="food", budget_key="_none", note=NOTE),
                 exact([(b, 300), (c, 400)], b, category="food", note=NOTE),
                 exact([(d, 300)], d, category="food", budget_key="ana-s-birthday-dinner", note=NOTE)):
        r = add(client, wallet, body)
        assert r.status_code == 201, r.text
    set_rows(dsn, itinerary_id, [r for r in ROWS if r.get("key") != "ana-s-birthday-dinner"])
    return slug, wallet, (a, b, c, d)


# ---------------------------------------------------------------- G12: the states

def test_g12_ok_is_the_whole_answer(on, dsn):
    slug, _, (a, b, c, d) = spend(on, dsn)
    r = budget(on, slug)
    assert r.status_code == 200, r.text
    assert r.json() == {
        "state": "ok",
        "member_count": 4,
        "total_centavos": 5502,
        "lines": [
            {"key": "meals", "item": "Meals", "estimate": "1,500 to 2,200", "min": 1500, "max": 2200, "readable": True,
             "spent": 3000, "spent_each": 750},
            {"key": "van", "item": "Van to La Trinidad", "estimate": "350", "min": 350, "max": 350, "readable": True,
             "spent": 1002, "spent_each": 251},  # 250.5 rounds half up
            {"key": "tips", "item": "Tips", "estimate": "free", "min": None, "max": None, "readable": False,
             "spent": 0, "spent_each": 0},
        ],
        "not_in_budget": {"count": 1, "spent": 500},
        "unsorted": {"count": 2, "spent": 1000, "removed": 1},
        "members": [
            {"member_id": a, "name": NAMES[0], "share_lines": 1750, "share_total": 2250},
            {"member_id": b, "name": NAMES[1], "share_lines": 1752, "share_total": 2052},
            {"member_id": c, "name": NAMES[2], "share_lines": 250, "share_total": 650},
            {"member_id": d, "name": NAMES[3], "share_lines": 250, "share_total": 550},
        ],
    }


def test_g12_no_wallet(on, dsn):
    slug, _ = trip(dsn)
    r = budget(on, slug)
    assert r.status_code == 200, r.text
    assert r.json() == {"state": "no_wallet", "member_count": 0, "total_centavos": 0, "lines": [],
                        "not_in_budget": None, "unsorted": None, "members": []}


def test_g12_two_trips_counts_the_wallet_but_shows_no_lines(on, dsn):
    wallet, (a, b, *_) = new_wallet(on, n=3)
    slug, _ = trip(dsn, wallet)
    assert add(on, wallet, equal([a, b], amount=1200, category="food", budget_key="meals")).status_code == 201
    other, _ = trip(dsn, wallet, name="Another trip")
    for s in (slug, other):
        r = budget(on, s)
        assert r.status_code == 200, r.text
        assert r.json() == {"state": "two_trips", "member_count": 3, "total_centavos": 1200, "lines": [],
                            "not_in_budget": None, "unsorted": None, "members": []}


@pytest.mark.parametrize("case", ["no itinerary", "no guide", "no rows", "keyless rows", "unreadable guide"])
def test_g12_no_budget_counts_the_wallet_but_shows_no_lines(on, dsn, case):
    wallet, (a, b, *_) = new_wallet(on, n=2)
    assert add(on, wallet, equal([a, b], amount=800)).status_code == 201
    kw = {
        "no itinerary": {"itinerary": False},
        "no guide": {"plan": {"days": []}},
        "no rows": {"rows": []},
        "keyless rows": {"rows": [{k: v for k, v in r.items() if k not in ("key", "category")} for r in ROWS]},
        "unreadable guide": {"plan": {"guide": {**guide_of(ROWS), "budget": "not a budget"}}},
    }[case]
    slug, _ = trip(dsn, wallet, **kw)
    r = budget(on, slug)
    assert r.status_code == 200, r.text
    assert r.json() == {"state": "no_budget", "member_count": 2, "total_centavos": 800, "lines": [],
                        "not_in_budget": None, "unsorted": None, "members": []}


def test_g12_two_trips_comes_before_no_budget(on, dsn):
    wallet, _ = new_wallet(on, n=2)
    slug, _ = trip(dsn, wallet, rows=[])
    trip(dsn, wallet, name="Another trip")
    assert budget(on, slug).json()["state"] == "two_trips"


def test_g12_ok_with_nothing_spent(on, dsn):
    wallet, (a, b) = new_wallet(on, n=2)
    slug, _ = trip(dsn, wallet)
    body = budget(on, slug).json()
    assert body["state"] == "ok" and (body["member_count"], body["total_centavos"]) == (2, 0)
    assert [(x["key"], x["spent"], x["spent_each"]) for x in body["lines"]] == [
        ("meals", 0, 0), ("van", 0, 0), ("tips", 0, 0), ("ana-s-birthday-dinner", 0, 0)]
    assert body["not_in_budget"] == {"count": 0, "spent": 0}
    assert body["unsorted"] == {"count": 0, "spent": 0, "removed": 0}
    assert body["members"] == [{"member_id": a, "name": NAMES[0], "share_lines": 0, "share_total": 0},
                               {"member_id": b, "name": NAMES[1], "share_lines": 0, "share_total": 0}]


def test_g12_the_lines_follow_the_trips_own_plan(on, dsn):
    """A rename, a move and a new row in the trip's plan show on the next read; the spend stays with the key."""
    wallet, (a, b) = new_wallet(on, n=2)
    slug, itinerary_id = trip(dsn, wallet)
    assert add(on, wallet, equal([a, b], amount=600, category="food", budget_key="meals")).status_code == 201
    set_rows(dsn, itinerary_id, [{"item": "Gas", "estimate": "800", "key": "gas", "category": "transport"},
                                 {**ROWS[0], "item": "Meals and merienda", "estimate": "2,000"}])
    lines = budget(on, slug).json()["lines"]
    assert [(x["key"], x["item"], x["min"], x["spent"]) for x in lines] == [
        ("gas", "Gas", 800, 0), ("meals", "Meals and merienda", 2000, 600)]


# ---------------------------------------------------------------- G13: the sums

def test_g13_every_centavo_is_counted_once(on, dsn):
    slug, _, _ = spend(on, dsn)
    body = budget(on, slug).json()
    lines = sum(x["spent"] for x in body["lines"])
    assert lines + body["not_in_budget"]["spent"] + body["unsorted"]["spent"] == body["total_centavos"] == 5502


def test_g13_a_removed_line_comes_back_with_its_spend(on, dsn):
    wallet, (a, b) = new_wallet(on, n=2)
    slug, itinerary_id = trip(dsn, wallet)
    assert add(on, wallet, equal([a, b], amount=900, category="transport", budget_key="van")).status_code == 201
    set_rows(dsn, itinerary_id, [r for r in ROWS if r.get("key") != "van"])
    body = budget(on, slug).json()
    assert body["unsorted"] == {"count": 1, "spent": 900, "removed": 1}
    assert "van" not in [x["key"] for x in body["lines"]]
    set_rows(dsn, itinerary_id, ROWS)
    body = budget(on, slug).json()
    assert body["unsorted"] == {"count": 0, "spent": 0, "removed": 0}
    assert [x["spent"] for x in body["lines"] if x["key"] == "van"] == [900]


@pytest.mark.parametrize("people, amount, each", [(2, 1001, 501), (3, 1000, 333), (3, 2000, 667), (4, 1002, 251),
                                                  (4, 1001, 250), (1, 999, 999)])
def test_g13_spent_each_is_spent_over_the_members_half_rounding_up(on, dsn, people, amount, each):
    """Over every member of the wallet, not only the people on the expense."""
    wallet, ids = new_wallet(on, n=people)
    slug, _ = trip(dsn, wallet)
    assert add(on, wallet, exact([(ids[0], amount)], ids[0], category="food", budget_key="meals")).status_code == 201
    line = budget(on, slug).json()["lines"][0]
    assert (line["key"], line["spent"], line["spent_each"]) == ("meals", amount, each)


# ---------------------------------------------------------------- G14: members

def test_g14_each_members_shares_add_up(on, dsn):
    slug, _, _ = spend(on, dsn)
    body = budget(on, slug).json()
    assert sum(m["share_total"] for m in body["members"]) == body["total_centavos"]
    assert sum(m["share_lines"] for m in body["members"]) == sum(x["spent"] for x in body["lines"])
    other = {m["name"]: m["share_total"] - m["share_lines"] for m in body["members"]}
    assert other == {NAMES[0]: 500, NAMES[1]: 300, NAMES[2]: 400, NAMES[3]: 300}, "_none, null and the removed line"


def test_g14_a_member_with_no_shares_is_listed_in_wallet_order(on, dsn):
    wallet, (a, b, c) = new_wallet(on, n=3)
    slug, _ = trip(dsn, wallet)
    assert add(on, wallet, exact([(c, 400)], c, category="food", budget_key="meals")).status_code == 201
    members = budget(on, slug).json()["members"]
    assert [(m["member_id"], m["share_lines"], m["share_total"]) for m in members] == [(a, 0, 0), (b, 0, 0), (c, 400, 400)]


# ---------------------------------------------------------------- G15: headers, 404s and the flag

@pytest.mark.parametrize("which", ["ok", "no_wallet"])
def test_g15_private_and_noindex(on, dsn, which):
    if which == "ok":
        slug, _, _ = spend(on, dsn)
    else:
        slug, _ = trip(dsn)
    r = budget(on, slug)
    assert r.status_code == 200 and r.json()["state"] == which
    assert {k: r.headers.get(k) for k in HEADERS} == HEADERS


@pytest.mark.parametrize("slug", ["nope", "0" * 32, "A" * 32])
def test_g15_a_bad_or_unknown_slug_is_tg58s_404(on, dsn, slug):
    r = budget(on, slug)
    assert (r.status_code, r.json()["detail"]) == (404, "Trip not found")
    assert r.json() == on.get(f"/sessions/{slug}").json()
    assert r.headers.get("x-robots-tag") == "noindex"


def test_g15_the_flag_off_is_404_feature_off(client, flags, dsn):
    flags(wallet_splits=True, budget_lines=True)
    slug, _, _ = spend(client, dsn)
    flags(wallet_splits=True)
    for s in (slug, "0" * 32, "nope"):
        r = budget(client, s)
        assert (r.status_code, r.json()["detail"]) == (404, "feature_off"), s
    assert client.get(f"/sessions/{slug}").status_code == 200, "the trip itself is unchanged"


# ---------------------------------------------------------------- G16: logs

def test_g16_the_log_says_state_and_counts_only(on, dsn, caplog):
    caplog.set_level(logging.DEBUG)
    slug, wallet, ids = spend(on, dsn)
    caplog.clear()
    assert budget(on, slug).status_code == 200
    lines = [r.getMessage() for r in caplog.records if r.name.startswith("tara_gala")]
    text = "\n".join(lines).replace(slug, "<slug>")  # a random hex slug may hold any digits
    secrets = (*NAMES, NOTE, "TESTPLACE", BIRTHDAY, "birthday", "ana-s-birthday-dinner", "meals", "Meals", "van", "Van",
               "tips", "Tips", "Pasalubong", "La Trinidad", wallet, "5502", "1002", "3000", *ids)
    for secret in secrets:
        assert secret not in text, secret
    assert f"session budget share_slug={slug} state=ok lines=3 unreadable=1 unsorted=2" in lines


@pytest.mark.parametrize("which", ["no_wallet", "two_trips", "no_budget"])
def test_g16_every_state_logs_its_line(on, dsn, caplog, which):
    caplog.set_level(logging.DEBUG)
    if which == "no_wallet":
        slug, _ = trip(dsn)
    else:
        wallet, _ = new_wallet(on, n=2)
        slug, _ = trip(dsn, wallet, rows=[] if which == "no_budget" else ROWS)
        if which == "two_trips":
            trip(dsn, wallet, name="Another trip")
    caplog.clear()
    assert budget(on, slug).json()["state"] == which
    lines = [r.getMessage() for r in caplog.records if r.name.startswith("tara_gala")]
    assert f"session budget share_slug={slug} state={which} lines=0 unreadable=0 unsorted=0" in lines


def test_g16_the_flag_off_logs_the_refusal_without_the_trip(client, flags, dsn, caplog):
    caplog.set_level(logging.DEBUG)
    slug, _ = trip(dsn)
    caplog.clear()
    assert budget(client, slug).status_code == 404
    lines = [r.getMessage() for r in caplog.records if r.name.startswith("tara_gala")]
    assert any(re.search(r"^session budget refused share_slug=\S+ reason=feature_off$", x) for x in lines), lines


# ---------------------------------------------------------------- §1: main.py's block

def test_main_py_has_one_commented_block_after_tg64s():
    from pathlib import Path

    text = (Path(__file__).resolve().parents[1] / "app" / "main.py").read_text(encoding="utf-8")
    tg64 = text.index("# TG-64: the read-only recap link")
    ours = text.index("# TG-62: budget vs actual, behind BUDGET_LINES")
    assert tg64 < ours and text.count("# TG-62: budget vs actual") == 1
    assert "session_budget" in text[ours:]
