"""TG-40: scraper and loader error handling. Passwords and CSV rows below are made up for tests only.

Test ids (T40-*) are from test-plan.md. HTTP is never touched (fetch_all is faked and the client has a
transport that raises), the repo .env is never read, and leak checks assert with fixed messages so pytest's
own output can't echo a marker.
"""

import ast
import functools
import inspect
import json
import re
import subprocess
import sys
from datetime import date, datetime
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import httpx
import psycopg
import pytest

import load_data
import victory_liner as vl
from conftest import ROOT, TEST_DSN, write_csvs

FIXTURES = Path(__file__).parent / "fixtures"
FIXTURE = json.loads((FIXTURES / "victory_liner_cubao_baguio_2026-11-06.json").read_text())
REVERSE = json.loads((FIXTURES / "victory_liner_baguio_cubao_2026-11-08.json").read_text())
OBS = vl.parse_response(FIXTURE, "vl-cubao", "vl-baguio", date(2026, 11, 6))
REVERSE_OBS = vl.parse_response(REVERSE, "vl-baguio", "vl-cubao", date(2026, 11, 8))

MARK = "TGSECRETPW40"
NO_SCHEME = f"postgres:{MARK}@localhost:55432/x"
BAD_ESCAPE = f"postgresql://postgres:{MARK}%zz@localhost:55432/x"
SHORT = "postgresql://postgres:t4%zz@localhost:55432/x"
SPECIAL = "postgresql://postgres:p@ss:w/rd40@localhost:55432/x"
LOADER = ROOT / "data" / "load_data.py"
SRC = "https://example.test/schedule"
TRIP_ROW = f"victory-liner,vl-cubao,vl-baguio,,regular_aircon,700,360,2x2,yes,07:00,daily,,,{SRC},2026-10-24,\n"
SPOT_ROW = "burnham-park,Burnham Park,park,16.41,120.59,,90,\n"
LAST_MILE_ROW = "vl-baguio,,,burnham-park,walk,,,,,,15,2026-10-24,\n"


def leaks(out: str, *secrets: str) -> bool:
    """Checked as a bool so a failing assert shows `assert not True`, never the output."""
    return any(s in out for s in secrets)


def warning_lines(err: str) -> list[str]:
    return [line for line in err.splitlines() if line.startswith("WARNING") and "--database-url" in line]


def count(dsn, table):
    with psycopg.connect(dsn) as conn:
        return conn.execute(f"select count(*) from {table}").fetchone()[0]


def sql(dsn, statement):
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(statement)


@pytest.fixture()
def no_dotenv(monkeypatch):
    """No DATABASE_URL in env and no repo .env, unless a test sets one. Returns a setter for the .env value."""
    monkeypatch.delenv("DATABASE_URL", raising=False)

    def set_dotenv(value):
        monkeypatch.setattr(load_data, "_dotenv_database_url", lambda: value)
        monkeypatch.setattr(vl, "_dotenv_database_url", lambda: value, raising=False)

    set_dotenv(None)
    return set_dotenv


@pytest.fixture()
def marker_dsn(dsn):
    """A login role whose password is the marker, so a valid DSN can be checked for leaks (not the `tg` password).

    bypassrls like Supabase's service role (RLS only has select policies), but not a superuser.
    Cluster-wide and never dropped (other builders share tg-pg). Grants are per database and re-made per test.
    """
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(
            "do $$ begin create role tg40_marker; exception when duplicate_object or unique_violation then null; end $$"
        )
        conn.execute(f"alter role tg40_marker with login nosuperuser nocreatedb nocreaterole bypassrls password '{MARK}'")
        conn.execute("grant usage on schema public to tg40_marker")
        conn.execute("grant all on all tables in schema public to tg40_marker")
    parts = urlsplit(dsn)
    return urlunsplit(parts._replace(netloc=f"tg40_marker:{MARK}@{parts.hostname}:{parts.port}"))


def scrape(monkeypatch, capsys, *args, obs=OBS + REVERSE_OBS):
    """Run victory_liner.main() with fetch_all faked and no network. Returns (exit code, stdout, stderr)."""

    def no_network(request):
        raise AssertionError(f"test tried the network: {request.url}")

    monkeypatch.setattr(vl.httpx, "Client", functools.partial(httpx.Client, transport=httpx.MockTransport(no_network)))
    monkeypatch.setattr(vl, "fetch_all", lambda *a, **k: list(obs))
    monkeypatch.setattr(sys, "argv", ["victory_liner.py", *args])
    rc = vl.main()
    out = capsys.readouterr()
    return rc, out.out, out.err


def load(monkeypatch, capsys, data_dir, *args):
    monkeypatch.setattr(sys, "argv", ["load_data.py", "--data-dir", str(data_dir), *args])
    rc = load_data.main()
    out = capsys.readouterr()
    return rc, out.out, out.err


def load_subprocess(tmp_path, database_url):
    """python -I data/load_data.py in a temp cwd, with only DATABASE_URL (no inherited env, no repo .env read)."""
    data = write_csvs(tmp_path, TRIP_ROW)
    env = {"PATH": "/usr/bin:/bin", "DATABASE_URL": database_url}
    p = subprocess.run(
        [sys.executable, "-I", str(LOADER), "--data-dir", str(data)],
        cwd=tmp_path, env=env, capture_output=True, text=True, timeout=60,
    )
    return p.returncode, p.stdout, p.stderr


# --- Item 1: database errors are redacted ---------------------------------------------------

def test_scraper_malformed_dsn_is_redacted(dsn, monkeypatch, capsys, no_dotenv):
    """T40-1a (B1)"""
    monkeypatch.setenv("DATABASE_URL", NO_SCHEME)
    rc, out, err = scrape(monkeypatch, capsys)
    assert rc == 1
    assert "FAILED, nothing was written" in err and "database error" in err
    assert 'missing "="' in err  # readable: libpq's reason stays
    assert not leaks(out + err, MARK, NO_SCHEME), "password or DSN leaked"
    assert "Traceback" not in err


def test_scraper_bad_percent_escape_is_redacted(dsn, monkeypatch, capsys, no_dotenv):
    """T40-1b (B1)"""
    monkeypatch.setenv("DATABASE_URL", BAD_ESCAPE)
    rc, out, err = scrape(monkeypatch, capsys)
    assert rc == 1
    assert "FAILED, nothing was written" in err and "invalid percent-encoded token" in err
    assert not leaks(out + err, MARK, BAD_ESCAPE), "password or DSN leaked"


def test_scraper_short_password_is_redacted(dsn, monkeypatch, capsys, no_dotenv):
    """T40-1c (B1): under TG-13's MIN_SECRET_LEN, so env masking alone would leak it"""
    monkeypatch.setenv("DATABASE_URL", SHORT)
    rc, out, err = scrape(monkeypatch, capsys)
    assert rc == 1
    assert "FAILED, nothing was written" in err
    assert not leaks(out + err, '"t4', "t4%zz", SHORT), "short password leaked"


def test_scraper_raw_special_password_does_not_leak(dsn, monkeypatch, capsys, no_dotenv):
    """T40-1d (guard): libpq reads the host as 'ss', so only that fragment may show"""
    monkeypatch.setenv("DATABASE_URL", SPECIAL)
    rc, out, err = scrape(monkeypatch, capsys)
    assert rc == 1
    assert not leaks(out + err, "p@ss:w/rd40", "ss:w/rd40", "w/rd40", SPECIAL), "password leaked"


@pytest.mark.parametrize("source", ["flag", "dotenv"])
def test_scraper_masks_dsn_in_use_not_only_env(dsn, monkeypatch, capsys, no_dotenv, source):
    """T40-1e (B3)"""
    if source == "flag":
        rc, out, err = scrape(monkeypatch, capsys, "--database-url", NO_SCHEME)
    else:
        no_dotenv(NO_SCHEME)
        rc, out, err = scrape(monkeypatch, capsys)
    assert rc == 1
    assert "FAILED, nothing was written" in err and "database error" in err
    assert not leaks(out + err, MARK, NO_SCHEME), "password or DSN leaked"


def test_loader_malformed_dsn_is_clean_and_redacted(dsn, tmp_path):
    """T40-1f (B2)"""
    rc, out, err = load_subprocess(tmp_path, NO_SCHEME)
    assert rc != 0
    assert "Traceback" not in err, "loader printed a traceback"
    assert "FAILED, nothing was written" in err and "database error" in err
    assert not leaks(out + err, MARK, NO_SCHEME), "password or DSN leaked"


def _db_host_port():
    parts = urlsplit(TEST_DSN)
    return parts.hostname, parts.port


@pytest.mark.parametrize(
    "case",
    ["bad-escape", "short", "special", "auth-failed", "refused"],
)
def test_loader_db_errors_are_clean_readable_and_redacted(dsn, tmp_path, case):
    """T40-1g (B2, B4)"""
    host, port = _db_host_port()
    database_url, secrets, readable = {
        "bad-escape": (BAD_ESCAPE, (MARK, BAD_ESCAPE), "invalid percent-encoded token"),
        "short": (SHORT, ('"t4', "t4%zz", SHORT), None),
        "special": (SPECIAL, ("p@ss:w/rd40", "ss:w/rd40", "w/rd40", SPECIAL), None),
        "auth-failed": (
            f"postgresql://postgres:{MARK}@{host}:{port}/postgres", (MARK,),
            'password authentication failed for user "postgres"',
        ),
        "refused": (f"postgresql://postgres:{MARK}@127.0.0.1:1/x", (MARK,), "Connection refused"),
    }[case]
    rc, out, err = load_subprocess(tmp_path, database_url)
    assert rc != 0
    assert "Traceback" not in err, "loader printed a traceback"
    assert "FAILED, nothing was written" in err and "database error" in err
    if readable:
        assert readable in err
    if case == "refused":
        assert "127.0.0.1" in err and "port 1" in err  # host and port are readable context, not secrets
    assert not leaks(out + err, *secrets), "password or DSN leaked"


def test_scraper_mid_transaction_error_is_one_readable_line(marker_dsn, monkeypatch, capsys, no_dotenv):
    """T40-1h (B1, B4; review nit 3: the FAILED line stays on one line)"""
    sql(TEST_DSN, "drop table routes cascade")
    monkeypatch.setenv("DATABASE_URL", marker_dsn)
    rc, out, err = scrape(monkeypatch, capsys)
    assert rc == 1
    assert "Traceback" not in err
    failed = [line for line in err.splitlines() if "FAILED" in line]
    assert len(failed) == 1
    assert "FAILED, nothing was written (database error)" in failed[0]
    assert 'relation "routes" does not exist' in failed[0]
    assert [line for line in err.splitlines() if line.strip()] == failed, "error text spans more than one line"
    assert not leaks(out + err, MARK, marker_dsn), "password or DSN leaked"


# --- Item 2: --database-url warns ------------------------------------------------------------

def test_scraper_flag_warns_once_and_still_works(dsn, monkeypatch, capsys, no_dotenv):
    """T40-2a (B5): the flag is kept"""
    rc, out, err = scrape(monkeypatch, capsys, "--database-url", dsn)
    assert rc == 0
    lines = warning_lines(err)
    assert len(lines) == 1, "expected exactly one --database-url warning"
    assert "process list (ps)" in lines[0] and "DATABASE_URL" in lines[0]
    assert count(dsn, "trips") > 0


def test_scraper_flag_warning_never_contains_the_value(marker_dsn, monkeypatch, capsys, no_dotenv):
    """T40-2b (B5)"""
    rc, out, err = scrape(monkeypatch, capsys, "--database-url", marker_dsn)
    assert rc == 0
    lines = warning_lines(err)
    assert len(lines) == 1, "expected exactly one --database-url warning"
    assert not leaks(out + err, MARK, marker_dsn), "password or DSN leaked"


@pytest.mark.parametrize("source", ["env", "dotenv"])
def test_scraper_no_warning_without_flag(dsn, monkeypatch, capsys, no_dotenv, source):
    """T40-2c (B6, guard)"""
    if source == "env":
        monkeypatch.setenv("DATABASE_URL", dsn)
    else:
        no_dotenv(dsn)
    rc, out, err = scrape(monkeypatch, capsys)
    assert rc == 0
    assert warning_lines(err) == []
    assert count(dsn, "trips") > 0


def test_flag_still_wins_over_env_and_dotenv(dsn, monkeypatch, capsys, no_dotenv):
    """T40-2a/2c precedence guard: flag, then env, then .env"""
    monkeypatch.setenv("DATABASE_URL", NO_SCHEME)
    no_dotenv(SHORT)
    rc, _, _ = scrape(monkeypatch, capsys, "--database-url", dsn)
    assert rc == 0
    monkeypatch.delenv("DATABASE_URL")
    no_dotenv(dsn)
    rc, _, _ = scrape(monkeypatch, capsys)
    assert rc == 0


@pytest.mark.parametrize("with_flag", [True, False])
def test_loader_flag_warns_and_env_does_not(dsn, monkeypatch, capsys, no_dotenv, tmp_path, with_flag):
    """T40-2d (B5, B6)"""
    write_csvs(tmp_path, TRIP_ROW)
    if with_flag:
        rc, out, err = load(monkeypatch, capsys, tmp_path, "--dry-run", "--database-url", dsn)
    else:
        monkeypatch.setenv("DATABASE_URL", dsn)
        rc, out, err = load(monkeypatch, capsys, tmp_path, "--dry-run")
    assert rc == 0
    assert "Dry run OK" in out
    lines = warning_lines(err)
    assert len(lines) == (1 if with_flag else 0)
    if with_flag:
        assert "process list (ps)" in lines[0]
        assert not leaks(lines[0], dsn), "warning contains the DSN"


@pytest.mark.parametrize("module", [vl, load_data], ids=["scraper", "loader"])
def test_help_marks_flag_deprecated(monkeypatch, capsys, module):
    """T40-2e (B7)"""
    monkeypatch.setattr(sys, "argv", ["x.py", "--help"])
    with pytest.raises(SystemExit) as exit_:
        module.main()
    assert exit_.value.code == 0
    text = " ".join(capsys.readouterr().out.split())
    assert "deprecated" in text and "visible in ps" in text and "DATABASE_URL" in text, "--database-url help isn't marked deprecated"


# --- Item 3: missing seed rows ---------------------------------------------------------------

def booking_url(dsn):
    with psycopg.connect(dsn) as conn:
        row = conn.execute("select booking_url from operators where slug = 'victory-liner'").fetchone()
    return row and row[0]


def test_scraper_missing_operator_seed(dsn, monkeypatch, capsys, no_dotenv):
    """T40-3a (B8)"""
    sql(dsn, "delete from operators where slug = 'victory-liner'")
    monkeypatch.setenv("DATABASE_URL", dsn)
    rc, out, err = scrape(monkeypatch, capsys)
    assert rc == 1
    assert "FAILED, nothing was written" in err and "'victory-liner'" in err and "supabase/schema.sql" in err
    assert "Traceback" not in err
    assert (count(dsn, "routes"), count(dsn, "trips")) == (0, 0)


@pytest.mark.parametrize("slug", ["vl-cubao", "vl-baguio"], ids=["T40-3b", "T40-3b2"])
def test_scraper_missing_terminal_seed_writes_nothing(dsn, monkeypatch, capsys, no_dotenv, slug):
    """T40-3b, T40-3b2 (B9): validated before the booking_url update"""
    sql(dsn, f"delete from terminals where slug = '{slug}'")
    before = booking_url(dsn)
    monkeypatch.setenv("DATABASE_URL", dsn)
    rc, out, err = scrape(monkeypatch, capsys)
    assert rc == 1
    assert "FAILED, nothing was written" in err and f"'{slug}'" in err and "supabase/schema.sql" in err
    assert "Traceback" not in err
    assert (count(dsn, "routes"), count(dsn, "trips")) == (0, 0)
    assert booking_url(dsn) == before


def test_scraper_missing_unobserved_terminal_fails_fast(dsn, monkeypatch, capsys, no_dotenv):
    """T40-3b3 (B9, pinned: fail fast even when the slug got no observations)"""
    sql(dsn, "delete from terminals where slug = 'vl-sampaloc'")
    monkeypatch.setenv("DATABASE_URL", dsn)
    rc, out, err = scrape(monkeypatch, capsys)  # Cubao-only observations
    assert rc == 1
    assert "FAILED, nothing was written" in err and "'vl-sampaloc'" in err and "supabase/schema.sql" in err
    assert count(dsn, "trips") == 0


def test_scraper_apply_raises_scrape_error_for_missing_seed(dsn):
    """T40-3g (B8)"""
    sql(dsn, "delete from operators where slug = 'victory-liner'")
    routes = vl.aggregate(OBS + REVERSE_OBS)
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        with pytest.raises(vl.ScrapeError, match=r"missing operator slug 'victory-liner' \(run supabase/schema.sql seeds\)"):
            vl.apply(cur, routes, datetime.now(vl.MANILA), ["to-baguio", "from-baguio"])


def test_loader_missing_operator_seed(dsn, monkeypatch, capsys, no_dotenv, tmp_path):
    """T40-3c (B10, B11)"""
    sql(dsn, "delete from operators where slug = 'victory-liner'")
    write_csvs(tmp_path, TRIP_ROW)
    monkeypatch.setenv("DATABASE_URL", dsn)
    rc, out, err = load(monkeypatch, capsys, tmp_path)
    assert rc != 0
    assert "FAILED, nothing was written" in err and "'victory-liner'" in err and "supabase/schema.sql" in err
    assert count(dsn, "trips") == 0


def test_loader_missing_terminal_seed(dsn, monkeypatch, capsys, no_dotenv, tmp_path):
    """T40-3d (B10, B11)"""
    sql(dsn, "delete from terminals where slug = 'vl-baguio'")
    write_csvs(tmp_path, spots=SPOT_ROW, last_mile=LAST_MILE_ROW)
    monkeypatch.setenv("DATABASE_URL", dsn)
    rc, out, err = load(monkeypatch, capsys, tmp_path)
    assert rc != 0
    assert "FAILED, nothing was written" in err and "'vl-baguio'" in err and "supabase/schema.sql" in err
    assert (count(dsn, "spots"), count(dsn, "last_mile_routes")) == (0, 0)


def test_loader_schema_not_applied(marker_dsn, monkeypatch, capsys, no_dotenv, tmp_path):
    """T40-3e (B2)"""
    sql(TEST_DSN, "drop table operators cascade")
    write_csvs(tmp_path, TRIP_ROW)
    monkeypatch.setenv("DATABASE_URL", marker_dsn)
    rc, out, err = load(monkeypatch, capsys, tmp_path)
    assert rc != 0
    assert "FAILED, nothing was written" in err
    assert 'relation "operators" does not exist' in err and "supabase/schema.sql" in err
    assert "Traceback" not in err
    assert not leaks(out + err, MARK, marker_dsn), "password or DSN leaked"


def test_loader_typo_still_lists_known_slugs(dsn, monkeypatch, capsys, no_dotenv, tmp_path):
    """T40-3f (B10, guard): a typo with the seeds present"""
    write_csvs(tmp_path, TRIP_ROW.replace("victory-liner", "victory-linr", 1))
    monkeypatch.setenv("DATABASE_URL", dsn)
    rc, out, err = load(monkeypatch, capsys, tmp_path)
    assert rc == 1
    assert "routes_trips.csv line 2: unknown operator 'victory-linr'; known: genesis, solid-north, victory-liner" in out + err
    assert count(dsn, "trips") == 0


# --- Reuse and scope guards ------------------------------------------------------------------

PASSWORD_REGEX = re.compile(r"re\.compile\(.*(://|password)", re.I)


def _imports_from(path: Path) -> dict[str, set[str]]:
    """{module: names} for every `from module import names` in the file (relative modules keep their dots)."""
    found: dict[str, set[str]] = {}
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.ImportFrom):
            found.setdefault("." * node.level + (node.module or ""), set()).update(a.name for a in node.names)
    return found


def test_one_masking_source():
    """T40-4a (B13): no second password regex; both scripts mask through the shared stdlib-only helper"""
    tracked = subprocess.run(["git", "ls-files", "*.py"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split()
    with_regex = sorted(
        f for f in tracked
        if not f.startswith("api/tests/") and PASSWORD_REGEX.search((ROOT / f).read_text(encoding="utf-8"))
    )
    assert len(with_regex) == 1 and with_regex[0].startswith("api/app/"), with_regex
    home = Path(with_regex[0]).stem  # logging_setup today, redact after the move

    loader_imports = _imports_from(LOADER)
    assert any(m in (f"app.{home}", "app.logging_setup") for m in loader_imports), "load_data.py doesn't import the masking helper"
    if home != "logging_setup":
        setup_imports = _imports_from(ROOT / "api" / "app" / "logging_setup.py")
        assert f".{home}" in setup_imports or f"app.{home}" in setup_imports, "logging_setup.py doesn't use the shared helper"
    scraper_imports = _imports_from(ROOT / "scraper" / "victory_liner.py")
    assert "db_failure" in scraper_imports.get("load_data", set()) or f"app.{home}" in scraper_imports, \
        "victory_liner.py doesn't mask through the shared helper"


def test_scripts_do_not_import_fastapi():
    """T40-4b (B13, guard)"""
    code = (
        f"import sys; sys.path[:0] = [{str(ROOT / 'scraper')!r}, {str(ROOT / 'data')!r}]; "
        "import victory_liner, load_data; "
        "print(any(m.split('.')[0] in ('fastapi', 'starlette') for m in sys.modules))"
    )
    p = subprocess.run([sys.executable, "-I", "-c", code], cwd=ROOT, capture_output=True, text=True, timeout=30)
    assert p.returncode == 0, p.stderr
    assert p.stdout.strip() == "False"


LOAD_DATA_SIGNATURES = {
    "read_csv": ["path"],
    "slug_map": ["cur", "table"],
    "load_spots": ["cur", "rows"],
    "load_routes_trips": ["cur", "rows"],
    "load_last_mile": ["cur", "rows"],
    "run": ["dsn", "data_dir", "dry_run"],
    "main": [],
    "_lookup": ["mapping", "slug", "what"],
    "_dotenv_database_url": [],
}


@pytest.mark.parametrize("name", sorted(LOAD_DATA_SIGNATURES))
def test_load_data_signatures_are_stable(name):
    """T40-5 (B14, guard for TG-24): existing parameters unchanged; only keyword-only ones with defaults may be added"""
    params = list(inspect.signature(getattr(load_data, name)).parameters.values())
    expected = LOAD_DATA_SIGNATURES[name]
    assert [p.name for p in params[: len(expected)]] == expected
    for p in params[: len(expected)]:
        assert p.kind is p.POSITIONAL_OR_KEYWORD and p.default is p.empty, p.name
    for p in params[len(expected):]:
        assert p.kind is p.KEYWORD_ONLY and p.default is not p.empty, p.name


def test_names_the_scraper_imports_still_exist():
    """T40-5 (B14, guard)"""
    for name in ("MANILA", "_dotenv_database_url", "slug_map"):
        assert hasattr(load_data, name), name
