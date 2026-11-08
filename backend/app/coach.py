"""Coach targets: what tempo the music should aim for right now. Shared by Spotify and Apple Music.

- target_bpm given: exactly that (manual override, no coaching).
- Otherwise start from the current heart rate: live from /live/hr (a reading in the last 15 s),
  else fallback_bpm (the app's "simulate heart rate" stepper).
- zone=1..5 turns on coach mode, in running tempo (150-185): from the current song's tempo (or an
  easy 160 with no song), a step faster when the heart rate is below the zone, a step slower above
  it, the same inside it (tempo.coach_target). Zones come from WHOOP (/whoop/summary), or an
  estimate from a 190 max heart rate if WHOOP isn't connected.
"""

from __future__ import annotations

import time
from typing import Any

import httpx

from app import tempo, whoop
from app.routes import live

HR_STALE_S = 15
HR_WINDOW_S = 10
DEFAULT_MAX_HR = 190  # zone estimate when WHOOP isn't connected
ZONES_TTL_S = 60

_zones_cache: dict[str, Any] = {}


def reset_cache() -> None:
    _zones_cache.clear()


def heart_rate() -> dict:
    hr = live.latest_hr(window_s=HR_WINDOW_S)
    fresh = hr["bpm"] is not None and hr["age_s"] is not None and hr["age_s"] <= HR_STALE_S
    return {"bpm": hr["bpm"], "avg_bpm": hr["avg_bpm"], "age_s": hr["age_s"], "live": fresh}


def hr_zones() -> dict:
    """The 5 heart rate zones coach mode aims for, and where they came from."""
    hit = _zones_cache.get("zones")
    if hit and time.time() - hit[0] < ZONES_TTL_S:
        return hit[1]
    zones, source = [], "default"
    try:
        zones = whoop.summary()["hr_zones"]
        source = "whoop" if whoop.mode() == "live" else "whoop_mock"
    except (whoop.WhoopNotConnectedError, whoop.WhoopAPIError, httpx.HTTPError):
        pass
    if not zones:
        zones, source = whoop.hr_zones(DEFAULT_MAX_HR, None), "default"
    result = {"zones": zones, "source": source}
    _zones_cache["zones"] = (time.time(), result)
    return result


def resolve(
    target_bpm: float | None,
    fallback_bpm: float | None,
    zone: int | None = None,
    song_bpm: float | None = None,
) -> dict:
    """Current heart rate and the tempo the music should aim for.

    Returns {"target", "source" (manual | heart_rate | fallback | None), "current", "coach", "hr"}.
    """
    hr = heart_rate()
    if target_bpm:
        return {"target": target_bpm, "source": "manual", "current": None, "coach": None, "hr": hr}
    if hr["live"]:
        current, source = hr["avg_bpm"] or hr["bpm"], "heart_rate"
    elif fallback_bpm:
        current, source = fallback_bpm, "fallback"
    else:
        return {"target": None, "source": None, "current": None, "coach": None, "hr": hr}

    coach = None
    target = current
    if zone:
        zones = hr_zones()
        z = next((z for z in zones["zones"] if z["zone"] == zone), None)
        if z:
            step = tempo.coach_target(current, z["min_bpm"], z["max_bpm"], song_bpm)
            target = step["target_bpm"]
            coach = {
                "zone": zone,
                "zone_min": z["min_bpm"],
                "zone_max": z["max_bpm"],
                "zones_source": zones["source"],
                **step,
            }
    return {"target": target, "source": source, "current": current, "coach": coach, "hr": hr}
