"""TG-61 L1 to L24: reading a pin and a name from a Google Maps link (api/app/maps_link.py, options.md §4).

No test reaches Google. Every request goes to an httpx.MockTransport that answers from a table and records what was
asked, so each test asserts the exact hosts requested: none for a refused link. The fixtures under fixtures/maps_links/
are synthetic until the owner's six real links are recorded beside them (plan.md §4 task 0); every file there runs.
"""

import json
import logging
import math
from pathlib import Path

import httpx
import pytest

from app import maps_link as ml
from app.maps_link import LinkError

FIXTURES = Path(__file__).parent / "fixtures" / "maps_links"
SHORT = "https://maps.app.goo.gl/Zx9Synthetic"
PLACE = "https://www.google.com/maps/place/Kapihan+sa+Ulap/@16.4101,120.5902,17z/data=!3m1!4b1!8m2!3d16.41234!4d120.59321"


class Clock:
    """A fake time.monotonic(): it moves only when a test moves it."""

    def __init__(self):
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


class Net:
    """Answers each URL from `table` (a Response, a callable, or an exception to raise) and records every request."""

    def __init__(self, table: dict | None = None):
        self.table = table or {}
        self.asked: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        self.asked.append(url)
        answer = self.table.get(url)
        if answer is None:
            return httpx.Response(404)
        if isinstance(answer, Exception):
            raise answer
        return answer(request) if callable(answer) else answer

    @property
    def hosts(self) -> list[str]:
        return [httpx.URL(u).host for u in self.asked]

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self))


def redirect(location: str, status: int = 302) -> httpx.Response:
    return httpx.Response(status, headers={"location": location})


def page(html: str | bytes, status: int = 200) -> httpx.Response:
    return httpx.Response(status, content=html.encode() if isinstance(html, str) else html)


@pytest.fixture(autouse=True)
def empty_cache():
    ml.clear_cache()
    yield
    ml.clear_cache()


def resolve(link: str, net: Net, clock=None) -> ml.Resolved:
    """One fresh resolve: the cache is emptied first (the cache's own tests call ml.resolve)."""
    ml.clear_cache()
    return ml.resolve(link, client=net.client(), clock=clock or Clock())


def refused(link: str, net: Net, clock=None) -> LinkError:
    with pytest.raises(LinkError) as e:
        resolve(link, net, clock)
    return e.value


# ---------------------------------------------------------------- L1: every recorded fixture

def fixtures() -> list[Path]:
    return sorted(FIXTURES.glob("*.json"))


def test_there_are_fixtures_and_each_says_what_it_is():
    assert len(fixtures()) >= 6
    for f in fixtures():
        d = json.loads(f.read_text(encoding="utf-8"))
        assert d["_note"], f"{f.name}: say whether it's synthetic or a real recording"
        assert set(d) <= {"_note", "link", "hops", "expect"}


@pytest.mark.parametrize("path", fixtures(), ids=lambda p: p.stem)
def test_every_fixture_resolves_as_recorded(path):  # L1
    d = json.loads(path.read_text(encoding="utf-8"))
    table = {h["url"]: redirect(h["location"], h["status"]) if "location" in h else page(h["html"], h["status"]) for h in d["hops"]}
    net = Net(table)
    want = d["expect"]
    if want["outcome"] == "ok":
        got = resolve(d["link"], net)
        assert (got.lat, got.lng, got.name, got.pin) == (want["lat"], want["lng"], want["name"], want["pin"])
        assert got.maps_url == want["maps_url"]
    else:
        assert refused(d["link"], net).code == want["outcome"]
    asked = [h["url"] for h in d["hops"]]
    assert net.asked == asked, "exactly the recorded hops are requested, in order, and nothing past them"


# ---------------------------------------------------------------- L2 to L7: the URL forms, read with no request

@pytest.mark.parametrize("url, lat, lng, pin", [
    (PLACE, 16.41234, 120.59321, "path"),  # the place's own pin wins over the map's centre
    ("https://www.google.com/maps?q=16.4123,120.5932", 16.4123, 120.5932, "query"),
    ("https://www.google.com/maps/search/?api=1&query=16.4123%2C120.5932", 16.4123, 120.5932, "query"),
    ("https://maps.google.com/maps?ll=16.4123,120.5932&z=17", 16.4123, 120.5932, "query"),
    ("https://www.google.com/maps/dir/?api=1&destination=16.4123,+120.5932", 16.4123, 120.5932, "query"),
    ("https://www.google.com.ph/maps/place/16.4123,120.5932/@16.4,120.59,17z", 16.4123, 120.5932, "path"),
    ("https://google.com/maps/@16.4123,120.5932,17z", 16.4123, 120.5932, "center"),
    ("https://maps.google.com.ph/maps/place/-16.5,-120.25", -16.5, -120.25, "path"),
])
def test_the_url_forms_give_the_pin_without_a_request(url, lat, lng, pin):  # L2
    net = Net()
    got = resolve(url, net)
    assert (got.lat, got.lng, got.pin) == (lat, lng, pin)
    assert net.asked == [], "a long link is parsed, never fetched"


def test_the_name_is_decoded_and_kept_short():  # L3
    got = resolve("https://www.google.com/maps/place/Caf%C3%A9+by+the+Ruins/@16.41,120.59,17z", Net())
    assert got.name == "Café by the Ruins" and got.pin == "center"
    got = resolve("https://www.google.com/maps/@16.41,120.59,17z", Net())
    assert got.name is None, "a dropped pin has no name; the group types it"
    long_name = "A" * 120
    got = resolve(f"https://www.google.com/maps/place/{long_name}/@16.41,120.59,17z", Net())
    assert got.name == "A" * 80


def test_a_name_in_q_is_read_and_the_pin_still_needed():  # L4
    with pytest.raises(LinkError) as e:
        ml.resolve("https://www.google.com/maps?q=Good+Taste+Restaurant", client=Net().client(), clock=Clock())
    assert e.value.code == "link_no_pin"
    parsed = ml.parse(httpx.URL("https://www.google.com/maps?q=Good+Taste+Restaurant"))
    assert (parsed.name, parsed.lat, parsed.pin) == ("Good Taste Restaurant", None, "none")


@pytest.mark.parametrize("url", [
    "https://www.google.com/maps?q=0,0",
    "https://www.google.com/maps?q=91,120",
    "https://www.google.com/maps?q=16,181",
    "https://www.google.com/maps/@nan,120.5,17z",
    "https://www.google.com/maps/place/x/data=!3dinf!4d120.5",
    "https://www.google.com/maps/place/x/data=!3d0!4d0",
])
def test_a_pin_must_be_finite_in_range_and_not_zero_zero(url):  # L5
    net = Net()
    assert refused(url, net).code == "link_no_pin"
    assert net.asked == []


def test_the_link_is_found_inside_the_shared_text():  # L6
    net = Net({f"{SHORT}": redirect(PLACE)})
    got = resolve(f"Kapihan sa Ulap\n{SHORT}\nShared from Google Maps", net)
    assert got.lat == 16.41234 and net.hosts == ["maps.app.goo.gl"]
    assert refused("x" * 2001 + f" {SHORT}", Net()).code == "link_not_maps", "at most 2,000 characters of text"
    assert refused("no link here", Net()).code == "link_not_maps"


def test_the_saved_link_drops_its_query_and_stays_short():  # L7
    net = Net({f"{SHORT}?g_st=ic": redirect(PLACE)})
    assert resolve(f"{SHORT}?g_st=ic", net).maps_url == SHORT
    pinned_in_query = resolve("https://www.google.com/maps?q=16.4123,120.5932&g_st=ic", Net())
    assert pinned_in_query.maps_url == "https://www.google.com/maps/search/?api=1&query=16.4123,120.5932"
    huge = f"https://www.google.com/maps/place/{'B' * 60}/data=!3d16.41!4d120.59" + "!1s" + "x" * 500
    assert resolve(huge, Net()).maps_url == "https://www.google.com/maps/search/?api=1&query=16.41,120.59"


# ---------------------------------------------------------------- L8 to L10: the allow-list

@pytest.mark.parametrize("link", [
    "ftp://maps.app.goo.gl/x",
    "javascript:alert(1)//https://maps.app.goo.gl/x",
    "http://169.254.169.254/latest/meta-data",
    "https://10.0.0.1/maps/place/x",
    "https://maps.app.goo.gl:8080/x",
    "https://user@maps.app.goo.gl/x",
    "https://user:pw@maps.app.goo.gl/x",
    "https://google.com.evil.io/maps/place/x/@16.4,120.5,17z",
    "https://evilgoogle.com/maps/@16.4,120.5,17z",
    "https://goo.gl/x",  # goo.gl only under /maps
    "https://www.google.com/search?q=16.4,120.5",  # a long host only under /maps
    "https://www.google.com/url?q=https://www.google.com/maps/@16.4,120.5,17z",
])
def test_links_off_the_allow_list_are_refused_with_no_request(link):  # L8, B28
    net = Net()
    assert refused(link, net).code == "link_not_maps"
    assert net.asked == []


def test_http_is_upgraded_for_listed_hosts_only():  # L9
    net = Net({SHORT: redirect(PLACE)})
    assert resolve(SHORT.replace("https:", "http:"), net).lat == 16.41234
    assert net.asked == [SHORT], "requested over https"
    net = Net({SHORT: redirect("http://www.google.com/maps/@16.4123,120.5932,17z")})
    assert resolve(SHORT, net).pin == "center", "a hop to http on a listed host is upgraded too"
    assert refused("http://evil.io/maps", Net()).code == "link_not_maps"


def test_a_redirect_off_the_list_is_refused_before_it_is_requested():  # L10, B28
    for location in ("https://evil.io/maps/place/x", "http://169.254.169.254/", "https://maps.app.goo.gl:8080/y",
                     "https://user@www.google.com/maps/@16.4,120.5,17z", "https://google.com.evil.io/maps", "//evil.io/x"):
        net = Net({SHORT: redirect(location)})
        assert refused(SHORT, net).code == "link_unreadable", location
        assert net.hosts == ["maps.app.goo.gl"], location


# ---------------------------------------------------------------- L11 to L15: following short links

def chain(n: int, end: httpx.Response | None = None) -> dict:
    """SHORT redirects to SHORT/1, ... SHORT/n, which answers `end`."""
    urls = [SHORT] + [f"{SHORT}/{i}" for i in range(1, n + 1)]
    table = {a: redirect(b) for a, b in zip(urls, urls[1:])}
    table[urls[-1]] = end or redirect(PLACE)
    return table


def test_five_redirects_are_followed_and_a_sixth_is_not():  # L11, B29
    net = Net(chain(4))  # 4 short hops, then the place: 5 redirects
    assert resolve(SHORT, net).lat == 16.41234 and len(net.asked) == 5
    net = Net(chain(5))  # 6 redirects
    e = refused(SHORT, net)
    assert (e.code, e.reason) == ("link_unreadable", "too_many_hops")
    assert len(net.asked) == 6, "the sixth Location is never requested"


@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
def test_only_redirect_statuses_are_followed(status):  # L12
    net = Net({SHORT: redirect(PLACE, status)})
    assert resolve(SHORT, net).lat == 16.41234
    for bad in (200, 304, 404, 500):
        net = Net({SHORT: redirect(PLACE, bad) if bad != 200 else page("<html></html>")})
        e = refused(SHORT, net)
        assert e.code in ("link_unreadable", "link_no_pin"), bad
        if bad != 200:
            assert e.reason == f"status_{bad}"
    net = Net({SHORT: httpx.Response(302)})
    assert refused(SHORT, net).code == "link_unreadable", "a redirect with no Location"


def test_a_hop_that_times_out_is_unreadable():  # L13, B29
    net = Net({SHORT: httpx.ReadTimeout("read timed out for " + SHORT)})
    e = refused(SHORT, net)
    assert (e.code, e.reason) == ("link_unreadable", "timeout")


def test_a_body_over_512_kb_is_not_read_past_the_cap():  # L14
    sent = []

    def chunks():
        for _ in range(100):
            sent.append(1)
            yield b"x" * 65536

    net = Net({SHORT: redirect("https://www.google.com/maps/place/Big"),
               "https://www.google.com/maps/place/Big": lambda r: httpx.Response(200, content=chunks())})
    e = refused(SHORT, net)
    assert (e.code, e.reason) == ("link_unreadable", "too_big")
    assert len(sent) <= 9, "reading stops at 512 KB"


def test_a_consent_or_sign_in_hop_is_unreadable_and_not_requested():  # L15
    for host in ("consent.google.com", "accounts.google.com"):
        net = Net({SHORT: redirect(f"https://{host}/ml?continue=https://www.google.com/maps")})
        e = refused(SHORT, net)
        assert (e.code, e.reason) == ("link_unreadable", "consent")
        assert net.hosts == ["maps.app.goo.gl"]


# ---------------------------------------------------------------- L16 to L20: review M4, one URL object

@pytest.mark.parametrize("link, reason", [
    ("https://maps.app.goo.gl\\@evil.io/x", "bad_char"),  # refused before httpx parses it, whatever httpx would make of it
    ("https://evil.io#@maps.app.goo.gl/", "off_list"),
    ("https://maps.app.goo.gl%2F@evil.io", "off_list"),
    ("https://[::1]/", "off_list"),
    ("https://[::ffff:169.254.169.254]/maps", "off_list"),
    ("https://maps.app\t.goo.gl/x", "off_list"),  # the tab ends the link: "https://maps.app"
    ("https://maps.app.goo.gl/x\x00y", "bad_char"),
    ("https://maps.app.goo.gl/x\x7f", "bad_char"),
    ("https://maps.app.goo.gl/x\u200by", "bad_char"),  # a zero-width space is a format character, not whitespace
])
def test_review_m4_tricks_are_refused_with_no_request(link, reason):  # L16
    net = Net()
    e = refused(link, net)
    assert (e.code, e.reason) == ("link_not_maps", reason)
    assert net.asked == []
    assert str(e) == "" and e.__cause__ is None and e.__suppress_context__ is True


@pytest.mark.parametrize("link", ["https://maps.app.goo.gl.:443/x", "HTTPS://MAPS.APP.GOO.GL/x", "https://maps.app.goo.gl:443/x"])
def test_review_m4_forms_that_are_the_short_host(link):  # L17
    net = Net({"https://maps.app.goo.gl./x": redirect(PLACE), "https://maps.app.goo.gl/x": redirect(PLACE)})
    assert resolve(link, net).lat == 16.41234
    assert [h.rstrip(".") for h in net.hosts] == ["maps.app.goo.gl"]


def test_the_open_redirector_is_never_requested():  # L18, review M4 (stricter: refused before its request)
    net = Net({SHORT: redirect("https://www.google.com/url?q=http://169.254.169.254/")})
    e = refused(SHORT, net)
    assert e.code == "link_unreadable" and e.reason == "off_list"
    assert net.hosts == ["maps.app.goo.gl"]


def test_a_location_with_a_backslash_or_space_is_refused():  # L19
    for location, reason in (("https://www.google.com\\@evil.io/maps", "bad_char"), ("https://www.google.com/maps place", "bad_char"),
                             ("https://www.google.com/maps\u200b", "bad_char"),
                             ("https://www.google.com/maps\tX", "network")):  # httpx refuses this one itself, before us
        net = Net({SHORT: httpx.Response(302, headers=[(b"location", location.encode())])})  # raw bytes, as a server sends them
        e = refused(SHORT, net)
        assert (e.code, e.reason) == ("link_unreadable", reason), repr(location)
        assert net.hosts == ["maps.app.goo.gl"]


def test_the_guard_checks_the_object_it_requests(monkeypatch):  # L20
    """Every URL handed to the client is an httpx.URL that passed allowed(), never a string parsed again."""
    seen = []
    real = ml.allowed

    def spy(u):
        seen.append(u)
        return real(u)

    monkeypatch.setattr(ml, "allowed", spy)
    net = Net({SHORT: redirect("https://maps.app.goo.gl/2"), "https://maps.app.goo.gl/2": redirect(PLACE)})
    client = net.client()
    requested = []
    original = client.stream

    def stream(method, url, **kw):
        assert isinstance(url, httpx.URL)
        assert any(url is s for s in seen), "the very object that was checked"
        assert kw.get("follow_redirects") is False
        requested.append(url)
        return original(method, url, **kw)

    client.stream = stream
    ml.resolve(SHORT, client=client, clock=Clock())
    assert len(requested) == 2


# ---------------------------------------------------------------- L21 and L22: the 8 s deadline (review S10)

def test_a_slow_second_hop_stops_the_chain():  # L21
    clock = Clock()

    def slow(request):
        clock.t += 7.0  # each answer takes 7 s on the fake clock: under the 8 s deadline once, over it twice
        return redirect(f"{SHORT}/{len(net.asked)}")

    net = Net({SHORT: slow, f"{SHORT}/1": slow, f"{SHORT}/2": slow})
    e = refused(SHORT, net, clock)
    assert (e.code, e.reason) == ("link_unreadable", "deadline")
    assert len(net.asked) == 2, "the third hop is never started"


def test_a_body_read_stops_at_the_deadline_between_chunks():  # L22
    clock = Clock()
    sent = []

    def chunks():
        for _ in range(5):
            sent.append(1)
            clock.t += 3.0
            yield b"<html>" + b" " * 1000

    net = Net({SHORT: redirect("https://www.google.com/maps/place/Slow"),
               "https://www.google.com/maps/place/Slow": lambda r: httpx.Response(200, content=chunks())})
    e = refused(SHORT, net, clock)
    assert (e.code, e.reason) == ("link_unreadable", "deadline")
    assert len(sent) == 3, "stopped as the third chunk passes 8 s"


# ---------------------------------------------------------------- L23: the page fallback and the cache

def test_the_final_page_gives_the_pin_only_when_the_url_has_none():  # L23, B30
    html = '<meta content="https://maps.google.com/maps/api/staticmap?center=16.4178%2C120.5987&amp;zoom=15" property="og:image">'
    net = Net({SHORT: redirect("https://www.google.com/maps/place/Panaderia"), "https://www.google.com/maps/place/Panaderia": page(html)})
    got = resolve(SHORT, net)
    assert (got.lat, got.lng, got.pin, got.name) == (16.4178, 120.5987, "page", "Panaderia")
    markers = '<img src="https://maps.googleapis.com/maps/api/staticmap?markers=16.4001%2C120.6002&size=1x1">'
    net = Net({SHORT: page(markers)})
    assert resolve(SHORT, net).pin == "page"
    net = Net({SHORT: redirect(PLACE)})
    resolve(SHORT, net)
    assert net.asked == [SHORT], "the place URL has its pin, so it isn't fetched"


def test_a_resolved_link_is_cached_for_15_minutes():  # L23
    clock = Clock()
    net = Net({SHORT: redirect(PLACE)})
    first = ml.resolve(SHORT, client=net.client(), clock=clock)
    clock.t += 14 * 60
    assert ml.resolve(f"{SHORT}?g_st=ic", client=net.client(), clock=clock) == first, "the Apply after Suggest reads the cache"
    assert len(net.asked) == 1
    clock.t += 2 * 60
    ml.resolve(SHORT, client=net.client(), clock=clock)
    assert len(net.asked) == 2, "kept 15 minutes"


def test_the_cache_holds_256_links():
    clock = Clock()
    net = Net({f"{SHORT}{i}": redirect(PLACE) for i in range(260)})
    for i in range(257):
        ml.resolve(f"{SHORT}{i}", client=net.client(), clock=clock)
    ml.resolve(f"{SHORT}256", client=net.client(), clock=clock)
    assert len(net.asked) == 257, "the newest is cached"
    ml.resolve(f"{SHORT}0", client=net.client(), clock=clock)
    assert len(net.asked) == 258, "the oldest was dropped"


# ---------------------------------------------------------------- L24: no URL, name or pin in errors or logs (review M3)

def test_errors_carry_no_url_and_no_cause():  # L24
    net = Net({SHORT: httpx.ConnectError(f"failed to reach {SHORT}/secret-path")})
    e = refused(SHORT, net)
    assert (e.code, e.reason) == ("link_unreadable", "network")
    assert str(e) == "" and e.args == () and e.__cause__ is None and e.__suppress_context__ is True
    for bad in ("https://evil.io/x", "https://maps.app.goo.gl\\@evil.io/x"):
        e = refused(bad, Net())
        assert str(e) == "" and e.args == ()


def test_resolve_logs_counts_and_codes_only(caplog):  # L24
    caplog.set_level(logging.INFO, logger="tara_gala.api")
    net = Net({SHORT: redirect("https://www.google.com/maps/place/Kapihan+sa+Ulap/data=!3d16.41234!4d120.59321")})
    resolve(SHORT, net)
    ml.clear_cache()
    net = Net({SHORT: httpx.ConnectError(f"boom {SHORT}")})
    refused(SHORT, net)
    refused("https://evil.io/maps/place/Kapihan", Net())
    lines = [r.getMessage() for r in caplog.records if r.name == "tara_gala.api"]
    assert any(m.startswith("maps link resolve outcome=ok hops=1 final=long ") and "pin=path name=yes cache=no" in m for m in lines), lines
    warn = [r for r in caplog.records if r.levelno == logging.WARNING and "outcome=unreadable" in r.getMessage()]
    assert warn and "reason=network" in warn[0].getMessage()
    assert any("outcome=not_maps" in m and "reason=off_list" in m for m in lines)
    text = caplog.text
    for leak in ("Zx9Synthetic", "goo.gl", "google.com", "evil.io", "Kapihan", "16.41", "120.59", "boom"):
        assert leak not in text, leak


def test_the_httpx_logger_stays_at_warning():  # L24, review nit 5
    from app.logging_setup import configure_logging

    configure_logging({})
    assert logging.getLogger("httpx").level == logging.WARNING


def test_the_default_client_takes_no_proxy_and_follows_nothing():
    c = ml.make_client()
    try:
        assert c.follow_redirects is False and c._trust_env is False
        assert c.timeout == httpx.Timeout(ml.HOP_TIMEOUT_S)
    finally:
        c.close()
    assert ml.HOP_TIMEOUT_S == 4.0 and ml.DEADLINE_S == 8.0 and ml.MAX_HOPS == 5 and ml.MAX_BODY == 512 * 1024
    assert math.isclose(ml.CACHE_TTL_S, 900) and ml.CACHE_SIZE == 256
