"""TG-20 B20: CORS allows POST for the planner; GET still works.

Kept apart from test_planner.py so it fails on the CORS setting itself, not on a missing planner module.
"""

ORIGIN = "http://localhost:3000"


def test_cors_preflight_allows_post(client):
    r = client.options("/plan", headers={"Origin": ORIGIN, "Access-Control-Request-Method": "POST",
                                         "Access-Control-Request-Headers": "content-type"})
    assert r.status_code == 200, r.text
    assert "POST" in r.headers["access-control-allow-methods"]
    assert r.headers["access-control-allow-origin"] == ORIGIN
    other = client.options("/plan", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in other.headers
    get = client.get("/spots", headers={"Origin": ORIGIN})
    assert get.status_code == 200
    assert get.headers["access-control-allow-origin"] == ORIGIN
