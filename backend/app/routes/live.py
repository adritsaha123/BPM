"""Live heart rate relay.

scripts/whoop_live_hr.py reads the WHOOP band over Bluetooth on the laptop and POSTs each
reading here; the app polls GET /live/hr. In memory only, resets on restart.
"""

import time
from collections import deque

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

router = APIRouter(prefix="/live", tags=["live"])

_readings: deque[dict] = deque(maxlen=900)  # ~15 min at 1 Hz


class HeartRateIn(BaseModel):
    bpm: int = Field(ge=20, le=250)
    source: str = "whoop"
    rr_ms: list[float] = []
    ts: float | None = None  # unix seconds; defaults to receive time


@router.post("/hr", status_code=204)
def push_hr(reading: HeartRateIn) -> None:
    _readings.append(
        {
            "bpm": reading.bpm,
            "source": reading.source,
            "rr_ms": reading.rr_ms,
            "ts": reading.ts or time.time(),
        }
    )


@router.get("/hr")
def latest_hr(window_s: int = Query(30, ge=1, le=900)) -> dict:
    """Latest bpm, how stale it is, and the average over the last `window_s` seconds."""
    if not _readings:
        return {"bpm": None, "source": None, "age_s": None, "avg_bpm": None, "recent": []}
    now = time.time()
    last = _readings[-1]
    recent = [r for r in _readings if now - r["ts"] <= window_s]
    return {
        "bpm": last["bpm"],
        "source": last["source"],
        "age_s": round(now - last["ts"], 1),
        "avg_bpm": round(sum(r["bpm"] for r in recent) / len(recent), 1) if recent else None,
        "recent": [{"bpm": r["bpm"], "ts": r["ts"]} for r in recent],
    }


@router.delete("/hr", status_code=204)
def clear_hr() -> None:
    _readings.clear()
