"""TG-61: the change lines for one plan edit, worked out by the server from the base guide and the new one (options.md
§3.5). One shape, ChangeLine {word, day, text}, for the history, the suggestions and the chatbot's proposals; the
phone writes the sentences from it (review S8).

Rows are matched by key, buses by table and position, and to-dos by key. Pure: no database, no FastAPI. The lines
hold place names and the group's own text, so they're stored and shown to the trip, and never logged.
"""

from uuid import UUID

from pydantic import BaseModel

from .guide import BusTable, Day, Guide, Place, Row

MAX_LINES = 3  # then one "More" line: the table holds 1 to 4
TEXT_MAX = 120


class ChangeLine(BaseModel):
    word: str  # New, Out, In, Later, Earlier, Dropped, Moved, Budget, Bus, Changed, To-do, Sources, Copied, More
    day: int | None
    text: str


COPIED = ChangeLine(word="Copied", day=None, text="the plan")  # version 0's one line


def clock(hhmm: str) -> str:
    """'14:30' as '2:30 PM'."""
    h, m = (int(x) for x in hhmm.split(":"))
    return f"{h % 12 or 12}:{m:02d} {'AM' if h < 12 else 'PM'}"


def _line(word: str, day: int | None, text: str) -> ChangeLine:
    return ChangeLine(word=word, day=day, text=text if len(text) <= TEXT_MAX else text[: TEXT_MAX - 3] + "...")


def _place_id(p: Place | None) -> UUID | None:
    return (p.spot_id or p.terminal_id or p.trip_place_id) if p else None


def _steady(base_order: list[str], new_order: list[str]) -> set[str]:
    """The keys that kept their order: the longest run of new_order that's in base_order's order. The rest moved."""
    rank = {k: i for i, k in enumerate(base_order)}
    seq = [k for k in new_order if k in rank]
    best: list[list[str]] = []  # best[i]: the longest increasing run ending at seq[i]
    for i, k in enumerate(seq):
        prev = max((best[j] for j in range(i) if rank[seq[j]] < rank[k]), key=len, default=[])
        best.append(prev + [k])
    return set(max(best, key=len, default=[]))


def _rows(base: Guide, new: Guide, names: dict[UUID, str]) -> list[ChangeLine]:
    def where(g: Guide) -> dict[str, tuple[Day, Row]]:
        return {r.key: (d, r) for d in g.days for r in d.rows}

    old, now = where(base), where(new)

    def label(r: Row) -> str:
        return r.plan

    def name(r: Row) -> str:
        return names.get(_place_id(r.place)) or r.plan

    steady: set[str] = set()
    for d in new.days:
        here = [r.key for r in d.rows if r.key in old and old[r.key][0].day == d.day]
        was = [r.key for bd in base.days if bd.day == d.day for r in bd.rows if r.key in here]
        steady |= _steady(was, here)

    lines = []
    for d in new.days:
        for r in d.rows:
            if r.key not in old:
                lines.append(_line("New", d.day, f"{label(r)} at {clock(r.time)}"))
                continue
            bd, br = old[r.key]
            if bd.day != d.day or r.key not in steady:
                lines.append(_line("Moved", d.day, label(r)))
            if _place_id(br.place) != _place_id(r.place):
                lines.append(_line("Out", d.day, name(br)))
                lines.append(_line("In", d.day, name(r)))
            if br.time != r.time:
                lines.append(_line("Later" if r.time > br.time else "Earlier", d.day, f"{label(r)} to {clock(r.time)}"))
            rest = ("plan", "note", "leg", "show_if", "hide_if", "bus")
            if any(getattr(br, f) != getattr(r, f) for f in rest):
                lines.append(_line("Changed", d.day, label(r)))
    for bd in base.days:
        lines += [_line("Dropped", bd.day, label(r)) for r in bd.rows if r.key not in now]
    return lines


def _days(base: Guide, new: Guide) -> list[ChangeLine]:
    old = {d.day: d for d in base.days}
    lines = []
    for d in new.days:
        b = old.get(d.day)
        if b is None:
            lines.append(_line("New", d.day, d.title))
            continue
        if (b.title, b.intro, b.tips) != (d.title, d.intro, d.tips):
            lines.append(_line("Changed", d.day, d.title))
        if b.pick != d.pick:
            lines.append(_line("Changed", d.day, (d.pick or b.pick).title))
    now = {d.day for d in new.days}
    return lines + [_line("Dropped", d.day, d.title) for d in base.days if d.day not in now]


def _buses(side: str, base: BusTable, new: BusTable, names: dict[UUID, str]) -> list[ChangeLine]:
    lines = []
    for i, b in enumerate(new.buses):
        was = base.buses[i] if i < len(base.buses) else None
        if was is None or (was.trip_id, was.booked, was.note, was.date) != (b.trip_id, b.booked, b.note, b.date):
            lines.append(_line("Bus", None, f"{side}: {names.get(b.trip_id, 'another bus')}"))
    lines += [_line("Bus", None, f"{side}: {names.get(b.trip_id, 'a bus')}") for b in base.buses[len(new.buses):]]
    if (base.title, base.intro, base.tips) != (new.title, new.intro, new.tips):
        lines.append(_line("Changed", None, new.title))
    return lines


def _todos(base: Guide, new: Guide) -> list[ChangeLine]:
    old = {t.key: t for t in base.todo}
    now = {t.key for t in new.todo}
    lines = [_line("To-do", None, t.text) for t in new.todo if old.get(t.key) != t]
    lines += [_line("To-do", None, t.text) for t in base.todo if t.key not in now]
    if [t.key for t in base.todo if t.key in now] != [t.key for t in new.todo if t.key in old]:
        lines.append(_line("To-do", None, "the order"))
    return lines


def changes(base: Guide, new: Guide, names: dict[UUID, str]) -> list[ChangeLine]:
    """What changed, in the guide's order, as at most MAX_LINES lines plus one "More". Empty when nothing did.
    `names` are the places' and buses' names by id ("Victory Liner 4:10 PM" for a bus)."""
    lines = _rows(base, new, names) + _days(base, new)
    lines += _buses("Out", base.getting_there, new.getting_there, names) + _buses("Home", base.getting_home, new.getting_home, names)
    lines += _todos(base, new)
    if base.budget != new.budget:
        lines.append(_line("Budget", None, new.budget.summary or "the budget"))
    if base.sources != new.sources:
        lines.append(_line("Sources", None, "the sources"))
    if (base.title, base.summary) != (new.title, new.summary):
        lines.append(_line("Changed", None, new.title))
    if _place_id(base.lodging) != _place_id(new.lodging):
        lines.append(_line("Changed", None, "where you stay"))
    if len(lines) > MAX_LINES:
        more = len(lines) - MAX_LINES
        lines = lines[:MAX_LINES] + [_line("More", None, f"and {more} more change{'s' if more > 1 else ''}")]
    return lines
