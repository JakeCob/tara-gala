"""Loader + /trips tests. Fixture data below is made up for tests only, not real schedules."""

import shutil
from datetime import date
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

import load_data
from conftest import write_csvs

SRC = "https://example.test/schedule"

TRIPS = (
    f"victory-liner,vl-cubao,vl-baguio,Luisita,regular_aircon,700,360,2x2,yes,9:30 AM,daily,,,{SRC},2026-10-24,\n"
    f"victory-liner,vl-cubao,vl-baguio,Luisita,regular_aircon,700,360,2x2,yes,07:00,daily,,,{SRC},2026-10-24,\n"
    f"genesis,gen-pasay,gen-baguio,,premiere,900,300,2x1,yes,1:00 AM,weekends,,,{SRC},2026-10-24,\n"
    f"solid-north,pitx,sn-baguio,TPLEX,luxury,1000,300,,,3:00 PM,daily,2026-11-01,2026-11-30,{SRC},2026-10-24,holiday run\n"
)
SPOTS = "burnham-park,Burnham Park,park,16.41,120.59,,90,\n"
LAST_MILE = "vl-baguio,,,burnham-park,walk,,,,,,15,2026-10-24,\n"


def count(dsn, table):
    with psycopg.connect(dsn) as conn:
        return conn.execute(f"select count(*) from {table}").fetchone()[0]


def test_dry_run_saves_nothing(dsn, tmp_path):
    write_csvs(tmp_path, TRIPS, SPOTS, LAST_MILE)
    assert load_data.run(dsn, tmp_path, dry_run=True) == 0
    assert count(dsn, "trips") == 0
    assert count(dsn, "spots") == 0


def test_load_is_idempotent(dsn, tmp_path):
    write_csvs(tmp_path, TRIPS, SPOTS, LAST_MILE)
    assert load_data.run(dsn, tmp_path, dry_run=False) == 0
    assert load_data.run(dsn, tmp_path, dry_run=False) == 0
    assert count(dsn, "routes") == 3
    assert count(dsn, "trips") == 4
    assert count(dsn, "spots") == 1
    assert count(dsn, "last_mile_routes") == 1


def test_bad_rows_abort_whole_load(dsn, tmp_path):
    bad = (
        f"victory-liner,vl-nowhere,vl-baguio,,regular_aircon,,,,,09:00,daily,,,{SRC},2026-10-24,\n"
        f"victory-liner,vl-cubao,vl-baguio,,regular_aircon,,,,,10:00,daily,,,{SRC},,\n"
    )
    write_csvs(tmp_path, TRIPS + bad)
    assert load_data.run(dsn, tmp_path, dry_run=False) == 1
    assert count(dsn, "trips") == 0


def test_last_mile_needs_exactly_one_origin(dsn, tmp_path):
    write_csvs(tmp_path, spots=SPOTS, last_mile="vl-baguio,burnham-park,,burnham-park,walk,,,,,,5,2026-10-24,\n")
    assert load_data.run(dsn, tmp_path, dry_run=False) == 1


def test_trips_metro_manila_to_baguio_on_a_friday(dsn, client, tmp_path):
    write_csvs(tmp_path, TRIPS, SPOTS, LAST_MILE)
    load_data.run(dsn, tmp_path, dry_run=False)

    # 2026-11-06 is a Friday: weekend-only Genesis trip excluded, Solid North holiday run included
    r = client.get("/trips", params={"origin_city": "Metro Manila", "destination_city": "Baguio", "date": "2026-11-06"})
    assert r.status_code == 200
    trips = r.json()
    assert [t["departure_time"] for t in trips] == ["07:00", "09:30", "15:00"]
    first = trips[0]
    assert first["operator_name"] == "Victory Liner"
    assert first["arrives_around"] == "13:00"
    assert first["last_verified_at"] is not None
    assert "Confirm with the operator" in first["confirm_note"]


def test_trips_respects_weekend_days_and_valid_range(dsn, client, tmp_path):
    write_csvs(tmp_path, TRIPS)
    load_data.run(dsn, tmp_path, dry_run=False)

    # Saturday in October: Genesis weekend trip runs, Solid North (from Nov 1) does not
    r = client.get("/trips", params={"origin_city": "Metro Manila", "destination_city": "Baguio", "date": "2026-10-31"})
    ops = {t["operator_slug"] for t in r.json()}
    assert ops == {"victory-liner", "genesis"}


def test_terminals_and_health(client):
    assert client.get("/health").json() == {"status": "ok"}
    baguio = client.get("/terminals", params={"city": "Baguio"}).json()
    assert {t["slug"] for t in baguio} == {"vl-baguio", "gen-baguio", "sn-baguio"}


# --- TG-67 S1: the city column on spots.csv and last_mile_routes.csv. Made-up rows, never the owner's trip ---------
CITY_FIXTURE = Path(__file__).parent / "fixtures" / "loader_city"


def city_csvs(dsn, folder: Path) -> Path:
    """Copy the city fixture CSVs and add the made-up Sagada terminal its first leg starts from."""
    for name in ("spots.csv", "last_mile_routes.csv"):
        shutil.copy(CITY_FIXTURE / name, folder / name)
    with psycopg.connect(dsn) as conn:
        conn.execute("insert into terminals (slug, name, city) values ('test-sg-sagada', 'Test Sagada stop', 'Sagada')")
    return folder


def cities(dsn, table: str) -> dict[str, str]:
    """slug (or 'from>to' for legs) -> city."""
    with psycopg.connect(dsn) as conn:
        if table == "spots":
            return dict(conn.execute("select slug, city from spots").fetchall())
        return dict(conn.execute("""
            select coalesce(ft.slug, fs.slug) || '>' || coalesce(tt.slug, ts.slug), l.city
            from last_mile_routes l
            left join terminals ft on ft.id = l.from_terminal_id left join spots fs on fs.id = l.from_spot_id
            left join terminals tt on tt.id = l.to_terminal_id left join spots ts on ts.id = l.to_spot_id
        """).fetchall())


def test_cities_list():
    assert load_data.CITIES == ("Baguio", "Sagada")


def test_spot_and_leg_city_saved_and_rerun_changes_nothing(dsn, tmp_path, capsys):
    # B1, B3: city=Sagada is saved on the spot and the leg; a blank cell is Baguio; a re-run is a no-op
    city_csvs(dsn, tmp_path)
    assert load_data.run(dsn, tmp_path, dry_run=False) == 0
    assert load_data.run(dsn, tmp_path, dry_run=False) == 0
    assert cities(dsn, "spots") == {"test-sg-lodge": "Sagada", "test-sg-cave": "Sagada", "test-bg-park": "Baguio"}
    assert cities(dsn, "last_mile_routes") == {
        "test-sg-sagada>test-sg-lodge": "Sagada",
        "test-sg-lodge>test-sg-cave": "Sagada",
        "vl-baguio>test-bg-park": "Baguio",
    }
    out = capsys.readouterr().out.splitlines()[-1]
    assert out == "Loaded spots: 3 (Baguio 1, Sagada 2), trips: 0 (0 new routes), last-mile routes: 3 (Baguio 1, Sagada 2)"


def test_csvs_without_a_city_column_load_as_baguio(dsn, tmp_path, capsys):
    # B2: today's CSVs have no city column; every row is Baguio, as today
    write_csvs(tmp_path, TRIPS, SPOTS, LAST_MILE)
    assert load_data.run(dsn, tmp_path, dry_run=False) == 0
    assert cities(dsn, "spots") == {"burnham-park": "Baguio"}
    assert cities(dsn, "last_mile_routes") == {"vl-baguio>burnham-park": "Baguio"}
    assert "spots: 1 (Baguio 1)" in capsys.readouterr().out


def test_unknown_city_is_a_line_error_and_saves_nothing(dsn, tmp_path, capsys):
    # B3: a misspelt city ('Sagda', or 'sagada' in the wrong case) fails its line; nothing is saved
    city_csvs(dsn, tmp_path)
    lm = (tmp_path / "last_mile_routes.csv").read_text(encoding="utf-8")
    (tmp_path / "last_mile_routes.csv").write_text(lm.replace("made-up test row,Sagada\n,", "made-up test row,Sagda\n,", 1),
                                                   encoding="utf-8")
    sp = (tmp_path / "spots.csv").read_text(encoding="utf-8")
    (tmp_path / "spots.csv").write_text(sp.replace("120,100,Sagada", "120,100,sagada"), encoding="utf-8")
    assert load_data.run(dsn, tmp_path, dry_run=True) == 1
    err = capsys.readouterr().err
    assert "spots.csv line 3: 'city' must be one of Baguio, Sagada; got 'sagada'" in err
    assert "last_mile_routes.csv line 2: 'city' must be one of Baguio, Sagada; got 'Sagda'" in err
    assert count(dsn, "spots") == 0
    assert count(dsn, "last_mile_routes") == 0


def test_dry_run_lists_rows_whose_city_would_change(dsn, tmp_path, capsys):
    # review N2: a row whose city was set by hand would flip back to Baguio; the dry run names it and saves nothing
    write_csvs(tmp_path, spots=SPOTS, last_mile=LAST_MILE)
    assert load_data.run(dsn, tmp_path, dry_run=False) == 0
    with psycopg.connect(dsn) as conn:
        conn.execute("update spots set city = 'La Trinidad' where slug = 'burnham-park'")
        conn.execute("update last_mile_routes set city = 'La Trinidad'")
    capsys.readouterr()
    assert load_data.run(dsn, tmp_path, dry_run=True) == 0
    out = capsys.readouterr().out
    assert "spots.csv line 2: city La Trinidad -> Baguio (burnham-park)" in out
    assert "last_mile_routes.csv line 2: city La Trinidad -> Baguio (vl-baguio > burnham-park)" in out
    assert cities(dsn, "spots") == {"burnham-park": "La Trinidad"}


def test_sagada_rows_stay_out_of_baguio_answers(dsn, client, tmp_path, monkeypatch):
    # B4: the planner context and the Baguio terminal's last-mile list never see the Sagada rows
    from app.planner_context import load_context

    city_csvs(dsn, tmp_path)
    assert load_data.run(dsn, tmp_path, dry_run=False) == 0
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        ctx = load_context(conn, date(2026, 11, 25), date(2026, 11, 28))
    assert {s["slug"] for s in ctx.spots} == {"test-bg-park"}
    assert {(leg["from"], leg["to"]) for leg in ctx.legs} == {("vl-baguio", "test-bg-park")}

    legs = client.get("/last-mile", params={"terminal": "vl-baguio"}).json()
    assert [leg["destination"]["slug"] for leg in legs] == ["test-bg-park"]

    # T67-L4: nor does the planner's prompt text; GET /spots stays unfiltered on purpose (the web filters it, S4)
    from app import planner
    from app.planner_prompt import build_user_message
    from planner_data import TODAY, request_body

    monkeypatch.setattr(planner, "manila_today", lambda: TODAY)  # request_body's dates stay in the future
    prompt = build_user_message(ctx, planner.PlanRequest(**request_body()))
    assert "test-sg-" not in prompt and "Sagada" not in prompt
    spots = {s["slug"]: s["city"] for s in client.get("/spots").json()}
    assert spots == {"test-sg-lodge": "Sagada", "test-sg-cave": "Sagada", "test-bg-park": "Baguio"}


def test_a_real_rerun_moves_an_existing_spot_and_leg_to_sagada(dsn, tmp_path, capsys):
    # T67-L5 (RED audit M1, M2): rows first loaded with no city are Baguio; a real re-run with city=Sagada updates them
    spot = "test-sg-lodge,Test Sagada Lodge,other,17.08,120.90,made-up test row,,"
    leg = ",test-sg-lodge,vl-baguio,,taxi,,,,,,30,2026-11-20,made-up test row"
    write_csvs(tmp_path, spots=spot + "\n", last_mile=leg + "\n")
    assert load_data.run(dsn, tmp_path, dry_run=False) == 0
    assert cities(dsn, "spots") == {"test-sg-lodge": "Baguio"}
    assert cities(dsn, "last_mile_routes") == {"test-sg-lodge>vl-baguio": "Baguio"}

    (tmp_path / "spots.csv").write_text("slug,name,category,lat,lng,description,visit_minutes,entrance_fee_php,city\n"
                                        f"{spot},Sagada\n", encoding="utf-8")
    lm_header = (tmp_path / "last_mile_routes.csv").read_text(encoding="utf-8").splitlines()[0]
    (tmp_path / "last_mile_routes.csv").write_text(f"{lm_header},city\n{leg},Sagada\n", encoding="utf-8")
    capsys.readouterr()
    assert load_data.run(dsn, tmp_path, dry_run=False) == 0
    assert cities(dsn, "spots") == {"test-sg-lodge": "Sagada"}
    assert cities(dsn, "last_mile_routes") == {"test-sg-lodge>vl-baguio": "Sagada"}
    assert (count(dsn, "spots"), count(dsn, "last_mile_routes")) == (1, 1)
    out = capsys.readouterr().out
    assert "spots.csv line 2: city Baguio -> Sagada (test-sg-lodge)" in out
    assert "last_mile_routes.csv line 2: city Baguio -> Sagada (test-sg-lodge > vl-baguio)" in out


def test_a_city_cell_with_spaces_is_stripped(dsn, tmp_path):
    # T67-L3: ' Sagada ' is read as Sagada, as _s strips every cell
    (tmp_path / "spots.csv").write_text("slug,name,category,lat,lng,description,visit_minutes,entrance_fee_php,city\n"
                                        "test-sg-cave,Test Sagada Cave,viewpoint,,,made-up test row,,, Sagada \n",
                                        encoding="utf-8")
    assert load_data.run(dsn, tmp_path, dry_run=False) == 0
    assert cities(dsn, "spots") == {"test-sg-cave": "Sagada"}


def test_the_repo_csvs_load_as_baguio(dsn, tmp_path):
    # T67-L2: today's data/spots.csv and data/last_mile_routes.csv (no city column) load every row as Baguio.
    # Must stay green on main too; the summary's per-city counts are L6, above.
    for name in ("spots.csv", "last_mile_routes.csv"):
        shutil.copy(load_data.HERE / name, tmp_path / name)
    assert load_data.run(dsn, tmp_path, dry_run=False) == 0
    assert set(cities(dsn, "spots").values()) == {"Baguio"}
    with psycopg.connect(dsn) as conn:
        assert conn.execute("select distinct city from last_mile_routes").fetchall() == [("Baguio",)]
    assert count(dsn, "spots") and count(dsn, "last_mile_routes")
