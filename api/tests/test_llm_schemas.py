"""TG-62 fix: the strict output schemas the LLM providers must accept.

Anthropic's structured output (direct, and through OpenRouter) refuses a whole request whose schema has a node with a
list `type` and an `enum`: "Invalid schema: Enum value transport does not match declared type [string, null]". GP1's
chat schema had one (budget_rows[].category), so every chat call failed with 502 chat_failed. A nullable enum is written
as anyOf: [{type: string, enum}, {type: null}]. No live LLM call here: the rule is checked on the schema itself.
"""
import pytest
from pydantic import ValidationError

from app import plan_ops
from app.planner_prompt import PLAN_SCHEMA

SCHEMAS = {"chat REPLY_SCHEMA": plan_ops.REPLY_SCHEMA, "planner PLAN_SCHEMA": PLAN_SCHEMA}


def _nodes(node, path="$"):
    """Every dict in the schema, with its path."""
    if isinstance(node, dict):
        yield path, node
        for k, v in node.items():
            yield from _nodes(v, f"{path}.{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from _nodes(v, f"{path}[{i}]")


def _is(value, kind: str) -> bool:
    return {"string": isinstance(value, str), "null": value is None, "integer": isinstance(value, int) and not isinstance(value, bool),
            "boolean": isinstance(value, bool), "number": isinstance(value, (int, float)) and not isinstance(value, bool)}.get(kind, False)


def _accepts(node: dict, value) -> bool:
    """JSON Schema's answer for a scalar value, for the keywords these schemas use on scalars: anyOf, type, enum."""
    if "anyOf" in node and not any(_accepts(n, value) for n in node["anyOf"]):
        return False
    kinds = node.get("type")
    if kinds is not None and not any(_is(value, k) for k in (kinds if isinstance(kinds, list) else [kinds])):
        return False
    return "enum" not in node or value in node["enum"]


@pytest.mark.parametrize("name", SCHEMAS)
def test_no_node_has_a_type_list_and_an_enum(name):  # the provider's rule
    bad = [path for path, n in _nodes(SCHEMAS[name]) if isinstance(n.get("type"), list) and "enum" in n]
    assert bad == [], f"{name}: a type list with an enum is refused by Anthropic: {bad}"


@pytest.mark.parametrize("name", SCHEMAS)
def test_every_enum_value_matches_its_own_type(name):  # the same refusal, for a single type too
    for path, n in _nodes(SCHEMAS[name]):
        if "enum" in n and "type" in n:
            kinds = n["type"] if isinstance(n["type"], list) else [n["type"]]
            assert all(any(_is(v, k) for k in kinds) for v in n["enum"]), f"{name} {path}: {n['enum']} vs {kinds}"


CATEGORY_PATH = ("properties", "ops", "items", "properties", "budget_rows", "items", "properties", "category")


def _category_node() -> dict:
    node = plan_ops.REPLY_SCHEMA
    for k in CATEGORY_PATH:
        node = node[k]
    return node


def test_the_set_budget_category_takes_tg66s_words_or_null_and_nothing_else():  # tg-review N1, by the schema
    node = _category_node()
    for word in plan_ops.CATEGORIES:
        assert _accepts(node, word), word
    assert plan_ops.CATEGORIES == ("transport", "hotel", "food", "activities", "other")
    assert _accepts(node, None), "null keeps the row's category"
    for other in ("snacks", "Food", "", "pasalubong"):
        assert not _accepts(node, other), f"{other!r} would reach apply"
    assert node.get("description"), "the model still reads what null means"


def test_the_reply_model_refuses_a_word_outside_the_categories():  # tg-review N1, by the model's own validation
    def reply(category):
        return plan_ops.Reply.model_validate({"reply": "ok", "ops": [{"op": "set_budget", "budget_rows": [
            {"item": "E2E meals", "estimate": "2", "key": "meals", "category": category}]}]})

    for word in (*plan_ops.CATEGORIES, None):
        assert reply(word).ops[0].budget_rows[0].category == word
    with pytest.raises(ValidationError):
        reply("snacks")


# ---------------------------------------------------------------- tg-review N1 (#96): an allowlist of keywords
# Anthropic's structured outputs, "JSON schema limitations" (platform.claude.com/docs/en/build-with-claude/
# structured-outputs, read 2026-11-20). Anything else is a 400 for the whole request, which the chat and planner turn
# into a 502 in prod. A keyword this list doesn't know fails here first: check the doc, then add it.
KEYWORDS = {"type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf", "allOf", "$ref",
            "$defs", "definitions", "default", "description", "title", "format", "minItems"}
# Supported by the doc but kept out by our own rule (tg-test S2): `pattern` takes only a subset of regex (no backreferences,
# lookarounds or \b), and neither schema needs one. Check the doc's list before allowing it.
HOUSE_RULES = {"pattern": "our house rule, not an Anthropic limit: the doc takes only a subset of regex, so check it before allowing pattern"}
FORMATS = {"date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"}
TYPES = {"object", "array", "string", "integer", "number", "boolean", "null"}


def _schemas(node: dict, path="$"):
    """Every schema node: through properties, items, anyOf, allOf and $defs, never into a properties map's names."""
    yield path, node
    for name, sub in node.get("properties", {}).items():
        yield from _schemas(sub, f"{path}.properties.{name}")
    if isinstance(node.get("items"), dict):
        yield from _schemas(node["items"], f"{path}.items")
    for k in ("anyOf", "allOf"):
        for i, sub in enumerate(node.get(k, [])):
            yield from _schemas(sub, f"{path}.{k}[{i}]")
    for k in ("$defs", "definitions"):
        for name, sub in node.get(k, {}).items():
            yield from _schemas(sub, f"{path}.{k}.{name}")


def _problems(schema: dict) -> list[str]:
    out = []
    for path, n in _schemas(schema):
        out += [f"{path}: {k}: {HOUSE_RULES.get(k, 'not supported by Anthropic structured output')}" for k in sorted(set(n) - KEYWORDS)]
        if "items" in n and not isinstance(n["items"], dict):
            out.append(f"{path}: items must be one schema, not a list (tuple items aren't supported or walked)")
        kinds = n.get("type")
        kinds = kinds if isinstance(kinds, list) else [kinds] if kinds is not None else []
        out += [f"{path}: type {k!r}" for k in kinds if k not in TYPES]
        if "format" in n and n["format"] not in FORMATS:
            out.append(f"{path}: format {n['format']!r}")
        if "minItems" in n and n["minItems"] not in (0, 1):
            out.append(f"{path}: minItems {n['minItems']} (only 0 or 1)")
        if "additionalProperties" in n and n["additionalProperties"] is not False:
            out.append(f"{path}: additionalProperties must be false")
        if "object" in kinds and n.get("additionalProperties") is not False:
            out.append(f"{path}: an object needs additionalProperties: false")
        if "object" in kinds and set(n.get("required", [])) != set(n.get("properties", {})):
            # Our own rule, not Anthropic's (it allows optional properties): every _obj requires all its properties, and
            # the OpenRouter adapter sends strict: true. Don't loosen a schema's required list to "match the provider"
            out.append(f"{path}: an object requires every property (our house rule for strict outputs, not an Anthropic limit)")
        if "anyOf" in n and ("type" in n or "properties" in n):
            out.append(f"{path}: anyOf beside type or properties")
        for v in [*n.get("enum", []), *([n["const"]] if "const" in n else [])]:
            if isinstance(v, (dict, list)):
                out.append(f"{path}: enum or const value {v!r} isn't a scalar")
        if "$ref" in n and not str(n["$ref"]).startswith("#"):
            out.append(f"{path}: external $ref")
    return out


@pytest.mark.parametrize("name", SCHEMAS)
def test_every_keyword_is_one_anthropic_structured_output_supports(name):  # tg-review N1 (#96)
    assert _problems(SCHEMAS[name]) == []


def _obj(**props):
    return {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}


@pytest.mark.parametrize("bad", [
    {"type": "string", "minLength": 1}, {"type": "string", "maxLength": 9}, {"type": "integer", "minimum": 0},
    {"type": "integer", "maximum": 9}, {"type": "number", "multipleOf": 2}, {"type": "array", "items": {"type": "string"}, "maxItems": 3},
    {"type": "array", "items": {"type": "string"}, "minItems": 2}, {"type": "array", "items": {"type": "string"}, "uniqueItems": True},
    {"oneOf": [{"type": "string"}, {"type": "null"}]}, {"not": {"type": "null"}}, {"type": "string", "format": "phone"},
    {"type": "object", "properties": {"a": {"type": "string"}}, "required": ["a"], "additionalProperties": True},
    {"type": "object", "properties": {"a": {"type": "string"}}, "required": ["a"]},
    {"type": "object", "properties": {"a": {"type": "string"}, "b": {"type": "string"}}, "required": ["a"], "additionalProperties": False},
    {"type": "string", "anyOf": [{"enum": ["x"]}, {"type": "null"}]}, {"type": "string", "enum": [{"a": 1}]},
    {"$ref": "https://example.invalid/s.json"}, {"type": "date"}, {"type": "string", "patternProperties": {}},
    # tg-test F1, F2: a refused keyword one level down, so a walk that stops at anyOf, allOf, $defs or definitions fails
    pytest.param({"anyOf": [{"type": "string", "minLength": 1}, {"type": "null"}]}, id="under-anyOf"),
    pytest.param({"allOf": [{"type": "string", "maxLength": 3}]}, id="under-allOf"),
    pytest.param({"$ref": "#/$defs/d", "$defs": {"d": {"type": "string", "maxLength": 3}}}, id="under-$defs"),
    pytest.param({"$ref": "#/definitions/d", "definitions": {"d": {"type": "integer", "minimum": 0}}}, id="under-definitions"),
    # tg-test S1, S2
    pytest.param({"type": "array", "items": [{"type": "string"}, {"type": "integer"}]}, id="items-list"),
    pytest.param({"type": "string", "pattern": "^[a-z]+$"}, id="pattern-house-rule"),
], ids=lambda b: next(iter(sorted(set(b) - {"type", "properties", "required", "items"}) or ["type"])))
def test_the_allowlist_refuses_what_anthropic_refuses(bad):  # the check isn't vacuous: each one, nested in a real shape
    assert _problems(_obj(reply={"type": "string"}, ops={"type": "array", "items": _obj(x=bad)}))
