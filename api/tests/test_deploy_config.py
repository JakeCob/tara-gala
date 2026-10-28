"""TG-11: Railway deploy config for the api and web services. Static checks, no database access.

Skipped like the rest of the suite when TEST_DATABASE_URL is unset (conftest); skipped is not a pass.
"""

import ast
import json
import re

import pytest

from conftest import ROOT

SERVICES = {"api": "/health", "web": "/"}
SECRET_LIKE = re.compile(r"postgres(ql)?://|password|KEY=", re.I)


def config(service):
    return json.loads((ROOT / service / "railway.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("service", sorted(SERVICES))
def test_railway_json_builds_with_railpack(service):
    assert config(service)["build"]["builder"] == "RAILPACK"


@pytest.mark.parametrize("service", sorted(SERVICES))
def test_start_command_binds_all_interfaces_on_8080(service):
    cmd = config(service)["deploy"]["startCommand"]
    assert "0.0.0.0" in cmd, cmd
    assert re.search(r"(--port|-p)\s+8080\b", cmd), cmd


@pytest.mark.parametrize("service,path", sorted(SERVICES.items()))
def test_healthcheck_path(service, path):
    assert config(service)["deploy"]["healthcheckPath"] == path


def test_health_is_a_get_route():
    tree = ast.parse((ROOT / "api" / "app" / "main.py").read_text(encoding="utf-8"))
    routes = {
        (d.func.attr, d.args[0].value)
        for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef)
        for d in node.decorator_list
        if isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute) and d.args and isinstance(d.args[0], ast.Constant)
    }
    assert ("get", "/health") in routes


@pytest.mark.parametrize("path,prefix", [("api/.python-version", "3.12"), ("web/.node-version", "24")])
def test_runtime_versions_are_pinned(path, prefix):
    assert (ROOT / path).read_text(encoding="utf-8").strip().startswith(prefix)


@pytest.mark.parametrize("service", sorted(SERVICES))
def test_railway_json_holds_no_secrets(service):
    text = (ROOT / service / "railway.json").read_text(encoding="utf-8")
    assert not SECRET_LIKE.search(text), "railway.json contains a DSN, password or key"
