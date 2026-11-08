"""TG-61 PR 1: edit a trip's plan (options.md §1 to §3). Anyone with the trip's link may edit, as with the rest of
the trip page. Only plans with a guide (the level map) can be edited.

The first edit copies the trip's plan into an itineraries row of its own (model trip-edit) and points the trip at it,
so the shared plan and the ready-made ones never change, and the nightly loaders never touch the copy. Every edit
after that is the next version in itinerary_versions, and itineraries.plan always equals the newest one. A save names
the version it was worked out from (its base); if that's no longer the newest, the answer is 409 plan_changed with
the newest, and nothing is written (the TG-54 rule). The one exception is a replay: Chrome resends a PUT whose answer
was cut, and that resend's base is one behind its own save. If the request is exactly what made the newest version, it
gets that save's answer, and nothing is written (F2). Any other request on that base is still a 409.

Only the server mints keys: a new row, to-do or pick option comes with a null key, and gets one that no version,
tick or photo of this trip has used, so it can't inherit an old row's ticks. A row keeps its key when it moves day.

Logs carry the trip slug, seqs, codes and counts, never a name, a note, a change line or a place.
"""

import json
import logging
import secrets
from dataclasses import dataclass
from typing import Annotated, Literal
from uuid import UUID

import psycopg
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from . import db, plan_diff
from . import guide as guides
from . import itineraries as its
from .guide import ROW_KEY, TODO_KEY
from .plan_diff import ChangeLine
from .plan_validation import MODEL_TRIP_EDIT, load_trips, trip_problems
from .sessions import NOINDEX, WRITE_LIMITER, _limit, _private, _session_id
from .trip_rows import TRIP_ROWS_SQL

router = APIRouter(tags=["plan-edit"])
logger = logging.getLogger("tara_gala.api")

MAX_VERSIONS = 1000  # a copy's 1,000th version is refused; about 15 MB a copy
MAX_PLAN_BYTES = 64 * 1024
LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
NUMBERS = [f"{n:02d}" for n in range(1, 100)] + ["00"]  # a new row's NN: the lowest free, from 01
WARN_CODES = {"too_many_rows", "too_many_todos", "too_many_options", "too_many_versions"}


# ---------------------------------------------------------------- shapes

class RowIn(guides.Row):
    key: Annotated[str, StringConstraints(pattern=ROW_KEY)] | None = None  # null: a new row; the server mints its key


class TodoIn(guides.Todo):
    key: Annotated[str, StringConstraints(pattern=TODO_KEY)] | None = None


class OptionIn(guides.Option):
    id: Annotated[str, StringConstraints(pattern=r"^[A-Z]$")] | None = None


class PickIn(guides.Pick):
    options: list[OptionIn] = Field(min_length=2, max_length=6)


class DayIn(guides.Day):
    pick: PickIn | None = None
    rows: list[RowIn] = Field(max_length=40)


class GuideIn(guides.Guide):
    """The stored guide as a phone sends it back, with null keys and ids on what's new (options.md §3.1)."""
    days: list[DayIn] = Field(min_length=1, max_length=31)
    todo: list[TodoIn] = []


class Base(BaseModel):
    """The plan a change was worked out from: the copy's slug and seq, or the shared plan's slug and 0."""
    model_config = ConfigDict(extra="forbid")
    itinerary_slug: Annotated[str, StringConstraints(max_length=100)]
    seq: int = Field(ge=0, le=9999)


class PlanIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    base: Base
    guide: GuideIn
    source: Literal["hand", "chat"] = "hand"


class UndoIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    base: Base


class PlanSaved(BaseModel):
    """The whole new plan, built in the save's own transaction (review M1), and the server's lines for the change."""
    itinerary: its.ItineraryOut
    changes: list[ChangeLine]


class Refused(Exception):
    """An answer with a code, and nothing written: the transaction rolls back."""

    def __init__(self, status: int, detail: str, **extra):
        super().__init__(detail)
        self.status, self.body = status, {"detail": detail, **extra}


@dataclass
class Current:
    """The plan the trip holds now: its row, whether it's this trip's own copy, and its seq (0 for a shared plan)."""
    row: dict
    copy: bool
    seq: int
    guide: guides.Guide


# ---------------------------------------------------------------- reads

def current(conn, session_id: UUID) -> Current:
    row = conn.execute(
        """select i.id, i.share_slug, i.trip_date, i.return_date, i.party, i.budget_php, i.vibe, i.plan, i.model,
                  (select max(v.seq) from itinerary_versions v where v.itinerary_id = i.id and v.session_id = s.id) as seq
           from trip_sessions s join itineraries i on i.id = s.itinerary_id where s.id = %s""",
        (session_id,),
    ).fetchone()
    if row is None:
        raise Refused(422, "no_plan")
    raw = row["plan"].get("guide") if isinstance(row["plan"], dict) else None
    g = guides.parse_guide(raw)[0] if raw is not None else None
    if g is None:
        raise Refused(422, "no_guide")  # only level-map plans can be edited
    copy = row["model"] == MODEL_TRIP_EDIT and row["seq"] is not None
    return Current(row=row, copy=copy, seq=row["seq"] if copy else 0, guide=g)


def _check_base(cur: Current, base: Base, share_slug: str, action: str) -> None:
    if (base.itinerary_slug, base.seq) != (cur.row["share_slug"], cur.seq):
        logger.info("plan %s refused share_slug=%s reason=plan_changed base_seq=%d seq=%d", action, share_slug, base.seq, cur.seq)
        raise Refused(409, "plan_changed", itinerary_slug=cur.row["share_slug"], seq=cur.seq)


@dataclass
class Taken:
    rows: set[str]
    todos: set[str]
    letters: dict[str, set[str]]  # by pick key


def taken(conn, session_id: UUID, cur: Current) -> Taken:
    """Every key this trip has used: in any version of its copy, in the plan it holds, in a tick or on a photo."""
    t = Taken(rows={r.key for d in cur.guide.days for r in d.rows}, todos={x.key for x in cur.guide.todo},
              letters={d.pick.key: {o.id for o in d.pick.options} for d in cur.guide.days if d.pick})
    if cur.copy:
        iid = cur.row["id"]
        t.rows |= {r["k"] for r in conn.execute(
            "select distinct k #>> '{}' as k from itinerary_versions v, jsonb_path_query(v.plan, '$.guide.days[*].rows[*].key') k"
            " where v.itinerary_id = %s", (iid,))}
        t.todos |= {r["k"] for r in conn.execute(
            "select distinct k #>> '{}' as k from itinerary_versions v, jsonb_path_query(v.plan, '$.guide.todo[*].key') k"
            " where v.itinerary_id = %s", (iid,))}
        for r in conn.execute(
            "select distinct p #>> '{key}' as pick, o #>> '{id}' as id from itinerary_versions v,"
            " jsonb_path_query(v.plan, '$.guide.days[*].pick') p, jsonb_path_query(p, '$.options[*]') o where v.itinerary_id = %s", (iid,)):
            t.letters.setdefault(r["pick"], set()).add(r["id"])
    for r in conn.execute("select key, value from session_marks where session_id = %s", (session_id,)):
        kind, _, rest = r["key"].partition(":")
        if kind == "row":
            t.rows.add(rest)
        elif kind == "todo":
            t.todos.add(f"todo-{rest}")
        else:
            t.letters.setdefault(rest, set()).add(r["value"])
    t.rows |= {r["row_key"] for r in conn.execute(
        "select row_key from session_files where session_id = %s and row_key is not null", (session_id,))}
    return t


def picked(conn, session_id: UUID) -> dict[str, str]:
    return {r["key"].removeprefix("pick:"): r["value"] for r in conn.execute(
        "select key, value from session_marks where session_id = %s and key like 'pick:%%'", (session_id,))}


# ---------------------------------------------------------------- keys

def _known_keys(g: GuideIn, base: guides.Guide) -> bool:
    """Every non-null key is already in the base: a client can't bring back a retired key, and its old ticks."""
    rows = {r.key for d in base.days for r in d.rows}
    todos = {t.key for t in base.todo}
    options = {d.pick.key: {o.id for o in d.pick.options} for d in base.days if d.pick}
    for d in g.days:
        if any(r.key is not None and r.key not in rows for r in d.rows):
            return False
        if d.pick and (d.pick.key not in options or any(o.id is not None and o.id not in options[d.pick.key] for o in d.pick.options)):
            return False
    return all(t.key is None or t.key in todos for t in g.todo)


def mint(g: GuideIn, t: Taken) -> tuple[dict, int]:
    """The guide with a key on every new row, to-do and pick option, as stored. Also how many were minted."""
    raw = g.model_dump(mode="json", by_alias=True, exclude_none=True)
    used = t.rows | {r["key"] for d in raw["days"] for r in d["rows"] if "key" in r}
    minted = 0
    for d in raw["days"]:
        for r in d["rows"]:
            if "key" not in r:
                days = ([d["day"]] if 1 <= d["day"] <= 9 else []) + list(range(1, 10))
                r["key"] = next((k for dd in days for k in (f"d{dd}-{nn}" for nn in NUMBERS) if k not in used), None)
                if r["key"] is None:
                    raise Refused(422, "too_many_rows")
                used.add(r["key"])
                minted += 1
        if d.get("pick"):
            letters = t.letters.get(d["pick"]["key"], set()) | {o["id"] for o in d["pick"]["options"] if "id" in o}
            for o in d["pick"]["options"]:
                if "id" not in o:
                    o["id"] = next((x for x in LETTERS if x not in letters), None)
                    if o["id"] is None:
                        raise Refused(422, "too_many_options")
                    letters.add(o["id"])
                    minted += 1
    used = t.todos | {x["key"] for x in raw.get("todo", []) if "key" in x}
    for x in raw.get("todo", []):
        if "key" not in x:
            x["key"] = next((f"todo-{nn}" for nn in NUMBERS if f"todo-{nn}" not in used), None)
            if x["key"] is None:
                raise Refused(422, "too_many_todos")
            used.add(x["key"])
            minted += 1
    return raw, minted


# ---------------------------------------------------------------- checks

def bus_times(new: guides.Guide, base: guides.Guide, trips: dict) -> None:
    """A bus row's time is its table's booked bus's departure, set here (B18). With no booked bus, it keeps the base's."""
    was = {r.key: r.time for d in base.days for r in d.rows}
    for kind, table in (("outbound", new.getting_there), ("return", new.getting_home)):
        booked = next((b for b in table.buses if b.booked), None)
        for d in new.days:
            for r in d.rows:
                if r.bus == kind:
                    if booked and booked.trip_id in trips:
                        r.time = trips[booked.trip_id].departure_time.strftime("%H:%M")
                    elif r.key in was:
                        r.time = was[r.key]


def references(conn, session_id: UUID, g: guides.Guide) -> list[str]:
    """unknown_place and unknown_leg: every place is ours, and every route is on file."""
    codes = []
    spots, terminals, places = guides.spot_ids(g), guides.terminal_ids(g), guides.trip_place_ids(g)
    found = conn.execute(
        """select (select count(*) from spots where id = any(%s)) as spots, (select count(*) from terminals where id = any(%s)) as terminals,
                  (select count(*) from trip_places where id = any(%s) and session_id = %s) as places,
                  (select count(*) from last_mile_routes where id = any(%s)) as legs""",
        (list(spots), list(terminals), list(places), session_id, list(guides.leg_ids(g))),
    ).fetchone()
    if (found["spots"], found["terminals"], found["places"]) != (len(spots), len(terminals), len(places)):
        codes.append("unknown_place")
    if found["legs"] != len(guides.leg_ids(g)):
        codes.append("unknown_leg")
    return codes


def check(conn, session_id: UUID, base: guides.Guide, new: guides.Guide, trips: dict) -> list[str]:
    """Every problem with a new guide against its base, as codes (options.md §3.4). Shared by hand, undo and chat.
    `trips` are the TripRefs of every bus the new guide names."""
    codes = references(conn, session_id, new)
    for name, direction in (("getting_there", "outbound"), ("getting_home", "return")):
        was, now = getattr(base, name).buses, getattr(new, name).buses
        if len(was) != len(now) or any(a.date != b.date for a, b in zip(was, now)):
            codes.append("bus_table_changed")  # D5: swap only, keeping each row's date
            continue
        if sum(b.booked for b in now) > 1:
            codes.append("two_booked")
        for a, b in zip(was, now):
            if a.trip_id != b.trip_id:
                codes += trip_problems(trips.get(b.trip_id), b.date, direction)

    def bus_rows(g: guides.Guide) -> dict:
        return {r.key: (d.day, r.bus) for d in g.days for r in d.rows if r.bus}

    if bus_rows(base) != bus_rows(new):
        codes.append("bus_row_changed")  # a bus row stays, on its day
    options = {d.pick.key: {o.id for o in d.pick.options} for d in new.days if d.pick}
    if any(k in options and v not in options[k] for k, v in picked(conn, session_id).items()):
        codes.append("option_picked")  # unpick it first (ux.md §8)
    return list(dict.fromkeys(codes))


def names(conn, session_id: UUID, *gs: guides.Guide) -> dict[UUID, str]:
    """The places' and buses' names, for the change lines only (never logged)."""
    spots = set().union(*(guides.spot_ids(g) for g in gs))
    terminals = set().union(*(guides.terminal_ids(g) for g in gs))
    places = set().union(*(guides.trip_place_ids(g) for g in gs))
    trips = set().union(*(guides.trip_ids(g) for g in gs))
    out = {r["id"]: r["name"] for r in conn.execute("select id, name from spots where id = any(%s)", (list(spots),))}
    out |= {r["id"]: r["name"] for r in conn.execute("select id, name from terminals where id = any(%s)", (list(terminals),))}
    out |= {r["id"]: r["name"] for r in conn.execute(
        "select id, name from trip_places where id = any(%s) and session_id = %s", (list(places), session_id))}
    out |= {r["trip_id"]: f"{r['operator_name']} {plan_diff.clock(r['departure_time'].strftime('%H:%M'))}"
            for r in conn.execute(TRIP_ROWS_SQL, (list(trips),))}
    return out


# ---------------------------------------------------------------- writes

def _stored(row: dict, guide: dict) -> dict:
    """The whole plan with its new guide; the planner's core (outbound, return, days) stays as copied."""
    return {**{k: v for k, v in row["plan"].items() if k != "guide"}, "guide": guide}


def _write(conn, session_id: UUID, cur: Current, plan: dict, source: str, changes: list[ChangeLine]) -> tuple[str, int]:
    """Copy the plan first if the trip has no copy, then the next version. The copy's slug and the new seq."""
    if cur.seq + 1 >= MAX_VERSIONS:
        raise Refused(422, "too_many_versions")
    iid, slug = cur.row["id"], cur.row["share_slug"]
    if not cur.copy:
        slug = secrets.token_hex(16)  # 128 bits, like the trip link; made in Python (TG-58 S1)
        r = cur.row
        iid = conn.execute(
            """insert into itineraries (share_slug, trip_date, return_date, party, budget_php, vibe, plan, model)
               values (%s, %s, %s, %s, %s, %s, %s, %s) returning id""",
            (slug, r["trip_date"], r["return_date"], Jsonb(r["party"]), r["budget_php"], r["vibe"], Jsonb(r["plan"]), MODEL_TRIP_EDIT),
        ).fetchone()["id"]
        conn.execute(
            "insert into itinerary_versions (itinerary_id, session_id, based_on, seq, source, plan, changes) values (%s, %s, %s, 0, 'copy', %s, %s)",
            (iid, session_id, r["id"], Jsonb(r["plan"]), Jsonb([plan_diff.COPIED.model_dump()])),
        )
        conn.execute("update trip_sessions set itinerary_id = %s where id = %s", (iid, session_id))
    seq = cur.seq + 1
    conn.execute(
        "insert into itinerary_versions (itinerary_id, session_id, seq, source, plan, changes) values (%s, %s, %s, %s, %s, %s)",
        (iid, session_id, seq, source, Jsonb(plan), Jsonb([c.model_dump() for c in changes])),
    )
    conn.execute("update itineraries set plan = %s where id = %s", (Jsonb(plan), iid))
    return slug, seq


@dataclass
class Prepared:
    """A new guide that passed every check, as it would be saved."""
    guide: guides.Guide
    plan: dict  # the whole plan with it
    changes: list[ChangeLine]
    minted: int
    size: int


def prepare(conn, session_id: UUID, cur: Current, guide_in: GuideIn, used: Taken | None = None) -> Prepared:
    """Everything a save checks, with nothing written: keys, mint, model, bus times, checks, change lines, size. `used`
    is the keys already taken, when they aren't what taken() reads now (a replay). Raises Refused."""
    if not _known_keys(guide_in, cur.guide):
        raise Refused(422, "unknown_key")
    raw, minted = mint(guide_in, used or taken(conn, session_id, cur))
    new, problems = guides.parse_guide(raw)
    if new is None:
        raise Refused(422, "bad_guide", problems=len(problems))
    trips = load_trips(conn, guides.trip_ids(new))
    bus_times(new, cur.guide, trips)
    codes = check(conn, session_id, cur.guide, new, trips)
    if codes:
        raise Refused(422, codes[0], codes=codes, problems=len(codes))
    changes = plan_diff.changes(cur.guide, new, names(conn, session_id, cur.guide, new))
    if not changes:
        raise Refused(422, "no_change")
    plan = _stored(cur.row, new.model_dump(mode="json", by_alias=True, exclude_none=True))
    size = len(json.dumps(plan).encode())
    if size > MAX_PLAN_BYTES:
        raise Refused(422, "too_big")
    return Prepared(guide=new, plan=plan, changes=changes, minted=minted, size=size)


# ---------------------------------------------------------------- replays (F2)

def _one_behind(conn, cur: Current, base: Base) -> bool:
    """Is `base` what the newest version was saved on? The first edit's base names the shared plan it was copied from."""
    if not cur.copy or cur.seq < 1 or base.seq != cur.seq - 1:
        return False
    if base.itinerary_slug == cur.row["share_slug"]:
        return True
    shared = conn.execute(
        "select i.share_slug from itinerary_versions v join itineraries i on i.id = v.based_on where v.itinerary_id = %s and v.seq = 0",
        (cur.row["id"],),
    ).fetchone() if cur.seq == 1 else None
    return shared is not None and shared["share_slug"] == base.itinerary_slug


def _versions(conn, cur: Current, *seqs: int) -> list[dict]:
    return conn.execute("select seq, source, plan, changes from itinerary_versions where itinerary_id = %s and seq = any(%s) order by seq",
                        (cur.row["id"], list(seqs))).fetchall()


def _without_minted(used: Taken, before: guides.Guide, after: guides.Guide) -> Taken:
    """The keys taken before `after` was saved: it minted its new ones from what was free then, so a replay mints the
    same. A later tick on a new row changes nothing, since its key is one of these."""
    def letters(g: guides.Guide) -> dict[str, set[str]]:
        return {d.pick.key: {o.id for o in d.pick.options} for d in g.days if d.pick}

    was = letters(before)
    return Taken(
        rows=used.rows - ({r.key for d in after.days for r in d.rows} - {r.key for d in before.days for r in d.rows}),
        todos=used.todos - ({t.key for t in after.todo} - {t.key for t in before.todo}),
        letters={k: v - (letters(after).get(k, set()) - was.get(k, set())) for k, v in used.letters.items()},
    )


def replayed_save(conn, session_id: UUID, cur: Current, body: PlanIn) -> PlanSaved | None:
    """The answer the newest version already gave, if this request is exactly what made it (F2): one behind, from the
    same source, and worked out again from the version before, it gives the newest version's plan."""
    if not _one_behind(conn, cur, body.base):
        return None
    prior, newest = _versions(conn, cur, cur.seq - 1, cur.seq)
    before = guides.parse_guide(prior["plan"].get("guide"))[0]
    if newest["source"] != body.source or before is None:
        return None
    was = Current(row={**cur.row, "plan": prior["plan"]}, copy=True, seq=prior["seq"], guide=before)
    try:
        p = prepare(conn, session_id, was, body.guide, _without_minted(taken(conn, session_id, cur), before, cur.guide))
    except Refused:
        return None  # it isn't this save, so it's an ordinary clash
    if p.plan != newest["plan"]:
        return None
    return _answer(conn, cur.row["share_slug"], [ChangeLine(**c) for c in newest["changes"]])


def replayed_undo(conn, cur: Current, base: Base) -> PlanSaved | None:
    """The same for an undo: the newest version is the undo that this base would have made."""
    if base.seq < 1 or not _one_behind(conn, cur, base):
        return None
    target, newest = _versions(conn, cur, base.seq - 1, cur.seq)
    if newest["source"] != "undo" or newest["plan"] != target["plan"]:
        return None
    return _answer(conn, cur.row["share_slug"], [ChangeLine(**c) for c in newest["changes"]])


def _answer(conn, slug: str, changes: list[ChangeLine]) -> PlanSaved:
    return PlanSaved(itinerary=its.build_out(conn, conn.execute(its.ROW_SQL, (slug,)).fetchone()), changes=changes)


def _run(share_slug: str, action: str, work) -> PlanSaved | JSONResponse:
    """One plan write in one transaction, with its database errors turned into codes (options.md §3.3, review M3)."""
    try:
        with db.get_conn() as conn:
            return work(conn)
    except Refused as r:
        if r.status == 422:
            level = logging.WARNING if r.body["detail"] in WARN_CODES else logging.INFO
            logger.log(level, "plan %s rejected share_slug=%s codes=%s problems=%d", action, share_slug,
                       ",".join(r.body.get("codes", [r.body["detail"]])), r.body.get("problems", 1))
        elif r.body["detail"] == "nothing_to_undo":
            logger.info("plan undo refused share_slug=%s reason=nothing_to_undo", share_slug)
        return JSONResponse(r.body, status_code=r.status, headers={"Cache-Control": "private, no-cache", **NOINDEX})
    except psycopg.errors.UniqueViolation:
        # Two saves at one seq: the session lock makes it impossible, and this is the belt
        logger.info("plan %s refused share_slug=%s reason=plan_changed constraint=unique", action, share_slug)
        return JSONResponse({"detail": "plan_changed"}, status_code=409, headers=NOINDEX)
    except psycopg.errors.IntegrityError as e:
        # A database check fired: logged by its name only, since its DETAIL holds the row (review M3)
        logger.warning("plan %s rejected share_slug=%s codes=bad_plan constraint=%s", action, share_slug, e.diag.constraint_name)
        return JSONResponse({"detail": "bad_plan"}, status_code=422, headers=NOINDEX)


# ---------------------------------------------------------------- routes

@router.put("/sessions/{share_slug}/plan", response_model=PlanSaved, response_model_by_alias=True,
            responses={409: {"description": "plan_changed: the base isn't the newest version"}, 422: {"description": "a code"}})
def save_plan(share_slug: str, body: PlanIn, request: Request, response: Response):
    _limit(WRITE_LIMITER, request, "plan-save")

    def work(conn) -> PlanSaved:
        session_id = _session_id(conn, share_slug, lock=True)  # two phones queue here instead of racing
        cur = current(conn, session_id)
        replay = replayed_save(conn, session_id, cur, body)
        if replay is not None:
            logger.info("plan save replay share_slug=%s seq=%d", share_slug, cur.seq)
            return replay
        _check_base(cur, body.base, share_slug, "save")
        p = prepare(conn, session_id, cur, body.guide)
        slug, seq = _write(conn, session_id, cur, p.plan, body.source, p.changes)
        saved = _answer(conn, slug, p.changes)
        logger.info(
            "plan save share_slug=%s source=%s base_seq=%d seq=%d copied=%s rows=%d todos=%d new_keys=%d bytes=%d",
            share_slug, body.source, body.base.seq, seq, not cur.copy, sum(len(d.rows) for d in p.guide.days), len(p.guide.todo),
            p.minted, p.size,
        )
        return saved

    out = _run(share_slug, "save", work)
    _private(response)
    return out


@router.post("/sessions/{share_slug}/plan/undo", response_model=PlanSaved, response_model_by_alias=True,
             responses={409: {"description": "plan_changed or nothing_to_undo"}, 422: {"description": "cannot_undo"}})
def undo_plan(share_slug: str, body: UndoIn, request: Request, response: Response):
    """Undo the newest version: the version before it, saved as the next one (source undo). Undoing an undo puts the
    change back (D2: the web calls it Redo)."""
    _limit(WRITE_LIMITER, request, "plan-undo")

    def work(conn) -> PlanSaved:
        session_id = _session_id(conn, share_slug, lock=True)
        cur = current(conn, session_id)
        replay = replayed_undo(conn, cur, body.base)
        if replay is not None:
            logger.info("plan undo replay share_slug=%s seq=%d", share_slug, cur.seq)
            return replay
        _check_base(cur, body.base, share_slug, "undo")
        if not cur.copy or cur.seq == 0:
            raise Refused(409, "nothing_to_undo")
        prev = conn.execute("select plan from itinerary_versions where itinerary_id = %s and seq = %s",
                            (cur.row["id"], cur.seq - 1)).fetchone()["plan"]
        restored = guides.parse_guide(prev.get("guide"))[0]
        # a stored version passed the full check when it was saved, so only its references are checked again
        if restored is None or references(conn, session_id, restored):
            raise Refused(422, "cannot_undo")
        changes = plan_diff.changes(cur.guide, restored, names(conn, session_id, cur.guide, restored)) or \
            [ChangeLine(word="Changed", day=None, text="the plan")]
        slug, seq = _write(conn, session_id, cur, prev, "undo", changes)
        saved = _answer(conn, slug, changes)
        logger.info("plan undo share_slug=%s seq=%d undid_seq=%d", share_slug, seq, cur.seq)
        return saved

    out = _run(share_slug, "undo", work)
    _private(response)
    return out


def flag_check(request: Request) -> None:
    """PLAN_EDITING off: the edit routes answer 404, as if they weren't there (plan.md §6)."""
    if not request.app.state.flags.plan_editing:
        raise HTTPException(404, "Not Found")
