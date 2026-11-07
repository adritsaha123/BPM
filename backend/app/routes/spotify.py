"""Spotify: sign-in, playlists, and live BPM sync (song tempo vs live heart rate).

Connect once on the laptop running the backend: http://127.0.0.1:8000/spotify/login
(Spotify only allows 127.0.0.1 loopback redirects, not "localhost").
With no Spotify credentials in .env, every endpoint runs on a mock library + player.

Which tempo the music aims for:
- ?target_bpm= given: exactly that (manual override).
- Otherwise start from the current heart rate: live from /live/hr (a reading in the last 15 s),
  else ?fallback_bpm= (the app's "simulate heart rate" stepper).
- ?zone=1..5 turns on coach mode: below the zone the music leads a step faster, above it a step
  slower, inside it the music matches the heart rate (tempo.coach_target). Zones come from WHOOP
  (/whoop/summary), or an estimate from a 190 max heart rate if WHOOP isn't connected.
"""

import time
from collections import deque
from collections.abc import Callable
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel, Field

from app import spotify, tempo, whoop
from app.config import get_settings
from app.routes import live

router = APIRouter(prefix="/spotify", tags=["spotify"])

HR_STALE_S = 15
HR_WINDOW_S = 10
DEFAULT_MAX_HR = 190  # zone estimate when WHOOP isn't connected
ZONES_TTL_S = 60
_recently_synced: deque[str] = deque(maxlen=15)  # don't queue the same songs over and over
_zones_cache: dict[str, Any] = {}

TargetBpm = Query(None, ge=30, le=250, description="Override: match exactly this BPM")
FallbackBpm = Query(None, ge=30, le=250, description="Heart rate to use when there's no live reading")
Zone = Query(None, ge=1, le=5, description="Coach mode: nudge the heart rate into this zone (1-5)")
PlaylistId = Query(spotify.LIKED, description="Playlist id, or 'liked' for Liked Songs")


def _call(fn: Callable[..., Any], *args: Any) -> Any:
    try:
        return fn(*args)
    except spotify.SpotifyNotConnectedError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    except spotify.SpotifyAPIError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


def _heart_rate() -> dict:
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


def _resolve(target_bpm: float | None, fallback_bpm: float | None, zone: int | None = None) -> dict:
    """Work out the current heart rate and the tempo the music should aim for."""
    hr = _heart_rate()
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
        z = next((z for z in hr_zones()["zones"] if z["zone"] == zone), None)
        if z:
            step = tempo.coach_target(current, z["min_bpm"], z["max_bpm"])
            target = step["target_bpm"]
            coach = {
                "zone": zone,
                "zone_min": z["min_bpm"],
                "zone_max": z["max_bpm"],
                "zones_source": hr_zones()["source"],
                **step,
            }
    return {"target": target, "source": source, "current": current, "coach": coach, "hr": hr}


def _with_tempo(tracks: list[dict], target: float | None) -> list[dict]:
    tempos = tempo.get_tempos([t["id"] for t in tracks])
    return [
        {**t, "tempo": tempos.get(t["id"]), "match": tempo.match(tempos.get(t["id"]), target)} for t in tracks
    ]


def _ranked(playlist_id: str, target: float) -> tuple[list[dict], int]:
    tracks = _with_tempo(_call(spotify.playlist_tracks, playlist_id), target)
    known = [t for t in tracks if t["match"]]
    known.sort(key=lambda t: abs(t["match"]["diff_bpm"]))
    return known, len(tracks) - len(known)


# --------------------------------------------------------------------------- connect


@router.get("/status")
def status() -> dict:
    return {"mode": spotify.mode(), "login_url": "/spotify/login"}


@router.get("/login")
def login() -> RedirectResponse:
    if not get_settings().spotify_enabled:
        raise HTTPException(
            status_code=400,
            detail="Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in backend/.env, then restart.",
        )
    return RedirectResponse(spotify.authorization_url())


@router.get("/callback", response_class=HTMLResponse)
def callback(code: str | None = None, state: str | None = None, error: str | None = None) -> str:
    if error:
        raise HTTPException(status_code=400, detail=f"Spotify returned an error: {error}")
    if not code or not state or not spotify.consume_state(state):
        raise HTTPException(
            status_code=400, detail="Missing or unknown OAuth state. Start again at /spotify/login."
        )
    _call(spotify.exchange_code, code)
    return (
        "<h2>Spotify connected.</h2>"
        "<p>You can close this tab. Check <a href='/spotify/now-playing'>/spotify/now-playing</a>.</p>"
    )


# --------------------------------------------------------------------------- library


@router.get("/playlists")
def playlists() -> list[dict]:
    """Liked Songs first, then the user's playlists."""
    return _call(spotify.playlists)


@router.get("/playlists/{playlist_id}/tracks")
def playlist_tracks(playlist_id: str, target_bpm: float | None = TargetBpm) -> list[dict]:
    """Tracks with tempo (BPM). Use playlist_id 'liked' for Liked Songs."""
    target = _resolve(target_bpm, None)["target"]
    return _with_tempo(_call(spotify.playlist_tracks, playlist_id), target)


# --------------------------------------------------------------------------- live BPM sync


@router.get("/zones")
def zones() -> dict:
    """The 5 heart rate zones coach mode can aim for (from WHOOP, or estimated)."""
    return hr_zones()


@router.get("/now-playing")
def now_playing(
    target_bpm: float | None = TargetBpm,
    fallback_bpm: float | None = FallbackBpm,
    zone: int | None = Zone,
) -> dict:
    """Current song + its tempo + heart rate + coach target + how well they match. Poll every 1-2 s."""
    playback = _call(spotify.current_playback)
    r = _resolve(target_bpm, fallback_bpm, zone)
    track = playback.get("track") if playback else None
    if track:
        track = {**track, "tempo": tempo.get_tempo(track["id"])}
    return {
        "mode": spotify.mode(),
        "is_playing": bool(playback and playback["is_playing"]),
        "progress_ms": playback.get("progress_ms") if playback else None,
        "track": track,
        "heart_rate": r["hr"],
        "current_bpm": r["current"],
        "target_bpm": r["target"],
        "target_source": r["source"],
        "coach": r["coach"],
        "match": tempo.match(track["tempo"], r["target"]) if track else None,
    }


@router.get("/match")
def match(
    playlist_id: str = PlaylistId,
    target_bpm: float | None = TargetBpm,
    fallback_bpm: float | None = FallbackBpm,
    zone: int | None = Zone,
    limit: int = Query(10, ge=1, le=50),
) -> dict:
    """Songs from a playlist ranked by how close their tempo is to the target BPM."""
    r = _resolve(target_bpm, fallback_bpm, zone)
    base = {
        "target_bpm": r["target"],
        "target_source": r["source"],
        "coach": r["coach"],
        "playlist_id": playlist_id,
    }
    if r["target"] is None:
        return {**base, "tracks": [], "no_tempo_count": 0}
    ranked, no_tempo = _ranked(playlist_id, r["target"])
    return {**base, "tracks": ranked[:limit], "no_tempo_count": no_tempo}


class SyncIn(BaseModel):
    playlist_id: str = spotify.LIKED
    target_bpm: float | None = Field(None, ge=30, le=250)
    fallback_bpm: float | None = Field(None, ge=30, le=250)
    zone: int | None = Field(None, ge=1, le=5)
    play_now: bool = False  # False = add to queue (plays after the current song)


@router.post("/sync")
def sync(body: SyncIn) -> dict:
    """Pick the song that best fits the target (heart rate, or coach target with a zone) and queue
    it, or play it now."""
    r = _resolve(body.target_bpm, body.fallback_bpm, body.zone)
    target, source = r["target"], r["source"]
    if target is None:
        raise HTTPException(
            status_code=400,
            detail="No live heart rate. Start scripts/whoop_live_hr.py, or send target_bpm / fallback_bpm.",
        )
    playback = _call(spotify.current_playback)
    current_id = ((playback or {}).get("track") or {}).get("id")
    ranked, _ = _ranked(body.playlist_id, target)
    candidates = [t for t in ranked if t["id"] != current_id]
    pick = next((t for t in candidates if t["id"] not in _recently_synced), None) or next(
        iter(candidates), None
    )
    if pick is None:
        raise HTTPException(status_code=404, detail="No songs with a known tempo in that playlist.")
    if body.play_now:
        _call(spotify.play, [pick["uri"]])
    else:
        _call(spotify.queue, pick["uri"])
    _recently_synced.append(pick["id"])
    return {
        "action": "playing" if body.play_now else "queued",
        "target_bpm": target,
        "target_source": source,
        "coach": r["coach"],
        "track": pick,
    }


# --------------------------------------------------------------------------- player controls


class PlayIn(BaseModel):
    uris: list[str] | None = None
    context_uri: str | None = None
    offset_uri: str | None = None


class QueueIn(BaseModel):
    uri: str


@router.post("/play", status_code=204)
def play(body: PlayIn | None = None) -> None:
    """Play specific tracks or a playlist; with an empty body, resume."""
    body = body or PlayIn()
    _call(spotify.play, body.uris, body.context_uri, body.offset_uri)


@router.post("/pause", status_code=204)
def pause() -> None:
    _call(spotify.pause)


@router.post("/next", status_code=204)
def next_track() -> None:
    _call(spotify.next_track)


@router.post("/queue", status_code=204)
def add_to_queue(body: QueueIn) -> None:
    _call(spotify.queue, body.uri)


def reset_sync_history() -> None:
    _recently_synced.clear()
    _zones_cache.clear()
