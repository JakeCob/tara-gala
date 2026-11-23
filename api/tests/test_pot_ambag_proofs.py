"""TG-73 A3: an ambag's proof, added, changed, removed, served and swept exactly as a payment's (TG-53), on its own
routes behind WALLET_POT (plan B11, test-plan §5). The payments' own TG-53 suite (test_wallet_proofs.py) runs unchanged
over the shared helpers. Made-up wallets and names; a fake Storage; the local throwaway database.
"""

import logging
from datetime import date

import pytest

from app import wallet_proofs
from test_wallet_pot import flags, frozen_today, on, send, started  # noqa: F401  (fixtures)
from test_wallet_proofs import GIF, JPEG, LIMIT, OBJECT_PATH, PNG, PNG2, WEBP, api_messages, sql, store  # noqa: F401


def url(slug, aid):
    return f"/wallets/{slug}/pot/ambag/{aid}/proof"


def upload(client, slug, aid, data=PNG, content_type="image/png", by=None):
    return client.post(url(slug, aid) + (f"?by={by}" if by else ""), content=data, headers={"content-type": content_type})


def sent(client, n=3):
    """A goal with one pending ambag from the second person. Returns (slug, ids, ambag id)."""
    slug, ids, _ = started(client, n)
    r = send(client, slug, ids[1], ids[1], 500000)
    return slug, ids, r.json()["pot"]["ambag"][0]["id"]


def row(dsn, aid):
    found = sql(dsn, "select proof_path, proof_type, proof_bytes, proof_at from pot_ambag where id = %s", (aid,))
    return found[0] if found else None


def ambag_of(wallet, aid):
    return next(a for a in wallet["pot"]["ambag"] if a["id"] == aid)


def lines(dsn, slug):
    return sql(dsn, """select a.action, a.actor::text as actor, a.member_id::text as member_id, a.after from wallet_activity a
                       join wallets w on w.id = a.wallet_id where w.share_slug = %s order by a.id""", (slug,))


def test_add_then_get_then_replace_then_remove(on, dsn, store, caplog):
    slug, ids, aid = sent(on)
    with caplog.at_level(logging.INFO, logger="tara_gala.api"):
        r = upload(on, slug, aid, by=ids[1])
    assert r.status_code == 201, r.text
    a = ambag_of(r.json(), aid)
    assert a["has_proof"] is True and a["proof_at"] is not None
    first = row(dsn, aid)
    assert OBJECT_PATH.fullmatch(first["proof_path"]) and store.objects[first["proof_path"]][0] == PNG
    assert lines(dsn, slug)[-1] == {"action": "ambag_proof_add", "actor": ids[1], "member_id": ids[1],
                                    "after": {"ambag_id": aid, "member_id": ids[1], "amount_centavos": 500000}}
    assert f"wallet ambag proof add share_slug={slug} bytes={len(PNG)} replaced=0 proofs=1" in api_messages(caplog)

    got = on.get(url(slug, aid))
    assert got.status_code == 200 and got.content == PNG
    assert got.headers["cache-control"] == "private, no-store" and got.headers["x-content-type-options"] == "nosniff"
    assert got.headers["x-robots-tag"] == "noindex" and got.headers["content-type"] == "image/png"

    r = upload(on, slug, aid, data=PNG2, by=ids[1])
    assert r.status_code == 201
    assert first["proof_path"] not in store.objects and row(dsn, aid)["proof_path"] in store.objects
    assert lines(dsn, slug)[-1]["action"] == "ambag_proof_change"

    r = on.delete(url(slug, aid) + f"?by={ids[1]}")
    assert r.status_code == 200 and ambag_of(r.json(), aid)["has_proof"] is False
    assert row(dsn, aid) == {"proof_path": None, "proof_type": None, "proof_bytes": None, "proof_at": None}
    assert not store.objects
    assert lines(dsn, slug)[-1]["action"] == "ambag_proof_remove"
    again = on.delete(url(slug, aid))
    assert (again.status_code, again.json()) == (404, {"detail": "Proof not found"})
    assert on.get(url(slug, aid)).status_code == 404


@pytest.mark.parametrize("data, content_type", [(JPEG, "image/jpeg"), (WEBP, "image/webp"), (GIF, "image/gif")])
def test_each_image_type(on, data, content_type):
    slug, ids, aid = sent(on)
    assert upload(on, slug, aid, data=data, content_type=content_type).status_code == 201
    assert on.get(url(slug, aid)).headers["content-type"] == content_type


@pytest.mark.parametrize("data, content_type, status, detail", [
    (b"not a picture at all", "image/png", 422, "not_an_image"),
    (PNG, "image/jpeg", 422, "not_an_image"),
    (b"\x89PNG\r\n\x1a\n" + b"\x00" * LIMIT, "image/png", 413, "too_big"),
])
def test_a_refused_upload_stores_nothing(on, dsn, store, data, content_type, status, detail):
    slug, ids, aid = sent(on)
    r = upload(on, slug, aid, data=data, content_type=content_type)
    assert (r.status_code, r.json()) == (status, {"detail": detail})
    assert store.puts == 0 and row(dsn, aid)["proof_path"] is None


def test_storage_down_is_a_503_and_the_ambag_stays(on, dsn, store):
    slug, ids, aid = sent(on)
    store.fail_put = True
    r = upload(on, slug, aid)
    assert (r.status_code, r.json()) == (503, {"detail": "storage_unavailable"})
    assert row(dsn, aid)["proof_path"] is None and ambag_of(on.get(f"/wallets/{slug}").json(), aid)["status"] == "sent"


def test_bytes_go_before_the_lock_and_an_ambag_undone_meanwhile_forgets_them(on, dsn, store):
    slug, ids, aid = sent(on)

    def undo(_path):  # Storage runs before the wallet lock: the withdrawal goes through during the upload
        r = on.delete(f"/wallets/{slug}/pot/ambag/{aid}?by={ids[1]}")
        assert r.status_code == 200

    store.on_put = undo
    r = upload(on, slug, aid)
    assert (r.status_code, r.json()) == (404, {"detail": "ambag_gone"})
    assert store.puts == 1 and not store.objects


def test_an_unknown_or_another_wallets_ambag_is_ambag_gone(on, store):
    slug, ids, aid = sent(on)
    other, oids, oaid = sent(on)
    for r in (upload(on, slug, oaid), on.delete(url(slug, oaid))):
        assert (r.status_code, r.json()) == (404, {"detail": "ambag_gone"})
    assert on.get(url(slug, oaid)).status_code == 404
    assert store.puts == 0


def test_undoing_an_ambag_deletes_its_proof_bytes(on, dsn, store):
    slug, ids, aid = sent(on)
    upload(on, slug, aid)
    assert store.objects
    assert on.delete(f"/wallets/{slug}/pot/ambag/{aid}?by={ids[1]}").status_code == 200
    assert not store.objects


def test_received_keeps_the_proof(on, dsn, store):
    slug, ids, aid = sent(on)
    upload(on, slug, aid)
    r = on.patch(f"/wallets/{slug}/pot/ambag/{aid}", json={"by": ids[0], "status": "received"})
    assert ambag_of(r.json(), aid)["has_proof"] is True and store.objects


def test_the_ambag_cap_is_its_own(on, dsn, store, monkeypatch):
    monkeypatch.setattr(wallet_proofs, "MAX_AMBAG_PROOFS", 1)
    slug, ids, aid = sent(on)
    second = send(on, slug, ids[2], ids[2], 100).json()["pot"]["ambag"][0]["id"]
    assert upload(on, slug, aid).status_code == 201
    r = upload(on, slug, second)
    assert (r.status_code, r.json()) == (409, {"detail": "too_many_proofs"})
    assert len(store.objects) == 1
    assert upload(on, slug, aid, data=PNG2).status_code == 201  # replacing its own proof isn't one more


def test_flag_off_the_proof_routes_are_feature_off(client, flags, store):
    flags(wallet_pot=True)
    slug, ids, aid = sent(client)
    flags(wallet_pot=False)
    for r in (upload(client, slug, aid), client.get(url(slug, aid)), client.delete(url(slug, aid))):
        assert (r.status_code, r.json()) == (404, {"detail": "feature_off"})
    assert store.puts == 0


def _aged(dsn, aid, stamp):
    sql(dsn, "update pot_ambag set proof_at = %s::timestamptz where id = %s", (stamp, aid))


def test_the_sweep_takes_ambag_proofs_14_days_after_the_later_of_upload_and_trip_home(on, dsn, store, caplog):
    slug, ids, aid = sent(on)
    upload(on, slug, aid)
    path = row(dsn, aid)["proof_path"]
    _aged(dsn, aid, "2026-11-01T10:00:00+08:00")
    assert wallet_proofs.sweep_proofs(date(2026, 11, 15)) == 0  # day 14: still kept
    with caplog.at_level(logging.INFO, logger="tara_gala.api"):
        assert wallet_proofs.sweep_proofs(date(2026, 11, 16)) == 1
    assert path not in store.objects
    swept = row(dsn, aid)
    assert swept["proof_path"] is None and swept["proof_at"] is not None  # "Proof deleted", as a payment's
    assert "wallet ambag proof sweep deleted=1" in api_messages(caplog)
    assert ambag_of(on.get(f"/wallets/{slug}").json(), aid)["has_proof"] is False


def test_the_sweep_waits_for_the_trip_home(on, dsn, store):
    slug, ids, aid = sent(on)
    upload(on, slug, aid)
    wid = sql(dsn, "select id from wallets where share_slug = %s", (slug,))[0]["id"]
    sql(dsn, "insert into trip_sessions (name, start_date, return_date, wallet_id) values ('Trip (made up)', '2026-11-25', '2026-11-29', %s)", (wid,))
    _aged(dsn, aid, "2026-11-01T10:00:00+08:00")
    assert wallet_proofs.sweep_proofs(date(2026, 12, 13)) == 0
    assert wallet_proofs.sweep_proofs(date(2026, 12, 14)) == 1


def test_a_storage_failure_in_the_sweep_keeps_the_row_for_the_next_hour(on, dsn, store):
    slug, ids, aid = sent(on)
    upload(on, slug, aid)
    _aged(dsn, aid, "2026-10-01T10:00:00+08:00")
    store.fail_delete = True
    assert wallet_proofs.sweep_proofs(date(2026, 11, 16)) == 0
    assert row(dsn, aid)["proof_path"] is not None


def test_logs_carry_slugs_and_sizes_never_a_name_or_a_path(on, dsn, store, caplog):
    with caplog.at_level(logging.INFO, logger="tara_gala.api"):
        slug, ids, aid = sent(on)
        upload(on, slug, aid, by=ids[1])
        on.get(url(slug, aid))
        upload(on, slug, aid, data=b"nope")
        on.delete(url(slug, aid))
        wallet_proofs.sweep_proofs(date(2026, 11, 16))
    path_free = [m for m in api_messages(caplog)]
    assert any(m.startswith("wallet ambag proof get ") for m in path_free)
    for m in path_free:
        assert "Testname" not in m and "wallets/" not in m and not any(i in m for i in [*ids, aid]), m
