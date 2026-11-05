"""A pin and a name from a pasted Google Maps link (TG-61, options.md §4). No Places API and no new dependency.

The allow-list is the only guard against the server being pointed at an internal address (SSRF), so it is strict:
- Only https on exactly the hosts below, port 443, no userinfo. http is upgraded for these hosts only.
- A short host may be requested on any path, goo.gl only under /maps. A long Google host is only ever parsed, and only
  under /maps: google.com/url is an open redirector, so it's refused.
- The guard checks an httpx.URL and hands that same object to the client, on every hop (review M4). Nothing here
  parses a URL a second way. Raw input with a backslash, whitespace, or a Unicode control or format character (a
  zero-width space, say) is refused first.

Short links are followed by hand: at most 5 requests, 4 s a read, 8 s in all on an injectable clock (review S10). Only
short links are requested. A resolved one is kept 15 minutes, so the Apply that follows Suggest doesn't fetch it again.

Links with no pin (owner round 5). A real share link often redirects to /maps/place/<address> with no coordinates,
and Google's page is centred on whoever fetched it (the server's location), so no Google page is ever read for a pin,
and a map centre (/@lat,lng) that came from a redirect isn't trusted either. Instead the address is geocoded with
OpenStreetMap Nominatim: one checked httpx.URL to nominatim.openstreetmap.org/search, a generic User-Agent, at most one
request a second across the process, the address tried shorter up to 3 times, and every answer cached per address.
If that finds nothing, or fails, the answer is need_pin and the group pastes the pin's coordinates (typed_pin).

LinkError's only text is its code, and it's raised outside any except, so it has no cause or context: httpx's own
messages carry the URL (review M3). It may carry the link's name for the answer, never for a log. Logs carry the
outcome, counts and kinds only, never the link, a host's path, an address, a name or a pin.
"""

import json
import logging
import math
import re
import threading
import time
import unicodedata
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from urllib.parse import unquote_plus

import httpx

logger = logging.getLogger("tara_gala.api")

SHORT_HOSTS = frozenset({"maps.app.goo.gl", "goo.gl"})
LONG_HOSTS = frozenset({"google.com", "www.google.com", "maps.google.com", "google.com.ph", "www.google.com.ph", "maps.google.com.ph"})
CONSENT_HOSTS = frozenset({"consent.google.com", "accounts.google.com"})  # a cookie or sign-in page, never a pin
REDIRECTS = frozenset({301, 302, 303, 307, 308})

MAX_TEXT = 2000
MAX_HOPS = 5
HOP_TIMEOUT_S = 4.0
DEADLINE_S = 8.0
MAX_NAME = 80
MAX_MAPS_URL = 500
MAX_PIN_TEXT = 60
CACHE_SIZE = 256
CACHE_TTL_S = 15 * 60

GEOCODER_HOST = "nominatim.openstreetmap.org"
GEOCODER_UA = "TaraGala/1.0 (trip planner)"  # Nominatim's policy asks every app to say who it is
GEOCODE_GAP_S = 1.0  # Nominatim's limit: one request a second
GEOCODE_TRIES = 3
GEOCODE_MIN_PARTS = 3  # never down to just a city or a province: that pin would be kilometres off
GEOCODE_BODY = 64 * 1024
GEOCODE_HIT_TTL_S = 24 * 3600
GEOCODE_MISS_TTL_S = 15 * 60

_NUM = r"(-?\d{1,3}(?:\.\d+)?)"
_PAIR = re.compile(rf"^\s*{_NUM}\s*,\s*{_NUM}\s*$")
_BANG = re.compile(rf"!3d{_NUM}!4d{_NUM}")
_AT = re.compile(rf"^@{_NUM},{_NUM}(?:,|$)")


class LinkError(Exception):
    """`code` is the answer's detail and the only text; `reason` is for the log; `name`, the link's own name, is only
    for need_pin's answer. A traceback carries no URL."""

    def __init__(self, code: str, reason: str, name: str | None = None):
        super().__init__(code)
        self.code = code  # link_not_maps | link_unreadable | need_pin | bad_pin
        self.reason = reason
        self.name = name


@dataclass(frozen=True)
class Parsed:
    lat: float | None
    lng: float | None
    pin: str  # path | query | center | none
    name: str | None
    address: str | None  # what to geocode when there's no pin: the /maps/place/ segment, else a q= that isn't a pin


@dataclass(frozen=True)
class Resolved:
    lat: float
    lng: float
    name: str | None  # None when the link has none: the group types it
    maps_url: str  # the link as given, cleaned (no query); or a search URL built from the pin
    pin: str  # path | query | center (from the URL) | address (geocoded) | typed (pasted by the group)

    @property
    def pin_source(self) -> str:
        """For the answer: "link", "address" (show "Pin from the address, check it") or "typed"."""
        return self.pin if self.pin in ("address", "typed") else "link"


# ---------------------------------------------------------------- pure

def _bare_host(u: httpx.URL) -> str:
    return u.host.lower().rstrip(".")


def _upgrade(u: httpx.URL) -> httpx.URL:
    if u.scheme == "http" and _bare_host(u) in SHORT_HOSTS | LONG_HOSTS:
        return u.copy_with(scheme="https")
    return u


def extract_url(text: str) -> httpx.URL:
    """The first link in the pasted text, as an httpx.URL, or LinkError. A share sheet gives "Name\\nhttps://...", and a
    one-line field drops the newline, so the link may be glued to the name (test-plan F3): it starts at the first
    http:// or https:// anywhere, and runs to the next whitespace. Anything else odd in it is refused by _url."""
    if len(text) > MAX_TEXT:
        raise LinkError("link_not_maps", "too_long")
    lower = text.lower()
    starts = [i for i in (lower.find("https://"), lower.find("http://")) if i >= 0]
    if not starts:
        raise LinkError("link_not_maps", "no_link")
    rest = text[min(starts):]
    return _url(rest.split(maxsplit=1)[0], "link_not_maps")


def _bad(raw: str) -> bool:
    """A backslash, any whitespace, or any Unicode control or format character (a zero-width space, say)."""
    return any(ch == "\\" or ch.isspace() or unicodedata.category(ch)[0] == "C" for ch in raw)


def _url(raw: str, code: str) -> httpx.URL:
    if _bad(raw):
        raise LinkError(code, "bad_char")
    try:
        return _upgrade(httpx.URL(raw))
    except (httpx.InvalidURL, ValueError, TypeError):
        raise LinkError(code, "bad_url") from None


def allowed(u: httpx.URL) -> bool:
    """May this URL be requested (a short host) or read (a long one)? The same object is then passed to the client."""
    if u.scheme != "https" or u.userinfo != b"" or u.port not in (None, 443):
        return False
    host = _bare_host(u)
    path = u.raw_path.split(b"?", 1)[0]
    under_maps = path == b"/maps" or path.startswith(b"/maps/") or path.startswith(b"/maps?")
    if host == "maps.app.goo.gl":
        return True
    if host == "goo.gl" or host in LONG_HOSTS:
        return under_maps
    return False


def _coords(lat: str, lng: str) -> tuple[float, float] | None:
    a, b = float(lat), float(lng)
    if not (math.isfinite(a) and math.isfinite(b)) or not (-90 <= a <= 90 and -180 <= b <= 180) or (a == 0 and b == 0):
        return None
    return a, b


def _pair(text: str | None) -> tuple[float, float] | None:
    m = _PAIR.match(text or "")
    return _coords(*m.groups()) if m else None


def _name(raw: str) -> str | None:
    """Printable, one line, at most 80 letters: cut at a comma when an address runs over, else at 80."""
    name = " ".join("".join(ch for ch in raw if ch.isprintable()).split())
    while len(name) > MAX_NAME and ", " in name:
        name = name.rsplit(", ", 1)[0]
    return name[:MAX_NAME].strip() or None


def _address(raw: str) -> str | None:
    text = " ".join("".join(ch for ch in raw if ch.isprintable()).split())
    return text[:300] or None


def parse(u: httpx.URL) -> Parsed:
    """The pin and name a long Google Maps URL carries, in options.md §4's order, and the address. No request."""
    raw_path = u.raw_path.split(b"?", 1)[0].decode("ascii", "replace")
    segments = [unquote_plus(s) for s in raw_path.split("/")]
    params = u.params

    pin, kind = None, "none"
    for m in _BANG.finditer(unquote_plus(raw_path)):  # 1. the place's own pin
        if pin := _coords(*m.groups()):
            kind = "path"
            break
    if pin is None:  # 2. a query that is lat,lng
        for key in ("q", "query", "ll", "destination"):
            if pin := _pair(params.get(key)):
                kind = "query"
                break
    if pin is None:  # 3. /maps/place/<lat>,<lng> (a dropped pin may come as /maps/search/<lat>,<lng>)
        for i, s in enumerate(segments[:-1]):
            if s in ("place", "search") and (pin := _pair(segments[i + 1])):
                kind = "path"
                break
    if pin is None:  # 4. /@<lat>,<lng>,<zoom>: the map's centre, the weakest
        for s in segments:
            m = _AT.match(s)
            if m and (pin := _coords(*m.groups())):
                kind = "center"
                break

    raw = None  # 5. /maps/place/<name>/, else a q or query that isn't a pin, even an unusable one
    for i, s in enumerate(segments[:-1]):
        if s == "place" and segments[i + 1] and not _PAIR.match(segments[i + 1]) and not segments[i + 1].startswith("@"):
            raw = segments[i + 1]
            break
    if raw is None:
        for key in ("q", "query"):
            value = params.get(key)
            if value and not _PAIR.match(value):
                raw = value
                break
    return Parsed(pin[0] if pin else None, pin[1] if pin else None, kind,
                  _name(raw) if raw else None, _address(raw) if raw else None)


def typed_pin(text: str) -> tuple[float, float]:
    """A pin the group pasted from a long-press in Google Maps: "16.4138, 120.5964", any spaces. Else bad_pin."""
    pin = _pair(text) if len(text) <= MAX_PIN_TEXT else None
    if pin is None:
        raise LinkError("bad_pin", "bad_pin")
    return pin


def _search_url(lat: float, lng: float) -> str:
    return f"https://www.google.com/maps/search/?api=1&query={lat},{lng}"


def maps_url(given: httpx.URL, lat: float, lng: float, pin: str) -> str:
    """The link to save: as given without its query (tracking such as g_st), unless that loses the pin or is long."""
    if _bare_host(given) not in SHORT_HOSTS and pin == "query":
        return _search_url(lat, lng)
    clean = str(given.copy_with(query=None, fragment=None))
    return clean if len(clean) <= MAX_MAPS_URL else _search_url(lat, lng)


def queries(address: str) -> list[str]:
    """The whole address, then shorter from the front ("Ground Floor, Shop, Building, Street, City" loses "Ground
    Floor", then "Shop"), at most 3, and never under 3 parts. A shorter address is tried once as it is."""
    parts = [p.strip() for p in address.split(",") if p.strip()]
    if not parts:
        return []
    if len(parts) < GEOCODE_MIN_PARTS:
        return [", ".join(parts)]
    return [", ".join(parts[i:]) for i in range(len(parts) - GEOCODE_MIN_PARTS + 1)][:GEOCODE_TRIES]


def geocode_url(q: str) -> httpx.URL:
    return httpx.URL(f"https://{GEOCODER_HOST}/search", params={"q": q, "format": "jsonv2", "limit": "1", "countrycodes": "ph"})


def geocoder_allowed(u: httpx.URL) -> bool:
    """The geocoder's own allow-list, as strict as the Maps hosts': https, its host, port 443, no userinfo, /search."""
    return (u.scheme == "https" and u.userinfo == b"" and u.port in (None, 443) and _bare_host(u) == GEOCODER_HOST
            and u.raw_path.split(b"?", 1)[0] == b"/search")


def _first_pin(data) -> tuple[float, float] | None:
    if not isinstance(data, list):
        raise ValueError("not a list")
    for item in data[:1]:
        if isinstance(item, dict) and isinstance(item.get("lat"), str) and isinstance(item.get("lon"), str):
            try:
                return _coords(item["lat"], item["lon"])
            except ValueError:
                return None
    return None


# ---------------------------------------------------------------- the caches and the geocoder's pace

def make_client() -> httpx.Client:
    """No proxy env, no redirects followed by httpx: each hop is checked here first."""
    return httpx.Client(follow_redirects=False, timeout=httpx.Timeout(HOP_TIMEOUT_S), trust_env=False)


class _Lru:
    def __init__(self, size: int):
        self.size = size
        self.items: "OrderedDict[str, tuple[float, float, object]]" = OrderedDict()  # key: (stored, ttl, value)
        self.lock = threading.Lock()

    def get(self, key: str, now: float):
        with self.lock:
            hit = self.items.get(key)
            if hit is None:
                return None
            if now - hit[0] > hit[1]:
                del self.items[key]
                return None
            self.items.move_to_end(key)
            return hit

    def put(self, key: str, now: float, ttl: float, value) -> None:
        with self.lock:
            self.items[key] = (now, ttl, value)
            self.items.move_to_end(key)
            while len(self.items) > self.size:
                self.items.popitem(last=False)

    def clear(self) -> None:
        with self.lock:
            self.items.clear()


_links = _Lru(CACHE_SIZE)
_geocodes = _Lru(CACHE_SIZE)
_pace = threading.Lock()
_last_geocode = [-math.inf]


def clear_cache(geocodes: bool = True) -> None:
    _links.clear()
    if geocodes:
        _geocodes.clear()
        _last_geocode[0] = -math.inf


def _wait_turn(clock: Callable[[], float], sleep: Callable[[float], None]) -> None:
    """At most one geocode request a second across the process: a caller waits out the rest of the second."""
    with _pace:
        wait = _last_geocode[0] + GEOCODE_GAP_S - clock()
        if wait > 0:
            sleep(wait)
        _last_geocode[0] = clock()


class _Trace:
    """What the log lines say about one resolve."""

    def __init__(self):
        self.hops = 0  # redirects followed
        self.requests = 0
        self.final = "short"
        self.pin = "none"
        self.name = False


def _read(response: httpx.Response, deadline: float, clock: Callable[[], float], cap: int) -> bytes:
    body = bytearray()
    for chunk in response.iter_bytes():
        body += chunk
        if clock() > deadline:
            raise LinkError("need_pin", "geocode_deadline")
        if len(body) > cap:
            raise LinkError("need_pin", "geocode_too_big")
    return bytes(body)


def _geocode_once(client: httpx.Client, q: str, deadline: float, clock, sleep) -> tuple[float, float] | None:
    _wait_turn(clock, sleep)
    if clock() > deadline:
        raise LinkError("need_pin", "geocode_deadline")
    u = geocode_url(q)
    if not geocoder_allowed(u):
        raise LinkError("need_pin", "geocode_off_list")
    try:
        with client.stream("GET", u, follow_redirects=False, timeout=httpx.Timeout(HOP_TIMEOUT_S),
                           headers={"User-Agent": GEOCODER_UA, "Accept-Language": "en"}) as r:
            if r.status_code != 200:
                raise LinkError("need_pin", f"geocode_status_{r.status_code}")
            body = _read(r, deadline, clock, GEOCODE_BODY)
    except httpx.TimeoutException:
        raise LinkError("need_pin", "geocode_timeout") from None
    except httpx.HTTPError:
        raise LinkError("need_pin", "geocode_network") from None
    try:
        return _first_pin(json.loads(body))
    except ValueError:
        raise LinkError("need_pin", "geocode_bad_json") from None


def geocode(address: str, client: httpx.Client, clock: Callable[[], float], sleep: Callable[[float], None]) -> tuple[float, float]:
    """The pin for an address from Nominatim, or LinkError need_pin. Logs one line, with no address."""
    start = clock()
    key = address.casefold()
    hit = _geocodes.get(key, start)
    outcome, reason, tries, cache = "found", None, 0, "no"
    pin = None
    try:
        if hit is not None:
            cache, pin = "yes", hit[2]
        else:
            deadline = start + DEADLINE_S
            for q in queries(address):
                tries += 1
                pin = _geocode_once(client, q, deadline, clock, sleep)
                if pin is not None:
                    break
            _geocodes.put(key, start, GEOCODE_HIT_TTL_S if pin else GEOCODE_MISS_TTL_S, pin)
        if pin is None:
            outcome, reason = "none", "geocode_none"
    except LinkError as e:
        outcome, reason = "failed", e.reason
    logger.log(logging.WARNING if outcome == "failed" else logging.INFO,
               "maps link geocode outcome=%s tries=%d cache=%s ms=%d" + (" reason=%s" if reason else ""),
               *[outcome, tries, cache, round((clock() - start) * 1000)] + ([reason] if reason else []))
    if pin is None:
        raise LinkError("need_pin", reason)
    return pin


# ---------------------------------------------------------------- following a short link

def _follow(client: httpx.Client, u: httpx.URL, clock: Callable[[], float], t: _Trace) -> Parsed:
    """From a short link to the first long URL. Only short hosts are requested, and no body is ever read."""
    deadline = clock() + DEADLINE_S
    while True:
        if clock() > deadline:
            raise LinkError("link_unreadable", "deadline")
        if t.requests == MAX_HOPS:
            raise LinkError("link_unreadable", "too_many_hops")
        t.requests += 1
        with client.stream("GET", u, follow_redirects=False, timeout=httpx.Timeout(HOP_TIMEOUT_S)) as r:
            if r.status_code not in REDIRECTS:
                if r.status_code != 200:
                    raise LinkError("link_unreadable", f"status_{r.status_code}")
                return Parsed(None, None, "none", None, None)  # a page, not a place URL: nothing here to trust
            location = r.headers.get("location")
        if not location:
            raise LinkError("link_unreadable", "no_location")
        t.hops += 1
        if _bad(location):
            raise LinkError("link_unreadable", "bad_char")
        u = _upgrade(u.join(location))
        if _bare_host(u) in CONSENT_HOSTS:
            raise LinkError("link_unreadable", "consent")
        if not allowed(u):
            raise LinkError("link_unreadable", "off_list")
        if _bare_host(u) in LONG_HOSTS:
            t.final = "long"
            p = parse(u)
            if p.pin == "center":  # Google may centre a redirect on the requester, so only the address counts
                p = Parsed(None, None, "none", p.name, p.address)
            return p


def resolve(link: str, client: httpx.Client | None = None, clock: Callable[[], float] = time.monotonic,
            sleep: Callable[[float], None] | None = None) -> Resolved:
    """The pin, name and link to save from pasted text, or LinkError(code). Logs one line either way."""
    sleep = sleep or time.sleep
    start = clock()
    t = _Trace()
    outcome, reason, cache = "ok", None, "no"
    failed: tuple[str, str, str | None] | None = None
    own = client is None
    try:
        given = extract_url(link)
        if not allowed(given):
            raise LinkError("link_not_maps", "off_list")
        short = _bare_host(given) in SHORT_HOSTS
        key = str(given.copy_with(query=None, fragment=None))
        if short and (hit := _links.get(key, start)) is not None:
            result = hit[2]
            cache, t.final, t.pin, t.name = "yes", "short", result.pin, result.name is not None
            return result
        client = client or make_client()
        if short:
            parsed = _follow(client, given, clock, t)
        else:
            t.final = "long"
            parsed = parse(given)
        t.name = parsed.name is not None
        if parsed.lat is not None:
            lat, lng, pin = parsed.lat, parsed.lng, parsed.pin
        elif parsed.address:
            try:
                (lat, lng), pin = geocode(parsed.address, client, clock, sleep), "address"
            except LinkError as e:
                raise LinkError("need_pin", e.reason, parsed.name) from None
        else:
            raise LinkError("need_pin", "no_address", parsed.name)
        t.pin = pin
        result = Resolved(lat, lng, parsed.name, maps_url(given, lat, lng, pin), pin)
        if short:
            _links.put(key, start, CACHE_TTL_S, result)
        return result
    except LinkError as e:
        failed = (e.code, e.reason, e.name)
    except httpx.TimeoutException:
        failed = ("link_unreadable", "timeout", None)
    except (httpx.HTTPError, httpx.InvalidURL, httpx.StreamError, ValueError):
        failed = ("link_unreadable", "network", None)  # httpx's message carries the URL, so it goes no further
    finally:
        if own and client is not None:
            client.close()
        if failed:
            outcome, reason = failed[0].removeprefix("link_"), failed[1]
        line = (
            "maps link resolve outcome=%s hops=%d final=%s ms=%d pin=%s name=%s cache=%s"
            + (" reason=%s" if reason else "")
        )
        args = [outcome, t.hops, t.final, round((clock() - start) * 1000), t.pin, "yes" if t.name else "no", cache]
        if reason:
            args.append(reason)
        logger.log(logging.WARNING if outcome == "unreadable" else logging.INFO, line, *args)
    raise LinkError(*failed) from None  # outside every except: no __cause__ and no __context__ (review M3)


def typed(link: str, pin_text: str) -> Resolved:
    """A pin the group pasted, with its link: checked like any link, with no request. bad_pin or link_not_maps."""
    given = extract_url(link)
    if not allowed(given):
        raise LinkError("link_not_maps", "off_list")
    lat, lng = typed_pin(pin_text)
    return Resolved(lat, lng, None, maps_url(given, lat, lng, "typed"), "typed")
