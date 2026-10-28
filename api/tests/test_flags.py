"""Feature flag tests (TG-35). Pure: no database, but conftest skips without TEST_DATABASE_URL."""

import ast
import dataclasses
import logging
import re
from pathlib import Path

import pytest

from app.flags import Flags, get_flags, load_flags, parse_flag

ROOT = Path(__file__).resolve().parents[2]
LOGGER = "tara_gala.flags"
ENV_NAMES = {f.name.upper(): f for f in dataclasses.fields(Flags)}

# (raw, default, expected). Keep identical to the table in web/src/lib/flags.test.ts.
CASES = [
    (None, False, False),
    (None, True, True),
    ("", True, True),
    ("   ", False, False),
    ("1", False, True),
    ("true", False, True),
    (" TRUE ", False, True),
    ("yes", False, True),
    ("On", False, True),
    ("0", True, False),
    ("false", True, False),
    ("No", True, False),
    (" off ", True, False),
    ("ture", False, False),
    ("maybe", True, True),
    ("2", False, False),
    ("-1", True, True),
    ("truee", True, True),
]


def warnings(caplog):
    return [r for r in caplog.records if r.name == LOGGER and r.levelno == logging.WARNING]


@pytest.fixture()
def clean_env(monkeypatch):
    for name in ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


@pytest.fixture()
def fresh_cache():
    get_flags.cache_clear()
    yield
    get_flags.cache_clear()


def test_defaults_when_unset():
    assert set(ENV_NAMES) == {"PLANNER_LIVE", "PREMADE_ITINERARIES", "REAL_MAP"}
    flags = load_flags({})
    assert flags == Flags()
    assert flags.planner_live is False
    assert flags.premade_itineraries is True
    assert flags.real_map is False


@pytest.mark.parametrize("name", sorted(ENV_NAMES))
def test_each_flag_can_be_overridden(name):
    field = ENV_NAMES[name]
    opposite = not field.default
    flags = load_flags({name: "true" if opposite else "false"})
    assert flags == dataclasses.replace(Flags(), **{field.name: opposite})


@pytest.mark.parametrize("raw,default,expected", CASES)
def test_parse_flag_cases(raw, default, expected):
    assert parse_flag("SOME_FLAG", raw, default) is expected


def test_garbage_value_falls_back_and_warns(caplog):
    caplog.set_level(logging.WARNING, logger=LOGGER)
    assert load_flags({"PLANNER_LIVE": "ture"}).planner_live is False
    records = warnings(caplog)
    assert len(records) == 1
    assert "PLANNER_LIVE" in records[0].getMessage()
    assert "'ture'" in records[0].getMessage()


def test_empty_and_valid_values_do_not_warn(caplog):
    caplog.set_level(logging.WARNING, logger=LOGGER)
    assert load_flags({"REAL_MAP": ""}).real_map is False
    assert load_flags({"PLANNER_LIVE": " TRUE "}).planner_live is True
    assert warnings(caplog) == []


def test_reads_os_environ(clean_env):
    clean_env.setenv("PLANNER_LIVE", "1")
    assert load_flags().planner_live is True
    clean_env.delenv("PLANNER_LIVE")
    assert load_flags().planner_live is False


def test_get_flags_logs_once_and_caches(clean_env, fresh_cache, caplog):
    clean_env.setenv("PLANNER_LIVE", "yes")
    clean_env.setenv("DATABASE_URL", "postgresql://u:s3cret@x/db")
    caplog.set_level(logging.INFO, logger=LOGGER)

    first = get_flags()
    second = get_flags()

    assert first is second
    assert first == Flags(planner_live=True)
    infos = [r for r in caplog.records if r.name == LOGGER and r.levelno == logging.INFO]
    assert len(infos) == 1
    message = infos[0].getMessage()
    for pair in ("planner_live=True", "premade_itineraries=True", "real_map=False"):
        assert pair in message
    assert "s3cret" not in caplog.text


def test_flags_module_is_stdlib_only():
    tree = ast.parse((ROOT / "api" / "app" / "flags.py").read_text(encoding="utf-8"))
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            assert node.level == 0, "flags.py must not import from the app package"
            imported.add(node.module)
    allowed = {"logging", "os", "collections.abc", "dataclasses", "functools", "typing", "__future__"}
    assert imported <= allowed, imported - allowed


def test_flags_documented():
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    start = readme.find("## 7.")
    assert start != -1, "README needs a '## 7.' feature flags section"
    section = readme[start:]
    root_env = (ROOT / ".env.example").read_text(encoding="utf-8")
    web_env = (ROOT / "web" / ".env.example").read_text(encoding="utf-8")

    for word in ("1", "yes", "on", "0", "no", "off"):
        assert f"`{word}`" in section, word
    assert "build" in section  # web flags are baked in at next build
    assert "restart" in section  # get_flags() caches for the process lifetime
    assert "22.18" in section  # npm test needs Node type stripping

    for name, field in ENV_NAMES.items():
        default = "true" if field.default else "false"
        web_name = f"NEXT_PUBLIC_{name}"
        rows = [line for line in section.splitlines() if f"`{name}`" in line and web_name in line]
        assert rows, f"README section 7 has no row for {name}"
        assert f"`{default}`" in rows[0], f"README default for {name}"
        assert re.search(rf"^{name}={default}$", root_env, re.M), f".env.example {name}"
        assert re.search(rf"^{web_name}={default}$", root_env, re.M), f".env.example {web_name}"
        assert re.search(rf"^{web_name}={default}$", web_env, re.M), f"web/.env.example {web_name}"
