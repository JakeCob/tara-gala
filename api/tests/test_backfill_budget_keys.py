"""TG-62 GP1: data/backfill_budget_keys.py gives a key to every keyless budget row in stored plans (plan.md §3 G21, §5 step 4,
§6 --strip). A throwaway database only: the owner's plan file on a made-up trip, whose stored plans are taken back to
their pre-GP1 shape (no key, no category) in the database. Never Supabase, never the real trip.
"""

import json

import psycopg
import pytest
from psycopg.types.json import Jsonb

from app import guide as guides
from test_guide import SLUG, barkada, trip  # noqa: F401  fixtures
from test_plan_edit import editing, edit, move, one, rows, t  # noqa: F401

import backfill_budget_keys  # noqa: E402  (data/, on the path from test_guide)

G20 = [("meals", "food"), ("pasalubong", "other"), ("entrance", "activities"), ("taxis", "transport")]
SNACKS = "E2E snacks for the bus"


def plans(dsn) -> list[tuple[str, dict]]:
    """Every stored plan with a guide: ("it:<slug>" or "v:<slug>:<seq>", plan)."""
    out = [(f"it:{r['share_slug']}", r["plan"]) for r in rows(dsn, "select share_slug, plan from itineraries where plan ? 'guide' order by share_slug")]
    out += [(f"v:{r['share_slug']}:{r['seq']}", r["plan"]) for r in rows(
        dsn, "select i.share_slug, v.seq, v.plan from itinerary_versions v join itineraries i on i.id = v.itinerary_id order by i.share_slug, v.seq")]
    return out


def budget_rows(plan: dict) -> list[dict]:
    return plan["guide"]["budget"]["rows"]


def keys_cats(rs: list[dict]) -> list[tuple]:
    return [(r.get("key"), r.get("category")) for r in rs]


def strip_everything(dsn, keep=None) -> None:
    """Every stored plan as it was before GP1: budget rows with no key and no category. `keep(where, i)` spares a row."""
    with psycopg.connect(dsn, autocommit=True) as conn:
        for table, id_col in (("itineraries", "id"), ("itinerary_versions", "id")):
            for r in conn.execute(f"select {id_col}, plan from {table} where plan ? 'guide'").fetchall():
                plan = r[1]
                for row in budget_rows(plan):
                    row.pop("key", None)
                    row.pop("category", None)
                conn.execute(f"update {table} set plan = %s where {id_col} = %s", (Jsonb(plan), r[0]))


def copy_slug(dsn, trip_slug) -> str:
    return one(dsn, "select i.share_slug from trip_sessions s join itineraries i on i.id = s.itinerary_id where s.share_slug = %s", trip_slug)["share_slug"]


@pytest.fixture()
def old(t, client, barkada):  # noqa: F811
    """A made-up trip with its own copy (versions 0 to 2, one with a line of its own), all stored without keys."""
    edit(client, t, lambda g: g["budget"]["rows"].append({"item": SNACKS, "estimate": "150"}))
    edit(client, t, lambda g: move(g, "d1-03", 2))
    strip_everything(barkada)
    assert all("key" not in r and "category" not in r for _, p in plans(barkada) for r in budget_rows(p))
    return copy_slug(barkada, t)


def run(dsn, capsys, *args) -> tuple[int, str]:
    capsys.readouterr()
    code = backfill_budget_keys.run(dsn, apply="--apply" in args, strip="--strip" in args)
    return code, capsys.readouterr().out


def test_a_dry_run_counts_and_writes_nothing(old, barkada, capsys):
    before = plans(barkada)
    code, out = run(barkada, capsys)
    assert code == 0
    assert "Dry run: nothing saved." in out
    assert "plans read: 5" in out and "rows keyed: 23" in out and "rows already keyed: 0" in out, out
    assert plans(barkada) == before


def test_apply_keys_every_row_from_the_curated_file_or_by_its_text(old, barkada, capsys):
    code, out = run(barkada, capsys, "--apply")
    assert code == 0 and "rows keyed: 23" in out, out
    every = dict(plans(barkada))
    assert keys_cats(budget_rows(every[f"it:{SLUG}"])) == G20, "the shared plan, from its own file"
    assert keys_cats(budget_rows(every[f"v:{old}:0"])) == G20, "the copy's first version, from the file it was copied from"
    for where in (f"v:{old}:1", f"v:{old}:2", f"it:{old}"):
        assert keys_cats(budget_rows(every[where])) == G20 + [("e2e-snacks-for-the", None)], where
    assert every[f"it:{old}"] == every[f"v:{old}:2"], "the copy's plan still equals its newest version"
    for where, plan in every.items():
        g, problems = guides.parse_guide(plan["guide"])
        assert problems == [], (where, problems)


def without_keys(plan: dict) -> dict:
    out = json.loads(json.dumps(plan))
    for r in budget_rows(out):
        r.pop("key", None)
        r.pop("category", None)
    return out


def test_apply_changes_nothing_but_the_budget_rows_keys_and_categories(old, barkada, capsys):  # tg-test RED F2
    before = dict(plans(barkada))
    assert run(barkada, capsys, "--apply")[0] == 0
    after = dict(plans(barkada))
    assert after.keys() == before.keys()
    for where, plan in after.items():
        assert without_keys(plan) == before[where], where
    assert any(after[w] != before[w] for w in after), "and it did change something"


def test_two_rows_of_one_text_get_two_keys_the_same_in_every_version(t, client, barkada, capsys):  # tg-test RED S1
    two = "E2E snacks"
    edit(client, t, lambda g: g["budget"]["rows"].extend([{"item": two, "estimate": "100"}, {"item": two, "estimate": "200"}]))
    edit(client, t, lambda g: move(g, "d1-03", 2))
    strip_everything(barkada)
    slug = copy_slug(barkada, t)
    assert run(barkada, capsys, "--apply")[0] == 0
    every = dict(plans(barkada))
    for where in (f"v:{slug}:1", f"v:{slug}:2", f"it:{slug}"):
        rs = budget_rows(every[where])
        assert [(r["key"], r["estimate"]) for r in rs][4:] == [("e2e-snacks", "100"), ("e2e-snacks-2", "200")], where
        assert guides.parse_guide(every[where]["guide"])[1] == [], where


def test_a_slug_held_by_another_version_of_the_trip_isnt_minted_again(old, barkada, capsys):  # tg-test RED S2
    with psycopg.connect(barkada, autocommit=True) as conn:
        for seq, item, key in ((1, "E2E snacks", "e2e-snacks"), (2, "E2E snacks!", None)):
            plan = conn.execute("select v.plan from itinerary_versions v join itineraries i on i.id = v.itinerary_id"
                                " where i.share_slug = %s and v.seq = %s", (old, seq)).fetchone()[0]
            budget_rows(plan)[4] = {"item": item, "estimate": "150", **({"key": key} if key else {})}
            conn.execute("update itinerary_versions v set plan = %s from itineraries i where i.id = v.itinerary_id and i.share_slug = %s and v.seq = %s",
                         (Jsonb(plan), old, seq))
    assert run(barkada, capsys, "--apply")[0] == 0
    every = dict(plans(barkada))
    assert budget_rows(every[f"v:{old}:1"])[4]["key"] == "e2e-snacks"
    assert budget_rows(every[f"v:{old}:2"])[4]["key"] == "e2e-snacks-2"


def test_a_save_between_deploy_and_backfill_gets_its_categories_and_keeps_its_keys(t, client, barkada, capsys):  # tg-review S1
    strip_everything(barkada)  # the stored plans as they are when GP1's API goes out (§5 step 2)
    edit(client, t, lambda g: move(g, "d1-03", 2))  # a save before the backfill: the editor mints keys, with no category
    slug = copy_slug(barkada, t)
    minted = [("meals-and-merienda-2", None), ("pasalubong-and", None), ("entrance-fees-bencab", None), ("taxis-split-4-per-cab", None)]
    assert keys_cats(budget_rows(dict(plans(barkada))[f"it:{slug}"])) == minted
    before = dict(plans(barkada))
    code, out = run(barkada, capsys, "--apply")
    assert code == 0 and "categories filled: 8" in out and "rows keyed: 8" in out and "rows already keyed: 8" in out, out
    every = dict(plans(barkada))
    cats = [c for _, c in G20]
    for where in (f"v:{slug}:1", f"it:{slug}"):
        assert keys_cats(budget_rows(every[where])) == [(k, c) for (k, _), c in zip(minted, cats, strict=True)], where
    assert keys_cats(budget_rows(every[f"v:{slug}:0"])) == G20, "the copy's first version is keyed from the file"
    for where, plan in every.items():
        assert without_keys(plan) == without_keys(before[where]), where
        assert guides.parse_guide(plan["guide"])[1] == [], where
    code, out = run(barkada, capsys, "--apply")
    assert "categories filled: 0" in out and "rows keyed: 0" in out, out


def test_a_keyed_row_with_a_category_keeps_it(old, barkada, capsys):  # S1's fill never overrides a category
    run(barkada, capsys, "--apply")
    with psycopg.connect(barkada, autocommit=True) as conn:
        plan = conn.execute("select plan from itineraries where share_slug = %s", (old,)).fetchone()[0]
        budget_rows(plan)[0]["category"] = "other"
        conn.execute("update itineraries set plan = %s where share_slug = %s", (Jsonb(plan), old))
    code, out = run(barkada, capsys, "--apply")
    assert "categories filled: 0" in out, out
    assert budget_rows(dict(plans(barkada))[f"it:{old}"])[0]["category"] == "other"


def test_a_second_run_keys_nothing(old, barkada, capsys):  # N3: §5 step 4's check
    run(barkada, capsys, "--apply")
    after = plans(barkada)
    code, out = run(barkada, capsys)
    assert code == 0 and "rows keyed: 0" in out and "rows already keyed: 23" in out, out
    code, out = run(barkada, capsys, "--apply")
    assert code == 0 and "rows keyed: 0" in out, out
    assert plans(barkada) == after, "idempotent"


def test_a_row_that_has_a_key_is_never_changed(old, barkada, capsys):
    with psycopg.connect(barkada, autocommit=True) as conn:
        plan = conn.execute("select v.plan from itinerary_versions v join itineraries i on i.id = v.itinerary_id"
                            " where i.share_slug = %s and v.seq = 1", (old,)).fetchone()[0]
        budget_rows(plan)[3] |= {"key": "cabs", "category": "other"}
        budget_rows(plan)[4] |= {"key": "snacks"}
        conn.execute("update itinerary_versions v set plan = %s from itineraries i where i.id = v.itinerary_id and i.share_slug = %s and v.seq = 1",
                     (Jsonb(plan), old))
    code, out = run(barkada, capsys, "--apply")
    assert code == 0 and "rows keyed: 21" in out and "rows already keyed: 2" in out, out
    v1 = dict(plans(barkada))[f"v:{old}:1"]
    assert keys_cats(budget_rows(v1))[3:] == [("cabs", "other"), ("snacks", None)]
    for where, plan in plans(barkada):
        assert guides.parse_guide(plan["guide"])[1] == [], where


def test_a_curated_key_already_on_another_row_isnt_given_twice(old, barkada, capsys):
    with psycopg.connect(barkada, autocommit=True) as conn:
        plan = conn.execute("select plan from itineraries where share_slug = %s", (old,)).fetchone()[0]
        budget_rows(plan)[4] |= {"key": "meals"}  # the trip's own line already holds the curated key
        conn.execute("update itineraries set plan = %s where share_slug = %s", (Jsonb(plan), old))
    assert run(barkada, capsys, "--apply")[0] == 0
    rs = budget_rows(dict(plans(barkada))[f"it:{old}"])
    assert rs[4]["key"] == "meals" and rs[0]["key"] not in (None, "meals")
    assert guides.parse_guide(dict(plans(barkada))[f"it:{old}"]["guide"])[1] == []


def test_the_output_is_counts_only(old, barkada, capsys):
    for args in ((), ("--apply",)):
        _, out = run(barkada, capsys, *args)
        low = out.lower()
        assert not any(w in low for w in ("snacks", "meals", "taxis", "pasalubong", "entrance", SLUG, old)), out


def test_strip_is_a_dry_run_unless_apply_and_then_removes_every_key_and_category(old, barkada, capsys):  # §6 N1
    run(barkada, capsys, "--apply")
    keyed = plans(barkada)
    code, out = run(barkada, capsys, "--strip")
    assert code == 0 and "Dry run: nothing saved." in out and "rows stripped: 23" in out, out
    assert plans(barkada) == keyed
    code, out = run(barkada, capsys, "--strip", "--apply")
    assert code == 0 and "rows stripped: 23" in out, out
    assert all("key" not in r and "category" not in r for _, p in plans(barkada) for r in budget_rows(p))
    assert run(barkada, capsys, "--apply")[1].count("rows keyed: 23") == 1
    assert plans(barkada) == keyed, "the backfill gives the same keys back"


def test_main_needs_a_database_url(monkeypatch, capsys):
    monkeypatch.setattr(backfill_budget_keys.load_data, "database_url", lambda _v: None)
    monkeypatch.setattr("sys.argv", ["backfill_budget_keys.py"])
    assert backfill_budget_keys.main() == 2
    assert "DATABASE_URL" in capsys.readouterr().err


def test_main_is_a_dry_run_by_default(old, barkada, monkeypatch, capsys):
    monkeypatch.setattr("sys.argv", ["backfill_budget_keys.py"])
    monkeypatch.setattr(backfill_budget_keys.load_data, "database_url", lambda _v: barkada)
    before = plans(barkada)
    assert backfill_budget_keys.main() == 0
    assert "Dry run: nothing saved." in capsys.readouterr().out
    assert plans(barkada) == before
    assert json.dumps(before)  # plain JSON throughout
