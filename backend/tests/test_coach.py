import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app import coach, tempo
from app.main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def clean(monkeypatch, tmp_path):
    client.delete("/live/hr")
    coach.reset_cache()
    tempo.reset_meta_cache()
    monkeypatch.setattr(tempo, "CACHE_FILE", tmp_path / "tempo_cache.json")
    monkeypatch.setattr(tempo, "DEEZER_MIN_INTERVAL_S", 0)
    monkeypatch.setattr(tempo, "RECCOBEATS_MIN_INTERVAL_S", 0)
    monkeypatch.setattr(tempo, "RATE_LIMIT_WAIT_S", 0)
    tempo._next_call.clear()

    def no_whoop(*a, **k):  # zones estimated from a 190 max HR: Zone 3 = 133-152
        raise coach.whoop.WhoopNotConnectedError("no whoop")

    monkeypatch.setattr(coach.whoop, "summary", no_whoop)
    yield
    client.delete("/live/hr")
    tempo.reset_meta_cache()


# --------------------------------------------------------------------------- /coach


def test_target_with_simulated_heart_rate_and_zone():
    r = client.get("/coach/target", params={"fallback_bpm": 120, "zone": 3}).json()
    assert r["current_bpm"] == 120 and r["target_source"] == "fallback"
    assert r["coach"]["direction"] == "push" and r["target_bpm"] == 168  # running tempo: 160 + 8


def test_target_prefers_live_heart_rate():
    client.post("/live/hr", json={"bpm": 170})
    r = client.get("/coach/target", params={"fallback_bpm": 120, "zone": 3}).json()
    assert r["target_source"] == "heart_rate" and r["coach"]["direction"] == "ease"
    assert r["target_bpm"] == 152  # running tempo: 160 - 8


def test_target_without_any_heart_rate():
    r = client.get("/coach/target").json()
    assert r["target_bpm"] is None and r["coach"] is None and r["heart_rate"]["live"] is False


def test_zones_endpoint():
    z = client.get("/coach/zones").json()
    assert z["source"] == "default" and z["zones"][2] == {"zone": 3, "min_bpm": 133, "max_bpm": 152}


# --------------------------------------------------------------------------- tempo by title + artist


def _fake_sources(monkeypatch, reccobeats=(), features=None, deezer=(), status=200):
    """Fake ReccoBeats + Deezer.

    reccobeats: search hits (title, artists, duration_s, popularity, isrc); search matches titles
    containing the search text. features: isrc -> tempo. deezer: (id, title, artist, duration_s,
    isrc, bpm). Returns the list of requested URLs.
    """
    features = features or {}
    calls = []

    def fake_get(url, params=None, headers=None, timeout=None):
        calls.append(url)
        if status != 200:
            return httpx.Response(status, json={})
        if url == tempo.RECCOBEATS_SEARCH_URL:
            want = params["searchText"].lower()
            content = [
                {
                    "trackTitle": t,
                    "artists": [{"name": a} for a in artists],
                    "durationMs": d * 1000,
                    "popularity": pop,
                    "isrc": isrc,
                }
                for t, artists, d, pop, isrc in reccobeats
                if want in t.lower()
            ]
            return httpx.Response(200, json={"content": content, "totalPages": 1 if content else 0})
        if url == tempo.RECCOBEATS_URL:
            rows = [{"isrc": i, "tempo": features[i]} for i in params["ids"].split(",") if i in features]
            return httpx.Response(200, json={"content": rows})
        if url == tempo.DEEZER_SEARCH_URL:
            q = params["q"].lower()
            data = [
                {"id": i, "title": t, "duration": d, "rank": 100 - n, "artist": {"name": a}}
                for n, (i, t, a, d, _, _) in enumerate(deezer)
                if t.lower().split(" (")[0] in q
            ]
            return httpx.Response(200, json={"data": data})
        track = next(x for x in deezer if url == tempo.DEEZER_TRACK_URL.format(x[0]))
        return httpx.Response(200, json={"id": track[0], "isrc": track[4], "bpm": track[5]})

    monkeypatch.setattr(tempo.httpx, "get", fake_get)
    return calls


def test_strip_tags_and_names():
    assert tempo._strip_tags("Hey Jude - Remastered 2015") == "Hey Jude"
    assert tempo._strip_tags("Levitating (feat. DaBaby)") == "Levitating"
    assert tempo._strip_tags('Shallow (From "A Star Is Born") [Radio Edit]') == "Shallow"
    assert tempo._strip_tags("Run the World (Girls)") == "Run the World (Girls)"
    assert tempo._strip_tags("Mr. Brightside - Live") == "Mr. Brightside - Live"
    assert tempo._strip_tags("Song - Live / Remastered 2011") == "Song - Live / Remastered 2011"
    assert tempo._norm("Beyoncé & JAY-Z") == "beyonce and jay z"


def test_lookup_finds_the_recording_on_deezer_first(monkeypatch):
    calls = _fake_sources(
        monkeypatch,
        features={"DZ2": 140.2},
        deezer=[
            (1, "Far Away (Live)", "The Strays", 250, "DZ1", 150),
            (2, "Far Away", "Other Band", 180, "DZ3", 0),  # a cover
            (3, "Far Away", "The Strays", 180, "DZ2", 0),
        ],
    )
    r = tempo.lookup_tempo("Far Away", "The Strays", duration_s=181)
    assert r == {"bpm": 140.2, "source": "reccobeats", "matched": "Far Away - The Strays", "isrc": "DZ2"}
    assert tempo.RECCOBEATS_SEARCH_URL not in calls


def test_lookup_picks_the_original_over_covers_and_other_versions(monkeypatch):
    _fake_sources(
        monkeypatch,
        reccobeats=[
            ("Night Drive", ["Cover Band"], 200, 90, "COVER"),  # most popular, wrong artist
            ("Night Drive - Live", ["Low Tide"], 260, 80, "LIVE"),
            ("Night Drive", ["Low Tide"], 410, 70, "EXTENDED"),  # same title, much longer
            ("Night Drive", ["Choir", "Strings", "Orchestra", "Low Tide"], 200, 65, "SONGWRITER"),
            ("Night Drive - 2019 Remaster", ["Low Tide", "Friends"], 201, 60, "ORIGINAL"),
        ],
        features={"COVER": 99.0, "LIVE": 130.0, "EXTENDED": 121.0, "SONGWRITER": 98.0, "ORIGINAL": 122.4},
    )
    r = tempo.lookup_tempo("Night Drive (feat. Someone)", "Low Tide & Friends", duration_s=200)
    assert r["bpm"] == 122.4 and r["source"] == "reccobeats" and r["isrc"] == "ORIGINAL"
    assert r["matched"] == "Night Drive - 2019 Remaster - Low Tide, Friends"


def test_lookup_uses_deezer_bpm_when_reccobeats_has_none(monkeypatch):
    _fake_sources(monkeypatch, deezer=[(5, "Quiet Song", "Duo", 200, "Q1", 92)])
    r = tempo.lookup_tempo("Quiet Song", "Duo")
    assert r == {"bpm": 92.0, "source": "deezer", "matched": "Quiet Song - Duo", "isrc": "Q1"}


def test_lookup_many_asks_reccobeats_once_per_40_songs(monkeypatch):
    calls = _fake_sources(
        monkeypatch,
        features={"A1": 100.0, "B1": 120.0},
        deezer=[
            (1, "Alpha", "Band", 200, "A1", 0),
            (2, "Beta", "Band", 200, "B1", 0),
            (3, "Gamma", "Band", 200, "G1", 0),
        ],
    )
    tracks = [{"id": t, "title": t, "artist": "Band", "duration_s": 200} for t in ("Alpha", "Beta", "Gamma")]
    tracks.append({"id": "Alpha again", "title": "Alpha", "artist": "Band"})
    out = tempo.lookup_many(tracks)
    assert [out[t] and out[t]["bpm"] for t in ("Alpha", "Beta", "Gamma", "Alpha again")] == [
        100.0,
        120.0,
        None,
        100.0,
    ]
    assert calls.count(tempo.RECCOBEATS_URL) == 1  # Gamma's ISRC wasn't asked about twice either
    assert calls.count(tempo.RECCOBEATS_SEARCH_URL) == 1  # only Gamma fell through to the title search


def test_lookup_waits_out_a_rate_limit(monkeypatch):
    calls = _fake_sources(monkeypatch, features={"Q1": 92.5}, deezer=[(5, "Quiet Song", "Duo", 200, "Q1", 0)])
    fake_get = tempo.httpx.get
    limited = []

    def once_limited(url, **kw):
        if url == tempo.RECCOBEATS_URL and not limited:
            limited.append(url)
            return httpx.Response(429, headers={"Retry-After": "0"}, json={"error": "Too many request"})
        return fake_get(url, **kw)

    monkeypatch.setattr(tempo.httpx, "get", once_limited)
    assert tempo.lookup_tempo("Quiet Song", "Duo")["bpm"] == 92.5
    assert limited and calls.count(tempo.RECCOBEATS_URL) == 1  # + the 429 that was retried


def test_lookup_caches_hits_and_misses(monkeypatch):
    calls = _fake_sources(monkeypatch, deezer=[(7, "Unknown Tempo", "Band", 180, None, 0)])
    assert tempo.lookup_tempo("Unknown Tempo", "Band") is None  # found on Deezer, no BPM anywhere
    n = len(calls)
    assert tempo.lookup_tempo("Unknown Tempo", "Band") is None
    assert len(calls) == n  # cached


def test_lookup_failures_are_not_cached(monkeypatch):
    _fake_sources(monkeypatch, status=429)
    assert tempo.lookup_tempo("Song", "Artist") is None
    assert "song|artist" not in tempo._load_meta_cache()
    monkeypatch.setattr(
        tempo.httpx,
        "get",
        lambda *a, **k: httpx.Response(200, json={"error": {"code": 4, "message": "Quota limit exceeded"}}),
    )
    assert tempo.lookup_tempo("Song", "Artist") is None
    assert "song|artist" not in tempo._load_meta_cache()


def test_tempo_lookup_endpoint(monkeypatch, tmp_path):
    _fake_sources(
        monkeypatch,
        reccobeats=[("Steady", ["Pacers"], 200, 50, "ST1")],
        features={"ST1": 160.2},
    )
    body = {
        "tracks": [
            {"id": "a", "title": "Steady", "artist": "Pacers", "duration_s": 199},
            {"id": "b", "title": "Tagged", "artist": "X", "library_bpm": 128},
            {"id": "c", "title": "  ", "artist": "X"},
            {"id": "d", "title": "Nowhere", "artist": "Nobody"},
        ]
    }
    tempos = client.post("/tempo/lookup", json=body).json()["tempos"]
    assert tempos["a"]["bpm"] == 160.2 and tempos["a"]["source"] == "reccobeats"
    assert tempos["b"] == {"bpm": 128, "source": "library"}
    assert tempos["c"] is None and tempos["d"] is None
    saved = json.loads((tmp_path / "tempo_cache.json").read_text())
    assert saved["version"] == tempo.CACHE_VERSION and saved["songs"]["steady|pacers"]["bpm"] == 160.2


def test_tempo_cache_from_an_older_version_is_ignored(tmp_path):
    (tmp_path / "tempo_cache.json").write_text(json.dumps({"steady|pacers": {"bpm": 1}}))
    assert tempo._load_meta_cache() == {}


def test_tempo_lookup_limits_batch_size():
    tracks = [{"id": str(i), "title": "x"} for i in range(51)]
    assert client.post("/tempo/lookup", json={"tracks": tracks}).status_code == 422
