"""A pin and a name from a pasted Google Maps link (TG-61, options.md §4). No Places API and no new dependency.

The allow-list is the only guard against the server being pointed at an internal address (SSRF), so it is strict:
- Only https on exactly the hosts below, port 443, no userinfo. http is upgraded for these hosts only.
- A short host may be requested on any path, goo.gl only under /maps, and a long Google host only under /maps.
  google.com/url is an open redirector, so it's never requested.
- The guard checks an httpx.URL and hands that same object to the client, on every hop (review M4). Nothing here
  parses a URL a second way. Raw input with a backslash, whitespace, or a Unicode control or format character (a
  zero-width space, say) is refused first.

Long links are read with no request. Short links are followed by hand: at most 5 requests, 4 s a read, 8 s in all on
an injectable clock (review S10). A body is read only on the last hop, only when no URL had a pin, and only its first
512 KB, for the static map's centre=lat%2Clng (the og:image). A resolved short link is kept 15 minutes, so the Apply
that follows Suggest doesn't fetch it again.

LinkError's only text is its code, and it's raised outside any except, so it has no cause or context: httpx's own
messages carry the URL (review M3). Logs carry the outcome, counts and kinds only, never the link, a host's path, a
name or a pin.
"""

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
MAX_BODY = 512 * 1024
MAX_NAME = 80
MAX_MAPS_URL = 500
CACHE_SIZE = 256
CACHE_TTL_S = 15 * 60

_NUM = r"(-?\d{1,3}(?:\.\d+)?)"
_PAIR = re.compile(rf"^\s*{_NUM}\s*,\s*{_NUM}\s*$")
_BANG = re.compile(rf"!3d{_NUM}!4d{_NUM}")
_AT = re.compile(rf"^@{_NUM},{_NUM}(?:,|$)")
_PAGE = re.compile(rb"(?:center|markers)=" + _NUM.encode() + rb"(?:%2C|,)" + _NUM.encode(), re.IGNORECASE)


class LinkError(Exception):
    """`code` is the answer's detail and the only text; `reason` is for the log. A traceback carries no URL."""

    def __init__(self, code: str, reason: str):
        super().__init__(code)
        self.code = code  # link_not_maps | link_no_pin | link_unreadable
        self.reason = reason


@dataclass(frozen=True)
class Parsed:
    lat: float | None
    lng: float | None
    pin: str  # path | query | center | none
    name: str | None


@dataclass(frozen=True)
class Resolved:
    lat: float
    lng: float
    name: str | None  # None when the link has none: the group types it
    maps_url: str  # the link as given, cleaned (no query); or a search URL built from the pin
    pin: str  # path | query | center | page


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
    """May this URL be requested (or, for a long host, read)? The same object is then passed to the client."""
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
    name = " ".join("".join(ch for ch in raw if ch.isprintable()).split())[:MAX_NAME].strip()
    return name or None


def parse(u: httpx.URL) -> Parsed:
    """The pin and name a long Google Maps URL carries, in options.md §4's order. No request."""
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

    name = None  # 5. /maps/place/<name>/, else a q or query that isn't a pin
    for i, s in enumerate(segments[:-1]):
        if s == "place" and segments[i + 1] and not _pair(segments[i + 1]) and not segments[i + 1].startswith("@"):
            name = _name(segments[i + 1])
            break
    if name is None:
        for key in ("q", "query"):
            value = params.get(key)
            if value and not _pair(value):
                name = _name(value)
                break
    return Parsed(pin[0] if pin else None, pin[1] if pin else None, kind, name)


def page_pin(html: bytes) -> tuple[float, float] | None:
    """The first centre= or markers= lat%2Clng in the final page (the og:image static map)."""
    for m in _PAGE.finditer(html):
        if pin := _coords(m.group(1).decode(), m.group(2).decode()):
            return pin
    return None


def _search_url(lat: float, lng: float) -> str:
    return f"https://www.google.com/maps/search/?api=1&query={lat},{lng}"


def maps_url(given: httpx.URL, lat: float, lng: float, pin: str) -> str:
    """The link to save: as given without its query (tracking such as g_st), unless that loses the pin or is long."""
    if _bare_host(given) not in SHORT_HOSTS and pin == "query":
        return _search_url(lat, lng)
    clean = str(given.copy_with(query=None, fragment=None))
    return clean if len(clean) <= MAX_MAPS_URL else _search_url(lat, lng)


# ---------------------------------------------------------------- following a short link

def make_client() -> httpx.Client:
    """No proxy env, no redirects followed by httpx: each hop is checked here first."""
    return httpx.Client(follow_redirects=False, timeout=httpx.Timeout(HOP_TIMEOUT_S), trust_env=False)


_cache: "OrderedDict[str, tuple[float, Resolved]]" = OrderedDict()
_cache_lock = threading.Lock()


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


def _cached(key: str, now: float) -> Resolved | None:
    with _cache_lock:
        hit = _cache.get(key)
        if hit is None:
            return None
        if now - hit[0] > CACHE_TTL_S:
            del _cache[key]
            return None
        _cache.move_to_end(key)
        return hit[1]


def _keep(key: str, now: float, r: Resolved) -> None:
    with _cache_lock:
        _cache[key] = (now, r)
        _cache.move_to_end(key)
        while len(_cache) > CACHE_SIZE:
            _cache.popitem(last=False)


class _Trace:
    """What the log line says about one resolve."""

    def __init__(self):
        self.hops = 0  # redirects followed
        self.requests = 0
        self.final = "short"
        self.pin = "none"
        self.name = False


def _read(response: httpx.Response, deadline: float, clock: Callable[[], float]) -> bytes:
    """At most the first 512 KB: the static map is in the page's head, and nothing past the cut is read."""
    body = bytearray()
    for chunk in response.iter_bytes():
        body += chunk
        if clock() > deadline:
            raise LinkError("link_unreadable", "deadline")
        if len(body) >= MAX_BODY:
            return bytes(body[:MAX_BODY])
    return bytes(body)


def _follow(client: httpx.Client, u: httpx.URL, clock: Callable[[], float], t: _Trace) -> tuple[Parsed, httpx.URL]:
    """From a short link to the first URL with a pin, or the last page's static map."""
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
                parsed = parse(u)
                t.final, t.name = "page", parsed.name is not None
                pin = page_pin(_read(r, deadline, clock))
                if pin is None:
                    raise LinkError("link_no_pin", "none")
                return Parsed(pin[0], pin[1], "page", parsed.name), u
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
            parsed = parse(u)
            if parsed.lat is not None:
                return parsed, u


def resolve(link: str, client: httpx.Client | None = None, clock: Callable[[], float] = time.monotonic) -> Resolved:
    """The pin, name and link to save from pasted text, or LinkError(code). Logs one line either way."""
    start = clock()
    t = _Trace()
    outcome, reason, cache = "ok", None, "no"
    failed: tuple[str, str] | None = None
    try:
        given = extract_url(link)
        if not allowed(given):
            raise LinkError("link_not_maps", "off_list")
        short = _bare_host(given) in SHORT_HOSTS
        key = str(given.copy_with(query=None, fragment=None))
        if short and (hit := _cached(key, start)) is not None:
            cache, t.final, t.pin, t.name = "yes", "short", hit.pin, hit.name is not None
            return hit
        if short:
            own = client is None
            client = client or make_client()
            try:
                parsed, _ = _follow(client, given, clock, t)
            finally:
                if own:
                    client.close()
        else:
            t.final = "long"
            parsed = parse(given)
            if parsed.lat is None:
                t.name = parsed.name is not None
                raise LinkError("link_no_pin", "none")
        t.pin, t.name = parsed.pin, parsed.name is not None
        result = Resolved(parsed.lat, parsed.lng, parsed.name, maps_url(given, parsed.lat, parsed.lng, parsed.pin), parsed.pin)
        if short:
            _keep(key, start, result)
        return result
    except LinkError as e:
        failed = (e.code, e.reason)
    except httpx.TimeoutException:
        failed = ("link_unreadable", "timeout")
    except (httpx.HTTPError, httpx.InvalidURL, httpx.StreamError, ValueError):
        failed = ("link_unreadable", "network")  # httpx's message carries the URL, so it goes no further
    finally:
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
