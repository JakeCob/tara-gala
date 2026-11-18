"""TG-62 GP1: a guide budget row's stable key (plan.md §3, G17 and G18a). expenses.budget_key points at it, so a line
keeps its spend when it's renamed, moved or recategorised.

- slug_key / unique_key: a key from the row's own text, as the table's check allows it (^[a-z][a-z0-9-]{1,20}$).
- inherit: a keyless row (today's web drops keys on every save) takes the key of the base row with the same text.
- mint_keys: every row still keyless gets a fresh key, never one this trip has used.

Pure: no database. A key is a slug of the group's own line text, so it's never logged (plan N2).
"""

import re
import unicodedata

MAX = 21  # the check's 1 + 20
LINE = "line"  # the key of a text with no letters, and the prefix of one that doesn't start with a letter


def _cut(slug: str, limit: int) -> str:
    """At most `limit` characters, cut after a whole word when one fits; one long word is cut where it stands."""
    if len(slug) <= limit:
        return slug
    words, out = slug.split("-"), ""
    for w in words:
        nxt = f"{out}-{w}" if out else w
        if len(nxt) > limit:
            break
        out = nxt
    return out or slug[:limit]


def slug_key(text: str) -> str:
    """Lowercase ASCII, every other run of characters one hyphen, at most 21 characters at a word boundary, and never
    ending in a hyphen. A text that doesn't start with a letter gets `line-` in front; one with no letters is `line`."""
    ascii_ = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_).strip("-")
    if not re.search(r"[a-z]", slug):
        return LINE
    if not slug[0].isalpha() or len(slug) < 2:  # the check needs a letter first and two characters
        slug = f"{LINE}-{slug}"
    return _cut(slug, MAX)


def unique_key(text: str, taken: set[str]) -> str:
    """slug_key(text), or with -2, -3 and so on when that's taken, still within 21 characters."""
    key = slug_key(text)
    n = 1
    while key in taken:
        n += 1
        suffix = f"-{n}"
        key = _cut(slug_key(text), MAX - len(suffix)) + suffix
    return key


def inherit(rows_in: list[dict], base_rows: list[dict]) -> list[dict]:
    """The incoming rows with the base's keys where they match (plan G18a), as new dicts; the input is unchanged.
    1. A row with a key claims it, and with no category takes the base row's.
    2. Then each keyless row, in order, takes the key of the first base row with exactly its text whose key no row has
       claimed, and that row's category unless it brings its own.
    3. The rest stay keyless, for mint_keys. Keyless base rows (a plan from before the backfill) give nothing."""
    base = {r["key"]: r for r in base_rows if r.get("key")}
    out = [dict(r) for r in rows_in]
    claimed = {r["key"] for r in out if r.get("key")}
    for r in out:
        if r.get("key") and r.get("category") is None and r["key"] in base:
            r["category"] = base[r["key"]].get("category")
    for r in out:
        if r.get("key"):
            continue
        match = next((b for k, b in base.items() if k not in claimed and b["item"] == r["item"]), None)
        if match is None:
            continue
        claimed.add(match["key"])
        r["key"] = match["key"]
        if r.get("category") is None:
            r["category"] = match.get("category")
    return out


def by_text(rows_in: list[dict], rows_out: list[dict]) -> int:
    """How many rows came in keyless and went out of inherit() with a key: an old phone's save (plan §8), for the log."""
    return sum(1 for a, b in zip(rows_in, rows_out, strict=True) if not a.get("key") and b.get("key"))


def mint_keys(rows: list[dict], taken: set[str]) -> int:
    """A fresh key on every keyless row, in place: never one in `taken` or already in the rows. How many it minted."""
    used = set(taken) | {r["key"] for r in rows if r.get("key")}
    minted = 0
    for r in rows:
        if r.get("key"):
            continue
        r["key"] = unique_key(r["item"], used)
        used.add(r["key"])
        minted += 1
    return minted
