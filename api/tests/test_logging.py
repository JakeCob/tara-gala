"""TG-13: request and error logging. Fixture data below is made up for tests only, not real schedules.

Test ids (T13-*) are from test-plan.md. Process tests start the API the way Railway does,
from api/Procfile, with this venv's python (`python -m uvicorn`), and always stop it.
"""

import ast
import importlib
import logging
import logging.config
import os
import re
import socket
import subprocess
import sys
import time
import traceback
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import httpx
import psycopg
import pytest

import load_data
from conftest import write_csvs

ROOT = Path(__file__).resolve().parents[2]
API = ROOT / "api"
SRC = "https://example.test/schedule"

TRIPS = (
    f"victory-liner,vl-cubao,vl-baguio,,regular_aircon,700,360,2x2,yes,07:00,daily,2026-11-01,,{SRC},2026-10-24,\n"
    f"victory-liner,vl-cubao,vl-baguio,,regular_aircon,700,360,2x2,yes,22:00,daily,2026-11-01,,{SRC},2026-10-24,\n"
)
SEARCH = {"origin_city": "Metro Manila", "destination_city": "Baguio", "date": "2026-11-06"}

# Secret markers: none of these may appear in any log output
DSN_PASSWORD = "TGSECRETDSN7"  # password of a throwaway login role, so the DSN marker is a real secret
LLM_KEY = "sk-TGSECRETKEY9"
SERVICE_KEY = "TGSECRETSVC3"
SECRET_HEADERS = {"Authorization": "Bearer TGSECRETHDR5", "Cookie": "session=TGSECRETCKE1"}
MARKERS = [DSN_PASSWORD, LLM_KEY, SERVICE_KEY, "TGSECRETHDR5", "TGSECRETCKE1"]

REQUEST_LINE = re.compile(r"request method=GET path='(?P<path>[^']*)' status=(?P<status>\d{3}) duration_ms=(?P<ms>\d+(?:\.\d+)?)")


def setup_mod():
    return importlib.import_module("app.logging_setup")


def request_records(caplog):
    return [r for r in caplog.records if r.name == "tara_gala.request" and r.levelno == logging.INFO]


def error_records(caplog):
    return [r for r in caplog.records if r.levelno >= logging.ERROR]


def assert_no_secrets(text: str, marker_dsn: str | None = None):
    for m in MARKERS + ([marker_dsn] if marker_dsn else []):
        assert m not in text, f"secret marker {m!r} leaked into logs"


def drop_trip_search(dsn):
    """Makes /trips fail with a real psycopg UndefinedTable whose message carries SQL text."""
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute("drop view trip_search")


@pytest.fixture()
def restore_logging():
    """Undo configure_logging() calls made by a test: root level, our handlers, uvicorn loggers."""
    root = logging.getLogger()
    level = root.level
    ours = [h for h in root.handlers if getattr(h, "_tara_gala", False)]
    names = ("uvicorn", "uvicorn.error", "uvicorn.access")
    saved = {n: (lg.level, list(lg.handlers), lg.propagate, lg.disabled) for n in names for lg in [logging.getLogger(n)]}
    yield
    for h in list(root.handlers):
        if getattr(h, "_tara_gala", False) and h not in ours:
            root.removeHandler(h)
    for h in ours:
        if h not in root.handlers:
            root.addHandler(h)
    root.setLevel(level)
    for n, (lvl, handlers, propagate, disabled) in saved.items():
        lg = logging.getLogger(n)
        lg.setLevel(lvl)
        lg.handlers[:] = handlers
        lg.propagate = propagate
        lg.disabled = disabled


@pytest.fixture()
def marker_dsn(dsn):
    """A DSN for a login role whose password is a marker. Grants are re-made because dsn rebuilds the schema.

    The role is cluster-wide in tg-pg but has no privileges outside this test DB. To remove it, run
    `drop owned by tg13_marker` in each DB that has grants, then `drop role tg13_marker`.
    """
    with psycopg.connect(dsn, autocommit=True) as conn:
        # Race-safe create, then reset attributes and password every run so a changed marker never goes stale
        conn.execute(
            "do $$ begin create role tg13_marker; exception when duplicate_object then null; end $$"
        )
        conn.execute(f"alter role tg13_marker with login nosuperuser nocreatedb nocreaterole password '{DSN_PASSWORD}'")
        conn.execute("grant usage on schema public to tg13_marker")
        conn.execute("grant select on all tables in schema public to tg13_marker")
    parts = urlsplit(dsn)
    return urlunsplit(parts._replace(netloc=f"tg13_marker:{DSN_PASSWORD}@{parts.hostname}:{parts.port}"))


# --- unit: setup, level, redaction ---------------------------------------------------------


def test_logging_setup_is_stdlib_only():
    """T13-L1"""
    setup_mod()
    tree = ast.parse((API / "app" / "logging_setup.py").read_text(encoding="utf-8"))
    top = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            top |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom) and node.level == 0:
            top.add(node.module.split(".")[0])
    assert top <= set(sys.stdlib_module_names) | {"fastapi", "starlette"}, top


def test_single_root_config():
    """T13-L2 (plan B1): no basicConfig left in main.py; one root handler even after a second setup call."""
    assert "basicConfig" not in (API / "app" / "main.py").read_text(encoding="utf-8")
    code = "import app.main, app.logging_setup as s; s.configure_logging(); import logging; print(len(logging.getLogger().handlers))"
    out = subprocess.run([sys.executable, "-c", code], cwd=API, capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == "1"


@pytest.mark.parametrize(
    "env, expected",
    [({"LOG_LEVEL": "INFO"}, logging.INFO), ({"LOG_LEVEL": "debug"}, logging.DEBUG),
     ({"LOG_LEVEL": "Warning"}, logging.WARNING), ({}, logging.INFO)],
)
def test_log_level_from_env(restore_logging, env, expected):
    """T13-V1 (plan B1)"""
    setup_mod().configure_logging(env)
    assert logging.getLogger().level == expected


def test_unknown_log_level_warns_and_uses_info(restore_logging, caplog, capsys):
    """T13-V2 (plan B2): one WARNING naming the bad value, written through our handler."""
    setup_mod().configure_logging({"LOG_LEVEL": "loud"})
    assert logging.getLogger().level == logging.INFO
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert "'loud'" in warnings[0].getMessage()
    assert "WARNING tara_gala.api LOG_LEVEL='loud' is not a log level; using INFO" in capsys.readouterr().out


def test_app_loggers_reach_root_at_info(restore_logging, capsys):
    """T13-T1: TG-35's flag INFO line and bad-value WARNING still come out through our handler."""
    setup_mod().configure_logging({"LOG_LEVEL": "INFO"})
    flags_logger = logging.getLogger("tara_gala.flags")
    assert flags_logger.isEnabledFor(logging.INFO)
    assert flags_logger.propagate

    from app import flags

    flags.get_flags.cache_clear()
    try:
        flags.get_flags()
        flags.load_flags({"PLANNER_LIVE": "maybe"})
    finally:
        flags.get_flags.cache_clear()
    out = capsys.readouterr().out
    assert re.search(r"INFO tara_gala\.flags feature flags: planner_live=", out)
    assert "WARNING tara_gala.flags PLANNER_LIVE='maybe' is not a recognised flag value" in out


def test_uvicorn_loggers_routed_through_root(restore_logging):
    """T13-R4 unit part (plan B5 + review should-fix 2): no uvicorn access log; uvicorn lines follow LOG_LEVEL."""
    import uvicorn.config

    logging.config.dictConfig(uvicorn.config.LOGGING_CONFIG)  # what uvicorn does before importing the app
    setup_mod().configure_logging({"LOG_LEVEL": "WARNING"})

    access = logging.getLogger("uvicorn.access")
    assert access.disabled and not access.handlers and not access.propagate
    assert not access.hasHandlers()  # uvicorn 0.32 skips its access line when this is False
    for name in ("uvicorn", "uvicorn.error"):
        lg = logging.getLogger(name)
        assert not lg.handlers and lg.propagate
        assert lg.level == logging.NOTSET
        assert not lg.isEnabledFor(logging.INFO)


def test_redacting_formatter_masks_secrets():
    """T13-X3 (plan B8b + review should-fix 3): env secrets, URL passwords, bare and password= forms, tracebacks."""
    s = setup_mod()
    env = {
        "DATABASE_URL": "postgresql://tg13:p%40ss%2Fword9@db.example.test:5432/postgres",
        "LLM_API_KEY": LLM_KEY,
        "SUPABASE_SERVICE_KEY": SERVICE_KEY,
        "PATH": "/usr/local/bin:/usr/bin",
    }
    fmt = s.RedactingFormatter(s.secret_values(env))

    def render(msg, exc_info=None):
        return fmt.format(logging.LogRecord("tara_gala.api", logging.ERROR, __file__, 1, msg, None, exc_info))

    cases = {
        "full DSN": f"connecting to {env['DATABASE_URL']}",
        "keys": f"llm={LLM_KEY} service={SERVICE_KEY}",
        "bare raw password": "auth failed for p%40ss%2Fword9",
        "bare decoded password": "auth failed for p@ss/word9",
        "key=value password": "conninfo host=h password=hunter2xyz dbname=db",
        "other URL password": "retrying postgresql://u:s3cretpw@h/db",
    }
    for label, msg in cases.items():
        text = render(msg)
        for secret in ("p%40ss%2Fword9", "p@ss/word9", LLM_KEY, SERVICE_KEY, "hunter2xyz", "s3cretpw"):
            assert secret not in text, f"{label}: {secret!r} not masked in {text!r}"
        assert "***" in text, label
    assert "password=***" in render(cases["key=value password"])
    assert "/usr/local/bin" in render("PATH is /usr/local/bin")  # non-secret env values are left alone

    try:
        raise RuntimeError(f"boom postgresql://u:s3cretpw@h/db with {LLM_KEY}")
    except RuntimeError:
        text = render("unhandled error", sys.exc_info())
    assert "Traceback (most recent call last)" in text and "RuntimeError" in text
    assert "s3cretpw" not in text and LLM_KEY not in text


# --- in-process API: request line, errors, search, secrets -------------------------------


@pytest.mark.parametrize(
    "path, params, status",
    [("/health", None, 200), ("/terminals", {"city": "Baguio"}, 200), ("/nope", None, 404)],
)
def test_one_request_line_per_request(client, caplog, path, params, status):
    """T13-R1 (plan B3/B4)"""
    caplog.set_level(logging.INFO)
    r = client.get(path, params=params)
    assert r.status_code == status
    lines = request_records(caplog)
    assert len(lines) == 1, [rec.getMessage() for rec in caplog.records]
    m = REQUEST_LINE.fullmatch(lines[0].getMessage())
    assert m, lines[0].getMessage()
    assert (m["path"], int(m["status"])) == (path, status)
    assert 0 <= float(m["ms"]) < 10_000
    assert "Baguio" not in lines[0].getMessage()  # no query string
    assert error_records(caplog) == []


def test_request_line_status_for_validation_error(client, caplog):
    """T13-R2 (plan B4)"""
    caplog.set_level(logging.INFO)
    r = client.get("/trips", params={"date": "not-a-date"})
    assert r.status_code == 422
    lines = request_records(caplog)
    assert len(lines) == 1, [rec.getMessage() for rec in caplog.records]
    m = REQUEST_LINE.fullmatch(lines[0].getMessage())
    assert m and m["path"] == "/trips" and m["status"] == "422", lines[0].getMessage()
    assert error_records(caplog) == []


def test_request_line_escapes_and_omits_headers(client, caplog):
    """T13-R3 (plan B3): a newline in user text can't forge a line; headers and cookies are never logged."""
    caplog.set_level(logging.DEBUG)
    params = {**SEARCH, "origin_city": "Baguio\nFAKE 500 line"}
    r = client.get("/trips", params=params, headers=SECRET_HEADERS)
    assert r.status_code == 200
    lines = request_records(caplog)
    assert len(lines) == 1, [rec.getMessage() for rec in caplog.records]
    assert REQUEST_LINE.fullmatch(lines[0].getMessage())
    for rec in caplog.records:
        if rec.name.startswith("tara_gala"):
            msg = rec.getMessage()
            assert "\n" not in msg, msg
            if "FAKE 500 line" in msg:
                assert "\\nFAKE 500 line" in msg, msg
    assert "TGSECRETHDR5" not in caplog.text and "TGSECRETCKE1" not in caplog.text


def test_unhandled_error_logs_stack_trace_and_returns_generic_500(dsn, client, caplog):
    """T13-E1, T13-E2 (plan B6). Default TestClient re-raises server errors, so this also proves nothing escapes."""
    drop_trip_search(dsn)
    caplog.set_level(logging.INFO)
    try:
        r = client.get("/trips", params=SEARCH, headers={"Origin": "http://localhost:3000"})
    except Exception as e:  # noqa: BLE001
        pytest.fail(f"unhandled error escaped the app to the server: {type(e).__name__}")

    assert r.status_code == 500
    assert r.json() == {"detail": "Internal server error"}
    assert r.headers.get("access-control-allow-origin") == "http://localhost:3000"
    for leak in ("Traceback", "trip_search", "select", "UndefinedTable", "psycopg"):
        assert leak not in r.text

    errors = error_records(caplog)
    assert len(errors) == 1, [rec.getMessage() for rec in errors]
    err = errors[0]
    assert err.name == "tara_gala.request" and err.exc_info
    trace = "".join(traceback.format_exception(*err.exc_info))
    assert "Traceback (most recent call last)" in trace and "UndefinedTable" in trace
    assert "GET" in err.getMessage() and "'/trips'" in err.getMessage()  # T13-E2

    lines = request_records(caplog)
    assert len(lines) == 1
    m = REQUEST_LINE.fullmatch(lines[0].getMessage())
    assert m and m["path"] == "/trips" and m["status"] == "500", lines[0].getMessage()


def test_search_logs_params_and_count(dsn, client, caplog, tmp_path):
    """T13-S1 (plan B7). TG-12's line is already on main, so this is a characterisation guard that passes at RED."""
    write_csvs(tmp_path, TRIPS)
    assert load_data.run(dsn, tmp_path, dry_run=False) == 0
    caplog.set_level(logging.INFO)

    def search_lines():
        return [r.getMessage() for r in caplog.records if r.name == "tara_gala.api" and r.getMessage().startswith("trips search")]

    assert len(client.get("/trips", params=SEARCH).json()) == 2
    lines = search_lines()
    assert len(lines) == 1
    for part in ("date=2026-11-06", "origin_city='Metro Manila'", "destination_city='Baguio'", "results=2"):
        assert part in lines[0], lines[0]

    caplog.clear()
    assert client.get("/trips", params={**SEARCH, "date": "2026-10-30"}).json() == []  # before valid_from
    lines = search_lines()
    assert len(lines) == 1 and "results=0" in lines[0], lines


def test_no_secrets_in_logs(dsn, marker_dsn, monkeypatch, caplog, tmp_path):
    """T13-X1 (plan B8a): startup, 200, 404, 422 and the error path at DEBUG never log a secret. Guard at RED."""
    from fastapi.testclient import TestClient

    write_csvs(tmp_path, TRIPS)
    assert load_data.run(dsn, tmp_path, dry_run=False) == 0
    monkeypatch.setenv("DATABASE_URL", marker_dsn)
    monkeypatch.setenv("LLM_API_KEY", LLM_KEY)
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", SERVICE_KEY)
    from app.main import app

    caplog.set_level(logging.DEBUG)
    with TestClient(app, raise_server_exceptions=False, headers=SECRET_HEADERS) as c:
        assert c.get("/health").status_code == 200  # the marker role can connect
        assert len(c.get("/trips", params=SEARCH).json()) == 2  # and read through RLS
        c.get("/nope")
        c.get("/trips", params={"date": "nope"})
        drop_trip_search(dsn)
        assert c.get("/trips", params=SEARCH).status_code == 500

    text = caplog.text + "".join(r.exc_text or "" for r in caplog.records) + "".join(str(r.args) for r in caplog.records)
    assert_no_secrets(text, marker_dsn)


# --- process: the API as Railway starts it ----------------------------------------------


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def procfile_cmd(port: int) -> list[str]:
    """api/Procfile's web command, run with this venv's python (review should-fix 5), bound to localhost."""
    line = (API / "Procfile").read_text(encoding="utf-8").strip()
    assert line.startswith("web: uvicorn "), line
    args = [a.replace("$PORT", str(port)).replace("0.0.0.0", "127.0.0.1") for a in line.split()[2:]]
    return [sys.executable, "-m", "uvicorn", *args]


def run_api(env: dict, calls: list[tuple[str, dict | None]]) -> tuple[str, list[httpx.Response]]:
    """Start the API, make the calls once each, stop it. Returns merged stdout+stderr and the responses."""
    port = free_port()
    proc_env = {k: v for k, v in os.environ.items() if k != "LOG_LEVEL"}
    proc_env.update(PYTHONUNBUFFERED="1", LLM_API_KEY=LLM_KEY, SUPABASE_SERVICE_KEY=SERVICE_KEY, **env)
    proc = subprocess.Popen(procfile_cmd(port), cwd=API, env=proc_env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    responses = []
    try:
        deadline = time.monotonic() + 15
        while True:  # wait for the port, not /health, so readiness adds no request line
            if proc.poll() is not None:
                pytest.fail(f"API exited early:\n{proc.communicate()[0]}")
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
                break
            except OSError:
                if time.monotonic() > deadline:
                    pytest.fail("API did not start within 15 s")
                time.sleep(0.05)
        with httpx.Client(base_url=f"http://127.0.0.1:{port}", headers={**SECRET_HEADERS, "Origin": "http://localhost:3000"}, timeout=10) as c:
            for path, params in calls:
                responses.append(c.get(path, params=params))
    finally:
        proc.terminate()
        try:
            out = proc.communicate(timeout=10)[0]
        except subprocess.TimeoutExpired:
            proc.kill()
            out = proc.communicate()[0]
    return out, responses


def lines_for(out: str, path: str) -> list[str]:
    return [line for line in out.splitlines() if f"path='{path}'" in line]


def test_procfile_process_logs_one_line_per_request(marker_dsn):
    """T13-R4, T13-X2 (plan B5): exactly one line per request, with a duration; no uvicorn access line."""
    out, rs = run_api({"DATABASE_URL": marker_dsn}, [("/health", None), ("/terminals", None), ("/nope", None)])
    assert [r.status_code for r in rs] == [200, 200, 404]
    for path, status in (("/health", 200), ("/terminals", 200), ("/nope", 404)):
        found = lines_for(out, path)
        assert len(found) == 1, f"{path}: {found}\n--- output ---\n{out}"
        assert f"status={status}" in found[0] and re.search(r"duration_ms=\d", found[0]), found[0]
    assert not re.search(r'"GET /\S* HTTP/1\.1" \d{3}', out), f"uvicorn access line present:\n{out}"
    assert_no_secrets(out, marker_dsn)


def test_procfile_process_logs_one_traceback_per_error(dsn, marker_dsn):
    """T13-E3, T13-X2 at DEBUG (plan B6): one traceback per unhandled error, JSON 500, no secrets."""
    drop_trip_search(dsn)
    out, (r,) = run_api({"DATABASE_URL": marker_dsn, "LOG_LEVEL": "DEBUG"}, [("/trips", SEARCH)])
    assert "Exception in ASGI application" not in out, f"uvicorn logged the error too:\n{out}"
    assert out.count("Traceback (most recent call last)") == 1, out
    found = lines_for(out, "/trips")
    assert len([line for line in found if "status=500" in line]) == 1, f"{found}\n--- output ---\n{out}"
    assert r.status_code == 500
    assert r.json() == {"detail": "Internal server error"}
    assert_no_secrets(out, marker_dsn)


def test_log_level_warning_in_process(marker_dsn):
    """T13-V3 (plan B1/B2 + review should-fix 2): WARNING hides INFO lines, uvicorn's included; a bad value warns."""
    out, (r,) = run_api({"DATABASE_URL": marker_dsn, "LOG_LEVEL": "WARNING"}, [("/health", None)])
    assert r.status_code == 200
    assert lines_for(out, "/health") == [], out
    assert "Application startup complete" not in out, f"uvicorn INFO line ignores LOG_LEVEL:\n{out}"
    assert_no_secrets(out, marker_dsn)

    out, (r,) = run_api({"DATABASE_URL": marker_dsn, "LOG_LEVEL": "loud"}, [("/health", None)])
    assert r.status_code == 200
    assert re.search(r"WARNING tara_gala\.api LOG_LEVEL='loud' is not a log level; using INFO", out), out
    found = lines_for(out, "/health")
    assert len(found) == 1 and "status=200" in found[0], out
    assert_no_secrets(out, marker_dsn)
