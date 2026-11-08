import pytest
from fastapi.testclient import TestClient

from app import token_store
from app.main import app
from app.routes import runs

client = TestClient(app)
USER = {"X-User-Id": "test-runner-1"}


@pytest.fixture(autouse=True)
def file_storage(tmp_path, monkeypatch):
    monkeypatch.setattr(runs, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(token_store, "_db_url", lambda: "")


def _run(run_id="run-1", n=61):
    # ~1 km north over 10 minutes, 1 point every 10 s (0.009° lat ≈ 1 km)
    t0 = 1_700_000_000_000
    return {
        "id": run_id,
        "started_at": t0,
        "ended_at": t0 + (n - 1) * 10_000,
        "points": [
            {
                "t": t0 + i * 10_000,
                "lat": 42.0 + 0.009 * i / max(n - 1, 1),
                "lon": -71.0,
                "alt": 10.0,
                "hr": 150 + i % 5,
            }
            for i in range(n)
        ],
    }


def test_save_list_get_delete():
    r = client.post("/runs", json=_run(), headers=USER)
    assert r.status_code == 201
    s = r.json()
    assert s["point_count"] == 61
    assert s["distance_km"] == pytest.approx(1.0, abs=0.01)
    assert s["duration_min"] == 10.0
    assert s["pace_min_per_km"] == pytest.approx(10.0, abs=0.1)
    assert s["avg_hr"] == 152 and s["max_hr"] == 154

    assert [x["id"] for x in client.get("/runs", headers=USER).json()] == ["run-1"]
    assert client.get("/runs", headers={"X-User-Id": "someone-else"}).json() == []
    assert len(client.get("/runs/run-1", headers=USER).json()["points"]) == 61

    assert client.delete("/runs/run-1", headers=USER).status_code == 204
    assert client.get("/runs/run-1", headers=USER).status_code == 404


def test_resave_same_id_replaces():
    client.post("/runs", json=_run(n=10), headers=USER)
    client.post("/runs", json=_run(n=20), headers=USER)
    runs_list = client.get("/runs", headers=USER).json()
    assert len(runs_list) == 1 and runs_list[0]["point_count"] == 20


def test_exports():
    client.post("/runs", json=_run(), headers=USER)
    geo = client.get("/runs/run-1/route.geojson", headers=USER).json()
    assert geo["geometry"]["type"] == "LineString"
    assert geo["geometry"]["coordinates"][0] == [-71.0, 42.0, 10.0]
    assert len(geo["properties"]["times"]) == 61

    gpx = client.get("/runs/run-1/route.gpx", headers=USER)
    assert gpx.headers["content-type"].startswith("application/gpx+xml")
    assert gpx.text.count("<trkpt") == 61
    assert "<gpxtpx:hr>150</gpxtpx:hr>" in gpx.text


def test_rejects_bad_input():
    assert client.post("/runs", json=_run(n=1), headers=USER).status_code == 422
    assert client.post("/runs", json={**_run(), "id": "../etc"}, headers=USER).status_code == 422
    assert client.get("/runs/..%2Fetc", headers=USER).status_code == 404
