import json
import time
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from fastapi.testclient import TestClient

from app import spotify, tempo
from app.config import get_settings
from app.main import app
from app.routes import spotify as spotify_routes

client = TestClient(app)


@pytest.fixture(autouse=True)
def clean_state():
    client.delete("/live/hr")
    spotify.mock_reset()
    spotify._cache.clear()
    spotify_routes.reset_sync_history()
    tempo._cache.clear()
    tempo._last_failure = 0.0
    yield
    client.delete("/live/hr")


@pytest.fixture
def mock_mode(monkeypatch, tmp_path):
    monkeypatch.setenv("SPOTIFY_CLIENT_ID", "")
    monkeypatch.setenv("SPOTIFY_CLIENT_SECRET", "")
    monkeypatch.setenv("SPOTIFY_TOKEN_FILE", str(tmp_path / "tokens.json"))
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def live_creds(monkeypatch, tmp_path):
    monkeypatch.setenv("SPOTIFY_CLIENT_ID", "cid")
    monkeypatch.setenv("SPOTIFY_CLIENT_SECRET", "secret")
    monkeypatch.setenv("SPOTIFY_TOKEN_FILE", str(tmp_path / "tokens.json"))
    get_settings.cache_clear()
    yield tmp_path / "tokens.json"
    get_settings.cache_clear()


@pytest.fixture
def connected(live_creds):
    live_creds.write_text(
        json.dumps({"access_token": "tok", "refresh_token": "r1", "expires_at": time.time() + 600})
    )
    return live_creds


# --------------------------------------------------------------------------- tempo matching


def test_match_handles_half_and_double_time():
    m = tempo.match(85, 170)
    assert m["multiple"] == 2.0 and m["effective_bpm"] == 170 and m["status"] == "in_sync"
    assert tempo.match(180, 90)["multiple"] == 0.5
    close = tempo.match(150, 156)
    assert close["status"] == "close" and close["diff_bpm"] == -6 and close["speed_to_match"] == 1.04
    assert tempo.match(120, 160)["status"] == "off"
    assert tempo.match(None, 160) is None and tempo.match(120, None) is None


def test_reccobeats_lookup_batches_and_caches(monkeypatch):
    calls = []

    def fake_get(url, params, headers, timeout):
        ids = params["ids"].split(",")
        calls.append(ids)
        content = [
            {"href": f"https://open.spotify.com/track/{i}", "tempo": 120.04} for i in ids if i != "unknown"
        ]
        return httpx.Response(200, json={"content": content})

    monkeypatch.setattr(tempo.httpx, "get", fake_get)
    ids = [f"t{i}" for i in range(45)] + ["unknown"]
    out = tempo.get_tempos(ids)
    assert [len(c) for c in calls] == [40, 6]
    assert out["t0"] == 120.0 and out["unknown"] is None
    tempo.get_tempos(ids)  # all cached, including the unknown one
    assert len(calls) == 2


def test_reccobeats_failure_is_not_cached(monkeypatch):
    def boom(*a, **k):
        raise httpx.ConnectError("offline")

    monkeypatch.setattr(tempo.httpx, "get", boom)
    assert tempo.get_tempo("abc") is None
    assert "abc" not in tempo._cache


# --------------------------------------------------------------------------- mock mode


def test_status_and_health_mock(mock_mode):
    assert client.get("/spotify/status").json()["mode"] == "mock"
    assert client.get("/health").json()["spotify"] == "mock"


def test_playlists_mock(mock_mode):
    rows = client.get("/spotify/playlists").json()
    assert rows[0]["id"] == "liked" and {r["id"] for r in rows} >= {"mock-easy", "mock-tempo"}
    tracks = client.get("/spotify/playlists/mock-tempo/tracks").json()
    assert tracks and all(t["tempo"] >= 140 for t in tracks)


def test_now_playing_without_heart_rate(mock_mode):
    np = client.get("/spotify/now-playing").json()
    assert np["is_playing"] and np["track"]["tempo"]
    assert np["heart_rate"]["live"] is False and np["target_bpm"] is None and np["match"] is None
    fb = client.get("/spotify/now-playing", params={"fallback_bpm": 128}).json()
    assert fb["target_source"] == "fallback" and fb["match"]["status"] == "in_sync"  # Heartline = 128


def test_now_playing_uses_live_heart_rate(mock_mode):
    for bpm in (150, 154):
        client.post("/live/hr", json={"bpm": bpm})
    np = client.get("/spotify/now-playing", params={"fallback_bpm": 100}).json()
    assert np["heart_rate"]["live"] and np["target_source"] == "heart_rate" and np["target_bpm"] == 152
    assert np["match"]["target_bpm"] == 152


def test_match_ranks_by_closeness(mock_mode):
    body = client.get("/spotify/match", params={"target_bpm": 165, "limit": 5}).json()
    diffs = [abs(t["match"]["diff_bpm"]) for t in body["tracks"]]
    assert diffs == sorted(diffs) and body["tracks"][0]["tempo"] == 164
    assert client.get("/spotify/match").json()["tracks"] == []  # no target at all


def test_sync_queues_best_match_then_next_plays_it(mock_mode):
    client.post("/live/hr", json={"bpm": 176})
    r = client.post("/spotify/sync", json={}).json()
    assert r["action"] == "queued" and r["track"]["tempo"] in (176, 88)
    first = r["track"]["id"]
    second = client.post("/spotify/sync", json={}).json()["track"]["id"]
    assert second != first  # recently-synced songs are skipped
    assert client.post("/spotify/next").status_code == 204
    assert client.get("/spotify/now-playing").json()["track"]["id"] == first


def test_sync_play_now_and_needs_a_target(mock_mode):
    assert client.post("/spotify/sync", json={}).status_code == 400
    r = client.post("/spotify/sync", json={"target_bpm": 100, "play_now": True}).json()
    assert r["action"] == "playing"
    assert client.get("/spotify/now-playing").json()["track"]["id"] == r["track"]["id"]


def test_mock_player_pause_resume_and_auto_advance(mock_mode):
    client.post("/spotify/pause")
    paused = client.get("/spotify/now-playing").json()
    assert paused["is_playing"] is False
    client.post("/spotify/play")
    assert client.get("/spotify/now-playing").json()["is_playing"]
    spotify._mock["started_at"] -= 1_000  # pretend ~5 songs went by
    assert client.get("/spotify/now-playing").json()["track"]["id"] != paused["track"]["id"]
    assert client.post("/spotify/queue", json={"uri": "spotify:track:nope"}).status_code == 400


# --------------------------------------------------------------------------- live credentials


def test_login_without_credentials(mock_mode):
    assert client.get("/spotify/login", follow_redirects=False).status_code == 400


def test_login_redirects_to_spotify(live_creds):
    r = client.get("/spotify/login", follow_redirects=False)
    assert r.status_code == 307
    url = urlparse(r.headers["location"])
    q = parse_qs(url.query)
    assert url.netloc == "accounts.spotify.com" and q["client_id"] == ["cid"]
    assert q["redirect_uri"] == ["http://127.0.0.1:8000/spotify/callback"]
    assert "user-modify-playback-state" in q["scope"][0]


def test_not_connected_returns_401(live_creds):
    assert client.get("/spotify/status").json()["mode"] == "not_connected"
    assert client.get("/spotify/now-playing").status_code == 401


def test_callback_exchanges_code_and_saves_tokens(live_creds, monkeypatch):
    monkeypatch.setattr(
        spotify,
        "_token_request",
        lambda data: {"access_token": "a1", "refresh_token": "r1", "expires_in": 3600},
    )
    assert client.get("/spotify/callback", params={"code": "x", "state": "nope"}).status_code == 400
    login = client.get("/spotify/login", follow_redirects=False)
    state = parse_qs(urlparse(login.headers["location"]).query)["state"][0]
    r = client.get("/spotify/callback", params={"code": "abc", "state": state})
    assert r.status_code == 200 and "connected" in r.text
    assert json.loads(live_creds.read_text())["access_token"] == "a1"
    assert spotify.mode() == "live"


def test_refresh_keeps_old_refresh_token(connected, monkeypatch):
    connected.write_text(json.dumps({"access_token": "old", "refresh_token": "r1", "expires_at": 0}))
    monkeypatch.setattr(spotify, "_token_request", lambda data: {"access_token": "new", "expires_in": 3600})
    assert spotify._access_token() == "new"
    assert json.loads(connected.read_text())["refresh_token"] == "r1"


def _fake_spotify(monkeypatch, routes: dict):
    sent = []

    def fake_request(method, url, params=None, json=None, headers=None, timeout=None):
        path = url.removeprefix(spotify.API_BASE)
        sent.append((method, path, params, json))
        status, body = routes.get((method, path), (404, {"error": {"status": 404, "message": "nope"}}))
        return httpx.Response(status, json=body) if body is not None else httpx.Response(status)

    monkeypatch.setattr(spotify.httpx, "request", fake_request)
    return sent


def test_live_now_playing_and_playlist_items(connected, monkeypatch):
    track = {
        "type": "track",
        "id": "abc",
        "uri": "spotify:track:abc",
        "name": "Song",
        "duration_ms": 200000,
        "artists": [{"name": "Band"}],
        "album": {"name": "LP", "images": [{"url": "http://img"}]},
    }
    _fake_spotify(
        monkeypatch,
        {
            ("GET", "/me/player/currently-playing"): (
                200,
                {"is_playing": True, "progress_ms": 5000, "item": track},
            ),
            # Feb 2026 shape: entries use "item"; also a local file and a podcast episode to skip
            ("GET", "/playlists/p1/items"): (
                200,
                {
                    "items": [
                        {"item": track},
                        {"track": {"id": None, "is_local": True}},
                        {"item": {"type": "episode", "id": "ep"}},
                    ],
                    "next": None,
                },
            ),
        },
    )
    monkeypatch.setattr(tempo, "_fetch", lambda ids: dict.fromkeys(ids, 170.0))
    np = client.get("/spotify/now-playing", params={"target_bpm": 168}).json()
    assert np["track"]["name"] == "Song" and np["track"]["image"] == "http://img"
    assert np["match"]["status"] == "in_sync" and np["target_source"] == "manual"
    tracks = client.get("/spotify/playlists/p1/tracks").json()
    assert [t["id"] for t in tracks] == ["abc"]


def test_live_nothing_playing(connected, monkeypatch):
    _fake_spotify(monkeypatch, {("GET", "/me/player/currently-playing"): (204, None)})
    np = client.get("/spotify/now-playing").json()
    assert np["track"] is None and np["is_playing"] is False


def test_live_premium_and_device_errors_are_explained(connected, monkeypatch):
    _fake_spotify(
        monkeypatch,
        {
            ("POST", "/me/player/queue"): (
                403,
                {
                    "error": {
                        "status": 403,
                        "message": "Player command failed: Premium required",
                        "reason": "PREMIUM_REQUIRED",
                    }
                },
            ),
            ("PUT", "/me/player/play"): (
                404,
                {
                    "error": {
                        "status": 404,
                        "message": "Player command failed: No active device found",
                        "reason": "NO_ACTIVE_DEVICE",
                    }
                },
            ),
        },
    )
    r = client.post("/spotify/queue", json={"uri": "spotify:track:abc"})
    assert r.status_code == 403 and "Premium" in r.json()["detail"]
    r = client.post("/spotify/play", json={"uris": ["spotify:track:abc"]})
    assert r.status_code == 404 and "Open Spotify on your phone" in r.json()["detail"]


def test_live_401_refreshes_once(connected, monkeypatch):
    statuses = iter([401, 204])

    def fake_request(method, url, **kw):
        return httpx.Response(next(statuses))

    monkeypatch.setattr(spotify.httpx, "request", fake_request)
    monkeypatch.setattr(spotify, "_token_request", lambda data: {"access_token": "fresh", "expires_in": 3600})
    assert client.post("/spotify/pause").status_code == 204
    assert json.loads(connected.read_text())["access_token"] == "fresh"


# --------------------------------------------------------------------------- coach mode


@pytest.fixture
def default_zones(monkeypatch):
    """WHOOP not connected: zones estimated from a 190 max HR. Zone 3 = 133-152, middle 142.5."""

    def not_connected(*a, **k):
        raise spotify_routes.whoop.WhoopNotConnectedError("no whoop")

    monkeypatch.setattr(spotify_routes.whoop, "summary", not_connected)


def test_coach_target_leads_one_step_toward_the_zone():
    assert tempo.coach_target(120, 133, 152) == {"target_bpm": 128, "direction": "push"}
    assert tempo.coach_target(138, 140, 152)["target_bpm"] == 146  # capped at zone middle
    assert tempo.coach_target(130, 133, 152)["target_bpm"] == 138
    assert tempo.coach_target(170, 133, 152) == {"target_bpm": 162, "direction": "ease"}
    assert tempo.coach_target(155, 133, 152)["target_bpm"] == 147
    assert tempo.coach_target(140, 133, 152) == {"target_bpm": 140, "direction": "hold"}


def test_zones_default_and_from_whoop(mock_mode, default_zones, monkeypatch):
    z = client.get("/spotify/zones").json()
    assert z["source"] == "default" and z["zones"][2] == {"zone": 3, "min_bpm": 133, "max_bpm": 152}
    monkeypatch.undo()
    spotify_routes.reset_sync_history()  # clears the zones cache
    monkeypatch.setenv("WHOOP_CLIENT_ID", "")
    monkeypatch.setenv("WHOOP_CLIENT_SECRET", "")
    get_settings.cache_clear()
    z = client.get("/spotify/zones").json()
    assert z["source"] == "whoop_mock" and len(z["zones"]) == 5


def test_now_playing_coach_pushes_when_heart_rate_is_low(mock_mode, default_zones):
    client.post("/live/hr", json={"bpm": 120})
    np = client.get("/spotify/now-playing", params={"zone": 3}).json()
    assert np["current_bpm"] == 120 and np["target_bpm"] == 128
    assert np["coach"]["direction"] == "push" and np["coach"]["zone_min"] == 133
    assert np["match"]["target_bpm"] == 128  # Heartline (128) is exactly the push target
    assert np["match"]["status"] == "in_sync"
    plain = client.get("/spotify/now-playing").json()
    assert plain["coach"] is None and plain["target_bpm"] == 120


def test_coach_with_simulated_heart_rate_and_hold(mock_mode, default_zones):
    np = client.get("/spotify/now-playing", params={"zone": 3, "fallback_bpm": 140}).json()
    assert (
        np["target_source"] == "fallback" and np["coach"]["direction"] == "hold" and np["target_bpm"] == 140
    )


def test_sync_eases_off_when_heart_rate_is_high(mock_mode, default_zones):
    client.post("/live/hr", json={"bpm": 170})
    r = client.post("/spotify/sync", json={"zone": 3, "play_now": True}).json()
    assert r["coach"]["direction"] == "ease" and r["target_bpm"] == 162
    assert abs(r["track"]["match"]["effective_bpm"] - 162) <= 3
    ranked = client.get("/spotify/match", params={"zone": 3}).json()
    assert ranked["coach"]["direction"] == "ease" and ranked["target_bpm"] == 162


def test_manual_target_skips_coaching(mock_mode, default_zones):
    client.post("/live/hr", json={"bpm": 120})
    np = client.get("/spotify/now-playing", params={"zone": 3, "target_bpm": 100}).json()
    assert np["coach"] is None and np["target_bpm"] == 100
