"""TG-62 GA2, G11: `parse_estimate`, a budget row's estimate text read as whole pesos (min, max), or None when it can't be
read. Table-driven, and every estimate in the curated data file must read.

Readable: one amount, or two joined by "to", "-", "–" or "—", each with an optional ₱ and thousands commas, and min <= max.
Anything else (words, a rate like "/day", a reversed range, decimals, an empty string) is unreadable, so the panel shows
the text with no word (ux §5).
"""

import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def parse(text):
    from app.session_budget import parse_estimate  # imported per test, so a missing module fails each one (RED)

    return parse_estimate(text)


@pytest.mark.parametrize("text, want", [
    # the plan's G11 cases
    ("1,500 to 2,200", (1500, 2200)),
    ("350", (350, 350)),
    ("₱300 - 500", (300, 500)),
    ("300–500", (300, 500)),
    # the curated data file's estimates
    ("500 to 1,000", (500, 1000)),
    ("350 to 450", (350, 450)),
    ("300 to 500", (300, 500)),
    # the same grammar, other spellings
    ("₱350", (350, 350)),
    ("1500", (1500, 1500)),
    ("1,500", (1500, 1500)),
    ("₱300 - ₱500", (300, 500)),
    ("300—500", (300, 500)),
    ("300 TO 500", (300, 500)),
    ("  350 to 450  ", (350, 450)),
    ("300 to 300", (300, 300)),
    ("12,000 to 15,000", (12000, 15000)),
])
def test_g11_readable_estimates(text, want):
    assert parse(text) == want


@pytest.mark.parametrize("text", [
    # the plan's G11 cases
    "free", "depends", "₱300/day", "500 to 300", "",
    # more that must not read
    "   ", "about 300", "300 to", "to 500", "300 or 500", "300 to 500 each", "1,50", "1,500.50", "₱", "-300",
    "300 - 400 - 500", "PHP 300",
])
def test_g11_unreadable_estimates(text):
    assert parse(text) is None


def test_g11_every_estimate_in_the_data_file_reads():
    # An estimate with no digit ("As booked", "Your call") is a text line on purpose (TG-67 plan §12.3) and is skipped:
    # the panel shows its text with no number. Anything with a digit must still read, so a typo in a figure fails here.
    files = sorted((ROOT / "data" / "itineraries").glob("*.json"))
    assert files, "the curated plan files"
    seen = 0
    for f in files:
        data = json.loads(f.read_text(encoding="utf-8"))
        guide = data.get("guide") or (data.get("plan") or {}).get("guide") or {}
        for row in guide.get("budget", {}).get("rows", []):
            if not any(ch.isdigit() for ch in row["estimate"]):
                continue
            got = parse(row["estimate"])
            assert got is not None and got[0] <= got[1], (f.name, row["estimate"])
            seen += 1
    assert seen >= 4
