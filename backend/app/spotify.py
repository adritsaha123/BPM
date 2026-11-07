"""Spotify Web API client: sign-in, playlists, liked songs, now playing, playback control.

- OAuth 2.0 authorization code flow; the backend keeps the client secret. One login per app user
  (X-User-Id header), like WHOOP; users who haven't connected fall back to the shared laptop login.
  Tokens go to Postgres when DATABASE_URL is set, else to SPOTIFY_TOKEN_FILE
  (backend/.spotify_tokens[.<user>].json, gitignored). They refresh automatically.
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
import secrets
import time
from contextvars import ContextVar
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import httpx

from app import token_store
from app.config import get_settings
from app.whoop import DEFAULT_USER, valid_return_to, valid_user_id

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


# --------------------------------------------------------------------------- user + mode

# Whose Spotify login a request uses. routes/spotify.py sets it per request from the X-User-Id
# header (an async dependency, so sync endpoints running in the threadpool see it too).
_user: ContextVar[str] = ContextVar("spotify_user", default=DEFAULT_USER)


def use_user(user: str | None) -> None:
    _user.set(valid_user_id(user))


def current_user() -> str:
    return _user.get()


def login_owner(user: str | None = None) -> str | None:
    """Whose Spotify login serves this user: their own, else the shared laptop ("default") login."""
    user = user or current_user()
    if load_tokens(user) is not None:
        return user
    if user != DEFAULT_USER and load_tokens(DEFAULT_USER) is not None:
        return DEFAULT_USER
    return None


def mode(user: str | None = None) -> str:
    """'mock' (no credentials), 'not_connected' (credentials, no login yet) or 'live'."""
    if not get_settings().spotify_enabled:
        return "mock"
    return "live" if login_owner(user) is not None else "not_connected"


# --------------------------------------------------------------------------- OAuth

_pending_states: dict[str, dict] = {}  # state -> {"user", "return_to", "at"}
STATE_TTL_S = 900


def authorization_url(user: str = DEFAULT_USER, return_to: str | None = None) -> str:
    s = get_settings()
    now = time.time()
    for old in [k for k, v in _pending_states.items() if now - v["at"] > STATE_TTL_S]:
        _pending_states.pop(old, None)
    state = secrets.token_urlsafe(12)
    _pending_states[state] = {"user": valid_user_id(user), "return_to": valid_return_to(return_to), "at": now}
    params = {
        "response_type": "code",
        "client_id": s.spotify_client_id,
        "redirect_uri": s.spotify_redirect_uri,
        "scope": SCOPES,
        "state": state,
        "show_dialog": "true",  # let each person pick their own account on a shared phone/browser
    }
    return f"{AUTH_URL}?{urlencode(params)}"


def consume_state(state: str) -> dict | None:
    """Returns {"user", "return_to"} for a state we issued, once; None otherwise."""
    return _pending_states.pop(state, None)


def _token_path(user: str = DEFAULT_USER) -> Path:
    base = Path(get_settings().spotify_token_file)
    if user == DEFAULT_USER:
        return base
    return base.with_name(f"{base.stem}.{valid_user_id(user)}{base.suffix}")


def load_tokens(user: str | None = None) -> dict | None:
    user = valid_user_id(user or current_user())
    return token_store.load(f"spotify:{user}", _token_path(user))


def save_tokens(tokens: dict, user: str | None = None) -> dict:
    user = valid_user_id(user or current_user())
    tokens = dict(tokens)
    tokens["expires_at"] = time.time() + int(tokens.get("expires_in", 3600)) - 60
    token_store.save(f"spotify:{user}", _token_path(user), tokens)
    return tokens


def disconnect(user: str | None = None) -> None:
    """Forget this user's Spotify login."""
    user = valid_user_id(user or current_user())
    token_store.delete(f"spotify:{user}", _token_path(user))
    _clear_cache(user)


def _token_request(data: dict) -> dict:
    s = get_settings()
    basic = base64.b64encode(f"{s.spotify_client_id}:{s.spotify_client_secret}".encode()).decode()
    r = httpx.post(TOKEN_URL, data=data, headers={"Authorization": f"Basic {basic}"}, timeout=20)
    if r.status_code != 200:
        raise SpotifyAPIError(f"Spotify token request failed ({r.status_code}): {r.text[:300]}")
    return r.json()


def exchange_code(code: str, user: str | None = None) -> dict:
    user = valid_user_id(user or current_user())
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": get_settings().spotify_redirect_uri,
    }
    _clear_cache(user)
    return save_tokens(_token_request(data), user)


def _refresh(tokens: dict, owner: str) -> dict:
    if not tokens.get("refresh_token"):
        raise SpotifyNotConnectedError("Spotify session expired. Connect Spotify again in the app.")
    new = _token_request({"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"]})
    new.setdefault("refresh_token", tokens["refresh_token"])  # Spotify doesn't always rotate it
    return save_tokens(new, owner)


def _access_token(force_refresh: bool = False) -> str:
    owner = login_owner()
    tokens = load_tokens(owner) if owner else None
    if owner is None or tokens is None:
        raise SpotifyNotConnectedError("Spotify not connected yet. Tap Connect Spotify in the app.")
    if force_refresh or time.time() >= tokens.get("expires_at", 0):
        tokens = _refresh(tokens, owner)
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
            try:
                return r.json() if r.content else None
            except ValueError:  # e.g. POST /me/player/queue answers 200 with a non-JSON body
                return None
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


def _clear_cache(user: str) -> None:
    for key in [k for k in _cache if k[0] == user]:
        _cache.pop(key, None)


def _cached(key: tuple, fn):
    key = (login_owner() or current_user(), *key)  # each Spotify account has its own library
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
    if uris and len(uris) == 1 and not context_uri and _is_playing():
        # Spotify on iOS, running in the background, often stalls on "play this track"
        # (ends up paused with nothing loaded, then iOS suspends it). Queue + skip keeps the
        # audio going, so use that whenever something is already playing.
        queue(uris[0])
        next_track()
        return
    body: dict[str, Any] = {}
    if uris:
        body["uris"] = uris
    if context_uri:
        body["context_uri"] = context_uri
        if offset_uri:
            body["offset"] = {"uri": offset_uri}
    _with_device_fallback(lambda params: _request("PUT", "/me/player/play", params=params, body=body or None))


def _is_playing() -> bool:
    try:
        playback = current_playback()
    except SpotifyAPIError:
        return False
    return bool(playback and playback["is_playing"])


NO_DEVICE_MESSAGE = (
    "No active Spotify device. Open Spotify on your phone and play any song for a few seconds, "
    "then try again (iOS disconnects Spotify when it sits paused in the background)."
)


def _pick_device() -> str | None:
    """A device to target when Spotify says none is active: prefer a phone, skip restricted ones."""
    devices = [d for d in (_request("GET", "/me/player/devices") or {}).get("devices", []) if d.get("id")]
    usable = [d for d in devices if not d.get("is_restricted")]
    for d in usable:
        if d.get("is_active"):
            return d["id"]
    for d in usable:
        if d.get("type") == "Smartphone":
            return d["id"]
    return usable[0]["id"] if usable else None


def _with_device_fallback(call) -> None:
    """Run a playback call; on "no active device", retry it aimed at a specific device."""
    try:
        call(None)
        return
    except SpotifyAPIError as e:
        if "No active Spotify device" not in str(e):
            raise
    device_id = _pick_device()
    if not device_id:
        raise SpotifyAPIError(NO_DEVICE_MESSAGE, 404)
    try:
        call({"device_id": device_id})
    except SpotifyAPIError as e:
        if "No active Spotify device" in str(e):
            raise SpotifyAPIError(NO_DEVICE_MESSAGE, 404) from e
        raise


def pause() -> None:
    if mode() == "mock":
        return _mock_pause()
    _request("PUT", "/me/player/pause")


def next_track() -> None:
    if mode() == "mock":
        return _mock_next()
    _request("POST", "/me/player/next")


def volume() -> dict:
    """The active device volume. `supported` is False where Spotify refuses remote volume
    (usually Spotify on iPhone), so callers skip fades there."""
    if mode() == "mock":
        return {"percent": _mock["volume"], "supported": True}
    data = _request("GET", "/me/player") or {}
    device = data.get("device") or {}
    percent = device.get("volume_percent")
    return {"percent": percent, "supported": bool(device.get("supports_volume")) and percent is not None}


def set_volume(percent: int) -> None:
    if mode() == "mock":
        _mock["volume"] = percent
        return
    _request("PUT", "/me/player/volume", params={"volume_percent": max(0, min(100, int(percent)))})


def queue(uri: str) -> None:
    if mode() == "mock":
        return _mock_queue(uri)
    _with_device_fallback(
        lambda params: _request("POST", "/me/player/queue", params={"uri": uri, **(params or {})})
    )


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


def mock_features(track_id: str) -> dict | None:
    """Mock songs: energy rises with tempo, with some spread so energy matters when ranking."""
    bpm = _MOCK_TEMPO.get(track_id)
    if bpm is None:
        return None
    i = _MOCK_BY_ID[track_id]
    energy = min(0.95, max(0.15, 0.2 + (bpm - 72) / 110 * 0.65 + ((i * 7) % 5 - 2) * 0.06))
    return {"tempo": bpm, "energy": round(energy, 2), "danceability": round(0.5 + (i % 4) * 0.1, 2)}


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


_mock = {"index": 10, "started_at": time.time(), "paused_ms": None, "queue": [], "volume": 80}


def mock_reset() -> None:
    _mock.update(index=10, started_at=time.time(), paused_ms=None, queue=[], volume=80)


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
