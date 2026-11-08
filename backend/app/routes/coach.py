"""Coach target + tempo lookup for players that run on the phone (Apple Music).

The Apple Music player lives inside the iPhone app, so the app can ask here what tempo to aim
for, and looks up song tempos by title + artist (Apple Music library songs carry no BPM).
"""

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from app import coach, tempo

router = APIRouter(tags=["coach"])

TargetBpm = Query(None, ge=30, le=250, description="Override: aim for exactly this BPM")
FallbackBpm = Query(None, ge=30, le=250, description="Heart rate to use when there's no live reading")
Zone = Query(None, ge=1, le=5, description="Coach mode: nudge the heart rate into this zone (1-5)")


@router.get("/coach/zones")
def zones() -> dict:
    """The 5 heart rate zones (from WHOOP, or estimated from a 190 max heart rate)."""
    return coach.hr_zones()


@router.get("/coach/target")
def target(
    target_bpm: float | None = TargetBpm,
    fallback_bpm: float | None = FallbackBpm,
    zone: int | None = Zone,
) -> dict:
    """Current heart rate and the tempo the music should aim for. Poll every 1-2 s."""
    r = coach.resolve(target_bpm, fallback_bpm, zone)
    return {
        "heart_rate": r["hr"],
        "current_bpm": r["current"],
        "target_bpm": r["target"],
        "target_source": r["source"],
        "coach": r["coach"],
    }


class TrackIn(BaseModel):
    id: str
    title: str
    artist: str = ""
    duration_s: float | None = None
    library_bpm: float | None = None  # BPM tag already on the song, if any


class LookupIn(BaseModel):
    tracks: list[TrackIn] = Field(max_length=50)


@router.post("/tempo/lookup")
def lookup(body: LookupIn) -> dict:
    """Song tempos (BPM) by title + artist (ReccoBeats, then Deezer), cached on disk in backend/data.
    Only the first lookup of a library is slow (a few songs a second).

    {"tempos": {id: {"bpm", "source", "matched", "isrc"} | null}}
    """
    out: dict[str, dict | None] = {}
    todo: list[dict] = []
    for t in body.tracks:
        if t.library_bpm and t.library_bpm > 0:
            out[t.id] = {"bpm": round(t.library_bpm, 1), "source": "library"}
        elif not t.title.strip():
            out[t.id] = None
        else:
            todo.append(t.model_dump())
    out.update(tempo.lookup_many(todo))
    return {"tempos": out}
