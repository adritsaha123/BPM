"""DJ mode: openly licensed songs the app plays itself at the exact target tempo.

GET /dj/status  -> how many songs are in the catalog
GET /dj/match   -> songs ranked for a target BPM (and energy, with ?intensity=push|hold|ease),
                   each with the playback rate that lands it exactly on the target.
See app/dj.py and scripts/build_dj_catalog.py.
"""

from typing import Literal

from fastapi import APIRouter, Query

from app import dj

router = APIRouter(prefix="/dj", tags=["dj"])


@router.get("/status")
def status() -> dict:
    return {"count": len(dj.tracks()), "source": dj.source_note(), "max_stretch": dj.MAX_STRETCH}


@router.get("/match")
def match(
    target_bpm: float = Query(ge=30, le=250, description="Tempo the music should play at"),
    intensity: Literal["push", "hold", "ease"] | None = Query(
        None, description="push = favor high-energy songs, ease = calmer ones"
    ),
    exclude: str = Query("", description="Comma-separated song ids to skip (recently played)"),
    limit: int = Query(5, ge=1, le=50),
) -> dict:
    skip = {s for s in exclude.split(",") if s}
    ranked = dj.rank(target_bpm, intensity, skip)
    return {"target_bpm": target_bpm, "intensity": intensity, "count": len(ranked), "tracks": ranked[:limit]}
