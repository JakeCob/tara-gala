"""TG-62 GP1: a guide budget row's key through TG-61's editor and chat, and the loader (plan.md §3, G17 to G20).

The owner's plan file is the test plan, on a made-up trip in a throwaway database (test_plan_edit.py's fixtures). The
`keyed` fixture gives the shared plan G20's keys in the database itself, so these tests don't lean on the data file;
G20's own test checks the file. Line texts here are made up. Never the real trip.
"""

import copy
import json
import logging
import shutil

import psycopg
import pytest
from psycopg.types.json import Jsonb

from app import guide as guides
from test_guide import ITINERARY, SLUG, barkada, trip  # noqa: F401  fixtures
from test_plan_edit import base_of, editing, move, one, plan_of, save, stored, t, version_count  # noqa: F401
from test_plan_chat import ask, chat, op, say  # noqa: F401

import load_itinerary  # noqa: E402  (data/, on the path from test_guide)

G20 = [("meals", "food"), ("pasalubong", "other"), ("entrance", "activities"), ("taxis", "transport")]


def set_shared_budget(dsn, rows: list[dict]) -> None:
    """The shared plan's budget rows, written straight into the database (a stored plan, as the loader would)."""
    with psycopg.connect(dsn, autocommit=True) as conn:
        plan = conn.execute("select plan from itineraries where share_slug = %s", (SLUG,)).fetchone()[0]
        plan["guide"]["budget"]["rows"] = rows
        conn.execute("update itineraries set plan = %s where share_slug = %s", (Jsonb(plan), SLUG))


def shared_rows(dsn) -> list[dict]:
    return one(dsn, "select plan->'guide'->'budget'->'rows' as r from itineraries where share_slug = %s", SLUG)["r"]


@pytest.fixture()
def keyed(barkada):  # noqa: F811
    """The shared plan's four rows with G20's keys and categories, whatever the data file says."""
    rows = [{k: v for k, v in r.items() if k not in ("key", "category")} for r in shared_rows(barkada)]
    assert len(rows) == 4
    set_shared_budget(barkada, [r | {"key": k, "category": c} for r, (k, c) in zip(rows, G20, strict=True)])
    return barkada


@pytest.fixture()
def keyless(barkada):  # noqa: F811
    """The shared plan as stored before the backfill: no key, no category."""
    set_shared_budget(barkada, [{k: v for k, v in r.items() if k not in ("key", "category")} for r in shared_rows(barkada)])
    return barkada


def todays_web(guide_out: dict) -> dict:
    """What today's planEdit.toStored sends (before GP1): every budget row as {item, estimate} only."""
    g = stored(guide_out)
    g["budget"]["rows"] = [{"item": r["item"], "estimate": r["estimate"]} for r in g["budget"]["rows"]]
    return g


def budget(it_or_saved: dict) -> list[dict]:
    it = it_or_saved.get("itinerary", it_or_saved)
    return it["guide"]["budget"]["rows"]


def keys_cats(rows: list[dict]) -> list[tuple]:
    return [(r.get("key"), r.get("category")) for r in rows]


def stored_budget(dsn, trip_slug: str) -> list[dict]:
    return one(dsn, "select i.plan->'guide'->'budget'->'rows' as r from trip_sessions s join itineraries i on i.id = s.itinerary_id"
                    " where s.share_slug = %s", trip_slug)["r"]


def save_ok(client, slug, g, base=None, source="hand") -> dict:
    r = save(client, slug, g, base, source)
    assert r.status_code == 200, r.text
    return r.json()


# ---------------------------------------------------------------- S1 (tg-test's G0 audit): a category with no key

def test_a_row_with_a_category_and_no_key_keeps_its_category_on_a_dump():
    row = guides.BudgetRow.model_validate({"item": "E2E snacks", "estimate": "200", "category": "food"})
    assert row.model_dump() == {"item": "E2E snacks", "estimate": "200", "key": None, "category": "food"}
    assert row.model_dump(mode="json", exclude_none=True) == {"item": "E2E snacks", "estimate": "200", "category": "food"}
    g = guides.Budget.model_validate({"rows": [{"item": "E2E snacks", "estimate": "200", "category": "food"}]})
    assert g.model_dump(mode="json")["rows"] == [{"item": "E2E snacks", "estimate": "200", "key": None, "category": "food"}]


# ---------------------------------------------------------------- G17: slug_key and minting

@pytest.mark.parametrize("text, key", [
    ("Meals and merienda, 2.5 days", "meals-and-merienda-2"),  # the plan's own example
    ("Taxis", "taxis"),
    ("Taxis, split 4 per cab", "taxis-split-4-per-cab"),  # exactly 21
    ("Entrance fees (BenCab, Tam-awan, Yangbew)", "entrance-fees-bencab"),  # cut at a hyphen boundary
    ("Pasalubong and strawberries", "pasalubong-and"),
    ("  Gas -- and   tolls!! ", "gas-and-tolls"),  # every other run is one hyphen, none at either end
    ("Piña, ube & Café", "pina-ube-cafe"),  # lowercase ASCII
    ("2 taxis", "line-2-taxis"),  # doesn't start with a letter
    ("₱500 each", "line-500-each"),
    ("₱500", "line"),  # no letters at all
    ("!!!", "line"),
    ("🍓🍓", "line"),
    ("Supercalifragilisticexpialidocious", "supercalifragilistice"),  # one long word: cut at 21, no hyphen to cut at
    ("A", "line-a"),  # one letter is too short for the pattern
])
def test_slug_key(text, key):
    from app.budget_keys import slug_key

    assert slug_key(text) == key
    assert len(key) <= 21


@pytest.mark.parametrize("text", ["Meals and merienda, 2.5 days", "x", "Ñ", "a-", "-a", "9", "日本の旅", "Snacks " * 20, "a b c d e f g h i j k l",
                                  "Abcdefghijklmnopqrst-u", "Abcdefghijklmnopqrstu-v", "Line 2"])
def test_every_slug_key_fits_the_tables_pattern(text):
    import re

    from app.budget_keys import slug_key, unique_key

    assert re.fullmatch(guides.BUDGET_KEY, slug_key(text)), slug_key(text)
    taken = set()
    for _ in range(12):  # and with a clash suffix, up to -12
        k = unique_key(text, taken)
        assert re.fullmatch(guides.BUDGET_KEY, k) and k not in taken and not k.endswith("-"), k
        taken.add(k)


def test_a_clash_gets_2_then_3_and_stays_within_21():
    from app.budget_keys import unique_key

    assert unique_key("Taxis", set()) == "taxis"
    assert unique_key("Taxis", {"taxis"}) == "taxis-2"
    assert unique_key("Taxis", {"taxis", "taxis-2"}) == "taxis-3"
    assert unique_key("Taxis, split 4 per cab", {"taxis-split-4-per-cab"}) == "taxis-split-4-per-2"
    assert unique_key("Supercalifragilisticexpialidocious", {"supercalifragilistice"}) == "supercalifragilisti-2"
    assert unique_key("₱500", {"line"}) == "line-2"


def test_mint_keys_gives_each_keyless_row_one_and_skips_the_rest():
    from app.budget_keys import mint_keys

    rows = [{"item": "Taxis", "estimate": "1"}, {"item": "E2E meals", "estimate": "2", "key": "meals"},
            {"item": "Taxis", "estimate": "3", "category": "transport"}, {"item": "Meals", "estimate": "4", "key": None}]
    assert mint_keys(rows, {"taxis"}) == 3
    assert [r["key"] for r in rows] == ["taxis-2", "meals", "taxis-3", "meals-2"], "never a key taken, or one already in the rows"
    assert rows[2]["category"] == "transport"


# ---------------------------------------------------------------- G18a: inherit, pure

def test_inherit_claims_keys_then_matches_text_in_order_then_leaves_the_rest():
    from app.budget_keys import inherit

    base = [{"item": "Snacks", "estimate": "1", "key": "snacks", "category": "food"},
            {"item": "Snacks", "estimate": "2", "key": "snacks-2", "category": "other"},
            {"item": "Taxis", "estimate": "3", "key": "taxis", "category": "transport"},
            {"item": "Gas", "estimate": "4", "key": "gas", "category": "transport"}]
    rows_in = [{"item": "Gas money", "estimate": "4", "key": "gas"},  # step 1: claims gas, takes its category
               {"item": "Snacks", "estimate": "1"}, {"item": "Snacks", "estimate": "2"},  # step 2: in order
               {"item": "Taxis", "estimate": "3", "key": "taxis", "category": "other"},  # step 1: its own category stays
               {"item": "Taxis", "estimate": "5"},  # taxis is claimed already: nothing to inherit
               {"item": "Gas", "estimate": "6"}]  # gas is claimed by the renamed row
    out = inherit(rows_in, base)
    assert keys_cats(out) == [("gas", "transport"), ("snacks", "food"), ("snacks-2", "other"), ("taxis", "other"), (None, None), (None, None)]
    assert [r["item"] for r in out] == [r["item"] for r in rows_in] and [r["estimate"] for r in out] == [r["estimate"] for r in rows_in]
    assert rows_in[1] == {"item": "Snacks", "estimate": "1"}, "the input isn't changed"


def test_inherit_by_text_keeps_a_category_the_row_brings():  # GP1's call: a non-null category is the client's (G19)
    from app.budget_keys import inherit

    base = [{"item": "Snacks", "estimate": "1", "key": "snacks", "category": "food"}]
    assert keys_cats(inherit([{"item": "Snacks", "estimate": "1", "category": "other"}], base)) == [("snacks", "other")]


def test_inherit_ignores_keyless_base_rows():  # a plan from before the backfill has nothing to inherit
    from app.budget_keys import inherit

    out = inherit([{"item": "Snacks", "estimate": "1"}], [{"item": "Snacks", "estimate": "1"}])
    assert keys_cats(out) == [(None, None)]


# ---------------------------------------------------------------- G18: TG-61's editor

def test_a_new_row_goes_up_keyless_and_comes_back_minted(t, client, keyed):
    g = stored(plan_of(client, t)["guide"])
    g["budget"]["rows"].append({"item": "E2E gas and tolls", "estimate": "300", "category": "transport"})
    saved = save_ok(client, t, g)
    assert keys_cats(budget(saved)) == G20 + [("e2e-gas-and-tolls", "transport")]
    assert keys_cats(stored_budget(keyed, t)) == G20 + [("e2e-gas-and-tolls", "transport")]
    assert keys_cats(budget(plan_of(client, t))) == G20 + [("e2e-gas-and-tolls", "transport")], "the trip's GET reads it back"


def test_a_new_row_with_a_null_key_is_minted_too(t, client, keyed):
    g = stored(plan_of(client, t)["guide"])
    g["budget"]["rows"].append({"item": "E2E snacks", "estimate": "200", "key": None, "category": "food"})
    assert keys_cats(budget(save_ok(client, t, g)))[-1] == ("e2e-snacks", "food")


def test_a_new_row_with_no_category_is_minted_and_listed_under_other(t, client, keyed):  # a chat line, or an old phone's
    g = stored(plan_of(client, t)["guide"])
    g["budget"]["rows"].append({"item": "E2E snacks", "estimate": "200"})
    row = budget(save_ok(client, t, g))[-1]
    assert row["key"] == "e2e-snacks" and row.get("category") is None


def test_a_new_row_whose_slug_is_taken_gets_the_next_one(t, client, keyed):
    g = stored(plan_of(client, t)["guide"])
    g["budget"]["rows"] += [{"item": "Meals", "estimate": "1"}, {"item": "meals!", "estimate": "2"}]
    assert [r["key"] for r in budget(save_ok(client, t, g))][4:] == ["meals-2", "meals-3"]


def test_a_renamed_row_keeps_its_key_and_category(t, client, keyed):
    g = stored(plan_of(client, t)["guide"])
    g["budget"]["rows"][0] |= {"item": "E2E food, all of it", "estimate": "2,000"}
    rows = budget(save_ok(client, t, g))
    assert keys_cats(rows) == G20
    assert rows[0]["item"] == "E2E food, all of it"


def test_a_recategorised_row_keeps_its_key(t, client, keyed):
    g = stored(plan_of(client, t)["guide"])
    g["budget"]["rows"][1]["category"] = "food"
    assert keys_cats(budget(save_ok(client, t, g)))[1] == ("pasalubong", "food")


def test_a_key_the_base_doesnt_have_is_refused_and_nothing_is_written(t, client, keyed):
    it = plan_of(client, t)
    g = stored(it["guide"])
    g["budget"]["rows"].append({"item": "E2E made up", "estimate": "1", "key": "made-up", "category": "food"})
    n = version_count(keyed)
    r = save(client, t, g, base_of(it))
    assert r.status_code == 422 and r.json()["detail"] == "unknown_key"
    assert version_count(keyed) == n
    assert keys_cats(budget(plan_of(client, t))) == G20


def test_a_removed_rows_key_is_never_minted_again(t, client, keyed):
    g = stored(plan_of(client, t)["guide"])
    g["budget"]["rows"] = [r for r in g["budget"]["rows"] if r["key"] != "taxis"]
    save_ok(client, t, g)
    it = plan_of(client, t)
    g = stored(it["guide"])
    gone = copy.deepcopy(g)
    g["budget"]["rows"].append({"item": "Taxis", "estimate": "400", "category": "transport"})
    assert keys_cats(budget(save_ok(client, t, g, base_of(it))))[-1] == ("taxis-2", "transport")
    # and a client can't bring the old key back
    gone["budget"]["rows"].append({"item": "Taxis", "estimate": "400", "key": "taxis", "category": "transport"})
    r = save(client, t, gone)
    assert r.status_code == 422 and r.json()["detail"] == "unknown_key"


def test_a_key_from_an_older_version_only_is_still_taken(t, client, keyed):
    g = stored(plan_of(client, t)["guide"])
    g["budget"]["rows"].append({"item": "E2E snacks", "estimate": "200", "category": "food"})
    save_ok(client, t, g)  # e2e-snacks
    g = stored(plan_of(client, t)["guide"])
    g["budget"]["rows"] = [r for r in g["budget"]["rows"] if r["key"] != "e2e-snacks"]
    save_ok(client, t, g)
    g = stored(plan_of(client, t)["guide"])
    g["title"] = "E2E a later save"
    save_ok(client, t, g)  # e2e-snacks is now two versions back
    g = stored(plan_of(client, t)["guide"])
    g["budget"]["rows"].append({"item": "E2E snacks", "estimate": "250", "category": "food"})
    assert budget(save_ok(client, t, g))[-1]["key"] == "e2e-snacks-2"


def test_a_replayed_save_with_a_new_row_answers_the_same_save(t, client, keyed):  # TG-61's F2, with a minted line
    it = plan_of(client, t)
    g, base = stored(it["guide"]), base_of(it)
    g["budget"]["rows"].append({"item": "E2E snacks", "estimate": "200", "category": "food"})
    first = save(client, t, g, base)
    assert first.status_code == 200, first.text
    n = version_count(keyed)
    again = save(client, t, g, base)  # Chrome's resend: the same bytes, the new row still keyless
    assert again.status_code == 200, again.text
    assert again.json() == first.json()
    assert version_count(keyed) == n


def test_the_save_log_counts_budget_keys_and_never_names_them(t, client, keyed, caplog):
    caplog.set_level(logging.INFO)
    it = plan_of(client, t)
    g = todays_web(it["guide"])
    g["budget"]["rows"].append({"item": "E2E Zyxwvut's dinner", "estimate": "900"})
    save_ok(client, t, g, base_of(it))
    line = next(r.getMessage() for r in caplog.records if r.getMessage().startswith("plan save share_slug="))
    assert "budget_minted=1" in line and "budget_by_text=4" in line, line
    assert not any(w in caplog.text.lower() for w in ("zyxwvut", "e2e-zyxwvut", "meals", "pasalubong", "entrance", "taxis"))


# ---------------------------------------------------------------- G18a: today's web, which drops keys on every save

def test_todays_web_after_a_stop_move_keeps_every_key_and_category_and_writes_no_budget_line(t, client, keyed):
    it = plan_of(client, t)
    g = todays_web(it["guide"])
    assert all(set(r) == {"item", "estimate"} for r in g["budget"]["rows"])
    move(g, "d1-03", 2)
    saved = save_ok(client, t, g, base_of(it))
    assert keys_cats(budget(saved)) == G20
    assert keys_cats(stored_budget(keyed, t)) == G20
    assert not [c for c in saved["changes"] if c["word"] == "Budget"], saved["changes"]


def test_todays_web_with_two_rows_of_the_same_text_matches_them_in_order(t, client, keyed):
    g = stored(plan_of(client, t)["guide"])
    g["budget"]["rows"] += [{"item": "E2E snacks", "estimate": "100", "category": "food"},
                            {"item": "E2E snacks", "estimate": "200", "category": "other"}]
    assert keys_cats(budget(save_ok(client, t, g)))[4:] == [("e2e-snacks", "food"), ("e2e-snacks-2", "other")]
    it = plan_of(client, t)
    g = todays_web(it["guide"])
    move(g, "d1-03", 2)
    rows = budget(save_ok(client, t, g, base_of(it)))
    assert keys_cats(rows) == G20 + [("e2e-snacks", "food"), ("e2e-snacks-2", "other")]
    assert [r["estimate"] for r in rows][4:] == ["100", "200"]


def test_todays_web_renaming_a_row_mints_a_new_key(t, client, keyed):  # plan §8: the accepted gap
    it = plan_of(client, t)
    g = todays_web(it["guide"])
    g["budget"]["rows"][3]["item"] = "E2E cabs"
    rows = budget(save_ok(client, t, g, base_of(it)))
    assert keys_cats(rows) == G20[:3] + [("e2e-cabs", None)]


def test_a_known_key_with_no_category_takes_the_bases(t, client, keyed):  # G18a step 1
    it = plan_of(client, t)
    g = stored(it["guide"])
    for r in g["budget"]["rows"]:
        r.pop("category")
    move(g, "d1-03", 2)
    assert keys_cats(budget(save_ok(client, t, g, base_of(it)))) == G20


def test_a_plan_from_before_the_backfill_gets_a_key_on_every_row_and_keeps_them(t, client, keyless):
    it = plan_of(client, t)
    g = todays_web(it["guide"])
    move(g, "d1-03", 2)
    first = keys_cats(budget(save_ok(client, t, g, base_of(it))))
    assert first == [("meals-and-merienda-2", None), ("pasalubong-and", None), ("entrance-fees-bencab", None), ("taxis-split-4-per-cab", None)]
    it = plan_of(client, t)
    g = todays_web(it["guide"])
    move(g, "d2-03", 1)
    assert keys_cats(budget(save_ok(client, t, g, base_of(it)))) == first, "the next old-web save inherits them by text"


# ---------------------------------------------------------------- G19: TG-61's chat, set_budget

def test_the_set_budget_schema_asks_for_key_and_category():
    from app import plan_ops

    items = plan_ops.REPLY_SCHEMA["properties"]["ops"]["items"]["properties"]["budget_rows"]["items"]
    assert set(items["properties"]) == {"item", "estimate", "key", "category"}
    assert set(items["required"]) == {"item", "estimate", "key", "category"} and items["additionalProperties"] is False
    assert items["properties"]["key"]["type"] == ["string", "null"] and items["properties"]["category"]["type"] == ["string", "null"]
    assert "null for a new row" in items["properties"]["key"]["description"]
    assert "null keeps the row's category" in items["properties"]["category"]["description"]
    for word in ("transport", "hotel", "food", "activities", "other"):
        assert word in items["properties"]["category"]["description"]


def rows_for_chat(it: dict, **changes) -> list[dict]:
    """Every row as the model would send it: key kept, category null, with `changes` by key."""
    return [{"item": r["item"], "estimate": r["estimate"], "key": r["key"], "category": None} | changes.get(r["key"], {})
            for r in budget(it)]


def test_set_budget_drops_a_made_up_key_and_keeps_known_ones():  # pure: plan_ops.apply
    from app import plan_ops

    g = guides.Guide.model_validate({
        "title": "T", "getting_there": {"title": "Out", "buses": []}, "getting_home": {"title": "Back", "buses": []},
        "days": [{"day": 1, "title": "D1", "rows": [{"key": "d1-01", "time": "09:00", "plan": "x"}]}],
        "budget": {"rows": [{"item": "E2E meals", "estimate": "1", "key": "meals", "category": "food"}]},
    })
    o = plan_ops.Op.model_validate(op("set_budget", budget_rows=[
        {"item": "E2E meals", "estimate": "2", "key": "meals", "category": None},
        {"item": "E2E new", "estimate": "3", "key": "groceries", "category": "food"},
        {"item": "E2E odd", "estimate": "4", "key": "Not A Key!", "category": None}]))
    out, codes = plan_ops.apply(g, [o])
    assert codes == []
    assert out["budget"]["rows"] == [{"item": "E2E meals", "estimate": "2", "key": "meals", "category": None},
                                     {"item": "E2E new", "estimate": "3", "key": None, "category": "food"},
                                     {"item": "E2E odd", "estimate": "4"}]


def test_renaming_the_meals_line_through_the_chat_keeps_meals_and_food(chat, t, client, keyed):
    it = plan_of(client, t)
    chat.script(say("Pinalitan ko ang pangalan ng meals line.",
                    [op("set_budget", budget_rows=rows_for_chat(it, meals={"item": "E2E food and drinks"}))]))
    r = ask(client, t, "rename the meals line")
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["outcome"] == "proposal", out
    assert len(chat.llm.calls) == 1, "no retry"
    assert keys_cats(out["proposal"]["guide"]["budget"]["rows"]) == G20, "every row keeps its key and category"
    p = out["proposal"]
    saved = save_ok(client, t, p["stored"], p["base"], source="chat")  # Apply
    assert keys_cats(budget(saved)) == G20 and budget(saved)[0]["item"] == "E2E food and drinks"


def test_a_chat_reply_with_every_category_null_keeps_every_category(chat, t, client, keyed):
    it = plan_of(client, t)
    chat.script(say("Tinaasan ko ang taxis.", [op("set_budget", budget_rows=rows_for_chat(it, taxis={"estimate": "500 to 700"}))]))
    out = ask(client, t, "taxis cost more").json()
    assert out["outcome"] == "proposal", out
    assert keys_cats(out["proposal"]["guide"]["budget"]["rows"]) == G20


def test_a_chat_category_that_isnt_null_is_the_rows_new_category(chat, t, client, keyed):
    it = plan_of(client, t)
    chat.script(say("Inilagay ko sa food.", [op("set_budget", budget_rows=rows_for_chat(it, pasalubong={"category": "food"}))]))
    out = ask(client, t, "pasalubong is food").json()
    assert out["outcome"] == "proposal", out
    assert keys_cats(out["proposal"]["guide"]["budget"]["rows"])[1] == ("pasalubong", "food")


def test_a_key_the_model_made_up_is_minted_instead_of_refusing_the_proposal(chat, t, client, keyed):
    it = plan_of(client, t)
    rows = rows_for_chat(it) + [{"item": "E2E gas and tolls", "estimate": "300", "key": "gas", "category": "transport"},
                                {"item": "E2E parking", "estimate": "100", "key": "Parking!!", "category": None}]
    chat.script(say("Dinagdag ko ang gas.", [op("set_budget", budget_rows=rows)]))
    out = ask(client, t, "add gas and parking").json()
    assert out["outcome"] == "proposal", out
    assert len(chat.llm.calls) == 1, "not retried for unknown_key"
    assert keys_cats(out["proposal"]["guide"]["budget"]["rows"]) == G20 + [("e2e-gas-and-tolls", "transport"), ("e2e-parking", None)]


def test_a_chat_reply_naming_a_removed_key_mints_a_new_one(chat, t, client, keyed):
    g = stored(plan_of(client, t)["guide"])
    g["budget"]["rows"] = [r for r in g["budget"]["rows"] if r["key"] != "taxis"]
    save_ok(client, t, g)
    it = plan_of(client, t)
    rows = rows_for_chat(it) + [{"item": "Taxis", "estimate": "400", "key": "taxis", "category": "transport"}]
    chat.script(say("Binalik ko ang taxis.", [op("set_budget", budget_rows=rows)]))
    out = ask(client, t, "bring back taxis").json()
    assert out["outcome"] == "proposal", out
    assert keys_cats(out["proposal"]["guide"]["budget"]["rows"])[-1] == ("taxis-2", "transport")


# ---------------------------------------------------------------- G20: the data file and the loader

def test_the_owners_data_file_has_g20s_keys_and_categories():
    rows = json.loads(ITINERARY.read_text(encoding="utf-8"))["guide"]["budget"]["rows"]
    assert keys_cats(rows) == G20
    assert [r["item"] for r in rows] == ["Meals and merienda, 2.5 days", "Pasalubong and strawberries",
                                         "Entrance fees (BenCab, Tam-awan, Yangbew)", "Taxis, split 4 per cab"], "the texts are unchanged"


def test_the_loaded_plan_carries_the_keys(barkada, client):  # noqa: F811
    assert keys_cats(shared_rows(barkada)) == G20
    assert keys_cats(budget(client.get(f"/itineraries/{SLUG}").json())) == G20


@pytest.mark.parametrize("drop", ["key", "category"])
def test_the_loader_refuses_a_curated_row_without_a_key_or_a_category(barkada, tmp_path, capsys, drop):  # noqa: F811
    raw = json.loads(ITINERARY.read_text(encoding="utf-8"))
    raw["guide"]["budget"]["rows"][2].pop(drop, None)
    raw["share_slug"] = "e2e-curated-check"
    bad = tmp_path / "e2e-curated-check.json"
    bad.write_text(json.dumps(raw), encoding="utf-8")
    capsys.readouterr()
    assert load_itinerary.run(barkada, bad, dry_run=False) == 1
    err = capsys.readouterr().err
    assert f"guide.budget.rows.2: a curated budget row needs a {drop}" in err, err
    assert one(barkada, "select count(*) as n from itineraries where share_slug = 'e2e-curated-check'")["n"] == 0


def test_the_loader_takes_the_keyed_file(barkada, tmp_path, capsys):  # noqa: F811
    good = tmp_path / "copy.json"
    shutil.copy(ITINERARY, good)
    assert load_itinerary.run(barkada, good, dry_run=True) == 0
