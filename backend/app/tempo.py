"""Song tempo (BPM) lookup, and matching a song's tempo to a live heart rate.

Spotify returns 403 on /audio-features for apps created after Nov 27 2024, so tempo comes from
ReccoBeats (free, no API key): GET https://api.reccobeats.com/v1/audio-features?ids=<spotify ids>
with at most 40 ids per call. Tracks ReccoBeats doesn't know are simply missing from the
response, so their tempo is None. Results are cached in memory for the life of the process.

ReccoBeats also returns each song's energy and danceability (0-1). Coach mode uses energy too:
pushing the heart rate up picks fast *and* high-energy songs, easing off picks calmer ones
(see fit_score).

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

FEATURES = ("tempo", "energy", "danceability")
Features = dict[str, float | None]

_cache: dict[str, Features | None] = {}
_last_failure = 0.0


def _fetch(ids: list[str]) -> dict[str, Features | None] | None:
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
    found: dict[str, Features | None] = dict.fromkeys(ids)
    for row in r.json().get("content") or []:
        spotify_id = (row.get("href") or "").rstrip("/").rsplit("/", 1)[-1]
        if spotify_id in found and row.get("tempo"):
            found[spotify_id] = {
                "tempo": round(float(row["tempo"]), 1),
                **{k: _round(row.get(k)) for k in FEATURES[1:]},
            }
    return found


def _round(v: object) -> float | None:
    return round(float(v), 2) if isinstance(v, int | float) else None


def _as_features(v: Features | float | None) -> Features | None:
    """Cache entries are feature dicts; a bare number is treated as just a tempo."""
    if v is None or isinstance(v, dict):
        return v
    return {"tempo": float(v), "energy": None, "danceability": None}


def get_features(track_ids: list[str]) -> dict[str, Features | None]:
    """Spotify track id -> {tempo, energy, danceability} (None if ReccoBeats doesn't know it)."""
    global _last_failure
    out: dict[str, Features | None] = {}
    missing: list[str] = []
    for tid in dict.fromkeys(track_ids):  # dedupe, keep order
        if tid in _cache:
            out[tid] = _as_features(_cache[tid])
        elif (mock := spotify.mock_features(tid)) is not None:
            out[tid] = mock
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
        fetched = {k: _as_features(v) for k, v in fetched.items()}
        _cache.update(fetched)
        out.update(fetched)
    return out


def get_tempos(track_ids: list[str]) -> dict[str, float | None]:
    """Spotify track id -> tempo in BPM (None if unknown)."""
    return {tid: (f or {}).get("tempo") for tid, f in get_features(track_ids).items()}


def get_tempo(track_id: str) -> float | None:
    return get_tempos([track_id]).get(track_id)


# Coach mode works in running tempo: runners fall into step with the beat, and heart rate follows
# cadence. So the music steps from the current song's tempo toward the zone, one song at a time.
RUN_MIN_BPM = 150  # slower than this stops feeling like running music
RUN_MAX_BPM = 185
RUN_START_BPM = 160  # nothing playing yet: an easy running cadence
COACH_STEP_BPM = 8  # per song: Spotify changes tempo song by song, so smaller steps get lost


def running_tempo(song_bpm: float) -> float:
    """A song's tempo as a running cadence: halve or double it into 150-185 if that fits better
    (an 85 BPM song runs at 170), else the closest of the three."""

    def outside(b: float) -> float:
        return max(RUN_MIN_BPM - b, 0, b - RUN_MAX_BPM)

    return min((song_bpm, song_bpm * 2, song_bpm / 2), key=outside)


def coach_target(
    current_hr: float,
    zone_min: float,
    zone_max: float,
    song_bpm: float | None = None,
    step: float = COACH_STEP_BPM,
) -> dict:
    """Coach mode: the music tempo that nudges the heart rate toward a training zone.

    Start from the current song's tempo (as a running cadence) and move one step: faster when the
    heart rate is below the zone, slower above it, the same inside it. Always within 150-185.
    """
    base = running_tempo(song_bpm) if song_bpm else RUN_START_BPM
    base = min(max(base, RUN_MIN_BPM), RUN_MAX_BPM)
    if current_hr < zone_min:
        target, direction = base + step, "push"
    elif current_hr > zone_max:
        target, direction = base - step, "ease"
    else:
        target, direction = base, "hold"
    target = min(max(target, RUN_MIN_BPM), RUN_MAX_BPM)
    return {"target_bpm": round(target, 1), "direction": direction, "from_bpm": round(base, 1)}


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


# How energetic the music should feel for each coaching direction (ReccoBeats energy, 0-1).
INTENSITY_ENERGY = {"push": 0.8, "hold": 0.65, "ease": 0.4}
ENERGY_WEIGHT = 10  # 0.1 of energy off the goal counts like being 1 BPM off
UNKNOWN_ENERGY_PENALTY = 0.2  # songs with no energy data rank as if 0.2 off
HALF_DOUBLE_PENALTY = 2  # BPM-equivalent cost of matching at half or double time


def fit_score(match_info: dict | None, energy: float | None, intensity: str | None) -> float | None:
    """Lower is better. Tempo stays in charge; energy breaks near-ties.

    - tempo: distance from the target in BPM
    - wrong way: when pushing, songs slower than the target count double (and faster ones when
      easing off), so energy never drags the tempo the wrong way
    - energy: how far the song is from what that direction wants (push = high, ease = calm)
    """
    if not match_info:
        return None
    diff = match_info["diff_bpm"]
    score = abs(diff)
    if (intensity == "push" and diff < 0) or (intensity == "ease" and diff > 0):
        score += abs(diff)
    if intensity and match_info.get("multiple", 1) != 1:
        score += HALF_DOUBLE_PENALTY  # a half/double-time fit works, a song at the real tempo drives better
    want = INTENSITY_ENERGY.get(intensity or "")
    if want is not None:
        off = abs(energy - want) if energy is not None else UNKNOWN_ENERGY_PENALTY
        score += ENERGY_WEIGHT * off
    return round(score, 2)
