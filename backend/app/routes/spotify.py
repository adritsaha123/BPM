"""Spotify: sign-in, playlists, and live BPM sync (song tempo vs live heart rate).

Two ways to connect, like WHOOP:
- In the app: "Connect Spotify" opens /spotify/login?user=<id>&return_to=<app url> in an in-app
  browser; the callback saves that user's login and redirects back into the app. Needs a public
  https SPOTIFY_REDIRECT_URI (the cloud deploy or ngrok).
- On the laptop: http://127.0.0.1:8000/spotify/login (the shared "default" login; Spotify only
  allows 127.0.0.1 loopback redirects over http, not "localhost").
Every endpoint uses the user from the X-User-Id header (or ?user=).
With no Spotify credentials in .env, every endpoint runs on a mock library + player.

Which tempo the music aims for:
- ?target_bpm= given: exactly that (manual override).
- Otherwise start from the current heart rate: live from /live/hr (a reading in the last 15 s),
  else ?fallback_bpm= (the app's "simulate heart rate" stepper).
- ?zone=1..5 turns on coach mode, in running tempo (150-185): from the current song's tempo, the
  next song is a step faster when the heart rate is below the zone, a step slower above it, the same
  inside it (tempo.coach_target). Zones come from WHOOP
  (/whoop/summary), or an estimate from a 190 max heart rate if WHOOP isn't connected.

Which songs win: closest tempo, plus energy when there's an intensity (?intensity=push|hold|ease,
or the coach's direction in coach mode): push favors high-energy songs, ease favors calm ones
(tempo.fit_score).
"""

import time
from collections import deque
from collections.abc import Callable
from typing import Annotated, Any, Literal
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel, Field

from app import spotify, tempo, whoop
from app.config import get_settings
from app.routes import live


async def _use_user(
    x_user_id: Annotated[str | None, Header()] = None,
    user: Annotated[str | None, Query(description="App user id (alternative to X-User-Id)")] = None,
) -> None:
    """Whose Spotify login this request uses. Async on purpose: it runs in the request's own
    context, so the sync endpoints (run in the threadpool with a copy of it) see the user."""
    spotify.use_user(x_user_id or user)


router = APIRouter(prefix="/spotify", tags=["spotify"], dependencies=[Depends(_use_user)])

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
IntensityT = Literal["push", "hold", "ease"]
Intensity = Query(
    None, description="push = favor high-energy songs, ease = calmer songs (default: coach direction)"
)


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


def _song_tempo(playback: dict | None) -> float | None:
    track = (playback or {}).get("track")
    return tempo.get_tempo(track["id"]) if track else None


def _resolve(
    target_bpm: float | None,
    fallback_bpm: float | None,
    zone: int | None = None,
    song_bpm: float | None = None,
) -> dict:
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
            step = tempo.coach_target(current, z["min_bpm"], z["max_bpm"], song_bpm)
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
    features = tempo.get_features([t["id"] for t in tracks])
    out = []
    for t in tracks:
        f = features.get(t["id"]) or {}
        out.append(
            {
                **t,
                "tempo": f.get("tempo"),
                "energy": f.get("energy"),
                "danceability": f.get("danceability"),
                "match": tempo.match(f.get("tempo"), target),
            }
        )
    return out


def _intensity(explicit: str | None, coach: dict | None) -> str | None:
    """Explicit ?intensity wins; otherwise follow the coach (push / hold / ease)."""
    return explicit or (coach or {}).get("direction")


def _ranked(playlist_id: str, target: float, intensity: str | None = None) -> tuple[list[dict], int]:
    tracks = _with_tempo(_call(spotify.playlist_tracks, playlist_id), target)
    known = []
    for t in tracks:
        if t["match"]:
            known.append({**t, "fit_score": tempo.fit_score(t["match"], t["energy"], intensity)})
    known.sort(key=lambda t: t["fit_score"])
    return known, len(tracks) - len(known)


# --------------------------------------------------------------------------- connect


@router.get("/status")
def status() -> dict:
    user = spotify.current_user()
    owner = spotify.login_owner(user)
    return {
        "mode": spotify.mode(user),
        "login_url": "/spotify/login",
        "user": user,
        # True when this user hasn't connected their own Spotify and is borrowing the laptop's login.
        "shared": owner is not None and owner != user,
    }


def _back_to_app(return_to: str, **params: str) -> RedirectResponse:
    sep = "&" if "?" in return_to else "?"
    return RedirectResponse(f"{return_to}{sep}{urlencode(params)}", status_code=302)


@router.get("/login")
def login(return_to: str | None = None) -> RedirectResponse:
    if not get_settings().spotify_enabled:
        raise HTTPException(
            status_code=400,
            detail="Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET on the backend, then restart.",
        )
    return RedirectResponse(spotify.authorization_url(spotify.current_user(), return_to))


@router.get("/callback", response_class=HTMLResponse, response_model=None)
def callback(
    code: str | None = None, state: str | None = None, error: str | None = None
) -> str | RedirectResponse:
    pending = spotify.consume_state(state) if state else None
    return_to = pending["return_to"] if pending else None
    if error:
        if return_to:
            return _back_to_app(return_to, spotify="error", reason=error)
        raise HTTPException(status_code=400, detail=f"Spotify returned an error: {error}")
    if not code or not pending:
        raise HTTPException(
            status_code=400, detail="Missing or unknown OAuth state. Start again at /spotify/login."
        )
    try:
        _call(spotify.exchange_code, code, pending["user"])
    except HTTPException:
        if return_to:
            return _back_to_app(return_to, spotify="error", reason="token_exchange_failed")
        raise
    if return_to:
        return _back_to_app(return_to, spotify="connected")
    return (
        "<h2>Spotify connected.</h2>"
        "<p>You can close this tab. Check <a href='/spotify/now-playing'>/spotify/now-playing</a>.</p>"
    )


@router.delete("/connection", status_code=204)
def disconnect() -> None:
    """Forget this user's Spotify login (e.g. to switch accounts)."""
    spotify.disconnect()


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
    track = playback.get("track") if playback else None
    if track:
        f = tempo.get_features([track["id"]]).get(track["id"]) or {}
        track = {**track, "tempo": f.get("tempo"), "energy": f.get("energy")}
    r = _resolve(target_bpm, fallback_bpm, zone, track["tempo"] if track else None)
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
    intensity: IntensityT | None = Intensity,
    limit: int = Query(10, ge=1, le=50),
) -> dict:
    """Songs from a playlist ranked by tempo closeness to the target BPM (and energy, with an intensity)."""
    song_bpm = _song_tempo(_call(spotify.current_playback)) if zone and not target_bpm else None
    r = _resolve(target_bpm, fallback_bpm, zone, song_bpm)
    level = _intensity(intensity, r["coach"])
    base = {
        "target_bpm": r["target"],
        "target_source": r["source"],
        "coach": r["coach"],
        "intensity": level,
        "playlist_id": playlist_id,
    }
    if r["target"] is None:
        return {**base, "tracks": [], "no_tempo_count": 0}
    ranked, no_tempo = _ranked(playlist_id, r["target"], level)
    return {**base, "tracks": ranked[:limit], "no_tempo_count": no_tempo}


class SyncIn(BaseModel):
    playlist_id: str = spotify.LIKED
    target_bpm: float | None = Field(None, ge=30, le=250)
    fallback_bpm: float | None = Field(None, ge=30, le=250)
    zone: int | None = Field(None, ge=1, le=5)
    intensity: IntensityT | None = None  # push = high-energy songs, ease = calmer (default: coach)
    play_now: bool = False  # False = add to queue (plays after the current song)


@router.post("/sync")
def sync(body: SyncIn) -> dict:
    """Pick the song that best fits the target (heart rate, or coach target with a zone) and queue
    it, or play it now."""
    playback = _call(spotify.current_playback)
    r = _resolve(body.target_bpm, body.fallback_bpm, body.zone, _song_tempo(playback))
    target, source = r["target"], r["source"]
    if target is None:
        raise HTTPException(
            status_code=400,
            detail="No live heart rate. Connect the Whoop, or send target_bpm / fallback_bpm.",
        )
    current_id = ((playback or {}).get("track") or {}).get("id")
    level = _intensity(body.intensity, r["coach"])
    ranked, _ = _ranked(body.playlist_id, target, level)
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
        "intensity": level,
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


class VolumeIn(BaseModel):
    percent: int = Field(ge=0, le=100)


@router.get("/volume")
def volume() -> dict:
    """Device volume, and whether Spotify allows changing it remotely (used to fade song switches)."""
    return _call(spotify.volume)


@router.put("/volume", status_code=204)
def set_volume(body: VolumeIn) -> None:
    _call(spotify.set_volume, body.percent)


@router.post("/next", status_code=204)
def next_track() -> None:
    _call(spotify.next_track)


@router.post("/queue", status_code=204)
def add_to_queue(body: QueueIn) -> None:
    _call(spotify.queue, body.uri)


def reset_sync_history() -> None:
    _recently_synced.clear()
    _zones_cache.clear()
