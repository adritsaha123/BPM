"""Song tempo (BPM) lookup, and matching a song's tempo to a live heart rate.

Spotify returns 403 on /audio-features for apps created after Nov 27 2024, so tempo comes from
ReccoBeats (free, no API key): GET https://api.reccobeats.com/v1/audio-features?ids=<spotify ids>
with at most 40 ids per call. Tracks ReccoBeats doesn't know are simply missing from the
response, so their tempo is None. Results are cached in memory for the life of the process.

Matching treats half and double time as the same groove: a 85 BPM song "fits" a heart rate of
170 (one beat every two heartbeats), and a 180 BPM song fits 90.
"""

from __future__ import annotations

import time

import httpx

from app import spotify

RECCOBEATS_URL = "https://api.reccobeats.com/v1/audio-features"
BATCH = 40  # ReccoBeats rejects more: "size must be between 1 and 40"
RETRY_AFTER_FAILURE_S = 30
IN_SYNC_BPM = 3  # |song - heart rate| within this = in sync
CLOSE_BPM = 8

_cache: dict[str, float | None] = {}
_last_failure = 0.0


def _fetch(ids: list[str]) -> dict[str, float | None] | None:
    """One ReccoBeats call. None means the request failed (don't cache, retry later)."""
    try:
        r = httpx.get(
            RECCOBEATS_URL,
            params={"ids": ",".join(ids)},
            headers={"Accept": "application/json", "User-Agent": "BPM-hackathon/0.1"},
            timeout=15,
        )
    except httpx.HTTPError:
        return None
    if r.status_code != 200:
        return None
    found: dict[str, float | None] = dict.fromkeys(ids)
    for row in r.json().get("content") or []:
        spotify_id = (row.get("href") or "").rstrip("/").rsplit("/", 1)[-1]
        if spotify_id in found and row.get("tempo"):
            found[spotify_id] = round(float(row["tempo"]), 1)
    return found


def get_tempos(track_ids: list[str]) -> dict[str, float | None]:
    """Spotify track id -> tempo in BPM (None if unknown)."""
    global _last_failure
    out: dict[str, float | None] = {}
    missing: list[str] = []
    for tid in dict.fromkeys(track_ids):  # dedupe, keep order
        if tid in _cache:
            out[tid] = _cache[tid]
        elif (bpm := spotify.mock_tempo(tid)) is not None:
            out[tid] = bpm
        else:
            missing.append(tid)

    for i in range(0, len(missing), BATCH):
        chunk = missing[i : i + BATCH]
        fetched = None
        if time.time() - _last_failure >= RETRY_AFTER_FAILURE_S:
            fetched = _fetch(chunk)
            if fetched is None:
                _last_failure = time.time()
        if fetched is None:
            out.update(dict.fromkeys(chunk))
            continue
        _cache.update(fetched)
        out.update(fetched)
    return out


def get_tempo(track_id: str) -> float | None:
    return get_tempos([track_id]).get(track_id)


COACH_STEP_BPM = 8  # how far above/below the current heart rate the music leads


def coach_target(current_bpm: float, zone_min: float, zone_max: float, step: float = COACH_STEP_BPM) -> dict:
    """Coach mode: pick the music tempo that nudges the heart rate toward a training zone.

    Below the zone the music leads a step faster than the heart rate (never past the zone's
    middle); above it, a step slower; inside it, the music simply matches the heart rate.
    One step at a time, because big tempo jumps feel jarring and are hard to follow.
    """
    mid = (zone_min + zone_max) / 2
    if current_bpm < zone_min:
        target, direction = min(current_bpm + step, mid), "push"
    elif current_bpm > zone_max:
        target, direction = max(current_bpm - step, mid), "ease"
    else:
        target, direction = current_bpm, "hold"
    return {"target_bpm": round(target, 1), "direction": direction}


def match(song_bpm: float | None, target_bpm: float | None) -> dict | None:
    """How well a song's tempo fits a target (usually the live heart rate).

    speed_to_match is the playback rate the song would need to lock in exactly. Spotify can't
    change speed, so it's informational (and what an own-audio player would use).
    """
    if not song_bpm or not target_bpm:
        return None
    options = [(song_bpm, 1.0), (song_bpm * 2, 2.0), (song_bpm / 2, 0.5)]
    effective, multiple = min(options, key=lambda o: abs(o[0] - target_bpm))
    diff = effective - target_bpm
    status = "in_sync" if abs(diff) <= IN_SYNC_BPM else "close" if abs(diff) <= CLOSE_BPM else "off"
    return {
        "song_bpm": round(song_bpm, 1),
        "target_bpm": round(target_bpm, 1),
        "effective_bpm": round(effective, 1),
        "multiple": multiple,
        "diff_bpm": round(diff, 1),
        "status": status,
        "speed_to_match": round(target_bpm / effective, 3),
    }
