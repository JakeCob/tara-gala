"""TG-20 test helpers: made-up trips, spots and legs, a valid plan built from them, and a fake LLM.

Every row here is made up for tests only. None of it is a real schedule, spot or route.
Dates are fixed relative to a frozen Manila "today", so the tests don't go stale after the trip.
"""

import copy
import json
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

import load_data
from conftest import write_csvs

TODAY = date(2026, 11, 1)  # frozen Manila "today" (a Sunday); tests patch planner.manila_today to this
D = TODAY + timedelta(days=5)  # outbound date, a Friday
RD = D + timedelta(days=2)  # return date, a Sunday

MARKER_KEY = "sk-ant-TGSECRETLLM0"  # fake key; must never show up in logs, bodies or errors
PARTY_NAME = "Test Person (made up)"
HAIKU = "claude-haiku-5-5"
SONNET = "claude-sonnet-5-5"

SRC = "https://example.test/schedule"
# operator,origin,destination,via,class,fare_php,travel_minutes,seat_layout,has_restroom,departure_time,days,valid_from,valid_to,source_url,verified_on,notes
TRIPS = (
    f"victory-liner,vl-cubao,vl-baguio,,regular_aircon,700,360,2x2,yes,07:00,daily,,,{SRC},2026-10-24,made up\n"  # arrives 13:00
    f"victory-liner,vl-cubao,vl-baguio,,regular_aircon,700,360,2x2,yes,22:00,daily,,,{SRC},2026-10-24,made up\n"  # arrives 04:00 +1
    f"victory-liner,vl-cubao,vl-baguio,,regular_aircon,700,360,2x2,yes,10:00,daily,,,{SRC},2026-10-24,made up\n"  # set inactive below
    f"victory-liner,vl-cubao,vl-baguio,,regular_aircon,700,360,2x2,yes,11:00,daily,2026-01-01,2026-10-01,{SRC},2026-10-24,made up\n"  # expired
    f"victory-liner,vl-pasay,vl-baguio,,deluxe,800,300,2x2,yes,09:00,weekends,,,{SRC},2026-10-24,made up\n"  # not on Fridays
    f"genesis,gen-cubao,gen-baguio,,regular_aircon,650,,2x2,yes,08:00,daily,,,{SRC},2026-10-24,made up\n"  # no travel time
    f"victory-liner,vl-baguio,vl-cubao,,regular_aircon,700,360,2x2,yes,15:00,daily,,,{SRC},2026-10-24,made up\n"  # return
    f"victory-liner,vl-baguio,vl-pasay,,deluxe,800,300,2x2,yes,10:00,weekdays,,,{SRC},2026-10-24,made up\n"  # not on Sundays
)
# slug,name,category,lat,lng,description,visit_minutes,entrance_fee_php
SPOTS = (
    "test-park,Test Park (made up),park,16.41,120.59,made up for tests only,60,\n"
    "test-market,Test Market (made up),market,16.42,120.60,made up for tests only,45,20\n"
    "test-lodge,Test Lodge (made up),other,16.40,120.58,made up for tests only,,\n"
)
# from_terminal,from_spot,to_terminal,to_spot,mode,signboard,boarding_point,alighting_point,fare_min,fare_max,minutes,verified_on,notes
LAST_MILE = (
    "vl-baguio,,,test-park,jeep,Test Signboard (made up),,,13,15,15,2026-10-24,made up for tests only\n"
    ",test-park,,test-market,walk,,,,,,10,2026-10-24,made up for tests only\n"
    ",test-market,,test-lodge,taxi,,,,60,80,10,2026-10-24,made up for tests only\n"
    ",test-lodge,,test-park,taxi,,,,60,80,10,2026-10-24,made up for tests only\n"
)
PARK_HOURS = {d: ["06:00", "18:00"] for d in ("mon", "tue", "wed", "thu", "fri", "sat", "sun")}


@dataclass
class Ids:
    trips: dict[str, str] = field(default_factory=dict)  # name -> trip id
    spots: dict[str, str] = field(default_factory=dict)  # slug -> spot id
    legs: dict[str, str] = field(default_factory=dict)  # "from>to" -> leg id

    def all(self) -> set[str]:
        return set(self.trips.values()) | set(self.spots.values()) | set(self.legs.values())


TRIP_KEYS = {
    "out_day": ("vl-cubao", "vl-baguio", "07:00"),
    "out_night": ("vl-cubao", "vl-baguio", "22:00"),
    "out_inactive": ("vl-cubao", "vl-baguio", "10:00"),
    "out_expired": ("vl-cubao", "vl-baguio", "11:00"),
    "out_weekend": ("vl-pasay", "vl-baguio", "09:00"),
    "out_no_time": ("gen-cubao", "gen-baguio", "08:00"),
    "ret": ("vl-baguio", "vl-cubao", "15:00"),
    "ret_weekdays": ("vl-baguio", "vl-pasay", "10:00"),
}


def load_planner_data(dsn: str, folder: Path, trips: str = TRIPS, spots: str = SPOTS, last_mile: str = LAST_MILE) -> Ids:
    write_csvs(folder, trips=trips, spots=spots, last_mile=last_mile)
    assert load_data.run(dsn, folder, dry_run=False) == 0
    ids = Ids()
    with psycopg.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        conn.execute(
            "update trips set is_active = false where departure_time = '10:00' and route_id in "
            "(select r.id from routes r join terminals t on t.id = r.origin_terminal_id where t.slug = 'vl-cubao')"
        )
        conn.execute("update spots set opening_hours = %s::jsonb where slug = 'test-park'", [json.dumps(PARK_HOURS)])
        rows = conn.execute(
            """
            select t.id::text as id, ot.slug as o, dt.slug as d, to_char(t.departure_time, 'HH24:MI') as dep
            from trips t join routes r on r.id = t.route_id
            join terminals ot on ot.id = r.origin_terminal_id join terminals dt on dt.id = r.destination_terminal_id
            """
        ).fetchall()
        by_key = {(r["o"], r["d"], r["dep"]): r["id"] for r in rows}
        ids.trips = {name: by_key[k] for name, k in TRIP_KEYS.items() if k in by_key}
        ids.spots = {r["slug"]: r["id"] for r in conn.execute("select slug, id::text as id from spots")}
        for r in conn.execute(
            """
            select l.id::text as id, coalesce(ft.slug, fs.slug) as f, coalesce(tt.slug, ts.slug) as t
            from last_mile_routes l
            left join terminals ft on ft.id = l.from_terminal_id left join spots fs on fs.id = l.from_spot_id
            left join terminals tt on tt.id = l.to_terminal_id left join spots ts on ts.id = l.to_spot_id
            """
        ):
            ids.legs[f"{r['f']}>{r['t']}"] = r["id"]
    return ids


def stop(ids: Ids, spot: str, arrive: str, leave: str, leg: str) -> dict:
    return {"spot_id": ids.spots[spot], "arrive": arrive, "leave": leave, "leg": {"last_mile_route_id": ids.legs[leg]}}


def valid_plan(ids: Ids) -> dict:
    """A plan that passes every TG-24 check: 07:00 bus (arrives 13:00) on D, 15:00 bus back on RD."""
    return {
        "outbound": {"trip_id": ids.trips["out_day"], "date": D.isoformat()},
        "return": {"trip_id": ids.trips["ret"], "date": RD.isoformat()},
        "days": [
            {"day": 1, "stops": [
                stop(ids, "test-park", "13:30", "15:00", "vl-baguio>test-park"),
                stop(ids, "test-market", "15:15", "16:00", "test-park>test-market"),
                stop(ids, "test-lodge", "16:30", "21:00", "test-market>test-lodge"),
            ]},
            {"day": 2, "stops": [
                stop(ids, "test-park", "09:00", "11:00", "test-lodge>test-park"),
                stop(ids, "test-market", "11:15", "12:00", "test-park>test-market"),
                stop(ids, "test-lodge", "12:30", "20:00", "test-market>test-lodge"),
            ]},
            {"day": 3, "stops": [
                stop(ids, "test-park", "09:00", "12:00", "test-lodge>test-park"),
            ]},
        ],
    }


def mutated(plan: dict, fn) -> dict:
    p = copy.deepcopy(plan)
    fn(p)
    return p


def request_body(**overrides) -> dict:
    body = {
        "date": D.isoformat(),
        "return_date": RD.isoformat(),
        "party": [{"type": "adult", "name": PARTY_NAME}, {"type": "adult"}, {"type": "senior"}],
        "budget_php": 6000,
        "vibe": "food trip",
    }
    body.update(overrides)
    return body


# --- fake LLM at the LLMClient seam -------------------------------------------------------------

class FakeLLM:
    """Implements LLMClient. Each script item is an exception to raise or a dict of LLMReply fields.

    `text` may be a dict (dumped to JSON). `model` defaults to the model that was asked for.
    `advance` moves the fake clock by that many seconds during the call.
    """

    def __init__(self, *script, clock=None):
        self.script = list(script)
        self.calls: list[dict] = []
        self.clock = clock

    def complete(self, *, model, system, user, schema, max_tokens, timeout):
        from app.llm import LLMReply

        self.calls.append(dict(model=model, system=system, user=user, schema=schema, max_tokens=max_tokens, timeout=timeout))
        if not self.script:
            raise AssertionError("FakeLLM called more times than scripted")
        item = self.script.pop(0)
        if isinstance(item, BaseException):
            raise item
        item = dict(item)
        if self.clock is not None:
            self.clock.t += item.pop("advance", 0)
        else:
            item.pop("advance", None)
        text = item.pop("text", None)
        if isinstance(text, dict):
            text = json.dumps(text)
        stop = item.pop("stop", "complete")
        raw = {"complete": "end_turn", "refused": "refusal", "truncated": "max_tokens", "other": "pause_turn"}[stop]
        return LLMReply(
            text=text,
            stop=stop,
            raw_stop=item.pop("raw_stop", raw),
            refusal_category=item.pop("refusal_category", "cyber" if stop == "refused" else None),
            model=item.pop("model", model),
            input_tokens=item.pop("input_tokens", 1000),
            output_tokens=item.pop("output_tokens", 500),
            request_id=item.pop("request_id", f"req_fake_{len(self.calls)}"),
        )


class FakeClock:
    def __init__(self, t: float = 1000.0):
        self.t = t

    def __call__(self) -> float:
        return self.t


def ok(plan: dict, **kw) -> dict:
    return {"text": plan, **kw}
