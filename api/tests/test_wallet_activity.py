"""TG-66 A2: the activity list, comments, and the proof writes' activity rows (plan §3: B5 to B8, B17 for A2's routes).

Routes under test, all in app/wallet_activity.py below record(), and the record() calls in app/wallet_proofs.py:
- GET    /wallets/{slug}/activity?before=<id>&limit=<1..50, default 15>  -> {rev, rows} newest first
- GET    /wallets/{slug}/expenses/{id}/comments                           -> {rev, comments} oldest first
- POST   /wallets/{slug}/expenses/{id}/comments {body, by?}               -> 201 {wallet, comments}
- DELETE /wallets/{slug}/expenses/{id}/comments/{cid}?by=<member>         -> {wallet, comments}
- the proof's POST and DELETE take `?by=<member>` (the body of a proof POST is the raw image, so `by` can't ride in it)

WALLET_ACTIVITY off: the four routes above answer 404 `feature_off`; the proof writes still record. Made-up wallets,
names and text only. The expenses' own activity rows (expense_add, settle, ...) are A3's and aren't tested here.
"""

import dataclasses
import json
import logging
import re
import threading
from contextlib import contextmanager
from uuid import UUID, uuid4

import psycopg
import pytest

from app import db, wallet_activity, wallets
from conftest import ROOT
from test_wallet_proofs import PNG, PNG2, ProofStore, fill_proofs, new_wallet, pay, proof_url, sql, upload, wallet_uuid  # noqa: F401
from test_wallet_proofs import store  # noqa: F401  the autouse fixture: fake Storage, fresh rate limiters, no sweeper

MEMBERS = ("Tessa Testname", "Ugo Testname", "Vida Testname")
COMMENT = "TESTCOMMENT about the bill"
NOTE = "Lunch at TESTPLACE"


@pytest.fixture()
def on(client):
    """WALLET_ACTIVITY on for this test."""
    before = client.app.state.flags
    client.app.state.flags = dataclasses.replace(before, wallet_activity=True)
    yield client
    client.app.state.flags = before


# ---------------------------------------------------------------- helpers

def made_up(client):
    """A wallet with three made-up people and one expense. Returns (slug, people by name, the expense's id)."""
    slug, people = new_wallet(client, MEMBERS, note=NOTE)
    expense = client.get(f"/wallets/{slug}").json()["expenses"][0]["id"]
    return slug, people, expense


def rev(dsn, slug):
    return sql(dsn, "select rev from wallets where share_slug = %s", (slug,))[0]["rev"]


def _text_ids(rows):
    """The API's JSON gives ids as strings; psycopg gives UUIDs. Compare like with like."""
    return [{k: str(v) if isinstance(v, UUID) else v for k, v in r.items()} for r in rows]


def activity_rows(dsn, slug):
    return _text_ids(sql(
        dsn,
        """select a.id, a.actor, a.action, a.expense_id, a.settlement_id, a.member_id, a.before, a.after
           from wallet_activity a join wallets w on w.id = a.wallet_id where w.share_slug = %s order by a.id""",
        (slug,),
    ))


def comment_rows(dsn, expense):
    return _text_ids(sql(dsn, "select id, author, body from expense_comments where expense_id = %s order by created_at, id", (expense,)))


def comments_url(slug, expense, cid=None):
    return f"/wallets/{slug}/expenses/{expense}/comments" + (f"/{cid}" if cid else "")


def post(client, slug, expense, body=COMMENT, by=None):
    payload = {"body": body} if by is None else {"body": body, "by": by}
    return client.post(comments_url(slug, expense), json=payload)


def seed(dsn, slug, n, action="settle"):
    """n activity rows through record() itself, as A3's routes will write them. Returns their ids, oldest first."""
    with psycopg.connect(dsn) as conn:
        wid = conn.execute("select id from wallets where share_slug = %s", (slug,)).fetchone()[0]
        for _ in range(n):
            wallet_activity.record(conn, wid, action)
    return [r["id"] for r in activity_rows(dsn, slug)][-n:]


def fails(call):
    """An unhandled error: RequestLogMiddleware answers 500 (a TestClient may also re-raise it)."""
    try:
        r = call()
    except psycopg.Error:
        return
    assert r.status_code == 500, r.text


def nothing_written(dsn, slug, expense, rev_before, rows_before, comments_before):
    assert rev(dsn, slug) == rev_before
    assert len(activity_rows(dsn, slug)) == rows_before
    assert len(comment_rows(dsn, expense)) == comments_before


@contextmanager
def fail_on_rev_bump(dsn):
    """A trigger that fails the wallet's rev update: record()'s second statement, after its insert and the caller's
    own write. The whole request must then roll back."""
    sql(dsn, """create function tg66_fail() returns trigger language plpgsql as $$
                begin raise exception 'tg66 test: rev bump refused'; end $$""")
    sql(dsn, "create trigger tg66_fail before update of rev on wallets for each row execute function tg66_fail()")
    try:
        yield
    finally:
        sql(dsn, "drop trigger tg66_fail on wallets")
        sql(dsn, "drop function tg66_fail()")


# ---------------------------------------------------------------- B7b: WALLET_ACTIVITY off

def test_the_flag_is_off_by_default(client):
    assert client.app.state.flags.wallet_activity is False


def test_flag_off_the_activity_and_comment_routes_answer_feature_off(client, dsn):
    """B7b"""
    slug, people, expense = made_up(client)
    cid = sql(dsn, "insert into expense_comments (expense_id, body) values (%s, 'x') returning id", (expense,))[0]["id"]
    r0, n0 = rev(dsn, slug), len(activity_rows(dsn, slug))
    answers = [
        client.get(f"/wallets/{slug}/activity"),
        client.get(comments_url(slug, expense)),
        post(client, slug, expense, by=people["Ugo Testname"]),
        client.delete(comments_url(slug, expense, cid)),
    ]
    assert [(a.status_code, a.json()) for a in answers] == [(404, {"detail": "feature_off"})] * 4
    nothing_written(dsn, slug, expense, r0, n0, 1)


def test_flag_off_wins_over_a_bad_comment_body(client, dsn):
    """B7b: the web picks its feature_off line from what it sent, so the flag is answered before the body is judged"""
    slug, _, expense = made_up(client)
    for body in ("", "x" * 301):
        r = post(client, slug, expense, body=body)
        assert (r.status_code, r.json()) == (404, {"detail": "feature_off"})


def test_flag_off_proof_writes_still_record(client, dsn):
    """B7b: every wallet write records, whatever the flag"""
    slug, people, _ = made_up(client)
    sid = pay(client, slug, people, frm="Ugo Testname", to="Tessa Testname")
    r0 = rev(dsn, slug)
    assert upload(client, slug, sid).status_code == 201
    assert client.delete(proof_url(slug, sid)).status_code == 200
    assert [r["action"] for r in activity_rows(dsn, slug)][-2:] == ["proof_add", "proof_remove"]
    assert rev(dsn, slug) == r0 + 2


# ---------------------------------------------------------------- B6: the activity list

def test_activity_is_newest_first_with_the_wallets_rev(on, dsn):
    """B6"""
    slug, people, expense = made_up(on)
    seed(dsn, slug, 2)
    post(on, slug, expense, by=people["Vida Testname"])
    r = on.get(f"/wallets/{slug}/activity")
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"rev", "rows"}
    assert body["rev"] == rev(dsn, slug)
    ids = [row["id"] for row in body["rows"]]
    assert ids == sorted(ids, reverse=True) and len(ids) == len(activity_rows(dsn, slug))
    newest = body["rows"][0]
    assert newest["action"] == "comment_add"
    assert newest["actor"] == people["Vida Testname"] and newest["expense_id"] == expense
    assert set(newest) == {"id", "at", "actor", "action", "expense_id", "settlement_id", "member_id", "before", "after"}
    assert r.headers["cache-control"] == "private, no-cache" and r.headers["x-robots-tag"] == "noindex"


def test_activity_pages_by_before_without_gaps_or_repeats(on, dsn):
    """B6: 15 a page by default; `before` is the oldest id on screen"""
    slug, _, _ = made_up(on)
    seeded = seed(dsn, slug, 40)
    pages, before = [], None
    while True:
        url = f"/wallets/{slug}/activity" + ("" if before is None else f"?before={before}")
        rows = on.get(url).json()["rows"]
        if not rows:
            break
        pages.append([row["id"] for row in rows])
        before = rows[-1]["id"]
    assert [len(p) for p in pages] == [15, 15, 10]
    flat = [i for p in pages for i in p]
    assert flat == sorted(seeded, reverse=True)


def test_activity_limit_is_at_most_50(on, dsn):
    """B6"""
    slug, _, _ = made_up(on)
    seed(dsn, slug, 60)
    assert len(on.get(f"/wallets/{slug}/activity?limit=50").json()["rows"]) == 50
    assert len(on.get(f"/wallets/{slug}/activity?limit=3").json()["rows"]) == 3
    for bad in ("51", "0", "-1", "x"):
        assert on.get(f"/wallets/{slug}/activity?limit={bad}").status_code == 422, bad
    assert on.get(f"/wallets/{slug}/activity?before=x").status_code == 422


def test_activity_is_one_wallets_own(on, dsn):
    """B6"""
    slug, _, _ = made_up(on)
    other, _, _ = made_up(on)
    seed(dsn, slug, 3)
    seed(dsn, other, 2)
    assert len(on.get(f"/wallets/{slug}/activity").json()["rows"]) == 3
    assert len(on.get(f"/wallets/{other}/activity").json()["rows"]) == 2


def second_expense(client, slug, people):
    r = client.post(f"/wallets/{slug}/expenses", json={"paid_by": people["Ugo Testname"], "amount_centavos": 300, "note": "Taho", "split_among": [people["Ugo Testname"]]})
    assert r.status_code == 201, r.text
    return r.json()["expenses"][0]["id"]


def record_for(dsn, slug, action, expense):
    with psycopg.connect(dsn) as conn:
        wid = conn.execute("select id from wallets where share_slug = %s", (slug,)).fetchone()[0]
        wallet_activity.record(conn, wid, action, expense_id=expense)


def test_activity_for_one_expense(on, dsn):
    """B6a (plan §2 addendum 1): ?expense_id= keeps that expense's rows in this wallet, newest first, paged by before"""
    slug, people, e1 = made_up(on)
    e2 = second_expense(on, slug, people)
    other, other_people, o1 = made_up(on)
    for i in range(20):  # two wallets, two expenses, interleaved
        record_for(dsn, slug, "expense_edit", e1)
        record_for(dsn, slug, "expense_edit", e2)
        record_for(dsn, other, "expense_edit", o1)
        if i % 5 == 0:
            record_for(dsn, slug, "settle", None)
    post(on, slug, e1, by=people["Ugo Testname"])
    mine = [r["id"] for r in activity_rows(dsn, slug) if r["expense_id"] == e1]
    assert len(mine) == 21

    first = on.get(f"/wallets/{slug}/activity?expense_id={e1}")
    assert first.status_code == 200, first.text
    body = first.json()
    assert body["rev"] == rev(dsn, slug)
    assert [r["id"] for r in body["rows"]] == sorted(mine, reverse=True)[:15]
    assert {r["expense_id"] for r in body["rows"]} == {e1}
    assert body["rows"][0]["action"] == "comment_add"

    pages, before = [], None
    while True:
        url = f"/wallets/{slug}/activity?expense_id={e1}&limit=8" + ("" if before is None else f"&before={before}")
        rows = on.get(url).json()["rows"]
        if not rows:
            break
        pages.append([r["id"] for r in rows])
        before = rows[-1]["id"]
    assert [len(p) for p in pages] == [8, 8, 5]
    assert [i for p in pages for i in p] == sorted(mine, reverse=True)
    assert len(on.get(f"/wallets/{slug}/activity?expense_id={e1}&limit=50").json()["rows"]) == 21
    assert on.get(f"/wallets/{slug}/activity?expense_id={e1}&limit=51").status_code == 422


def test_activity_for_an_expense_that_isnt_here_is_empty_not_404(on, dsn):
    """B6a: another wallet's expense, a made-up id and an expense with no rows all give {rev, rows: []}"""
    slug, people, e1 = made_up(on)
    quiet = second_expense(on, slug, people)
    other, _, o1 = made_up(on)
    record_for(dsn, other, "expense_edit", o1)
    record_for(dsn, slug, "expense_edit", e1)
    for eid in (o1, str(uuid4()), quiet):
        r = on.get(f"/wallets/{slug}/activity?expense_id={eid}")
        assert (r.status_code, r.json()) == (200, {"rev": rev(dsn, slug), "rows": []}), eid
    assert on.get(f"/wallets/{slug}/activity?expense_id=not-a-uuid").status_code == 422


def test_activity_for_one_expense_flag_off_is_feature_off(client):
    """B6a with B7b"""
    slug, _, e1 = made_up(client)
    r = client.get(f"/wallets/{slug}/activity?expense_id={e1}")
    assert (r.status_code, r.json()) == (404, {"detail": "feature_off"})


def test_the_activity_log_line_says_whether_it_was_filtered_never_the_id(on, dsn, caplog):
    """B6a: expense=yes|no"""
    caplog.set_level(logging.INFO, logger="tara_gala.api")
    slug, _, e1 = made_up(on)
    on.get(f"/wallets/{slug}/activity")
    on.get(f"/wallets/{slug}/activity?expense_id={e1}")
    lines = [r.getMessage() for r in caplog.records if r.name == "tara_gala.api" and r.getMessage().startswith("wallet activity get ")]
    assert len(lines) == 2
    assert "expense=no" in lines[0] and "expense=yes" in lines[1]
    assert not any(e1 in m for r in caplog.records for m in [r.getMessage()])


def test_activity_of_an_unknown_wallet_is_404(on):
    for slug in ("0" * 32, "not-a-slug"):
        r = on.get(f"/wallets/{slug}/activity")
        assert (r.status_code, r.json()["detail"]) == (404, "Wallet not found")


class SneakyConn:
    """Wraps the request's connection. After its first statement that isn't the slug lookup, another connection commits
    one more comment and its rev bump, as a second phone would. A read that takes rev and the list in two statements
    then answers a rev that doesn't match its list."""

    def __init__(self, conn, sneak):
        self._conn, self._sneak, self.fired = conn, sneak, False

    def execute(self, query, *args, **kwargs):
        cur = self._conn.execute(query, *args, **kwargs)
        if not self.fired and "share_slug = " not in str(query):
            self.fired = True
            self._sneak()
        return cur

    def __getattr__(self, name):
        return getattr(self._conn, name)


def sneak_in(monkeypatch, dsn, slug, expense):
    def sneak():
        try:
            with psycopg.connect(dsn) as other:
                other.execute("set lock_timeout = '1s'")  # a reader that holds a lock on the wallet keeps us out: fine
                wid = other.execute("select id from wallets where share_slug = %s", (slug,)).fetchone()[0]
                other.execute("insert into expense_comments (expense_id, body) values (%s, 'sneaky')", (expense,))
                wallet_activity.record(other, wid, "comment_add", expense_id=expense)
        except psycopg.errors.LockNotAvailable:
            pass

    real = db.get_conn
    wrappers = []

    @contextmanager
    def get_conn():
        with real() as conn:
            wrapper = SneakyConn(conn, sneak)
            wrappers.append(wrapper)
            yield wrapper

    monkeypatch.setattr(db, "get_conn", get_conn)
    return wrappers


def test_comments_rev_and_list_are_one_snapshot(on, dsn, monkeypatch):
    """B7a (S1): the rev in GET …/comments belongs to exactly the list it comes with"""
    slug, _, expense = made_up(on)
    post(on, slug, expense)
    r0 = rev(dsn, slug)
    wrappers = sneak_in(monkeypatch, dsn, slug, expense)
    body = on.get(comments_url(slug, expense)).json()
    assert any(w.fired for w in wrappers)
    assert (body["rev"], len(body["comments"])) in {(r0, 1), (r0 + 1, 2)}


def test_activity_rev_and_rows_are_one_snapshot(on, dsn, monkeypatch):
    """B6 with the rev rule: every row here comes from record(), so a consistent answer has as many rows as its rev"""
    slug, _, expense = made_up(on)
    seed(dsn, slug, 3)
    wrappers = sneak_in(monkeypatch, dsn, slug, expense)
    body = on.get(f"/wallets/{slug}/activity?limit=50").json()
    assert any(w.fired for w in wrappers)
    assert len(body["rows"]) == body["rev"]


# ---------------------------------------------------------------- B7, B7a: comments

def test_post_a_comment_answers_the_wallet_and_the_comments(on, dsn):
    """B7, B7a"""
    slug, people, expense = made_up(on)
    r0 = rev(dsn, slug)
    r = post(on, slug, expense, body=f"  {COMMENT}  ", by=people["Ugo Testname"])
    assert r.status_code == 201, r.text
    body = r.json()
    assert set(body) == {"wallet", "comments"}
    assert body["wallet"]["rev"] == r0 + 1 == rev(dsn, slug)
    assert next(e for e in body["wallet"]["expenses"] if e["id"] == expense)["comment_count"] == 1
    [c] = body["comments"]
    assert (c["expense_id"], c["author"], c["body"]) == (expense, people["Ugo Testname"], COMMENT)  # trimmed
    assert set(c) == {"id", "expense_id", "author", "body", "created_at"}
    assert r.headers["cache-control"] == "private, no-cache"


def test_a_comment_writes_one_activity_row_without_its_text(on, dsn):
    """B5, B7: one comment_add row, and the text is nowhere in it"""
    slug, people, expense = made_up(on)
    n0 = len(activity_rows(dsn, slug))
    post(on, slug, expense, by=people["Ugo Testname"])
    rows = activity_rows(dsn, slug)
    assert len(rows) == n0 + 1
    row = rows[-1]
    assert (row["action"], row["actor"], row["expense_id"]) == ("comment_add", people["Ugo Testname"], expense)
    assert (row["settlement_id"], row["member_id"], row["before"], row["after"]) == (None, None, None, None)
    assert "TESTCOMMENT" not in json.dumps(row, default=str)


def test_a_comment_with_no_by_is_someones(on, dsn):
    slug, _, expense = made_up(on)
    c = post(on, slug, expense).json()["comments"][0]
    assert c["author"] is None
    assert activity_rows(dsn, slug)[-1]["actor"] is None


def test_get_comments_is_oldest_first_with_the_rev(on, dsn):
    """B7a"""
    slug, people, expense = made_up(on)
    for i, who in enumerate(MEMBERS):
        post(on, slug, expense, body=f"TESTCOMMENT {i}", by=people[who])
    r = on.get(comments_url(slug, expense))
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"rev", "comments"} and body["rev"] == rev(dsn, slug)
    assert [c["body"] for c in body["comments"]] == ["TESTCOMMENT 0", "TESTCOMMENT 1", "TESTCOMMENT 2"]
    assert r.headers["cache-control"] == "private, no-cache"


def test_comments_are_one_expenses_own(on, dsn):
    slug, people, expense = made_up(on)
    r = on.post(f"/wallets/{slug}/expenses", json={"paid_by": people["Ugo Testname"], "amount_centavos": 300, "note": "Taho", "split_among": [people["Ugo Testname"]]})
    second = r.json()["expenses"][0]["id"]
    post(on, slug, expense)
    assert on.get(comments_url(slug, second)).json()["comments"] == []
    wallet = on.get(f"/wallets/{slug}").json()
    assert {e["id"]: e["comment_count"] for e in wallet["expenses"]} == {expense: 1, second: 0}


def test_each_comment_write_is_one_rev_above_the_last(on, dsn):
    """B7a"""
    slug, _, expense = made_up(on)
    r0 = rev(dsn, slug)
    first = post(on, slug, expense, body="TESTCOMMENT a").json()
    assert on.get(comments_url(slug, expense)).json()["rev"] == r0 + 1
    second = post(on, slug, expense, body="TESTCOMMENT b").json()
    gone = on.delete(comments_url(slug, expense, first["comments"][0]["id"])).json()
    assert [c["body"] for c in second["comments"]] == ["TESTCOMMENT a", "TESTCOMMENT b"]  # a write's answer is oldest first too
    assert [first["wallet"]["rev"], second["wallet"]["rev"], gone["wallet"]["rev"]] == [r0 + 1, r0 + 2, r0 + 3]
    assert [c["body"] for c in gone["comments"]] == ["TESTCOMMENT b"]
    assert next(e for e in gone["wallet"]["expenses"] if e["id"] == expense)["comment_count"] == 1


@pytest.mark.parametrize("text", ["", "   ", "x" * 301])
def test_a_comment_is_1_to_300_characters(on, dsn, text):
    """B7"""
    slug, _, expense = made_up(on)
    r0, n0 = rev(dsn, slug), len(activity_rows(dsn, slug))
    assert post(on, slug, expense, body=text).status_code == 422
    nothing_written(dsn, slug, expense, r0, n0, 0)


def test_300_characters_is_fine(on):
    slug, _, expense = made_up(on)
    assert post(on, slug, expense, body="x" * 300).status_code == 201


def test_a_comment_body_has_only_body_and_by(on):
    slug, _, expense = made_up(on)
    assert on.post(comments_url(slug, expense), json={"body": "x", "author": None}).status_code == 422


def test_at_most_50_comments_an_expense(on, dsn):
    """B7: 409 comments_full, and nothing written"""
    slug, _, expense = made_up(on)
    sql(dsn, "insert into expense_comments (expense_id, body) select %s, 'old' from generate_series(1, 49)", (expense,))
    assert post(on, slug, expense).status_code == 201
    r0, n0 = rev(dsn, slug), len(activity_rows(dsn, slug))
    r = post(on, slug, expense)
    assert (r.status_code, r.json()) == (409, {"detail": "comments_full"})
    nothing_written(dsn, slug, expense, r0, n0, 50)


def test_the_cap_is_per_expense(on, dsn):
    slug, people, expense = made_up(on)
    sql(dsn, "insert into expense_comments (expense_id, body) select %s, 'old' from generate_series(1, 50)", (expense,))
    r = on.post(f"/wallets/{slug}/expenses", json={"paid_by": people["Ugo Testname"], "amount_centavos": 300, "note": "Taho", "split_among": [people["Ugo Testname"]]})
    assert post(on, slug, r.json()["expenses"][0]["id"]).status_code == 201


def test_by_must_be_one_of_this_wallets_people(on, dsn):
    """B7: 422 unknown_member, and nothing written"""
    slug, _, expense = made_up(on)
    _, strangers, _ = made_up(on)
    r0, n0 = rev(dsn, slug), len(activity_rows(dsn, slug))
    for by in (strangers["Ugo Testname"], str(uuid4())):
        r = post(on, slug, expense, by=by)
        assert (r.status_code, r.json()) == (422, {"detail": "unknown_member"})
    assert post(on, slug, expense, by="not-a-uuid").status_code == 422
    nothing_written(dsn, slug, expense, r0, n0, 0)


def test_comments_on_an_expense_that_isnt_here_are_404(on, dsn):
    slug, _, expense = made_up(on)
    other, _, elsewhere = made_up(on)
    for e in (elsewhere, str(uuid4())):
        assert (on.get(comments_url(slug, e)).status_code, on.get(comments_url(slug, e)).json()["detail"]) == (404, "Expense not found")
        r = post(on, slug, e)
        assert (r.status_code, r.json()["detail"]) == (404, "Expense not found")
    assert comment_rows(dsn, elsewhere) == []
    assert on.get(comments_url("0" * 32, expense)).json()["detail"] == "Wallet not found"


def test_delete_a_comment(on, dsn):
    """B5, B7: comment_delete with the expense id and the actor, and no body anywhere in the row"""
    slug, people, expense = made_up(on)
    cid = post(on, slug, expense, by=people["Ugo Testname"]).json()["comments"][0]["id"]
    r0, n0 = rev(dsn, slug), len(activity_rows(dsn, slug))
    r = on.delete(comments_url(slug, expense, cid) + f"?by={people['Vida Testname']}")
    assert r.status_code == 200, r.text
    assert r.json()["comments"] == [] and r.json()["wallet"]["rev"] == r0 + 1 == rev(dsn, slug)
    assert comment_rows(dsn, expense) == []
    rows = activity_rows(dsn, slug)
    assert len(rows) == n0 + 1
    row = rows[-1]
    assert (row["action"], row["actor"], row["expense_id"]) == ("comment_delete", people["Vida Testname"], expense)
    assert (row["settlement_id"], row["member_id"], row["before"], row["after"]) == (None, None, None, None)
    assert "TESTCOMMENT" not in json.dumps(rows, default=str)
    assert r.headers["cache-control"] == "private, no-cache"


def test_delete_without_by_is_someones(on, dsn):
    slug, people, expense = made_up(on)
    cid = post(on, slug, expense, by=people["Ugo Testname"]).json()["comments"][0]["id"]
    assert on.delete(comments_url(slug, expense, cid)).status_code == 200
    assert activity_rows(dsn, slug)[-1]["actor"] is None


def test_delete_refusals_write_nothing(on, dsn):
    slug, people, expense = made_up(on)
    _, strangers, elsewhere = made_up(on)
    cid = post(on, slug, expense).json()["comments"][0]["id"]
    foreign = post(on, _slug_of(on, dsn, elsewhere), elsewhere).json()["comments"][0]["id"]
    r0, n0 = rev(dsn, slug), len(activity_rows(dsn, slug))
    r = on.delete(comments_url(slug, expense, cid) + f"?by={strangers['Ugo Testname']}")
    assert (r.status_code, r.json()) == (422, {"detail": "unknown_member"})
    for url in (comments_url(slug, expense, uuid4()), comments_url(slug, expense, foreign), comments_url(slug, elsewhere, foreign)):
        r = on.delete(url)
        assert (r.status_code, r.json()["detail"]) == (404, "Comment not found"), url
    nothing_written(dsn, slug, expense, r0, n0, 1)
    assert len(comment_rows(dsn, elsewhere)) == 1


def _slug_of(client, dsn, expense):
    return sql(dsn, "select w.share_slug from wallets w join expenses e on e.wallet_id = w.id where e.id = %s", (expense,))[0]["share_slug"]


def test_a_comment_write_and_its_activity_roll_back_together(on, dsn):
    """B5: a failure after the insert leaves no comment, no row and the old rev"""
    slug, _, expense = made_up(on)
    cid = post(on, slug, expense).json()["comments"][0]["id"]
    r0, n0 = rev(dsn, slug), len(activity_rows(dsn, slug))
    with fail_on_rev_bump(dsn):
        fails(lambda: post(on, slug, expense, body="TESTCOMMENT lost"))
        fails(lambda: on.delete(comments_url(slug, expense, cid)))
    nothing_written(dsn, slug, expense, r0, n0, 1)


def test_deleting_an_expense_deletes_its_comments_and_keeps_their_lines(on, dsn):
    """B7: the cascade; the activity rows stay (no FK)"""
    slug, _, expense = made_up(on)
    post(on, slug, expense)
    post(on, slug, expense)
    assert on.delete(f"/wallets/{slug}/expenses/{expense}").status_code == 200
    assert comment_rows(dsn, expense) == []
    assert [r["action"] for r in activity_rows(dsn, slug) if r["expense_id"] == expense] == ["comment_add", "comment_add"]


def test_comment_writes_take_the_wallet_rate_limit(on, monkeypatch):
    from app.limits import RateLimiter

    slug, _, expense = made_up(on)
    monkeypatch.setattr(wallets, "WRITE_LIMITER", RateLimiter(1))
    assert post(on, slug, expense).status_code == 201
    r = post(on, slug, expense)
    assert (r.status_code, r.json()["detail"]) == (429, "rate_limited")


# ---------------------------------------------------------------- B7c: history is append-only

def test_nothing_in_the_api_updates_or_deletes_activity():
    """B7c"""
    pattern = re.compile(r"\b(update\s+(only\s+)?wallet_activity|delete\s+from\s+(only\s+)?wallet_activity|truncate\s+(table\s+)?wallet_activity)\b", re.I)
    hits = [f"{p.name}: {m.group(0)}" for p in sorted((ROOT / "api" / "app").rglob("*.py")) for m in pattern.finditer(p.read_text(encoding="utf-8"))]
    assert hits == []


def test_the_guard_would_catch_one():
    pattern = re.compile(r"\b(update\s+(only\s+)?wallet_activity|delete\s+from\s+(only\s+)?wallet_activity|truncate\s+(table\s+)?wallet_activity)\b", re.I)
    for bad in ("UPDATE wallet_activity SET after = null", "delete from wallet_activity where id = 1", "truncate wallet_activity"):
        assert pattern.search(bad), bad
    assert not pattern.search("insert into wallet_activity (wallet_id) values (1)")


# ---------------------------------------------------------------- B8: the proof writes

def paid_after(people, frm, to, amount):
    return {"from_member": people[frm], "to_member": people[to], "amount_centavos": amount}


def test_a_proof_add_change_and_remove_each_record(client, dsn):
    """B5, B8: one row each, rev + 1 each, the actor from ?by=, and after = the payment"""
    slug, people, _ = made_up(client)
    sid = pay(client, slug, people, frm="Ugo Testname", to="Tessa Testname", amount=30000)
    r0, n0 = rev(dsn, slug), len(activity_rows(dsn, slug))
    ugo, vida = people["Ugo Testname"], people["Vida Testname"]

    a = client.post(proof_url(slug, sid) + f"?by={ugo}", content=PNG, headers={"content-type": "image/png"})
    assert a.status_code == 201, a.text
    b = client.post(proof_url(slug, sid) + f"?by={vida}", content=PNG2, headers={"content-type": "image/png"})
    assert b.status_code == 201, b.text
    c = client.delete(proof_url(slug, sid))
    assert c.status_code == 200, c.text

    assert [a.json()["rev"], b.json()["rev"], c.json()["rev"]] == [r0 + 1, r0 + 2, r0 + 3]
    assert rev(dsn, slug) == r0 + 3
    rows = activity_rows(dsn, slug)[n0:]
    after = paid_after(people, "Ugo Testname", "Tessa Testname", 30000)
    assert [(r["action"], r["actor"], r["settlement_id"], r["after"]) for r in rows] == [
        ("proof_add", ugo, sid, after),
        ("proof_change", vida, sid, after),
        ("proof_remove", None, sid, after),
    ]
    assert all(r["before"] is None and r["expense_id"] is None and r["member_id"] is None for r in rows)


def test_a_proof_remove_takes_by(client, dsn):
    slug, people, _ = made_up(client)
    sid = pay(client, slug, people, frm="Ugo Testname", to="Tessa Testname")
    upload(client, slug, sid)
    assert client.delete(proof_url(slug, sid) + f"?by={people['Tessa Testname']}").status_code == 200
    assert activity_rows(dsn, slug)[-1]["actor"] == people["Tessa Testname"]


def test_a_proof_by_someone_not_here_is_refused_before_storage(client, dsn, store):
    """B8 with B7's `by` rule: 422 unknown_member, no bytes stored, nothing written"""
    slug, people, expense = made_up(client)
    _, strangers, _ = made_up(client)
    sid = pay(client, slug, people, frm="Ugo Testname", to="Tessa Testname")
    r0, n0 = rev(dsn, slug), len(activity_rows(dsn, slug))
    puts = store.puts
    for by in (strangers["Ugo Testname"], str(uuid4())):
        r = client.post(proof_url(slug, sid) + f"?by={by}", content=PNG, headers={"content-type": "image/png"})
        assert (r.status_code, r.json()) == (422, {"detail": "unknown_member"})
    assert client.post(proof_url(slug, sid) + "?by=nope", content=PNG, headers={"content-type": "image/png"}).status_code == 422
    assert store.puts == puts
    upload(client, slug, sid)
    r0, n0 = rev(dsn, slug), len(activity_rows(dsn, slug))
    r = client.delete(proof_url(slug, sid) + f"?by={strangers['Ugo Testname']}")
    assert (r.status_code, r.json()) == (422, {"detail": "unknown_member"})
    assert client.get(f"/wallets/{slug}").json()["settlements"][0]["has_proof"] is True
    nothing_written(dsn, slug, expense, r0, n0, 0)


def test_proof_refusals_write_nothing(client, dsn, store):
    slug, people, expense = made_up(client)
    sid = pay(client, slug, people, frm="Ugo Testname", to="Tessa Testname")
    r0, n0 = rev(dsn, slug), len(activity_rows(dsn, slug))
    assert upload(client, slug, str(uuid4())).status_code == 404  # no such payment
    assert client.delete(proof_url(slug, sid)).status_code == 404  # no proof to remove
    assert upload(client, slug, sid, data=b"not an image").status_code == 422
    store.on_put = lambda _path: sql(dsn, "delete from settlements where id = %s", (sid,))  # undone during the upload
    assert upload(client, slug, sid).status_code == 404
    nothing_written(dsn, slug, expense, r0, n0, 0)


def test_a_full_wallet_refuses_a_proof_and_writes_nothing(client, dsn):
    slug, people, expense = made_up(client)
    sid = pay(client, slug, people, frm="Ugo Testname", to="Tessa Testname")
    fill_proofs(dsn, slug, {"Ben": people["Ugo Testname"], "Jacob": people["Tessa Testname"]}, 50)
    r0, n0 = rev(dsn, slug), len(activity_rows(dsn, slug))
    assert upload(client, slug, sid).status_code == 409
    nothing_written(dsn, slug, expense, r0, n0, 0)


def test_a_proof_write_and_its_activity_roll_back_together(client, dsn, store):
    """B5: the proof stays as it was and the new bytes are forgotten"""
    slug, people, expense = made_up(client)
    sid = pay(client, slug, people, frm="Ugo Testname", to="Tessa Testname")
    assert upload(client, slug, sid).status_code == 201
    kept = sql(dsn, "select proof_path from settlements where id = %s", (sid,))[0]["proof_path"]
    r0, n0 = rev(dsn, slug), len(activity_rows(dsn, slug))
    with fail_on_rev_bump(dsn):
        fails(lambda: upload(client, slug, sid, data=PNG2))
        fails(lambda: client.delete(proof_url(slug, sid)))
    assert sql(dsn, "select proof_path from settlements where id = %s", (sid,))[0]["proof_path"] == kept
    assert set(store.objects) == {kept}
    nothing_written(dsn, slug, expense, r0, n0, 0)


def test_a_proof_line_still_reads_after_the_payment_is_undone(on, dsn):
    """B8: after = {from_member, to_member, amount_centavos}, with no FK, so the line outlives the payment"""
    slug, people, _ = made_up(on)
    sid = pay(on, slug, people, frm="Vida Testname", to="Tessa Testname", amount=12345)
    upload(on, slug, sid)
    assert on.delete(f"/wallets/{slug}/settlements/{sid}").status_code == 200
    row = next(r for r in on.get(f"/wallets/{slug}/activity").json()["rows"] if r["action"] == "proof_add")
    assert row["settlement_id"] == sid
    assert row["after"] == paid_after(people, "Vida Testname", "Tessa Testname", 12345)


def test_the_sweep_is_not_a_persons_write(client, dsn):
    """The hourly sweep deletes old proofs on its own: no activity row, and rev stays (a same-rev answer still shows)"""
    from datetime import date

    from app import wallet_proofs
    from test_wallet_proofs import age

    slug, people, _ = made_up(client)
    sid = pay(client, slug, people, frm="Ugo Testname", to="Tessa Testname")
    upload(client, slug, sid)
    age(dsn, sid, "2026-01-01 12:00+08")
    r0, n0 = rev(dsn, slug), len(activity_rows(dsn, slug))
    assert wallet_proofs.sweep_proofs(date(2026, 11, 18)) == 1
    assert (rev(dsn, slug), len(activity_rows(dsn, slug))) == (r0, n0)


# ---------------------------------------------------------------- B17: the logs

def test_no_log_line_has_a_name_text_or_member_id(on, dsn, caplog):
    """B17 for A2's routes: counts, slug and rev appear; names, comment text, notes and every id don't"""
    caplog.set_level(logging.DEBUG)
    slug, people, expense = made_up(on)
    ugo, vida = people["Ugo Testname"], people["Vida Testname"]
    sid = pay(on, slug, people, frm="Ugo Testname", to="Tessa Testname")
    cid = post(on, slug, expense, by=ugo).json()["comments"][0]["id"]
    post(on, slug, expense, by=vida)
    stranger = str(uuid4())
    assert post(on, slug, expense, by=stranger).status_code == 422  # refused: the stranger's id mustn't reach a log either
    on.get(comments_url(slug, expense))
    assert on.delete(comments_url(slug, expense, cid) + f"?by={stranger}").status_code == 422  # the query form's refusal too
    on.delete(comments_url(slug, expense, cid) + f"?by={vida}")
    on.post(proof_url(slug, sid) + f"?by={ugo}", content=PNG, headers={"content-type": "image/png"})
    on.post(proof_url(slug, sid) + f"?by={vida}", content=PNG2, headers={"content-type": "image/png"})
    assert on.delete(proof_url(slug, sid) + f"?by={stranger}").status_code == 422
    on.delete(proof_url(slug, sid) + f"?by={ugo}")
    on.get(f"/wallets/{slug}/activity")

    text = "\n".join(r.getMessage() for r in caplog.records)
    wallet_id = str(wallet_uuid(dsn, slug))
    secrets = [*MEMBERS, "Testname", "TESTCOMMENT", "TESTPLACE", wallet_id, stranger, *people.values()]
    assert [s for s in secrets if s in text] == []

    api = [r.getMessage() for r in caplog.records if r.name == "tara_gala.api"]
    assert any(m.startswith(f"wallet comment add share_slug={slug} ") and "comments=1" in m for m in api)
    assert any(m.startswith(f"wallet comment add share_slug={slug} ") and "comments=2" in m for m in api)
    assert any(m.startswith(f"wallet comment refused share_slug={slug} ") and "reason=unknown_member" in m for m in api)
    assert any(m.startswith(f"wallet comment delete share_slug={slug} ") and "comments=1" in m for m in api)
    assert any(m.startswith(f"wallet comments get share_slug={slug} ") and "comments=2" in m for m in api)
    assert any(m.startswith(f"wallet activity get share_slug={slug} ") and "rows=" in m for m in api)
    for action in ("comment_add", "comment_delete", "proof_add", "proof_change", "proof_remove"):
        assert any(m.startswith(f"wallet activity share_slug={slug} action={action} rev=") for m in api), action


def test_a_feature_off_refusal_is_logged_with_the_slug(client, caplog):
    caplog.set_level(logging.INFO, logger="tara_gala.api")
    slug, _, expense = made_up(client)
    client.get(f"/wallets/{slug}/activity")
    post(client, slug, expense)
    api = [r.getMessage() for r in caplog.records if r.name == "tara_gala.api"]
    assert sum(1 for m in api if m.startswith(f"wallet activity refused share_slug={slug} ") and "reason=feature_off" in m) == 2
