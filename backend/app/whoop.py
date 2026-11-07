"""WHOOP Developer API v2 client.

- OAuth 2.0 (authorization code + rotating refresh token), one login per user.
  The default user (laptop login, scripts) saves to WHOOP_TOKEN_FILE (backend/.whoop_tokens.json);
  app users (identified by the X-User-Id header) save to .whoop_tokens.<user>.json. All gitignored.
  With DATABASE_URL set (cloud), tokens go to Postgres instead (app/token_store.py).
- Paginated reads for workouts, cycles (incl. step_count), recovery and body measurements.
- Mock mode: with WHOOP_CLIENT_ID / WHOOP_CLIENT_SECRET blank, every read returns realistic
  sample data in the same shape, so teammates can build without a WHOOP account.

The WHOOP API only has summaries (per workout and per cycle), never live readings.
Live heart rate comes from the band's Heart Rate Broadcast over Bluetooth instead:
see scripts/whoop_live_hr.py and routes/live.py.
"""

from __future__ import annotations

import random
import re
import secrets
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import httpx

from app import token_store
from app.config import get_settings

AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth"
TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token"
API_BASE = "https://api.prod.whoop.com/developer"
SCOPES = "offline read:profile read:workout read:cycles read:recovery read:sleep read:body_measurement"
USER_AGENT = "BPM-hackathon/0.1"  # WHOOP rejects browser-like user agents on its OAuth endpoints
PAGE_LIMIT = 25  # WHOOP's max page size
CACHE_TTL_S = 120  # avoid hammering WHOOP (100 req/min limit) when the app polls
RUNNING_SPORT_IDS = {0}  # WHOOP sport_id 0 = Running
DEFAULT_USER = "default"  # laptop login + scripts; app users send their own id
_USER_ID_RE = re.compile(r"^[A-Za-z0-9-]{8,64}$")
# Where the backend may send the user after login: the app (dev build) or Expo Go.
ALLOWED_RETURN_PREFIXES = ("bpm://", "exp://", "exps://")


def valid_user_id(user: str | None) -> str:
    """Normalize a user id from the app; anything missing or malformed is the default user."""
    return user if user and _USER_ID_RE.match(user) else DEFAULT_USER


def valid_return_to(url: str | None) -> str | None:
    """Only allow redirecting back into the app (prevents an open redirect)."""
    return url if url and url.startswith(ALLOWED_RETURN_PREFIXES) else None


class WhoopNotConnectedError(Exception):
    """No saved tokens yet: open /whoop/login first."""


class WhoopAPIError(Exception):
    pass


# --------------------------------------------------------------------------- mode


def mode(user: str = DEFAULT_USER) -> str:
    """'mock' (no credentials), 'not_connected' (credentials, no login yet) or 'live'."""
    if not get_settings().whoop_enabled:
        return "mock"
    return "live" if login_owner(user) is not None else "not_connected"


def login_owner(user: str = DEFAULT_USER) -> str | None:
    """Whose WHOOP login serves this user: their own, else the shared laptop ("default") login."""
    if load_tokens(user) is not None:
        return user
    if user != DEFAULT_USER and load_tokens(DEFAULT_USER) is not None:
        return DEFAULT_USER
    return None


# --------------------------------------------------------------------------- OAuth

_pending_states: dict[str, dict] = {}  # state -> {"user", "return_to", "at"}
STATE_TTL_S = 900


def authorization_url(user: str = DEFAULT_USER, return_to: str | None = None) -> str:
    s = get_settings()
    now = time.time()
    for old in [k for k, v in _pending_states.items() if now - v["at"] > STATE_TTL_S]:
        _pending_states.pop(old, None)
    state = secrets.token_hex(4)  # WHOOP wants an 8-character state
    _pending_states[state] = {"user": user, "return_to": valid_return_to(return_to), "at": now}
    params = {
        "response_type": "code",
        "client_id": s.whoop_client_id,
        "redirect_uri": s.whoop_redirect_uri,
        "scope": SCOPES,
        "state": state,
    }
    return f"{AUTH_URL}?{urlencode(params)}"


def consume_state(state: str) -> dict | None:
    """Returns {"user", "return_to"} for a state we issued, once; None otherwise."""
    return _pending_states.pop(state, None)


def _token_path(user: str = DEFAULT_USER) -> Path:
    base = Path(get_settings().whoop_token_file)
    if user == DEFAULT_USER:
        return base
    return base.with_name(f"{base.stem}.{valid_user_id(user)}{base.suffix}")


def load_tokens(user: str = DEFAULT_USER) -> dict | None:
    return token_store.load(f"whoop:{valid_user_id(user)}", _token_path(user))


def save_tokens(tokens: dict, user: str = DEFAULT_USER) -> dict:
    tokens = dict(tokens)
    tokens["expires_at"] = time.time() + int(tokens.get("expires_in", 3600)) - 60
    token_store.save(f"whoop:{valid_user_id(user)}", _token_path(user), tokens)
    return tokens


def _token_request(data: dict) -> dict:
    s = get_settings()
    payload = {"client_id": s.whoop_client_id, "client_secret": s.whoop_client_secret, **data}
    r = httpx.post(TOKEN_URL, data=payload, headers={"User-Agent": USER_AGENT}, timeout=20)
    if r.status_code != 200:
        raise WhoopAPIError(f"WHOOP token request failed ({r.status_code}): {r.text[:300]}")
    return r.json()


def exchange_code(code: str, user: str = DEFAULT_USER) -> dict:
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": get_settings().whoop_redirect_uri,
    }
    _clear_cache(user)
    return save_tokens(_token_request(data), user)


def disconnect(user: str = DEFAULT_USER) -> None:
    """Forget this user's WHOOP login."""
    token_store.delete(f"whoop:{valid_user_id(user)}", _token_path(user))
    _clear_cache(user)


def _refresh(tokens: dict, user: str = DEFAULT_USER) -> dict:
    if not tokens.get("refresh_token"):
        raise WhoopNotConnectedError("WHOOP session expired. Connect WHOOP again.")
    new = _token_request(
        {"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"], "scope": "offline"}
    )
    new.setdefault("refresh_token", tokens["refresh_token"])
    return save_tokens(new, user)


def _access_token(force_refresh: bool = False, user: str = DEFAULT_USER) -> str:
    owner = login_owner(user)
    tokens = load_tokens(owner) if owner else None
    if owner is None or tokens is None:
        raise WhoopNotConnectedError(
            "WHOOP not connected yet. Tap Connect WHOOP in the app, or open /whoop/login on the "
            "laptop running the backend."
        )
    if force_refresh or time.time() >= tokens.get("expires_at", 0):
        tokens = _refresh(tokens, owner)  # refresh tokens rotate: always save to the owner's file
    return tokens["access_token"]


# --------------------------------------------------------------------------- HTTP

_cache: dict[tuple, tuple[float, Any]] = {}  # key starts with the user id


def _clear_cache(user: str) -> None:
    for key in [k for k in _cache if k[0] == user]:
        _cache.pop(key, None)


def _get(path: str, params: dict | None = None, user: str = DEFAULT_USER) -> dict:
    force_refresh = False
    for attempt in range(4):
        token = _access_token(force_refresh=force_refresh, user=user)
        r = httpx.get(
            f"{API_BASE}{path}",
            params=params,
            headers={"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT},
            timeout=20,
        )
        if r.status_code == 200:
            return r.json()
        if r.status_code == 401 and not force_refresh:
            force_refresh = True
            continue
        if r.status_code == 429:
            try:
                wait = float(r.headers.get("Retry-After", 2**attempt))
            except ValueError:
                wait = 2**attempt
            time.sleep(min(wait, 10))
            continue
        raise WhoopAPIError(f"GET {path} failed ({r.status_code}): {r.text[:300]}")
    raise WhoopAPIError(f"GET {path} failed after retries")


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _collect(path: str, days: int, max_records: int = 1000, user: str = DEFAULT_USER) -> list[dict]:
    key = (user, path, days)
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_TTL_S:
        return hit[1]

    end = datetime.now(UTC)
    params: dict[str, Any] = {
        "start": _iso(end - timedelta(days=days)),
        "end": _iso(end),
        "limit": PAGE_LIMIT,
    }
    records: list[dict] = []
    while True:
        page = _get(path, params, user)
        records.extend(page.get("records", []))
        next_token = page.get("next_token")
        if not next_token or len(records) >= max_records:
            break
        params["nextToken"] = next_token

    records = records[:max_records]
    _cache[key] = (time.time(), records)
    return records


def _single(path: str, user: str = DEFAULT_USER) -> dict:
    key = (user, path, None)
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_TTL_S:
        return hit[1]
    data = _get(path, user=user)
    _cache[key] = (time.time(), data)
    return data


# --------------------------------------------------------------------------- raw reads (live or mock)


def get_workouts(days: int = 30, user: str = DEFAULT_USER) -> list[dict]:
    if mode(user) == "mock":
        return _mock_workouts(days)
    return _collect("/v2/activity/workout", days, user=user)


def get_cycles(days: int = 30, user: str = DEFAULT_USER) -> list[dict]:
    return _mock_cycles(days) if mode(user) == "mock" else _collect("/v2/cycle", days, user=user)


def get_recovery(days: int = 30, user: str = DEFAULT_USER) -> list[dict]:
    return _mock_recovery(days) if mode(user) == "mock" else _collect("/v2/recovery", days, user=user)


def get_body(user: str = DEFAULT_USER) -> dict:
    return _mock_body() if mode(user) == "mock" else _single("/v2/user/measurement/body", user)


def get_profile(user: str = DEFAULT_USER) -> dict:
    if mode(user) == "mock":
        return {"user_id": 0, "first_name": "Mock", "last_name": "Runner", "email": "mock@example.com"}
    return _single("/v2/user/profile/basic", user)


# --------------------------------------------------------------------------- normalized views


def _parse(ts: str | None) -> datetime | None:
    return datetime.fromisoformat(ts) if ts else None


def is_run(workout: dict) -> bool:
    name = (workout.get("sport_name") or "").lower()
    return "run" in name or workout.get("sport_id") in RUNNING_SPORT_IDS


def normalize_workout(w: dict) -> dict:
    score = w.get("score") or {}
    start, end = _parse(w.get("start")), _parse(w.get("end"))
    duration_s = (end - start).total_seconds() if start and end else None
    dist_m = score.get("distance_meter")
    pace = duration_s / 60 / (dist_m / 1000) if duration_s and dist_m else None
    zones = score.get("zone_durations") or {}
    return {
        "id": w.get("id"),
        "sport": w.get("sport_name") or str(w.get("sport_id")),
        "is_run": is_run(w),
        "start": w.get("start"),
        "end": w.get("end"),
        "duration_min": round(duration_s / 60, 1) if duration_s else None,
        "avg_hr": score.get("average_heart_rate"),
        "max_hr": score.get("max_heart_rate"),
        "strain": score.get("strain"),
        "distance_km": round(dist_m / 1000, 2) if dist_m else None,
        "pace_min_per_km": round(pace, 2) if pace else None,
        "zone_minutes": {
            k.removeprefix("zone_").removesuffix("_milli"): round(v / 60000, 1)
            for k, v in zones.items()
            if v is not None
        },
        "score_state": w.get("score_state"),
    }


def normalize_cycle(c: dict) -> dict:
    score = c.get("score") or {}
    return {
        "id": c.get("id"),
        "start": c.get("start"),
        "end": c.get("end"),
        "strain": score.get("strain"),
        "avg_hr": score.get("average_heart_rate"),
        "max_hr": score.get("max_heart_rate"),
        "step_count": c.get("step_count", score.get("step_count")),
    }


def normalize_recovery(r: dict) -> dict:
    score = r.get("score") or {}
    return {
        "cycle_id": r.get("cycle_id"),
        "created_at": r.get("created_at"),
        "recovery_score": score.get("recovery_score"),
        "resting_hr": score.get("resting_heart_rate"),
        "hrv_ms": score.get("hrv_rmssd_milli"),
        "spo2": score.get("spo2_percentage"),
        "skin_temp_c": score.get("skin_temp_celsius"),
    }


def hr_zones(max_hr: float | None, resting_hr: float | None) -> list[dict]:
    """5 training zones. Uses heart rate reserve (Karvonen) when resting HR is known."""
    if not max_hr:
        return []
    bounds = [(0.5, 0.6), (0.6, 0.7), (0.7, 0.8), (0.8, 0.9), (0.9, 1.0)]

    def bpm(p: float) -> int:
        return round(resting_hr + p * (max_hr - resting_hr)) if resting_hr else round(p * max_hr)

    return [{"zone": i + 1, "min_bpm": bpm(lo), "max_bpm": bpm(hi)} for i, (lo, hi) in enumerate(bounds)]


def _avg(values: list) -> float | None:
    vals = [v for v in values if v]
    return round(sum(vals) / len(vals), 1) if vals else None


def summary(days: int = 30, user: str = DEFAULT_USER) -> dict:
    """Everything the music engine needs to personalize targets, in one call."""
    body = get_body(user)
    recoveries = sorted(
        (normalize_recovery(r) for r in get_recovery(days, user)),
        key=lambda r: r["created_at"] or "",
        reverse=True,
    )
    latest_rec = next((r for r in recoveries if r["resting_hr"]), {})
    workouts = [normalize_workout(w) for w in get_workouts(days, user)]
    runs = sorted((w for w in workouts if w["is_run"]), key=lambda w: w["start"] or "", reverse=True)
    cycles = sorted(
        (normalize_cycle(c) for c in get_cycles(days, user)), key=lambda c: c["start"] or "", reverse=True
    )

    max_hr = body.get("max_heart_rate")
    resting_hr = latest_rec.get("resting_hr")
    return {
        "mode": mode(user),
        "days": days,
        "max_hr": max_hr,
        "resting_hr": resting_hr,
        "hrv_ms": latest_rec.get("hrv_ms"),
        "recovery_score": latest_rec.get("recovery_score"),
        "zone_method": "heart_rate_reserve" if resting_hr else "percent_of_max",
        "hr_zones": hr_zones(max_hr, resting_hr),
        "run_count": len(runs),
        "avg_run_hr": _avg([r["avg_hr"] for r in runs]),
        "avg_run_pace_min_per_km": _avg([r["pace_min_per_km"] for r in runs]),
        "steps_current_cycle": cycles[0]["step_count"] if cycles else None,
        "recent_runs": runs[:10],
    }


# ------------------------------------------------------------------- mock data (same shape as WHOOP v2)


def _mock_workouts(days: int) -> list[dict]:
    rng = random.Random(7)
    today = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    names = ["zero", "one", "two", "three", "four", "five"]
    split = [0.02, 0.08, 0.20, 0.40, 0.25, 0.05]
    out = []
    for d in range(1, days + 1):
        if d % 2:
            continue
        run = d % 6 != 0
        start = today - timedelta(days=d) + timedelta(hours=11, minutes=rng.randint(0, 600))
        dist_km = rng.uniform(4, 10) if run else rng.uniform(15, 30)
        dur_min = dist_km * (rng.uniform(4.6, 6.2) if run else rng.uniform(2.0, 3.0))
        avg_hr = rng.randint(138, 168)
        total_ms = dur_min * 60000
        out.append(
            {
                "id": f"mock-workout-{d}",
                "sport_id": 0 if run else 1,
                "sport_name": "running" if run else "cycling",
                "start": _iso(start),
                "end": _iso(start + timedelta(minutes=dur_min)),
                "timezone_offset": "-05:00",
                "score_state": "SCORED",
                "score": {
                    "strain": round(rng.uniform(8, 15), 1),
                    "average_heart_rate": avg_hr,
                    "max_heart_rate": avg_hr + rng.randint(10, 25),
                    "kilojoule": round(dur_min * 45, 1),
                    "percent_recorded": 100.0,
                    "distance_meter": round(dist_km * 1000, 1),
                    "altitude_gain_meter": round(rng.uniform(10, 80), 1),
                    "altitude_change_meter": round(rng.uniform(-5, 5), 1),
                    "zone_durations": {
                        f"zone_{n}_milli": int(total_ms * p) for n, p in zip(names, split, strict=True)
                    },
                },
            }
        )
    return out


def _mock_cycles(days: int) -> list[dict]:
    rng = random.Random(11)
    today = datetime.now(UTC).replace(hour=4, minute=0, second=0, microsecond=0)
    out = []
    for d in range(days):
        start = today - timedelta(days=d)
        out.append(
            {
                "id": 1000 + d,
                "start": _iso(start),
                "end": None if d == 0 else _iso(start + timedelta(days=1)),
                "timezone_offset": "-05:00",
                "score_state": "SCORED",
                "score": {
                    "strain": round(rng.uniform(6, 17), 1),
                    "kilojoule": round(rng.uniform(8000, 14000), 1),
                    "average_heart_rate": rng.randint(62, 78),
                    "max_heart_rate": rng.randint(150, 190),
                },
                "step_count": rng.randint(6000, 15000),
            }
        )
    return out


def _mock_recovery(days: int) -> list[dict]:
    rng = random.Random(13)
    today = datetime.now(UTC).replace(hour=11, minute=0, second=0, microsecond=0)
    return [
        {
            "cycle_id": 1000 + d,
            "sleep_id": f"mock-sleep-{d}",
            "created_at": _iso(today - timedelta(days=d)),
            "score_state": "SCORED",
            "score": {
                "recovery_score": rng.randint(35, 95),
                "resting_heart_rate": rng.randint(48, 56),
                "hrv_rmssd_milli": round(rng.uniform(55, 90), 1),
                "spo2_percentage": round(rng.uniform(95, 99), 1),
                "skin_temp_celsius": round(rng.uniform(33, 34.5), 1),
            },
        }
        for d in range(days)
    ]


def _mock_body() -> dict:
    return {"height_meter": 1.83, "weight_kilogram": 77.0, "max_heart_rate": 197}
