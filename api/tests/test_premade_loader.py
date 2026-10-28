"""TG-24: the pre-made itinerary loader, data/load_premade.py (plan.md 2.6, B18 to B24).

Fixture data and itineraries below are made up for tests only, not real trips, spots or plans.
The committed data/premade_itineraries.json is only read by the template test.
"""

import json
import os
import re
import subprocess
import sys

import psycopg
import pytest
from psycopg.rows import dict_row

import load_premade
from app.plan_validation import validate_plan
from conftest import ROOT
from premade_data import (
    FRI, NIGHT_DAYS, P0_DAYS, SPOTS, SUN, THU, TRIPS, build_plan, chill_entry, db_ids, load_rows, night_entry,
    write_premade,
)

UUID_RE = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
PROBLEMS = "problem(s) found, nothing was saved"


@pytest.fixture()
def rows(dsn, tmp_path):
    load_rows(dsn, tmp_path / "csv")
    return dsn


def run(dsn, path, dry_run=False, prune=False) -> int:
    return load_premade.run(dsn, path, dry_run=dry_run, prune=prune)


def premade_rows(dsn) -> list[dict]:
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        return conn.execute("select * from itineraries order by share_slug").fetchall()


def insert_user_row(dsn, share_slug="abc123def456") -> None:
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(
            """insert into itineraries (share_slug, trip_date, return_date, party, vibe, plan, model)
               values (%s, '2026-11-06', '2026-11-08', '[{"type": "adult", "name": "Test Person (made up)"}]',
                       'user plan (made up)', '{"outbound": null, "days": []}', 'claude-haiku-5-5')""",
            (share_slug,),
        )


def user_snapshot(dsn) -> list[tuple]:
    with psycopg.connect(dsn) as conn:
        return conn.execute(
            "select id, share_slug, vibe, party, plan, model from itineraries where model is distinct from 'premade' order by id"
        ).fetchall()


def expected_plans(dsn) -> dict[str, dict]:
    trips, spots, legs = db_ids(dsn)
    ret = trips[("vl-baguio", "21:00", "regular_aircon")]
    return {
        "premade-test-chill": build_plan(trips[("vl-cubao", "07:00", "regular_aircon")], FRI, ret, SUN, P0_DAYS, spots, legs),
        "premade-test-night": build_plan(trips[("vl-cubao", "22:00", "regular_aircon")], THU, ret, SUN, NIGHT_DAYS, spots, legs),
    }


# --- B18 the committed template ----------------------------------------------------------------

def test_committed_file_is_a_template(rows, capsys):
    path = ROOT / "data" / "premade_itineraries.json"
    text = path.read_text(encoding="utf-8")
    assert not UUID_RE.search(text)  # authored by slug, and no real-looking ids
    data = json.loads(text)
    assert data["itineraries"] == []
    assert all(k.startswith("_") for k in data if k != "itineraries")
    assert run(rows, path) == 0
    assert "Loaded 0 pre-made itineraries" in capsys.readouterr().out
    assert premade_rows(rows) == []


# --- B19 resolve and save ------------------------------------------------------------------------

def test_loads_and_resolves_slugs_to_ids(rows, tmp_path, capsys):
    path = write_premade(tmp_path, [chill_entry(), night_entry()])
    assert run(rows, path) == 0
    assert "Loaded 2 pre-made itineraries (2 new, 0 updated)" in capsys.readouterr().out

    saved = {r["share_slug"]: r for r in premade_rows(rows)}
    assert set(saved) == {"premade-test-chill", "premade-test-night"}
    plans = expected_plans(rows)
    for slug, row in saved.items():
        assert row["model"] == "premade"
        assert row["plan"] == plans[slug]  # exactly the CLAUDE.md shape, with the looked-up ids
    chill, night = saved["premade-test-chill"], saved["premade-test-night"]
    assert (chill["trip_date"], chill["return_date"]) == (FRI, SUN)
    assert (night["trip_date"], night["return_date"]) == (THU, SUN)
    assert chill["party"] == [{"type": "adult"}, {"type": "student"}]
    assert float(chill["budget_php"]) == 5000
    assert night["budget_php"] is None
    assert (chill["vibe"], night["vibe"]) == ("Chill (made up)", "Night bus (made up)")
    with psycopg.connect(rows) as conn:
        for row in saved.values():
            assert validate_plan(conn, row["plan"], trip_date=row["trip_date"], return_date=row["return_date"]).ok


def test_keys_starting_with_underscore_are_ignored(rows, tmp_path):
    path = tmp_path / "premade.json"
    path.write_text(json.dumps({"_readme": "x", "_example": {"key": "nope"}, "itineraries": [chill_entry()]}), encoding="utf-8")
    assert run(rows, path) == 0
    assert [r["share_slug"] for r in premade_rows(rows)] == ["premade-test-chill"]


# --- B20 idempotent --------------------------------------------------------------------------------

def test_rerun_updates_in_place(rows, tmp_path, capsys):
    assert run(rows, write_premade(tmp_path, [chill_entry()])) == 0
    first = {r["share_slug"]: r["id"] for r in premade_rows(rows)}
    capsys.readouterr()

    path = write_premade(tmp_path, [chill_entry(), night_entry()])
    assert run(rows, path) == 0
    assert "Loaded 2 pre-made itineraries (1 new, 1 updated)" in capsys.readouterr().out
    assert run(rows, path) == 0
    assert "Loaded 2 pre-made itineraries (0 new, 2 updated)" in capsys.readouterr().out
    after = {r["share_slug"]: r["id"] for r in premade_rows(rows)}
    assert len(after) == 2
    assert after["premade-test-chill"] == first["premade-test-chill"]  # share links survive a reload

    edited = chill_entry()
    edited["days"][2]["stops"][0]["arrive"] = "10:15"
    edited["vibe"] = "Chill, edited (made up)"
    assert run(rows, write_premade(tmp_path, [edited, night_entry()])) == 0
    saved = {r["share_slug"]: r for r in premade_rows(rows)}
    assert len(saved) == 2
    assert saved["premade-test-chill"]["id"] == first["premade-test-chill"]
    assert saved["premade-test-chill"]["plan"]["days"][2]["stops"][0]["arrive"] == "10:15"
    assert saved["premade-test-chill"]["vibe"] == "Chill, edited (made up)"


# --- B21 dry run -----------------------------------------------------------------------------------

def test_dry_run_writes_nothing(rows, tmp_path, capsys):
    path = write_premade(tmp_path, [chill_entry(), night_entry()])
    assert run(rows, path, dry_run=True) == 0
    assert "Dry run OK, nothing saved. Would load 2 pre-made itineraries" in capsys.readouterr().out
    assert premade_rows(rows) == []

    assert run(rows, path) == 0
    before = premade_rows(rows)
    edited = chill_entry()
    edited["vibe"] = "Changed (made up)"
    assert run(rows, write_premade(tmp_path, [edited]), dry_run=True, prune=True) == 0
    assert premade_rows(rows) == before


# --- B22 errors roll everything back ---------------------------------------------------------------

def _stop0(e):
    return e["days"][0]["stops"][0]


ERROR_CASES = {
    "unknown spot": (lambda e: _stop0(e).update(spot="no-such-spot"), ["no-such-spot"]),
    "unknown terminal": (lambda e: e["outbound"].update(origin="vl-nowhere"), ["vl-nowhere"]),
    "unknown operator": (lambda e: e["outbound"].update(operator="no-such-bus"), ["no-such-bus"]),
    "no trip at that time": (lambda e: e["outbound"].update(departure="07:05"), ["07:05", "2026-11-06"]),
    "trip not running that day": (
        lambda e: e["outbound"].update(operator="genesis", origin="gen-pasay", departure="09:00"), ["genesis", "2026-11-06"]),
    "no matching leg": (lambda e: _stop0(e)["leg"].update(mode="taxi"), ["vl-baguio", "test-market"]),
    "validator error": (lambda e: _stop0(e).update(arrive="12:00"), ["  - test-chill: days[0].stops[0].arrive: "]),
    "bad party type": (lambda e: e["party"].append({"type": "pet"}), []),
    "empty party": (lambda e: e.update(party=[]), []),
    "missing vibe": (lambda e: e.pop("vibe"), []),
    "negative budget": (lambda e: e.update(budget_php=-1), []),
    "bad time": (lambda e: _stop0(e).update(arrive="1:30 PM"), []),
    "unknown field": (lambda e: e.update(title="x"), []),
}


@pytest.mark.parametrize("case", sorted(ERROR_CASES))
def test_any_error_saves_nothing(rows, tmp_path, capsys, case):
    edit, expected = ERROR_CASES[case]
    bad = chill_entry()
    edit(bad)
    assert run(rows, write_premade(tmp_path, [night_entry(), bad])) == 1
    out = capsys.readouterr().out
    assert PROBLEMS in out
    assert "  - test-chill: " in out  # every problem line names the entry key
    for text in expected:
        assert text in out
    assert premade_rows(rows) == []  # the valid night entry wasn't saved either


def test_party_names_are_rejected_and_never_printed(rows, tmp_path, capsys):
    bad = chill_entry()
    bad["party"] = [{"type": "adult", "name": "Juan Test (made up)"}]
    assert run(rows, write_premade(tmp_path, [bad])) == 1
    out = capsys.readouterr().out
    assert PROBLEMS in out and "test-chill" in out
    assert "Juan Test" not in out
    assert premade_rows(rows) == []


@pytest.mark.parametrize("key", ["Test Chill", "test_chill", "-test", "test--chill", ""])
def test_bad_key(rows, tmp_path, capsys, key):
    bad = chill_entry()
    bad["key"] = key
    assert run(rows, write_premade(tmp_path, [bad])) == 1
    assert PROBLEMS in capsys.readouterr().out
    assert premade_rows(rows) == []


def test_duplicate_key(rows, tmp_path, capsys):
    other = night_entry()
    other["key"] = "test-chill"
    assert run(rows, write_premade(tmp_path, [chill_entry(), other])) == 1
    out = capsys.readouterr().out
    assert PROBLEMS in out and "test-chill" in out
    assert premade_rows(rows) == []


@pytest.mark.parametrize("text", [
    "{not json",
    json.dumps({"itinerary": []}),
    json.dumps({"itineraries": {}}),
    json.dumps([]),
])
def test_bad_file_shape(rows, tmp_path, capsys, text):
    path = tmp_path / "premade.json"
    path.write_text(text, encoding="utf-8")
    assert run(rows, path) == 1
    assert PROBLEMS in capsys.readouterr().out
    assert premade_rows(rows) == []


def test_failed_run_keeps_the_rows_already_loaded(rows, tmp_path):
    assert run(rows, write_premade(tmp_path, [chill_entry()])) == 0
    before = premade_rows(rows)
    bad = chill_entry()
    bad["vibe"] = "Changed (made up)"
    _stop0(bad)["arrive"] = "12:00"
    assert run(rows, write_premade(tmp_path, [bad])) == 1
    assert premade_rows(rows) == before


# --- B23 ambiguous natural keys --------------------------------------------------------------------

AMBIGUOUS_TRIPS = TRIPS + (
    "victory-liner,vl-cubao,vl-baguio,,deluxe,800,,2x2,yes,07:00,daily,,,https://example.test/schedule,2026-10-24,made up for tests only\n"
)


def test_ambiguous_trip_lists_candidates_and_class_resolves_it(dsn, tmp_path, capsys):
    load_rows(dsn, tmp_path / "csv", trips=AMBIGUOUS_TRIPS)
    assert run(dsn, write_premade(tmp_path, [chill_entry()])) == 1
    out = capsys.readouterr().out
    assert PROBLEMS in out and "test-chill" in out
    assert "2 trips match" in out and "regular_aircon" in out and "deluxe" in out
    assert premade_rows(dsn) == []

    entry = chill_entry()
    entry["outbound"]["class"] = "regular_aircon"
    assert run(dsn, write_premade(tmp_path, [entry])) == 0
    trips, _, _ = db_ids(dsn)
    assert premade_rows(dsn)[0]["plan"]["outbound"]["trip_id"] == str(trips[("vl-cubao", "07:00", "regular_aircon")])


def test_destination_disambiguates_a_trip(dsn, tmp_path):
    extra = TRIPS + (
        "victory-liner,vl-cubao,gen-baguio,,regular_aircon,700,360,2x2,yes,07:00,daily,,,https://example.test/schedule,2026-10-24,made up for tests only\n"
    )
    load_rows(dsn, tmp_path / "csv", trips=extra)
    assert run(dsn, write_premade(tmp_path, [chill_entry()])) == 1
    entry = chill_entry()
    entry["outbound"]["destination"] = "vl-baguio"
    assert run(dsn, write_premade(tmp_path, [entry])) == 0


def test_slug_that_is_both_a_terminal_and_a_spot_is_ambiguous(dsn, tmp_path, capsys):
    spots = SPOTS + "vl-baguio,Clashing Spot (made up),other,,,made up for tests only,,\n"
    load_rows(dsn, tmp_path / "csv", spots=spots)
    assert run(dsn, write_premade(tmp_path, [chill_entry()])) == 1
    out = capsys.readouterr().out
    assert PROBLEMS in out and "test-chill" in out and "ambiguous" in out
    assert premade_rows(dsn) == []


# --- B24 prune, and other rows are never touched ---------------------------------------------------

def test_stale_rows_are_reported_and_only_pruned_on_request(rows, tmp_path, capsys):
    insert_user_row(rows)
    users = user_snapshot(rows)
    assert run(rows, write_premade(tmp_path, [chill_entry(), night_entry()])) == 0
    capsys.readouterr()

    only_chill = write_premade(tmp_path, [chill_entry()])
    assert run(rows, only_chill) == 0
    out = capsys.readouterr().out
    assert "1 pre-made itinerary in the database is not in the file (premade-test-night); run with --prune to delete it" in out
    assert {r["share_slug"] for r in premade_rows(rows) if r["model"] == "premade"} == {"premade-test-chill", "premade-test-night"}

    assert run(rows, only_chill, prune=True) == 0
    assert {r["share_slug"] for r in premade_rows(rows) if r["model"] == "premade"} == {"premade-test-chill"}
    assert user_snapshot(rows) == users  # the user plan survived load, rerun and prune

    assert run(rows, write_premade(tmp_path, []), prune=True) == 0
    assert [r["model"] for r in premade_rows(rows)] == ["claude-haiku-5-5"]
    assert user_snapshot(rows) == users


def test_user_row_with_a_clashing_slug_is_never_overwritten(rows, tmp_path):
    insert_user_row(rows, share_slug="premade-test-chill")
    users = user_snapshot(rows)
    run(rows, write_premade(tmp_path, [chill_entry()]))
    assert user_snapshot(rows) == users


# --- CLI and module boundaries ---------------------------------------------------------------------

def test_cli_dry_run_from_repo_root(rows, tmp_path):
    path = write_premade(tmp_path, [chill_entry()])
    env = {k: v for k, v in os.environ.items() if k != "DATABASE_URL"}
    out = subprocess.run(
        [sys.executable, "data/load_premade.py", "--dry-run", "--file", str(path), "--database-url", rows],
        cwd=ROOT, env=env, capture_output=True, text=True, timeout=60,
    )
    assert out.returncode == 0, out.stdout + out.stderr
    assert re.search(r"Dry run OK, nothing saved\. Would load 1 pre-made itinerar(y|ies)\b", out.stdout), out.stdout
    assert rows not in out.stdout + out.stderr  # never prints the DSN
    assert premade_rows(rows) == []


def test_loader_imports_no_fastapi_or_pool():
    """Review should-fix 3: the loader uses the validator without pulling in the web app."""
    code = (
        "import sys; sys.path.insert(0, 'data'); import load_premade; "
        "print([m for m in ('fastapi', 'starlette', 'psycopg_pool', 'app.main', 'app.db', 'app.premade') if m in sys.modules])"
    )
    env = {k: v for k, v in os.environ.items() if k != "DATABASE_URL"}
    out = subprocess.run([sys.executable, "-c", code], cwd=ROOT, env=env, capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == "[]"


def test_data_readme_documents_the_file_and_the_recheck():
    text = (ROOT / "data" / "README.md").read_text(encoding="utf-8")
    assert "## premade_itineraries.json" in text
    assert "python data/load_premade.py --dry-run" in text
    # review should-fix 4: re-validate after trip data changes and before the trip
    section = text.split("## premade_itineraries.json", 1)[1]
    assert "scraper" in section and "Nov 5" in section
