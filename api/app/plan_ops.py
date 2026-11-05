"""TG-61 PR 2: the chatbot's operations on a plan (options.md §7). The model answers with short operations instead of a
whole guide, so it can't retype or drop a key. apply() turns them into the stored guide a phone would send (GuideIn,
with null keys on what's new), and plan_edit.prepare() then checks it exactly as it checks a hand edit.

The model names only existing keys. It can't mint a key, and it can't make a pin: a place is a spot or a trip place
it was given, never coordinates or a link. Pure: no database, no model call.
"""

import copy
import re
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from .guide import HHMM, BudgetRow, Guide, Text

NAMES = ("add_row", "remove_row", "move_row", "set_row", "swap_bus", "add_todo", "remove_todo", "set_budget")
TABLES = ("getting_there", "getting_home")
MAX_OPS = 20


class Op(BaseModel):
    """One operation, flat: `op` says which fields it reads; the rest stay null."""
    model_config = ConfigDict(extra="forbid")
    op: Literal["add_row", "remove_row", "move_row", "set_row", "swap_bus", "add_todo", "remove_todo", "set_budget"]
    key: Annotated[str, StringConstraints(max_length=12)] | None = None  # an existing row's or to-do's key
    day: int | None = None
    after: Annotated[str, StringConstraints(max_length=12)] | None = None  # the row it goes after, null for the day's start
    time: Annotated[str, StringConstraints(max_length=8)] | None = None  # HH:MM, checked in apply
    plan: Annotated[str, StringConstraints(min_length=1, max_length=120)] | None = None
    note: Text | None = None
    spot_id: UUID | None = None
    trip_place_id: UUID | None = None
    table: Literal["getting_there", "getting_home"] | None = None
    index: int | None = None
    trip_id: UUID | None = None
    text: Annotated[str, StringConstraints(min_length=1, max_length=120)] | None = None  # a to-do
    budget_rows: list[BudgetRow] | None = None
    budget_summary: Text | None = None


class NeedLink(BaseModel):
    """A place it can't pin: the phone offers "Paste a Google Maps link", at this position when it's a real one."""
    model_config = ConfigDict(extra="forbid")
    name: Annotated[str, StringConstraints(min_length=1, max_length=80)]
    after: str | None = None
    replace: str | None = None
    first_of_day: int | None = None


class Reply(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reply: Annotated[str, StringConstraints(min_length=1, max_length=1500)]
    ops: list[Op] = Field(default=[], max_length=MAX_OPS)
    need_link: NeedLink | None = None


# ---------------------------------------------------------------- the output schema

def _obj(**properties) -> dict:
    return {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}


def _maybe(kind: str, description: str) -> dict:
    return {"type": [kind, "null"], "description": description}


_OP = _obj(
    op={"type": "string", "description": "One of: " + ", ".join(NAMES)},
    key=_maybe("string", "remove_row, move_row, set_row: the row's key. remove_todo: the to-do's key. Never for add_row"),
    day=_maybe("integer", "add_row, move_row: the day number"),
    after=_maybe("string", "add_row, move_row: the key of the row it goes after on that day; null for the day's start"),
    time=_maybe("string", "add_row, set_row: 24-hour HH:MM"),
    plan=_maybe("string", "add_row, set_row: what the stop is, short"),
    note=_maybe("string", "add_row, set_row: a note"),
    spot_id=_maybe("string", "add_row, set_row: a spot id from <spots>"),
    trip_place_id=_maybe("string", "add_row, set_row: a place id from <trip_places>"),
    table=_maybe("string", "swap_bus: getting_there or getting_home"),
    index=_maybe("integer", "swap_bus: the bus row's index in its table"),
    trip_id=_maybe("string", "swap_bus: a trip id from <buses>, same direction and date"),
    text=_maybe("string", "add_todo: the to-do"),
    budget_rows={"type": ["array", "null"], "items": _obj(item={"type": "string"}, estimate={"type": "string"}),
                 "description": "set_budget: every budget row"},
    budget_summary=_maybe("string", "set_budget: the budget's one-line summary"),
)
REPLY_SCHEMA: dict = _obj(
    reply={"type": "string", "description": "What you say to the group, in their own mix of English and Filipino"},
    ops={"type": "array", "items": _OP, "description": "The changes to propose; empty for a question"},
    need_link={"type": ["object", "null"], **{k: v for k, v in _obj(
        name={"type": "string"}, after=_maybe("string", "a row key"), replace=_maybe("string", "a row key"),
        first_of_day=_maybe("integer", "a day number"),
    ).items() if k != "type"}, "description": "A place the group wants that isn't in <spots> or <trip_places>"},
)


# ---------------------------------------------------------------- apply

class _Refused(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _day(g: dict, n: int | None) -> dict:
    day = next((d for d in g["days"] if d["day"] == n), None)
    if day is None:
        raise _Refused("bad_day")
    return day


def _find(g: dict, key: str | None) -> tuple[dict, dict]:
    for d in g["days"]:
        for r in d["rows"]:
            if key is not None and r.get("key") == key:
                return d, r
    raise _Refused("unknown_key")


def _insert(day: dict, after: str | None, r: dict) -> None:
    if after is None:
        day["rows"].insert(0, r)
        return
    i = next((i for i, x in enumerate(day["rows"]) if x.get("key") == after), None)
    if i is None:
        raise _Refused("unknown_key")  # `after` must be a row on that day
    day["rows"].insert(i + 1, r)


def _place(o: Op) -> dict | None:
    if o.spot_id and o.trip_place_id:
        raise _Refused("bad_op")
    return {"spot_id": str(o.spot_id)} if o.spot_id else {"trip_place_id": str(o.trip_place_id)} if o.trip_place_id else None


def _need(o: Op, *fields: str) -> None:
    if any(getattr(o, f) is None for f in fields):
        raise _Refused("bad_op")


def _one(g: dict, o: Op) -> None:
    if o.time is not None and not re.fullmatch(HHMM, o.time):
        raise _Refused("bad_op")
    if o.op == "add_row":
        if o.key is not None:
            raise _Refused("bad_op")  # only the server mints a key
        _need(o, "day", "time", "plan")
        day = _day(g, o.day)
        r = {"key": None, "time": o.time, "plan": o.plan, "note": o.note or ""}
        if (place := _place(o)) is not None:
            r["place"] = place
        prev = next((x for x in day["rows"] if x.get("key") == o.after), None) if o.after else None
        for c in ("show_if", "hide_if"):  # a new row follows the condition of the row it goes after (tg-ux 5)
            if prev and prev.get(c):
                r[c] = copy.deepcopy(prev[c])
        _insert(day, o.after, r)
    elif o.op == "remove_row":
        d, r = _find(g, o.key)
        d["rows"].remove(r)
    elif o.op == "move_row":
        _need(o, "day")
        d, r = _find(g, o.key)
        target = _day(g, o.day)
        d["rows"].remove(r)
        _insert(target, o.after, r)
    elif o.op == "set_row":
        _, r = _find(g, o.key)
        for f in ("time", "plan", "note"):
            if getattr(o, f) is not None:
                r[f] = getattr(o, f)
        if (place := _place(o)) is not None:
            r["place"] = place
            r.pop("leg", None)  # the way to the old place doesn't lead to the new one
    elif o.op == "swap_bus":
        _need(o, "table", "index", "trip_id")
        buses = g[o.table]["buses"]
        if not 0 <= o.index < len(buses):
            raise _Refused("bad_op")
        buses[o.index]["trip_id"] = str(o.trip_id)
    elif o.op == "add_todo":
        _need(o, "text")
        g.setdefault("todo", []).append({"key": None, "text": o.text, "done": False})
    elif o.op == "remove_todo":
        todo = next((x for x in g.get("todo", []) if x.get("key") == o.key), None)
        if todo is None:
            raise _Refused("unknown_key")
        g["todo"].remove(todo)
    elif o.op == "set_budget":
        _need(o, "budget_rows")
        g["budget"]["rows"] = [b.model_dump() for b in o.budget_rows]
        if o.budget_summary is not None:
            g["budget"]["summary"] = o.budget_summary


def apply(g: Guide, ops: list[Op]) -> tuple[dict | None, list[str]]:
    """The stored guide after `ops`, in order, as GuideIn's shape; or None and the one code that stopped it."""
    out = g.model_dump(mode="json", by_alias=True, exclude_none=True)
    out.setdefault("budget", {}).setdefault("rows", [])
    try:
        for o in ops:
            _one(out, o)
    except _Refused as e:
        return None, [e.code]
    return out, []


def texts(ops: list[Op]) -> list[str]:
    """Every text an operation adds or changes, for the time and fare rule. Budget rows are the group's own estimates."""
    return [t for o in ops for t in (o.plan, o.note, o.text) if t]

