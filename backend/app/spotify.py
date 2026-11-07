"""Spotify Web API client: sign-in, playlists, liked songs, now playing, playback control.

- OAuth 2.0 authorization code flow; the backend keeps the client secret. Tokens are saved to
  SPOTIFY_TOKEN_FILE (backend/.spotify_tokens.json, gitignored) and refresh automatically.
- Mock mode: with SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET blank, everything runs against a
  fake library and a fake player (songs advance in real time), so the app can be built and
  demoed without a Spotify account.

Limits worth knowing (details in docs/SPOTIFY.md):
- Development-mode apps allow 5 allowlisted users and the app owner needs Premium.
- Play / queue / skip only work for listeners with Spotify Premium.
- Spotify has no playback-speed control and gives new apps no song tempo, so tempo comes from
  app/tempo.py (ReccoBeats) and we *pick* songs that match instead of speeding them up.
"""

from __future__ import annotations

import base64
import json
import secrets
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import httpx

from app.config import get_settings

AUTH_URL = "https://accounts.spotify.com/authorize"
TOKEN_URL = "https://accounts.spotify.com/api/token"
API_BASE = "https://api.spotify.com/v1"
SCOPES = " ".join(
    [
        "user-read-playback-state",
        "user-modify-playback-state",
        "user-read-currently-playing",
        "playlist-read-private",
        "playlist-read-collaborative",
        "user-library-read",
    ]
)
LIKED = "liked"  # pseudo playlist id for the user's Liked Songs
PAGE_LIMIT = 50
CACHE_TTL_S = 120  # library reads; now-playing is never cached


class SpotifyNotConnectedError(Exception):
    """No saved tokens yet: open /spotify/login first."""


class SpotifyAPIError(Exception):
    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


# --------------------------------------------------------------------------- mode


def mode() -> str:
    """'mock' (no credentials), 'not_connected' (credentials, no login yet) or 'live'."""
    if not get_settings().spotify_enabled:
        return "mock"
    return "live" if load_tokens() is not None else "not_connected"


# --------------------------------------------------------------------------- OAuth

_pending_states: set[str] = set()


def authorization_url() -> str:
    s = get_settings()
    state = secrets.token_urlsafe(12)
    _pending_states.add(state)
    params = {
        "response_type": "code",
        "client_id": s.spotify_client_id,
        "redirect_uri": s.spotify_redirect_uri,
        "scope": SCOPES,
        "state": state,
    }
    return f"{AUTH_URL}?{urlencode(params)}"


def consume_state(state: str) -> bool:
    if state in _pending_states:
        _pending_states.discard(state)
        return True
    return False


def _token_path() -> Path:
    return Path(get_settings().spotify_token_file)


def load_tokens() -> dict | None:
    path = _token_path()
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:
        return None


def save_tokens(tokens: dict) -> dict:
    tokens = dict(tokens)
    tokens["expires_at"] = time.time() + int(tokens.get("expires_in", 3600)) - 60
    path = _token_path()
    path.write_text(json.dumps(tokens, indent=2))
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return tokens


def _token_request(data: dict) -> dict:
    s = get_settings()
    basic = base64.b64encode(f"{s.spotify_client_id}:{s.spotify_client_secret}".encode()).decode()
    r = httpx.post(TOKEN_URL, data=data, headers={"Authorization": f"Basic {basic}"}, timeout=20)
    if r.status_code != 200:
        raise SpotifyAPIError(f"Spotify token request failed ({r.status_code}): {r.text[:300]}")
    return r.json()


def exchange_code(code: str) -> dict:
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": get_settings().spotify_redirect_uri,
    }
    _cache.clear()
    return save_tokens(_token_request(data))


def _refresh(tokens: dict) -> dict:
    if not tokens.get("refresh_token"):
        raise SpotifyNotConnectedError("Spotify session expired. Open /spotify/login on the laptop again.")
    new = _token_request({"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"]})
    new.setdefault("refresh_token", tokens["refresh_token"])  # Spotify doesn't always rotate it
    return save_tokens(new)


def _access_token(force_refresh: bool = False) -> str:
    tokens = load_tokens()
    if tokens is None:
        raise SpotifyNotConnectedError(
            "Spotify not connected yet. Open http://127.0.0.1:8000/spotify/login on the laptop "
            "running the backend."
        )
    if force_refresh or time.time() >= tokens.get("expires_at", 0):
        tokens = _refresh(tokens)
    return tokens["access_token"]


# --------------------------------------------------------------------------- HTTP

_cache: dict[tuple, tuple[float, Any]] = {}


def _error_message(r: httpx.Response) -> str:
    try:
        err = r.json().get("error") or {}
    except ValueError:
        err = {}
    if isinstance(err, str):  # some endpoints return {"error": "...", "error_description": "..."}
        err = {"message": err}
    msg = err.get("message") or r.text[:300] or r.reason_phrase
    reason = err.get("reason") or ""
    if reason == "PREMIUM_REQUIRED" or "premium" in msg.lower():
        return "Spotify Premium is required to control playback (play, queue, skip)."
    if reason == "NO_ACTIVE_DEVICE" or "no active device" in msg.lower():
        return "No active Spotify device. Open Spotify on your phone, play any song, then try again."
    if r.status_code == 403 and "not registered" in msg.lower():
        return (
            "This Spotify account isn't on the app's allowlist. Add it under User Management in the "
            "Spotify Developer Dashboard (development mode allows 5 users)."
        )
    return f"Spotify error ({r.status_code}): {msg}"


def _request(method: str, path: str, params: dict | None = None, body: dict | None = None) -> Any:
    force_refresh = False
    for attempt in range(4):
        token = _access_token(force_refresh=force_refresh)
        r = httpx.request(
            method,
            f"{API_BASE}{path}",
            params=params,
            json=body,
            headers={"Authorization": f"Bearer {token}"},
            timeout=20,
        )
        if r.status_code in (200, 201):
            return r.json() if r.content else None
        if r.status_code in (202, 204):
            return None
        if r.status_code == 401 and not force_refresh:
            force_refresh = True
            continue
        if r.status_code == 429:
            try:
                wait = float(r.headers.get("Retry-After", 2**attempt))
            except ValueError:
                wait = 2**attempt
            if wait > 10:
                raise SpotifyAPIError("Spotify rate limit hit. Try again in a minute.", 429)
            time.sleep(wait)
            continue
        status = r.status_code if r.status_code in (400, 403, 404) else 502
        raise SpotifyAPIError(_error_message(r), status)
    raise SpotifyAPIError(f"{method} {path} failed after retries")


def _cached(key: tuple, fn):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_TTL_S:
        return hit[1]
    data = fn()
    _cache[key] = (time.time(), data)
    return data


# --------------------------------------------------------------------------- normalized shapes


def normalize_track(t: dict | None) -> dict | None:
    """Skip podcast episodes and local files (no Spotify id, no tempo lookup possible)."""
    if not t or t.get("type", "track") != "track" or not t.get("id") or t.get("is_local"):
        return None
    album = t.get("album") or {}
    images = album.get("images") or []
    return {
        "id": t["id"],
        "uri": t.get("uri") or f"spotify:track:{t['id']}",
        "name": t.get("name") or "",
        "artists": [a.get("name", "") for a in t.get("artists") or []],
        "album": album.get("name"),
        "image": images[0]["url"] if images else None,
        "duration_ms": t.get("duration_ms"),
    }


def _normalize_playlist(p: dict) -> dict:
    images = p.get("images") or []
    # Feb 2026 Web API rename: playlist "tracks" -> "items" (accept both).
    contents = p.get("items") if isinstance(p.get("items"), dict) else p.get("tracks") or {}
    return {
        "id": p["id"],
        "name": p.get("name") or "",
        "image": images[0]["url"] if images else None,
        "owner": (p.get("owner") or {}).get("display_name"),
        "track_count": contents.get("total"),
    }


# --------------------------------------------------------------------------- reads (live or mock)


def current_playback() -> dict | None:
    """What's playing right now, or None if nothing is."""
    if mode() == "mock":
        return _mock_current()
    data = _request("GET", "/me/player/currently-playing", params={"additional_types": "track"})
    if not data:
        return None
    return {
        "is_playing": bool(data.get("is_playing")),
        "progress_ms": data.get("progress_ms"),
        "track": normalize_track(data.get("item")),
    }


def playlists() -> list[dict]:
    """Liked Songs first, then the user's playlists."""
    if mode() == "mock":
        return [dict(p) for p in _MOCK_PLAYLISTS]

    def fetch() -> list[dict]:
        page = _request("GET", "/me/playlists", params={"limit": PAGE_LIMIT}) or {}
        rows = [_normalize_playlist(p) for p in page.get("items") or [] if p and p.get("id")]
        liked = _request("GET", "/me/tracks", params={"limit": 1}) or {}
        head = {
            "id": LIKED,
            "name": "Liked Songs",
            "image": None,
            "owner": None,
            "track_count": liked.get("total"),
        }
        return [head, *rows]

    return _cached(("playlists",), fetch)


def playlist_tracks(playlist_id: str = LIKED, limit: int = 200) -> list[dict]:
    """Tracks of a playlist (or Liked Songs). Spotify only returns contents of playlists the user
    owns or collaborates on for development-mode apps."""
    if mode() == "mock":
        return _mock_playlist_tracks(playlist_id)[:limit]

    path = "/me/tracks" if playlist_id == LIKED else f"/playlists/{playlist_id}/items"

    def fetch() -> list[dict]:
        out: list[dict] = []
        offset = 0
        while len(out) < limit:
            page = _request("GET", path, params={"limit": PAGE_LIMIT, "offset": offset}) or {}
            entries = page.get("items") or []
            for e in entries:
                # Feb 2026 rename: playlist entry "track" -> "item" (accept both).
                t = normalize_track((e or {}).get("item") or (e or {}).get("track"))
                if t:
                    out.append(t)
            offset += PAGE_LIMIT
            if not page.get("next") or not entries:
                break
        return out[:limit]

    return _cached(("tracks", playlist_id, limit), fetch)


# --------------------------------------------------------------------------- playback control


def play(
    uris: list[str] | None = None, context_uri: str | None = None, offset_uri: str | None = None
) -> None:
    """Start specific tracks, a playlist (optionally at a track), or resume if nothing given."""
    if mode() == "mock":
        return _mock_play(uris, context_uri, offset_uri)
    body: dict[str, Any] = {}
    if uris:
        body["uris"] = uris
    if context_uri:
        body["context_uri"] = context_uri
        if offset_uri:
            body["offset"] = {"uri": offset_uri}
    _request("PUT", "/me/player/play", body=body or None)


def pause() -> None:
    if mode() == "mock":
        return _mock_pause()
    _request("PUT", "/me/player/pause")


def next_track() -> None:
    if mode() == "mock":
        return _mock_next()
    _request("POST", "/me/player/next")


def queue(uri: str) -> None:
    if mode() == "mock":
        return _mock_queue(uri)
    _request("POST", "/me/player/queue", params={"uri": uri})


# ------------------------------------------------------------------- mock library + player

_MOCK_SONGS = [  # (name, artist, tempo bpm)
    ("Slow Burn Sunday", "Low Tide", 72),
    ("Porch Light", "Maple & Rye", 78),
    ("Cooldown Coast", "Low Tide", 84),
    ("Paper Planes Home", "The Quiet Hours", 88),
    ("Easy Mile", "Saltwater Static", 92),
    ("Golden Hour Jog", "Maple & Rye", 98),
    ("City Loop", "Neon Avenue", 104),
    ("Second Wind", "The Pacers", 110),
    ("Riverside", "Saltwater Static", 116),
    ("Lift Off", "Neon Avenue", 122),
    ("Heartline", "Kite Theory", 128),
    ("Steady State", "The Pacers", 132),
    ("Uphill Anthem", "Kite Theory", 138),
    ("Tempo Tuesday", "The Pacers", 144),
    ("Breakaway", "Neon Avenue", 150),
    ("Red Line", "Volt Parade", 156),
    ("Fast Feet", "Kite Theory", 160),
    ("Negative Split", "The Pacers", 164),
    ("Runner's High", "Volt Parade", 168),
    ("Last Interval", "Neon Avenue", 172),
    ("Finish Kick", "Volt Parade", 176),
    ("Sprint Lights", "Kite Theory", 182),
]
MOCK_TRACKS = [
    {
        "id": f"mock-{i:02d}",
        "uri": f"spotify:track:mock-{i:02d}",
        "name": name,
        "artists": [artist],
        "album": "Mock Mixtape",
        "image": None,
        "duration_ms": (150 + (i * 37) % 90) * 1000,
    }
    for i, (name, artist, _) in enumerate(_MOCK_SONGS)
]
_MOCK_TEMPO = {t["id"]: float(bpm) for t, (_, _, bpm) in zip(MOCK_TRACKS, _MOCK_SONGS, strict=True)}
_MOCK_BY_ID = {t["id"]: i for i, t in enumerate(MOCK_TRACKS)}
_MOCK_PLAYLISTS = [
    {"id": LIKED, "name": "Liked Songs", "image": None, "owner": None, "track_count": len(MOCK_TRACKS)},
    {
        "id": "mock-easy",
        "name": "Easy Run",
        "image": None,
        "owner": "Mock Runner",
        "track_count": sum(1 for b in _MOCK_TEMPO.values() if b <= 125),
    },
    {
        "id": "mock-tempo",
        "name": "Tempo Day",
        "image": None,
        "owner": "Mock Runner",
        "track_count": sum(1 for b in _MOCK_TEMPO.values() if b >= 140),
    },
]


def mock_tempo(track_id: str) -> float | None:
    return _MOCK_TEMPO.get(track_id)


def _mock_playlist_tracks(playlist_id: str) -> list[dict]:
    if playlist_id == LIKED:
        keep = MOCK_TRACKS
    elif playlist_id == "mock-easy":
        keep = [t for t in MOCK_TRACKS if _MOCK_TEMPO[t["id"]] <= 125]
    elif playlist_id == "mock-tempo":
        keep = [t for t in MOCK_TRACKS if _MOCK_TEMPO[t["id"]] >= 140]
    else:
        raise SpotifyAPIError(f"Unknown playlist {playlist_id!r}", 404)
    return [dict(t) for t in keep]


_mock = {"index": 10, "started_at": time.time(), "paused_ms": None, "queue": []}


def mock_reset() -> None:
    _mock.update(index=10, started_at=time.time(), paused_ms=None, queue=[])


def _mock_progress_ms() -> int:
    if _mock["paused_ms"] is not None:
        return _mock["paused_ms"]
    return int((time.time() - _mock["started_at"]) * 1000)


def _mock_start(index: int, at_ms: int = 0) -> None:
    _mock.update(index=index, started_at=time.time() - at_ms / 1000, paused_ms=None)


def _mock_advance(carry_ms: int = 0) -> None:
    nxt = _MOCK_BY_ID[_mock["queue"].pop(0)] if _mock["queue"] else (_mock["index"] + 1) % len(MOCK_TRACKS)
    _mock_start(nxt, carry_ms)


def _mock_current() -> dict:
    for _ in range(50):  # catch up if several songs ended while nobody was polling
        progress = _mock_progress_ms()
        duration = MOCK_TRACKS[_mock["index"]]["duration_ms"]
        if _mock["paused_ms"] is not None or progress < duration:
            break
        _mock_advance(progress - duration)
    return {
        "is_playing": _mock["paused_ms"] is None,
        "progress_ms": _mock_progress_ms(),
        "track": dict(MOCK_TRACKS[_mock["index"]]),
    }


def _mock_index(uri: str) -> int:
    track_id = uri.rsplit(":", 1)[-1]
    if track_id not in _MOCK_BY_ID:
        raise SpotifyAPIError(f"Unknown track {uri!r}", 400)
    return _MOCK_BY_ID[track_id]


def _mock_play(uris: list[str] | None, context_uri: str | None, offset_uri: str | None) -> None:
    if uris:
        _mock_start(_mock_index(uris[0]))
    elif context_uri:
        tracks = _mock_playlist_tracks(context_uri.rsplit(":", 1)[-1])
        _mock_start(_mock_index(offset_uri) if offset_uri else _MOCK_BY_ID[tracks[0]["id"]])
    elif _mock["paused_ms"] is not None:
        _mock_start(_mock["index"], _mock["paused_ms"])


def _mock_pause() -> None:
    if _mock["paused_ms"] is None:
        _mock["paused_ms"] = _mock_progress_ms()


def _mock_next() -> None:
    _mock_current()
    _mock_advance()


def _mock_queue(uri: str) -> None:
    _mock_index(uri)  # validate
    _mock["queue"].append(uri.rsplit(":", 1)[-1])
