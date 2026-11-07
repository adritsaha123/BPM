"""DJ mode ranking against a small fake catalog."""

import json

import pytest
from fastapi.testclient import TestClient

from app import dj
from app.main import app

client = TestClient(app)

SONGS = [
    {"id": "a", "name": "A", "artist": "x", "audio": "https://e/a", "bpm": 160.0, "energy": 0.4},
    {"id": "b", "name": "B", "artist": "x", "audio": "https://e/b", "bpm": 162.0, "energy": 0.9},
    {"id": "c", "name": "C", "artist": "x", "audio": "https://e/c", "bpm": 87.0, "energy": 0.9},
    {"id": "d", "name": "D", "artist": "x", "audio": "https://e/d", "bpm": 130.0, "energy": 0.9},
]


@pytest.fixture(autouse=True)
def fake_catalog(tmp_path, monkeypatch):
    path = tmp_path / "dj_catalog.json"
    path.write_text(json.dumps({"source": "test", "tracks": SONGS, "measured": {"secret": 1}}))
    monkeypatch.setattr(dj, "CATALOG", path)
    dj._load.cache_clear()
    yield
    dj._load.cache_clear()


def test_status_counts_songs():
    assert client.get("/dj/status").json()["count"] == 4


def test_playback_rate_lands_exactly_on_target():
    top = client.get("/dj/match", params={"target_bpm": 165}).json()["tracks"][0]
    assert top["id"] == "b" and top["playback_rate"] == round(165 / 162, 3) and top["reachable"]


def test_energy_breaks_ties_by_intensity():
    push = client.get("/dj/match", params={"target_bpm": 161, "intensity": "push"}).json()["tracks"]
    ease = client.get("/dj/match", params={"target_bpm": 161, "intensity": "ease"}).json()["tracks"]
    assert push[0]["id"] == "b" and ease[0]["id"] == "a"


def test_half_time_counts_and_unreachable_songs_go_last():
    ranked = client.get("/dj/match", params={"target_bpm": 174, "limit": 10}).json()["tracks"]
    assert ranked[0]["id"] == "c" and ranked[0]["match"]["multiple"] == 2.0  # 87 BPM runs at 174
    assert ranked[-1]["id"] == "d" and not ranked[-1]["reachable"]  # 130 can't stretch to 174
    assert all(abs(t["playback_rate"] - 1) <= dj.MAX_STRETCH + 1e-9 for t in ranked)


def test_exclude_skips_recent_songs_and_internal_fields_stay_private():
    r = client.get("/dj/match", params={"target_bpm": 165, "exclude": "b,a"}).json()
    assert {t["id"] for t in r["tracks"]} == {"c", "d"}
    assert "rms" not in r["tracks"][0] and "measured" not in r
