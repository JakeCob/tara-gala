"""TG-63 RA2, the pure parts of `app/receipt_scan.py` (plan.md section 2 step 8, BDD R9 to R11).

- `redact_note(text) -> str | None`: masks any run of 4+ digits (also when broken by spaces or dashes) as `••••`,
  removes email- and PH-phone-shaped text, squeezes spaces, cuts to 60, and gives None if nothing is left.
- `clamp_amount(amount_php) -> int | None`: pesos to centavos with Decimal, half up, never through a float;
  above 0 and at most ₱100,000, else None.
- `post_process(reply, line_keys) -> dict`: the model's JSON answer (options.md section 2 step 3) to the five
  `ScanOut` fields as a plain dict (the route wraps it in R0's model). `line_keys` are the wallet's budget line
  keys; empty when the wallet has no single trip.

Every string and number here is made up. No model is called: these are pure functions.
"""

import json
import random
import re

import pytest

from receipt_fakes import MADE_UP_ACCOUNT, MADE_UP_PHONE, model_reply, no_real_receipt_llm  # noqa: F401 (autouse guard)

MASK = "••••"
FOUR_DIGITS = re.compile(r"\d(?:[ -]*\d){3}")  # 4 digits in a row, spaces or dashes between them allowed


def redact_note(text):
    from app.receipt_scan import redact_note as f

    return f(text)


def clamp_amount(value):
    from app.receipt_scan import clamp_amount as f

    return f(value)


def post_process(reply, line_keys=("meals", "transport")):
    from app.receipt_scan import post_process as f

    return f(reply, line_keys)


# --- R9: redact_note ----------------------------------------------------------------------------

@pytest.mark.parametrize("raw, want", [
    ("GCash Ref 1234 5678 9012", f"GCash Ref {MASK}"),  # one run broken by spaces is one mask
    ("card ending 4321", f"card ending {MASK}"),
    ("Acct 1234-5678", f"Acct {MASK}"),  # broken by a dash
    ("Ref \uff11\uff12\uff13\uff14 \uff15\uff16\uff17\uff18", f"Ref {MASK}"),  # full-width digits are digits too
    ("Ref no. 9876 5432 at Good Taste", f"Ref no. {MASK} at Good Taste"),
    (f"Transfer {MADE_UP_ACCOUNT}", f"Transfer {MASK}"),
    ("Lunch 2026", f"Lunch {MASK}"),  # a 4-digit year is masked too: accepted, a note can't carry 4 digits
    ("Paid to 0917 123 4567", "Paid to"),  # a PH mobile number is removed, not masked
    ("Load 09171234567", "Load"),
    ("Load +63 917 123 4567", "Load"),
    ("Sent to juan@example.com for lunch", "Sent to for lunch"),
    ("Lunch at Good Taste", "Lunch at Good Taste"),  # unchanged
    ("Room 305, 2 pax", "Room 305, 2 pax"),  # 3 digits and fewer stay
    ("Total 1,280.00", "Total 1,280.00"),  # commas and dots don't join a run
    ("Lunch   at \t Good   Taste ", "Lunch at Good Taste"),  # spaces squeezed and trimmed
])
def test_redact_note_table(raw, want):
    assert redact_note(raw) == want


@pytest.mark.parametrize("raw", [None, "", "   ", "juan@example.com", MADE_UP_PHONE, "+63 917 123 4567"])
def test_redact_note_nothing_left_is_none(raw):
    assert redact_note(raw) is None


def test_redact_note_cuts_to_60():
    raw = "Halo-halo and pancit for the whole group at the night market stall by the park"
    out = redact_note(raw)
    assert len(out) <= 60
    assert raw.startswith(out.rstrip())


def test_redact_note_masks_before_cutting():
    """A digit run that crosses the 60th character is still masked, not cut in half and left as 2 digits + 2."""
    raw = "x" * 57 + " 1234 5678"
    out = redact_note(raw)
    assert out is not None and len(out) <= 60
    assert not re.search(r"\d", out)


def test_redact_note_never_leaves_four_digits_in_a_row():
    """Property check with a fixed seed (no new dependency): whatever the text, no 4-digit run survives."""
    rng = random.Random(63)
    alphabet = "0123456789" * 3 + " -" * 4 + "abcXYZ.,@+" + "•"
    for _ in range(2000):
        raw = "".join(rng.choice(alphabet) for _ in range(rng.randint(0, 90)))
        out = redact_note(raw)
        if out is None:
            continue
        assert 1 <= len(out) <= 60, raw
        assert not FOUR_DIGITS.search(out), (raw, out)
        assert out == out.strip() and "  " not in out, (raw, out)


# --- R10: clamp_amount --------------------------------------------------------------------------

@pytest.mark.parametrize("raw, want", [
    ("1280.00", 128000),
    ("1280", 128000),
    ("0.01", 1),
    ("100000", 10_000_000),  # at most ₱100,000: the cap itself passes
    ("12.345", 1235),  # half up
    ("1.005", 101),  # half up on the decimal text; a float would give 100
    ("0.005", 1),
    ("0", None),
    ("-5", None),
    ("100000.01", None),
    ("0.004", None),  # rounds to 0 centavos: nothing to fill
    ("null", None),
])
def test_clamp_amount_from_json_numbers(raw, want):
    assert clamp_amount(json.loads(raw)) == want  # as the model's JSON arrives: ints and floats


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf"), True, False])
def test_clamp_amount_refuses_non_amounts(value):
    assert clamp_amount(value) is None


def test_clamp_amount_returns_an_int():
    assert type(clamp_amount(json.loads("1280.50"))) is int


# --- R11 and the kinds: post_process ------------------------------------------------------------

FIELDS = {"kind", "amount_centavos", "note", "suggested_budget_key", "confident"}


def test_receipt_keeps_amount_note_and_line():
    out = post_process(model_reply(budget_key="meals"))
    assert out == {"kind": "receipt", "amount_centavos": 128000, "note": "Lunch at Good Taste Cafe",
                   "suggested_budget_key": "meals", "confident": True}


def test_transfer_to_merchant_is_read_like_a_receipt():
    out = post_process(model_reply(kind="transfer_to_merchant", amount_php=650, what_for="Taxi fare", budget_key="transport"))
    assert out == {"kind": "transfer_to_merchant", "amount_centavos": 65000, "note": "Taxi fare",
                   "suggested_budget_key": "transport", "confident": True}


def test_transfer_to_person_keeps_only_the_amount():
    out = post_process(model_reply(kind="transfer_to_person", amount_php=650, what_for="Sent to Juana", budget_key="meals"))
    assert (out["kind"], out["amount_centavos"], out["note"], out["suggested_budget_key"]) == (
        "transfer_to_person", 65000, None, None)


@pytest.mark.parametrize("kind", ["not_a_receipt", "unreadable"])
def test_failures_drop_everything(kind):
    out = post_process(model_reply(kind=kind, amount_php=1280, what_for="Lunch", budget_key="meals"))
    assert (out["kind"], out["amount_centavos"], out["note"], out["suggested_budget_key"]) == (kind, None, None, None)


def test_not_pesos_drops_the_amount_only():
    out = post_process(model_reply(currency_php=False, budget_key="meals"))
    assert (out["amount_centavos"], out["note"], out["suggested_budget_key"]) == (None, "Lunch at Good Taste Cafe", "meals")


def test_amount_goes_through_clamp_amount():
    assert post_process(model_reply(amount_php=250000))["amount_centavos"] is None
    assert post_process(model_reply(amount_php=None, amount_confident=False))["amount_centavos"] is None
    assert post_process(model_reply(amount_php=12.345))["amount_centavos"] == 1235


def test_note_goes_through_redact_note():
    assert post_process(model_reply(what_for="GCash Ref 1234 5678 9012"))["note"] == f"GCash Ref {MASK}"
    assert post_process(model_reply(what_for=""))["note"] is None
    assert post_process(model_reply(what_for=None))["note"] is None


@pytest.mark.parametrize("key, want", [
    ("meals", "meals"),
    ("transport", "transport"),
    ("_none", "_none"),  # options.md section 2 step 4: a line or `_none` is kept
    ("lodging", None),  # a valid-looking key that isn't one of this wallet's lines
    ("Meals", None),
    ("meals; drop table", None),  # made up
    ("", None),
    (None, None),
])
def test_line_key_must_be_one_of_the_wallets_lines(key, want):
    assert post_process(model_reply(budget_key=key))["suggested_budget_key"] == want


@pytest.mark.parametrize("key", ["meals", "_none", "anything"])
def test_no_lines_means_no_suggestion(key):
    """R11: a wallet with no single trip has no lines, so any key, `_none` included, is dropped."""
    assert post_process(model_reply(budget_key=key), line_keys=())["suggested_budget_key"] is None


@pytest.mark.parametrize("confident", [True, False])
def test_confident_is_the_models_amount_confident(confident):
    assert post_process(model_reply(amount_confident=confident))["confident"] is confident


@pytest.mark.parametrize("kind", ["receipt", "transfer_to_person", "transfer_to_merchant", "not_a_receipt", "unreadable"])
def test_answer_has_exactly_the_scanout_fields(kind):
    out = post_process(model_reply(kind=kind))
    assert set(out) == FIELDS
    assert out["kind"] == kind
    assert isinstance(out["confident"], bool)


def test_post_process_does_not_change_the_reply():
    reply = model_reply(what_for="GCash Ref 1234 5678 9012", budget_key="lodging")
    before = json.dumps(reply, sort_keys=True)
    post_process(reply)
    assert json.dumps(reply, sort_keys=True) == before
