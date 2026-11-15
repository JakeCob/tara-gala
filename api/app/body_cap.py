"""TG-61 (review S9): a plan write's body is capped before it's parsed. On the plan edit, undo, suggest, chat and
trip-place routes, a body over 128 KB answers 413 too_big: by its Content-Length, or by counting the bytes as they
arrive when it has none (a chunked body). Under the cap, the body is passed on as it came.

The log names the route's pattern, never the trip's slug.
"""

import json
import logging
import re

logger = logging.getLogger("tara_gala.api")

CAP = 128 * 1024
PATHS = re.compile(r"^/sessions/[^/]+/(plan|plan/undo|plan/suggest|plan/chat|places)$")


class BodyCapMiddleware:
    def __init__(self, app, cap: int = CAP):
        self.app, self.cap = app, cap

    async def __call__(self, scope, receive, send):
        m = PATHS.match(scope.get("path", "")) if scope["type"] == "http" and scope["method"] in ("PUT", "POST") else None
        if m is None:
            return await self.app(scope, receive, send)
        route = f"/sessions/{{share_slug}}/{m[1]}"
        length = dict(scope["headers"]).get(b"content-length")
        if length is not None and length.isdigit() and int(length) > self.cap:
            return await self._refuse(send, route, length.decode())
        chunks, total, more = [], 0, True
        while more:  # read it all here, up to the cap, whatever Content-Length says
            message = await receive()
            if message["type"] != "http.request":
                return  # the client went away
            total += len(message.get("body", b""))
            if total > self.cap:
                return await self._refuse(send, route, f">{self.cap}")
            chunks.append(message.get("body", b""))
            more = message.get("more_body", False)
        body, sent = b"".join(chunks), False

        async def replay():
            nonlocal sent
            if sent:
                return await receive()
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}

        await self.app(scope, replay, send)

    async def _refuse(self, send, route: str, size: str) -> None:
        logger.warning("body too big path=%s bytes=%s", route, size)
        payload = json.dumps({"detail": "too_big"}).encode()
        await send({"type": "http.response.start", "status": 413,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(payload)).encode())]})
        await send({"type": "http.response.body", "body": payload})
