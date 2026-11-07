import json
import time
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient

from app import whoop
from app.ble_hr import parse_hr_measurement
from app.config import get_settings
from app.main import app

client = TestClient(app)


@pytest.fixture
def mock_mode(monkeypatch, tmp_path):
    monkeypatch.setenv("WHOOP_CLIENT_ID", "")
    monkeypatch.setenv("WHOOP_CLIENT_SECRET", "")
    monkeypatch.setenv("WHOOP_TOKEN_FILE", str(tmp_path / "tokens.json"))
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def live_creds(monkeypatch, tmp_path):
    monkeypatch.setenv("WHOOP_CLIENT_ID", "cid")
    monkeypatch.setenv("WHOOP_CLIENT_SECRET", "secret")
    monkeypatch.setenv("WHOOP_TOKEN_FILE", str(tmp_path / "tokens.json"))
    get_settings.cache_clear()
    whoop._cache.clear()
    yield tmp_path / "tokens.json"
    get_settings.cache_clear()
    whoop._cache.clear()


def test_status_mock(mock_mode):
    assert client.get("/whoop/status").json()["mode"] == "mock"
    assert client.get("/health").json()["whoop"] == "mock"


def test_summary_mock(mock_mode):
    s = client.get("/whoop/summary").json()
    assert s["max_hr"] == 197
    assert len(s["hr_zones"]) == 5
    assert s["zone_method"] == "heart_rate_reserve"
    assert s["recent_runs"] and all(r["is_run"] for r in s["recent_runs"])
    assert s["steps_current_cycle"] > 0


def test_workouts_runs_only(mock_mode):
    rows = client.get("/whoop/workouts", params={"days": 30, "runs_only": True}).json()
    assert rows and all(r["is_run"] and r["pace_min_per_km"] for r in rows)


def test_cycles_and_recovery_mock(mock_mode):
    assert all(c["step_count"] for c in client.get("/whoop/cycles", params={"days": 7}).json())
    rec = client.get("/whoop/recovery", params={"days": 7}).json()
    assert len(rec) == 7 and rec[0]["resting_hr"]


def test_login_without_credentials(mock_mode):
    assert client.get("/whoop/login", follow_redirects=False).status_code == 400


def test_login_redirects_to_whoop(live_creds):
    r = client.get("/whoop/login", follow_redirects=False)
    assert r.status_code == 307
    url = urlparse(r.headers["location"])
    q = parse_qs(url.query)
    assert url.netloc == "api.prod.whoop.com"
    assert q["client_id"] == ["cid"] and "offline" in q["scope"][0] and len(q["state"][0]) == 8


def test_callback_rejects_unknown_state(live_creds):
    assert client.get("/whoop/callback", params={"code": "x", "state": "nope"}).status_code == 400


def test_not_connected_returns_401(live_creds):
    assert client.get("/whoop/status").json()["mode"] == "not_connected"
    assert client.get("/whoop/summary").status_code == 401


def test_callback_exchanges_code_and_saves_tokens(live_creds, monkeypatch):
    monkeypatch.setattr(
        whoop,
        "_token_request",
        lambda data: {"access_token": "a1", "refresh_token": "r1", "expires_in": 3600},
    )
    login = client.get("/whoop/login", follow_redirects=False)
    state = parse_qs(urlparse(login.headers["location"]).query)["state"][0]
    r = client.get("/whoop/callback", params={"code": "abc", "state": state})
    assert r.status_code == 200 and "connected" in r.text
    assert json.loads(live_creds.read_text())["access_token"] == "a1"
    assert whoop.mode() == "live"


def test_expired_token_refreshes(live_creds, monkeypatch):
    live_creds.write_text(
        json.dumps({"access_token": "old", "refresh_token": "r1", "expires_at": time.time() - 5})
    )
    calls = []

    def fake_token_request(data):
        calls.append(data)
        return {"access_token": "new", "refresh_token": "r2", "expires_in": 3600}

    monkeypatch.setattr(whoop, "_token_request", fake_token_request)
    assert whoop._access_token() == "new"
    assert calls[0]["grant_type"] == "refresh_token" and calls[0]["refresh_token"] == "r1"
    assert json.loads(live_creds.read_text())["refresh_token"] == "r2"


def test_hr_zones_percent_of_max_fallback():
    zones = whoop.hr_zones(200, None)
    assert zones[0] == {"zone": 1, "min_bpm": 100, "max_bpm": 120}
    assert whoop.hr_zones(None, 50) == []


def test_live_hr_roundtrip():
    client.delete("/live/hr")
    assert client.get("/live/hr").json()["bpm"] is None
    for bpm in (150, 154):
        assert client.post("/live/hr", json={"bpm": bpm}).status_code == 204
    latest = client.get("/live/hr").json()
    assert latest["bpm"] == 154 and latest["avg_bpm"] == 152.0 and latest["age_s"] < 5
    assert client.post("/live/hr", json={"bpm": 5}).status_code == 422


def test_parse_hr_measurement():
    assert parse_hr_measurement(bytes([0x00, 72]))["bpm"] == 72
    assert parse_hr_measurement(bytes([0x01, 0x96, 0x00]))["bpm"] == 150
    m = parse_hr_measurement(bytes([0x16, 140, 0x00, 0x04, 0x00, 0x02]))
    assert m == {"bpm": 140, "rr_ms": [1000.0, 500.0], "sensor_contact": True}
