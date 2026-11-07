"""WHOOP history: OAuth connect + workouts, cycles (steps), recovery, body, and a summary.

Connect once on the laptop running the backend: http://localhost:8000/whoop/login
With no WHOOP credentials in .env, every endpoint serves mock data (mode = "mock").
"""

from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import HTMLResponse, RedirectResponse

from app import whoop
from app.config import get_settings

router = APIRouter(prefix="/whoop", tags=["whoop"])

Days = Query(30, ge=1, le=365, description="How many days back to read")


def _call(fn: Callable[..., Any], *args: Any) -> Any:
    try:
        return fn(*args)
    except whoop.WhoopNotConnectedError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    except whoop.WhoopAPIError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/status")
def status() -> dict:
    return {"mode": whoop.mode(), "login_url": "/whoop/login"}


@router.get("/login")
def login() -> RedirectResponse:
    if not get_settings().whoop_enabled:
        raise HTTPException(
            status_code=400,
            detail="Set WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET in backend/.env, then restart the backend.",
        )
    return RedirectResponse(whoop.authorization_url())


@router.get("/callback", response_class=HTMLResponse)
def callback(
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    error_description: str | None = None,
) -> str:
    if error:
        detail = f"WHOOP returned an error: {error} {error_description or ''}"
        raise HTTPException(status_code=400, detail=detail)
    if not code or not state or not whoop.consume_state(state):
        detail = "Missing or unknown OAuth state. Start again at /whoop/login."
        raise HTTPException(status_code=400, detail=detail)
    _call(whoop.exchange_code, code)
    return (
        "<h2>WHOOP connected.</h2>"
        "<p>You can close this tab. Check <a href='/whoop/summary'>/whoop/summary</a>.</p>"
    )


@router.get("/profile")
def profile() -> dict:
    return _call(whoop.get_profile)


@router.get("/body")
def body() -> dict:
    """Height, weight and max heart rate."""
    return _call(whoop.get_body)


@router.get("/workouts")
def workouts(days: int = Days, runs_only: bool = False) -> list[dict]:
    """Per-workout avg/max HR, time in each HR zone, distance, pace, strain."""
    rows = [whoop.normalize_workout(w) for w in _call(whoop.get_workouts, days)]
    return [r for r in rows if r["is_run"]] if runs_only else rows


@router.get("/cycles")
def cycles(days: int = Days) -> list[dict]:
    """Per physiological cycle (roughly a day): strain, avg/max HR, step count."""
    return [whoop.normalize_cycle(c) for c in _call(whoop.get_cycles, days)]


@router.get("/recovery")
def recovery(days: int = Days) -> list[dict]:
    """Per cycle: recovery score, resting HR, HRV."""
    return [whoop.normalize_recovery(r) for r in _call(whoop.get_recovery, days)]


@router.get("/summary")
def summary(days: int = Days) -> dict:
    """Max HR, resting HR, 5 HR zones, recent runs with pace. One call for the app."""
    return _call(whoop.summary, days)
