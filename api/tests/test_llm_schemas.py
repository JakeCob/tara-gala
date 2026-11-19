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
