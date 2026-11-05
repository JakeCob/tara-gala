"""TG-61 L1 to L27: reading a pin and a name from a Google Maps link (api/app/maps_link.py, options.md §4). The IDs are
test-plan.md §3.2's; L28 on are cases it doesn't number. N1 on are owner round 5's links with no pin: the address is
geocoded with Nominatim (a MockTransport stand-in here), Google's pages are never read, and a typed pin is accepted.

No test reaches Google. Every request goes to an httpx.MockTransport that answers from a table and records what was
asked, so each test asserts the exact hosts requested: none for a refused link. The fixtures under fixtures/maps_links/
are synthetic until the owner's six real links are recorded beside them (plan.md §4 task 0). The manager asked for
synthetic fixtures for now, so L1 to L6 run on them rather than waiting as xfail (test-plan §8); every file there runs.
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


GEO = "nominatim.openstreetmap.org"


class Clock:
    """A fake time.monotonic(): it moves only when a test moves it, or when the code under test sleeps on it."""

    def __init__(self):
        self.t = 1000.0
        self.slept: list[float] = []

    def __call__(self) -> float:
        return self.t

    def sleep(self, s: float) -> None:
        self.slept.append(s)
        self.t += s


class Net:
    """Answers each URL from `table` (a Response, a callable, or an exception to raise) and records every request.
    Nominatim is answered by its query, from `geo`: a list is its JSON reply, and an unknown query finds nothing."""

    def __init__(self, table: dict | None = None, geo: dict | None = None):
        self.table = table or {}
        self.geo = geo or {}
        self.asked: list[str] = []
        self.headers: list[httpx.Headers] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        self.asked.append(url)
        self.headers.append(request.headers)
        if request.url.host == GEO:
            answer = self.geo.get(request.url.params.get("q"), [])
            if isinstance(answer, list):
                return httpx.Response(200, json=answer)
        else:
            answer = self.table.get(url)
        if answer is None:
            return httpx.Response(404)
        if isinstance(answer, Exception):
            raise answer
        return answer(request) if callable(answer) else answer

    @property
    def hosts(self) -> list[str]:
        return [httpx.URL(u).host for u in self.asked]

    @property
    def geocoded(self) -> list[str]:
        return [httpx.URL(u).params.get("q") for u in self.asked if httpx.URL(u).host == GEO]

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
    """One fresh resolve: the caches are emptied first (the caches' own tests call ml.resolve)."""
    ml.clear_cache()
    clock = clock or Clock()
    return ml.resolve(link, client=net.client(), clock=clock, sleep=clock.sleep)


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
        assert set(d) <= {"_note", "link", "hops", "geocode", "expect"}


@pytest.mark.parametrize("path", fixtures(), ids=lambda p: p.stem)
def test_every_fixture_resolves_as_recorded(path):  # L1 to L6 and N1; synthetic until task 0's recordings
    d = json.loads(path.read_text(encoding="utf-8"))
    table = {h["url"]: redirect(h["location"], h["status"]) if "location" in h else page(h["html"], h["status"]) for h in d["hops"]}
    net = Net(table, d.get("geocode"))
    want = d["expect"]
    if want["outcome"] == "ok":
        got = resolve(d["link"], net)
        assert (got.lat, got.lng, got.name, got.pin) == (want["lat"], want["lng"], want["name"], want["pin"])
        assert got.maps_url == want["maps_url"]
    else:
        e = refused(d["link"], net)
        assert e.code == want["outcome"]
        if "name" in want:
            assert e.name == want["name"]
    assert [u for u in net.asked if httpx.URL(u).host != GEO] == [h["url"] for h in d["hops"]], \
        "exactly the recorded hops are requested, in order, and no Google page past them"
    assert net.geocoded == want["geocoded"]


# ---------------------------------------------------------------- L7 and L26: the URL forms, read with no request

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
def test_the_url_forms_give_the_pin_without_a_request(url, lat, lng, pin):  # L7, L26
    net = Net()
    got = resolve(url, net)
    assert (got.lat, got.lng, got.pin) == (lat, lng, pin)
    assert net.asked == [], "a long link is parsed, never fetched"


def test_the_name_is_decoded_and_kept_short():  # L7
    got = resolve("https://www.google.com/maps/place/Caf%C3%A9+by+the+Ruins/@16.41,120.59,17z", Net())
    assert got.name == "Café by the Ruins" and got.pin == "center"
    got = resolve("https://www.google.com/maps/@16.41,120.59,17z", Net())
    assert got.name is None, "a dropped pin has no name; the group types it"
    long_name = "A" * 120
    got = resolve(f"https://www.google.com/maps/place/{long_name}/@16.41,120.59,17z", Net())
    assert got.name == "A" * 80


def test_a_name_in_q_is_read_and_the_pin_still_needed():  # L15, N2
    net = Net()
    e = refused("https://www.google.com/maps?q=Good+Taste+Restaurant", net)
    assert (e.code, e.name) == ("need_pin", "Good Taste Restaurant")
    assert net.geocoded == ["Good Taste Restaurant"], "geocoded, and nothing found"
    parsed = ml.parse(httpx.URL("https://www.google.com/maps?q=Good+Taste+Restaurant"))
    assert (parsed.name, parsed.lat, parsed.pin, parsed.address) == ("Good Taste Restaurant", None, "none", "Good Taste Restaurant")


@pytest.mark.parametrize("url", [
    "https://www.google.com/maps?q=0,0",
    "https://www.google.com/maps?q=91,120",
    "https://www.google.com/maps?q=16,181",
    "https://www.google.com/maps/@nan,120.5,17z",
    "https://www.google.com/maps/data=!3dinf!4d120.5",
    "https://www.google.com/maps/data=!3d0!4d0",
    "https://www.google.com/maps/place/0,0/",
    "https://www.google.com/maps/place/16.4,181/",
])
def test_a_pin_must_be_finite_in_range_and_not_zero_zero(url):  # L18
    net = Net()
    assert refused(url, net).code == "need_pin"
    assert net.asked == [], "no address either, so nothing to geocode: a bad pin is never read as an address"


@pytest.mark.parametrize("text", [
    f"Kapihan sa Ulap\n{SHORT}\nShared from Google Maps",
    f"Kapihan sa Ulap{SHORT}",  # a one-line field drops the newline (test-plan F3)
    f"Kapihan sa Ulap {SHORT.upper().replace('ZX9SYNTHETIC', 'Zx9Synthetic')}",
    "x" * (2000 - len(SHORT)) + SHORT,  # 2,000 characters, the link at the end
])
def test_the_link_is_found_inside_the_shared_text(text):  # L19, L25
    assert len(text) <= 2000
    net = Net({SHORT: redirect(PLACE)})
    got = resolve(text, net)
    assert got.lat == 16.41234 and net.asked == [SHORT]


def test_too_much_text_or_no_link_is_not_a_maps_link():  # L25
    assert refused("x" * (2001 - len(SHORT)) + SHORT, Net()).code == "link_not_maps", "2,001 characters"
    assert refused("no link here", Net()).code == "link_not_maps"
    assert refused("ftp://maps.app.goo.gl/x", Net()).code == "link_not_maps"


def test_the_saved_link_drops_its_query_and_stays_short():  # L27
    net = Net({f"{SHORT}?g_st=ic": redirect(PLACE)})
    assert resolve(f"{SHORT}?g_st=ic", net).maps_url == SHORT
    pinned_in_query = resolve("https://www.google.com/maps?q=16.4123,120.5932&g_st=ic", Net())
    assert pinned_in_query.maps_url == "https://www.google.com/maps/search/?api=1&query=16.4123,120.5932"
    huge = f"https://www.google.com/maps/place/{'B' * 60}/data=!3d16.41!4d120.59" + "!1s" + "x" * 500
    saved = resolve(huge, Net()).maps_url
    assert saved == "https://www.google.com/maps/search/?api=1&query=16.41,120.59" and len(saved) <= 500


# ---------------------------------------------------------------- L8 to L12: the allow-list (B28)

@pytest.mark.parametrize("link", [
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
def test_links_off_the_allow_list_are_refused_with_no_request(link):  # L8 to L12
    net = Net()
    assert refused(link, net).code == "link_not_maps"
    assert net.asked == []


def test_http_is_upgraded_for_listed_hosts_only():  # L28
    net = Net({SHORT: redirect(PLACE)})
    assert resolve(SHORT.replace("https:", "http:"), net).lat == 16.41234
    assert net.asked == [SHORT], "requested over https"
    net = Net({SHORT: redirect("http://www.google.com/maps?q=16.4123,120.5932")})
    assert resolve(SHORT, net).pin == "query", "a hop to http on a listed host is upgraded too"
    assert refused("http://evil.io/maps", Net()).code == "link_not_maps"


def test_a_redirect_off_the_list_is_refused_before_it_is_requested():  # L8 to L12
    for location in ("https://evil.io/maps/place/x", "http://169.254.169.254/", "https://maps.app.goo.gl:8080/y",
                     "https://user@www.google.com/maps/@16.4,120.5,17z", "https://google.com.evil.io/maps", "//evil.io/x"):
        net = Net({SHORT: redirect(location)})
        assert refused(SHORT, net).code == "link_unreadable", location
        assert net.hosts == ["maps.app.goo.gl"], location


# ---------------------------------------------------------------- L13 to L17: following short links

def chain(n: int, end: httpx.Response | None = None) -> dict:
    """SHORT redirects to SHORT/1, ... SHORT/n, which answers `end`."""
    urls = [SHORT] + [f"{SHORT}/{i}" for i in range(1, n + 1)]
    table = {a: redirect(b) for a, b in zip(urls, urls[1:])}
    table[urls[-1]] = end or redirect(PLACE)
    return table


def test_at_most_five_requests():  # L13, B29
    net = Net(chain(4))  # 5 requests, the last answering with the place URL, which has its pin
    assert resolve(SHORT, net).lat == 16.41234 and len(net.asked) == 5
    net = Net(chain(5))  # a sixth request would be needed
    e = refused(SHORT, net)
    assert (e.code, e.reason) == ("link_unreadable", "too_many_hops")
    assert len(net.asked) == 5, "exactly 5 requests, and the sixth Location is never requested"


@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
def test_only_redirect_statuses_are_followed(status):  # L29
    net = Net({SHORT: redirect(PLACE, status)})
    assert resolve(SHORT, net).lat == 16.41234
    for bad in (200, 304, 404, 500):
        net = Net({SHORT: redirect(PLACE, bad) if bad != 200 else page("<html></html>")})
        e = refused(SHORT, net)
        assert e.code == ("need_pin" if bad == 200 else "link_unreadable"), bad
        if bad != 200:
            assert e.reason == f"status_{bad}"
    net = Net({SHORT: httpx.Response(302)})
    assert refused(SHORT, net).code == "link_unreadable", "a redirect with no Location"


def test_a_hop_that_times_out_is_unreadable():  # L14, B29
    net = Net({SHORT: httpx.ReadTimeout("read timed out for " + SHORT)})
    e = refused(SHORT, net)
    assert (e.code, e.reason) == ("link_unreadable", "timeout")


def test_google_pages_are_never_read_for_a_pin():  # L16, N3 (owner round 5: their og:image is the requester's location)
    og = page('<meta content="https://maps.google.com/maps/api/staticmap?center=60.17%2C24.94&amp;zoom=15" property="og:image">'
              "<script>window.APP_INITIALIZATION_STATE=[[[1,24.94,60.17]]]</script>")
    place = "https://www.google.com/maps/place/Panaderia/"
    net = Net({SHORT: redirect(place), place: og}, {"Panaderia": [{"lat": "16.4178", "lon": "120.5987"}]})
    got = resolve(SHORT, net)
    assert (got.lat, got.lng, got.pin) == (16.4178, 120.5987, "address")
    assert net.hosts == ["maps.app.goo.gl", GEO], "the place page is never requested"
    sent = []

    def body():
        sent.append(1)
        yield b"<html>centre=60.17%2C24.94</html>"

    net = Net({SHORT: lambda r: httpx.Response(200, content=body())})
    e = refused(SHORT, net)
    assert (e.code, e.reason) == ("need_pin", "no_address") and sent == [], "a short link's own page isn't read either"


def test_a_consent_or_sign_in_hop_is_unreadable_and_not_requested():  # L17
    for host in ("consent.google.com", "accounts.google.com"):
        net = Net({SHORT: redirect(f"https://{host}/ml?continue=https://www.google.com/maps")})
        e = refused(SHORT, net)
        assert (e.code, e.reason) == ("link_unreadable", "consent")
        assert net.hosts == ["maps.app.goo.gl"]


# ---------------------------------------------------------------- L20, L21, L23: review M4, one URL object

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
def test_review_m4_tricks_are_refused_with_no_request(link, reason):  # L20
    net = Net()
    e = refused(link, net)
    assert (e.code, e.reason) == ("link_not_maps", reason)
    assert net.asked == []
    assert str(e) == "link_not_maps" and e.__cause__ is None and e.__context__ is None


@pytest.mark.parametrize("link", ["https://maps.app.goo.gl.:443/x", "HTTPS://MAPS.APP.GOO.GL/x", "https://maps.app.goo.gl:443/x"])
def test_review_m4_forms_that_are_the_short_host(link):  # L21
    net = Net({"https://maps.app.goo.gl./x": redirect(PLACE), "https://maps.app.goo.gl/x": redirect(PLACE)})
    assert resolve(link, net).lat == 16.41234
    assert [h.rstrip(".") for h in net.hosts] == ["maps.app.goo.gl"], "requested once"


def test_the_open_redirector_is_never_requested():  # L23, review M4 (stricter: refused before its request)
    net = Net({SHORT: redirect("https://www.google.com/url?q=http://169.254.169.254/")})
    e = refused(SHORT, net)
    assert e.code == "link_unreadable" and e.reason == "off_list"
    assert net.hosts == ["maps.app.goo.gl"], "zero requests to www.google.com"


def test_a_location_with_a_backslash_or_space_is_refused():  # L30
    for location, reason in (("https://www.google.com\\@evil.io/maps", "bad_char"), ("https://www.google.com/maps place", "bad_char"),
                             ("https://www.google.com/maps\u200b", "bad_char"),
                             ("https://www.google.com/maps\tX", "network")):  # httpx refuses this one itself, before us
        net = Net({SHORT: httpx.Response(302, headers=[(b"location", location.encode())])})  # raw bytes, as a server sends them
        e = refused(SHORT, net)
        assert (e.code, e.reason) == ("link_unreadable", reason), repr(location)
        assert net.hosts == ["maps.app.goo.gl"]


def test_the_guard_checks_the_object_it_requests(monkeypatch):  # L20, review M4
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


# ---------------------------------------------------------------- L22: the 8 s deadline (review S10)

def test_a_slow_second_hop_stops_the_chain():  # L22
    clock = Clock()

    def slow(request):
        clock.t += 7.0  # each answer takes 7 s on the fake clock: under the 8 s deadline once, over it twice
        return redirect(f"{SHORT}/{len(net.asked)}")

    net = Net({SHORT: slow, f"{SHORT}/1": slow, f"{SHORT}/2": slow})
    e = refused(SHORT, net, clock)
    assert (e.code, e.reason) == ("link_unreadable", "deadline")
    assert len(net.asked) == 2, "the third hop is never started"


def test_a_geocoder_reply_stops_at_the_deadline_between_chunks():  # L22, N9
    clock = Clock()
    sent = []

    def chunks():
        for _ in range(5):
            sent.append(1)
            clock.t += 3.0
            yield b" " * 1000

    net = Net({SHORT: redirect("https://www.google.com/maps/place/Slow")}, {"Slow": lambda r: httpx.Response(200, content=chunks())})
    e = refused(SHORT, net, clock)
    assert (e.code, e.reason) == ("need_pin", "geocode_deadline")
    assert len(sent) == 3, "stopped as the third chunk passes 8 s"


# ---------------------------------------------------------------- L19: the cache

def test_a_url_with_its_pin_is_never_fetched():  # L26
    net = Net({SHORT: redirect(PLACE)})
    resolve(SHORT, net)
    assert net.asked == [SHORT], "the place URL has its pin, so it isn't fetched"


def test_a_resolved_link_is_cached_for_15_minutes():  # L19
    clock = Clock()
    net = Net({SHORT: redirect(PLACE)})
    first = ml.resolve(SHORT, client=net.client(), clock=clock)
    clock.t += 14 * 60
    assert ml.resolve(f"{SHORT}?g_st=ic", client=net.client(), clock=clock) == first, "the Apply after Suggest reads the cache"
    assert len(net.asked) == 1
    clock.t += 2 * 60
    ml.resolve(SHORT, client=net.client(), clock=clock)
    assert len(net.asked) == 2, "kept 15 minutes"


def test_the_cache_holds_256_links():  # L19
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
    assert str(e) == "link_unreadable" and e.args == ("link_unreadable",)
    assert e.__cause__ is None and e.__context__ is None, "raised outside the except, so the ConnectError isn't chained"
    for bad in ("https://evil.io/x", "https://maps.app.goo.gl\\@evil.io/x", "https://www.google.com/maps?q=0,0"):
        e = refused(bad, Net())
        assert str(e) == e.code and e.args == (e.code,) and e.__cause__ is None and e.__context__ is None


def test_resolve_logs_counts_and_codes_only(caplog):  # L31
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


def test_the_httpx_logger_stays_at_warning():  # L31, review nit 5
    from app.logging_setup import configure_logging

    configure_logging({})
    assert logging.getLogger("httpx").level == logging.WARNING


def test_the_default_client_takes_no_proxy_and_follows_nothing():  # L32
    c = ml.make_client()
    try:
        assert c.follow_redirects is False and c._trust_env is False
        assert c.timeout == httpx.Timeout(ml.HOP_TIMEOUT_S)
    finally:
        c.close()
    assert ml.HOP_TIMEOUT_S == 4.0 and ml.DEADLINE_S == 8.0 and ml.MAX_HOPS == 5
    assert not hasattr(ml, "page_pin") and not hasattr(ml, "MAX_BODY"), "no code reads a Google page any more"
    assert math.isclose(ml.CACHE_TTL_S, 900) and ml.CACHE_SIZE == 256


# ---------------------------------------------------------------- N: owner round 5, links with no pin

ADDRESS = "Unit 2, Made-up Bakery, Made-up St, Baguio, 2600 Benguet"
NO_PIN = "https://www.google.com/maps/place/Unit+2,+Made-up+Bakery,+Made-up+St,+Baguio,+2600+Benguet/data=!4m2!3m1!1s0x0:0x1"
FOUND = [{"lat": "16.4101", "lon": "120.5999", "display_name": "Made-up St, Baguio"}]


def test_the_geocode_request_is_one_checked_url(monkeypatch):  # N4
    seen = []
    real = ml.geocoder_allowed
    monkeypatch.setattr(ml, "geocoder_allowed", lambda u: seen.append(u) or real(u))
    net = Net({SHORT: redirect(NO_PIN)}, {ADDRESS: FOUND})
    got = resolve(SHORT, net)
    assert (got.lat, got.lng, got.pin, got.pin_source) == (16.4101, 120.5999, "address", "address")
    u = httpx.URL(net.asked[-1])
    assert (u.scheme, u.host, u.port, u.path) == ("https", GEO, None, "/search")
    assert dict(u.params) == {"q": ADDRESS, "format": "jsonv2", "limit": "1", "countrycodes": "ph"}
    assert net.headers[-1]["user-agent"] == ml.GEOCODER_UA == "TaraGala/1.0 (trip planner)"
    assert len(seen) == 1 and str(seen[0]) == net.asked[-1]
    assert got.maps_url == SHORT and got.name == ADDRESS


@pytest.mark.parametrize("u, ok", [
    ("https://nominatim.openstreetmap.org/search?q=x", True),
    ("https://nominatim.openstreetmap.org./search?q=x", True),
    ("http://nominatim.openstreetmap.org/search?q=x", False),
    ("https://nominatim.openstreetmap.org/reverse?lat=1", False),
    ("https://nominatim.openstreetmap.org:8080/search", False),
    ("https://u@nominatim.openstreetmap.org/search", False),
    ("https://nominatim.openstreetmap.org.evil.io/search", False),
    ("https://evil.io/search", False),
])
def test_the_geocoder_guard(u, ok):  # N4
    assert ml.geocoder_allowed(httpx.URL(u)) is ok


def test_an_address_is_tried_shorter_up_to_three_times():  # N5
    assert ml.queries(ADDRESS) == [ADDRESS, "Made-up Bakery, Made-up St, Baguio, 2600 Benguet", "Made-up St, Baguio, 2600 Benguet"]
    assert ml.queries("Made-up Bakery, Baguio") == ["Made-up Bakery, Baguio"], "under 3 parts: tried once as it is"
    assert ml.queries("A, B, C") == ["A, B, C"], "never fewer than 3 parts, so never just a city or province"
    assert ml.queries("  ") == []
    net = Net({SHORT: redirect(NO_PIN)}, {"Made-up St, Baguio, 2600 Benguet": FOUND})
    clock = Clock()
    got = resolve(SHORT, net, clock)
    assert got.pin == "address" and net.geocoded == ml.queries(ADDRESS)
    assert clock.slept == [1.0, 1.0], "at most one request a second"


def test_one_request_a_second_across_resolves():  # N6
    clock = Clock()
    net = Net({SHORT: redirect(NO_PIN), f"{SHORT}2": redirect(NO_PIN.replace("Unit+2", "Unit+3"))},
              {ADDRESS: FOUND, ADDRESS.replace("Unit 2", "Unit 3"): FOUND})
    ml.clear_cache()
    ml.resolve(SHORT, client=net.client(), clock=clock, sleep=clock.sleep)
    clock.t += 0.25
    ml.resolve(f"{SHORT}2", client=net.client(), clock=clock, sleep=clock.sleep)
    assert clock.slept == [0.75], "the second trip's lookup waits out the rest of the second"
    assert ml.GEOCODE_GAP_S == 1.0


def test_an_address_is_geocoded_once_and_a_miss_is_kept_15_minutes():  # N7
    clock = Clock()
    other = f"{SHORT}B"
    net = Net({SHORT: redirect(NO_PIN), other: redirect(NO_PIN + "!18m1!1e1")}, {ADDRESS: FOUND})
    ml.clear_cache()
    ml.resolve(SHORT, client=net.client(), clock=clock, sleep=clock.sleep)
    ml.resolve(other, client=net.client(), clock=clock, sleep=clock.sleep)
    assert net.geocoded == [ADDRESS], "another link to the same address reads the cache"
    miss = "https://www.google.com/maps/place/Nowhere+Made-up/"
    net = Net({f"{SHORT}C": redirect(miss), f"{SHORT}D": redirect(miss)})
    for link in (f"{SHORT}C", f"{SHORT}D"):
        with pytest.raises(LinkError):
            ml.resolve(link, client=net.client(), clock=clock, sleep=clock.sleep)
    assert net.geocoded == ["Nowhere Made-up"], "a miss is kept too"
    clock.t += ml.GEOCODE_MISS_TTL_S + 1
    ml.clear_cache(geocodes=False)
    with pytest.raises(LinkError):
        ml.resolve(f"{SHORT}C", client=net.client(), clock=clock, sleep=clock.sleep)
    assert net.geocoded == ["Nowhere Made-up"] * 2, "for 15 minutes"
    assert ml.GEOCODE_HIT_TTL_S == 24 * 3600


@pytest.mark.parametrize("answer, reason", [
    (httpx.Response(429), "geocode_status_429"),
    (httpx.Response(500), "geocode_status_500"),
    (httpx.ReadTimeout("slow"), "geocode_timeout"),
    (httpx.ConnectError("no route"), "geocode_network"),
    (httpx.Response(302, headers={"location": "http://169.254.169.254/"}), "geocode_status_302"),
    (httpx.Response(200, content=b"<html>not json</html>"), "geocode_bad_json"),
    (httpx.Response(200, json={"lat": "16.4", "lon": "120.5"}), "geocode_bad_json"),
    (httpx.Response(200, json=[{"lat": "91", "lon": "120.5"}]), "geocode_none"),
    (httpx.Response(200, json=[{"lat": "0", "lon": "0"}]), "geocode_none"),
    (httpx.Response(200, json=[{"lat": 16.4}]), "geocode_none"),
    (httpx.Response(200, content=b"[" + b" " * (70 * 1024) + b"]"), "geocode_too_big"),
])
def test_a_geocoder_failure_is_need_pin(answer, reason):  # N8
    net = Net({SHORT: redirect(NO_PIN)}, {ADDRESS: answer})
    e = refused(SHORT, net)
    assert (e.code, e.reason, e.name) == ("need_pin", reason, ADDRESS)
    assert "169.254" not in " ".join(net.asked), "a geocoder redirect is never followed"
    if reason not in ("geocode_none",):
        assert net.geocoded == [ADDRESS], "a failure stops the tries"


def test_need_pin_keeps_the_name_and_carries_nothing_else():  # N9
    e = refused("https://www.google.com/maps/place/Made-up+Shop/", Net())
    assert (e.code, e.name, str(e), e.args) == ("need_pin", "Made-up Shop", "need_pin", ("need_pin",))
    assert e.__cause__ is None and e.__context__ is None


def test_a_centre_from_a_redirect_is_not_trusted():  # N10
    hop = "https://www.google.com/maps/place/Made-up+Shop/@60.17,24.94,15z"
    net = Net({SHORT: redirect(hop)}, {"Made-up Shop": FOUND})
    got = resolve(SHORT, net)
    assert (got.lat, got.pin) == (16.4101, "address"), "Google may centre a redirect on the requester"
    got = resolve("https://www.google.com/maps/place/Made-up+Shop/@16.4123,120.5932,17z", Net())
    assert (got.lat, got.pin) == (16.4123, "center"), "a long link someone pasted is their own map"


@pytest.mark.parametrize("text, pin", [
    ("16.4138, 120.5964", (16.4138, 120.5964)),
    ("16.4138,120.5964", (16.4138, 120.5964)),
    ("  16.413800 ,  120.596400 ", (16.4138, 120.5964)),
    ("-16.5, -120.25", (-16.5, -120.25)),
])
def test_a_typed_pin_is_read(text, pin):  # N11
    assert ml.typed_pin(text) == pin


@pytest.mark.parametrize("text", ["abc", "16.4", "16.4, 120.5, 3", "91, 120", "16.4, 181", "0, 0", "nan, 120", "16.4; 120.5",
                                  "1" * 61, "16.4\n120.5", ""])
def test_a_bad_typed_pin_is_refused(text):  # N11
    with pytest.raises(LinkError) as e:
        ml.typed_pin(text)
    assert (e.value.code, str(e.value)) == ("bad_pin", "bad_pin")


def test_a_typed_pin_with_its_link_makes_no_request():  # N12
    net = Net()
    got = ml.typed(f"Made-up Shop\n{SHORT}?g_st=ic", "16.4138, 120.5964")
    assert (got.lat, got.lng, got.pin, got.pin_source, got.maps_url, got.name) == (16.4138, 120.5964, "typed", "typed", SHORT, None)
    assert net.asked == []
    with pytest.raises(LinkError) as e:
        ml.typed("https://evil.io/x", "16.4138, 120.5964")
    assert e.value.code == "link_not_maps"


def test_the_geocode_logs_carry_no_address(caplog):  # N13
    caplog.set_level(logging.INFO, logger="tara_gala.api")
    resolve(SHORT, Net({SHORT: redirect(NO_PIN)}, {"Made-up St, Baguio, 2600 Benguet": FOUND}))
    refused(SHORT, Net({SHORT: redirect(NO_PIN)}, {ADDRESS: httpx.Response(503)}))
    lines = [r.getMessage() for r in caplog.records if r.name == "tara_gala.api"]
    assert "maps link geocode outcome=found tries=3 cache=no" in " ".join(lines)
    assert any(m.startswith("maps link resolve outcome=ok hops=1 final=long") and "pin=address" in m for m in lines), lines
    assert any("maps link geocode outcome=failed tries=1 cache=no" in m and "reason=geocode_status_503" in m for m in lines)
    assert any("outcome=need_pin" in m and "reason=geocode_status_503" in m for m in lines)
    for leak in ("Made-up", "Bakery", "Baguio", "Benguet", "Unit", "16.41", "120.59", "Zx9", "goo.gl", "nominatim"):
        assert leak not in caplog.text, leak
