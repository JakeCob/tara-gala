"""TG-62 G0: a guide budget row's key and category (plan §2, G2; owner-approved shapes 2026-11-16).

The key is optional on read: plans stored before the backfill have none, and `_M` forbids extra fields, so a tolerant
read comes first. The loader (GP1) is the strict place. Pure: no database, but conftest skips without TEST_DATABASE_URL.
"""

import copy
import json
import uuid

import pytest
from pydantic import ValidationError

from app import guide as guides
from test_guide import ITINERARY, SLUG, barkada  # noqa: F401 (the fixture: the repo's data plus the owner's trip)


def guide_with(rows: list[dict]) -> dict:
    return {
        "title": "T",
        "getting_there": {"title": "Out", "buses": [{"trip_id": str(uuid.uuid4()), "date": "2026-11-06"}]},
        "getting_home": {"title": "Back", "buses": []},
        "budget": {"summary": "E2E", "rows": rows},
        "days": [{"day": 1, "title": "D1", "rows": [{"key": "d1-01", "time": "09:00", "plan": "x"}]}],
    }


def test_the_key_pattern_is_the_tables():
    assert guides.BUDGET_KEY == r"^[a-z][a-z0-9-]{1,20}$"


def test_a_row_without_key_or_category_still_parses():  # an old stored plan
    g, problems = guides.parse_guide(guide_with([{"item": "E2E meals", "estimate": "1,500 to 2,200"}]))
    assert problems == []
    row = g.budget.rows[0]
    assert (row.key, row.category) == (None, None)


def test_a_keyed_row_with_a_category_parses_and_round_trips():
    rows = [{"item": "E2E meals", "estimate": "1,500", "key": "meals", "category": "food"},
            {"item": "E2E taxis", "estimate": "300 to 500", "key": "taxis-2", "category": "transport"},
            {"item": "E2E other", "estimate": "100", "key": "m" * 21, "category": None}]
    g, problems = guides.parse_guide(guide_with(rows))
    assert problems == []
    assert [r.model_dump() for r in g.budget.rows] == rows


@pytest.mark.parametrize("category", ["transport", "hotel", "food", "activities", "other"])
def test_each_tg66_category_is_a_budget_category(category):
    g, problems = guides.parse_guide(guide_with([{"item": "E2E", "estimate": "1", "key": "line", "category": category}]))
    assert problems == [] and g.budget.rows[0].category == category


def test_the_category_words_are_tg66s():
    from app import wallet_models

    assert guides.BudgetRow.model_fields["category"].annotation == (wallet_models.Category | None)


@pytest.mark.parametrize("key", ["Meals", "1meals", "m" * 22, "_other", "_none", "m", "meals_2", "meals 2", "", "-meals"])
def test_a_bad_key_is_refused(key):
    g, problems = guides.parse_guide(guide_with([{"item": "E2E", "estimate": "1", "key": key}]))
    assert g is None and any(p.startswith("budget.rows.0.key") for p in problems), problems


@pytest.mark.parametrize("category", ["drinks", "Food", "", "none"])
def test_a_bad_category_is_refused(category):
    g, problems = guides.parse_guide(guide_with([{"item": "E2E", "estimate": "1", "key": "line", "category": category}]))
    assert g is None and any(p.startswith("budget.rows.0.category") for p in problems), problems


def test_duplicate_keys_are_refused():
    rows = [{"item": "E2E a", "estimate": "1", "key": "meals"}, {"item": "E2E b", "estimate": "2", "key": "meals"}]
    g, problems = guides.parse_guide(guide_with(rows))
    assert g is None and any("duplicate_budget_key" in p for p in problems), problems
    with pytest.raises(ValidationError, match="duplicate_budget_key"):
        guides.Budget.model_validate({"rows": rows})


def test_several_keyless_rows_are_not_duplicates():  # only a non-null key must be unique
    rows = [{"item": "E2E a", "estimate": "1"}, {"item": "E2E b", "estimate": "2"},
            {"item": "E2E c", "estimate": "3", "key": "meals"}, {"item": "E2E d", "estimate": "4", "key": None}]
    g, problems = guides.parse_guide(guide_with(rows))
    assert problems == [] and [r.key for r in g.budget.rows] == [None, None, "meals", None]


def test_extra_fields_on_a_row_are_still_refused():
    g, problems = guides.parse_guide(guide_with([{"item": "E2E", "estimate": "1", "key": "line", "spent": 5}]))
    assert g is None and problems


def stored_guide(dsn) -> dict:
    import psycopg

    with psycopg.connect(dsn) as conn:
        return conn.execute("select plan->'guide' from itineraries where share_slug = %s", (SLUG,)).fetchone()[0]


def test_the_owners_data_file_as_it_is_today_still_parses(barkada):  # the loader parses it, then the API reads it back
    raw = json.loads(ITINERARY.read_text(encoding="utf-8"))["guide"]
    g, problems = guides.parse_guide(stored_guide(barkada))
    assert problems == []
    assert [(r.item, r.estimate) for r in g.budget.rows] == [(r["item"], r["estimate"]) for r in raw["budget"]["rows"]]


def test_the_owners_rows_keyed_as_g20_parse(barkada):  # what GP1 will write into the data file
    keyed = stored_guide(barkada)
    for row, (key, category) in zip(keyed["budget"]["rows"], [("meals", "food"), ("pasalubong", "other"), ("entrance", "activities"), ("taxis", "transport")], strict=True):
        row |= {"key": key, "category": category}
    g, problems = guides.parse_guide(copy.deepcopy(keyed))
    assert problems == [] and [r.key for r in g.budget.rows] == ["meals", "pasalubong", "entrance", "taxis"]
