"""Spotify: sign-in, playlists, and live BPM sync (song tempo vs live heart rate).

Connect once on the laptop running the backend: http://127.0.0.1:8000/spotify/login
(Spotify only allows 127.0.0.1 loopback redirects, not "localhost").
With no Spotify credentials in .env, every endpoint runs on a mock library + player.

Which tempo the music aims for (manual target, live heart rate, simulated heart rate, coach
zones) is worked out in app/coach.py, shared with Apple Music.
"""

from collections import deque
from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel, Field

from app import coach, spotify, tempo
from app.config import get_settings

router = APIRouter(prefix="/spotify", tags=["spotify"])

_recently_synced: deque[str] = deque(maxlen=15)  # don't queue the same songs over and over

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
    target = coach.resolve(target_bpm, None)["target"]
    return _with_tempo(_call(spotify.playlist_tracks, playlist_id), target)


# --------------------------------------------------------------------------- live BPM sync


@router.get("/zones")
def zones() -> dict:
    """The 5 heart rate zones coach mode can aim for (from WHOOP, or estimated)."""
    return coach.hr_zones()


@router.get("/now-playing")
def now_playing(
    target_bpm: float | None = TargetBpm,
    fallback_bpm: float | None = FallbackBpm,
    zone: int | None = Zone,
) -> dict:
    """Current song + its tempo + heart rate + coach target + how well they match. Poll every 1-2 s."""
    playback = _call(spotify.current_playback)
    r = coach.resolve(target_bpm, fallback_bpm, zone)
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
    r = coach.resolve(target_bpm, fallback_bpm, zone)
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
    r = coach.resolve(body.target_bpm, body.fallback_bpm, body.zone)
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
    coach.reset_cache()
