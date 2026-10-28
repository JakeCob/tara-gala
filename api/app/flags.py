"""Feature flags read from environment variables. See README section 7.

Each flag's env var is its field name upper-cased. `1/true/yes/on` is true and
`0/false/no/off` is false (case-insensitive, trimmed). Unset or empty gives the
default; anything else gives the default and logs a warning. Keep these rules in
step with web/src/lib/flags.ts.
"""

import logging
import os
from collections.abc import Mapping
from dataclasses import asdict, dataclass, fields
from functools import lru_cache

logger = logging.getLogger("tara_gala.flags")

TRUE_WORDS = frozenset({"1", "true", "yes", "on"})
FALSE_WORDS = frozenset({"0", "false", "no", "off"})


@dataclass(frozen=True)
class Flags:
    planner_live: bool = False  # PLANNER_LIVE: live AI planner (TG-25)
    premade_itineraries: bool = True  # PREMADE_ITINERARIES: pre-made itineraries (TG-24)
    real_map: bool = False  # REAL_MAP: real-map toggle (TG-26, cut)


def parse_flag(name: str, raw: str | None, default: bool) -> bool:
    value = (raw or "").strip().lower()
    if not value:
        return default
    if value in TRUE_WORDS:
        return True
    if value in FALSE_WORDS:
        return False
    logger.warning("%s=%r is not a recognised flag value; using default %s", name, raw, default)
    return default


def load_flags(env: Mapping[str, str] = os.environ) -> Flags:
    """Read every flag from `env` now. Not cached; use get_flags() in app code."""
    defaults = Flags()
    return Flags(**{
        f.name: parse_flag(f.name.upper(), env.get(f.name.upper()), getattr(defaults, f.name))
        for f in fields(Flags)
    })


@lru_cache(maxsize=1)
def get_flags() -> Flags:
    """Load the flags once per process and log the resolved values at INFO.

    Consumers (TG-24, TG-25) should call this once in the FastAPI `lifespan`, after
    logging is configured, so the startup line is not dropped. Changing a flag on
    Railway takes effect after the API restarts.
    """
    flags = load_flags()
    logger.info("feature flags: %s", " ".join(f"{k}={v}" for k, v in asdict(flags).items()))
    return flags
