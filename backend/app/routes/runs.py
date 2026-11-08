"""Recorded runs: the phone's GPS track from a workout, for building the route afterwards.

The app records one point per GPS fix (lat/lon/altitude/speed + the heart rate at that moment)
and POSTs the whole run when the workout stops. Runs are kept per user (X-User-Id header):

- DATABASE_URL set (cloud deploy): one row per run in the `runs` table.
- Otherwise (the laptop): data/runs/<user>/<run id>.json. Gitignored (backend/data/).

Export a route as GeoJSON (maps, geojson.io) or GPX (Strava, Garmin, Google Earth).
"""

from __future__ import annotations

import json
import math
import re
from datetime import UTC, datetime
from pathlib import Path
from xml.sax.saxutils import escape

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

from app import token_store
from app.routes.whoop import User

router = APIRouter(prefix="/runs", tags=["runs"])

RUNS_DIR = Path("data/runs")
RUN_ID = r"^[A-Za-z0-9_-]{1,64}$"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    started_at DOUBLE PRECISION NOT NULL,
    data JSONB NOT NULL,
    PRIMARY KEY (user_id, id)
)
"""


class PointIn(BaseModel):
    t: float  # unix ms
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    alt: float | None = None
    acc: float | None = None
    speed: float | None = None
    hr: int | None = Field(default=None, ge=20, le=250)


class RunIn(BaseModel):
    id: str = Field(pattern=RUN_ID)
    started_at: float  # unix ms
    ended_at: float
    points: list[PointIn] = Field(max_length=100_000)  # ~27 h at 1 Hz


# ------------------------------------------------------------------- storage


def _db():
    conn = token_store._connect()
    conn.execute(_SCHEMA)
    return conn


def _file(user: str, run_id: str) -> Path:
    return RUNS_DIR / user / f"{run_id}.json"


def _save(user: str, run: dict) -> None:
    if token_store._db_url():
        from psycopg.types.json import Jsonb

        with _db() as conn:
            conn.execute(
                "INSERT INTO runs (user_id, id, started_at, data) VALUES (%s, %s, %s, %s) "
                "ON CONFLICT (user_id, id) DO UPDATE "
                "SET started_at = EXCLUDED.started_at, data = EXCLUDED.data",
                (user, run["id"], run["started_at"], Jsonb(run)),
            )
        return
    path = _file(user, run["id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(run))


def _load(user: str, run_id: str) -> dict | None:
    if token_store._db_url():
        with _db() as conn:
            row = conn.execute(
                "SELECT data FROM runs WHERE user_id = %s AND id = %s", (user, run_id)
            ).fetchone()
        return row[0] if row else None
    path = _file(user, run_id)
    return json.loads(path.read_text()) if path.exists() else None


def _load_all(user: str) -> list[dict]:
    if token_store._db_url():
        with _db() as conn:
            rows = conn.execute("SELECT data FROM runs WHERE user_id = %s", (user,)).fetchall()
        runs = [r[0] for r in rows]
    else:
        folder = RUNS_DIR / user
        runs = [json.loads(p.read_text()) for p in folder.glob("*.json")] if folder.exists() else []
    return sorted(runs, key=lambda r: r["started_at"], reverse=True)


def _delete(user: str, run_id: str) -> bool:
    if token_store._db_url():
        with _db() as conn:
            cur = conn.execute("DELETE FROM runs WHERE user_id = %s AND id = %s", (user, run_id))
        return cur.rowcount > 0
    path = _file(user, run_id)
    if not path.exists():
        return False
    path.unlink()
    return True


def _get_or_404(user: str, run_id: str) -> dict:
    run = _load(user, run_id) if _valid_id(run_id) else None
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return run


def _valid_id(run_id: str) -> bool:
    return re.match(RUN_ID, run_id) is not None


# ------------------------------------------------------------------- route math


def haversine_m(a: dict, b: dict) -> float:
    r = 6_371_000
    p1, p2 = math.radians(a["lat"]), math.radians(b["lat"])
    dp, dl = p2 - p1, math.radians(b["lon"] - a["lon"])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def summarize(run: dict) -> dict:
    pts = run["points"]
    distance_m = sum(haversine_m(a, b) for a, b in zip(pts, pts[1:], strict=False))
    duration_s = (pts[-1]["t"] - pts[0]["t"]) / 1000 if len(pts) > 1 else 0
    hrs = [p["hr"] for p in pts if p.get("hr") is not None]
    km = distance_m / 1000
    return {
        "id": run["id"],
        "started_at": run["started_at"],
        "ended_at": run["ended_at"],
        "point_count": len(pts),
        "distance_km": round(km, 3),
        "duration_min": round(duration_s / 60, 1),
        "pace_min_per_km": round(duration_s / 60 / km, 2) if km >= 0.05 else None,
        "avg_hr": round(sum(hrs) / len(hrs)) if hrs else None,
        "max_hr": max(hrs) if hrs else None,
    }


def _iso(ms: float) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


# ------------------------------------------------------------------- endpoints


@router.post("", status_code=201)
def save_run(run: RunIn, user: User) -> dict:
    """Store (or replace, same id) a run recorded on the phone. Returns its summary."""
    if len(run.points) < 2:
        raise HTTPException(status_code=422, detail="A run needs at least 2 GPS points")
    data = run.model_dump()
    data["points"].sort(key=lambda p: p["t"])
    _save(user, data)
    return summarize(data)


@router.get("")
def list_runs(user: User) -> list[dict]:
    """This user's runs, newest first (summaries only)."""
    return [summarize(r) for r in _load_all(user)]


@router.get("/{run_id}")
def get_run(run_id: str, user: User) -> dict:
    """One run with all its points."""
    run = _get_or_404(user, run_id)
    return {**summarize(run), "points": run["points"]}


@router.get("/{run_id}/route.geojson")
def run_geojson(run_id: str, user: User) -> dict:
    """The route as a GeoJSON LineString. Per-point times and heart rates are in the properties."""
    run = _get_or_404(user, run_id)
    pts = run["points"]
    return {
        "type": "Feature",
        "geometry": {
            "type": "LineString",
            "coordinates": [
                [p["lon"], p["lat"]] + ([p["alt"]] if p.get("alt") is not None else []) for p in pts
            ],
        },
        "properties": {
            **summarize(run),
            "times": [_iso(p["t"]) for p in pts],
            "heart_rates": [p.get("hr") for p in pts],
        },
    }


@router.get("/{run_id}/route.gpx")
def run_gpx(run_id: str, user: User) -> Response:
    """The route as a GPX track (with heart rate), importable into Strava, Garmin Connect, etc."""
    run = _get_or_404(user, run_id)
    trkpts = []
    for p in run["points"]:
        ele = f"<ele>{p['alt']:.1f}</ele>" if p.get("alt") is not None else ""
        hr = (
            f"<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>{p['hr']}</gpxtpx:hr>"
            "</gpxtpx:TrackPointExtension></extensions>"
            if p.get("hr") is not None
            else ""
        )
        trkpts.append(
            f'<trkpt lat="{p["lat"]:.7f}" lon="{p["lon"]:.7f}">{ele}<time>{_iso(p["t"])}</time>{hr}</trkpt>'
        )
    gpx = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<gpx version="1.1" creator="BPM Coach" xmlns="http://www.topografix.com/GPX/1/1" '
        'xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">'
        f"<metadata><time>{_iso(run['started_at'])}</time></metadata>"
        f"<trk><name>{escape(run['id'])}</name><type>running</type><trkseg>"
        + "".join(trkpts)
        + "</trkseg></trk></gpx>\n"
    )
    return Response(
        gpx,
        media_type="application/gpx+xml",
        headers={"Content-Disposition": f'attachment; filename="{run["id"]}.gpx"'},
    )


@router.delete("/{run_id}", status_code=204)
def delete_run(run_id: str, user: User) -> None:
    if not (_valid_id(run_id) and _delete(user, run_id)):
        raise HTTPException(status_code=404, detail="Run not found")
