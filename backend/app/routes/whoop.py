"""WHOOP history: OAuth connect + workouts, cycles (steps), recovery, body, and a summary.

Two ways to connect:
- In the app: "Connect WHOOP" opens /whoop/login?user=<id>&return_to=<app url> in an in-app browser.
  After approval the callback stores tokens for that user and redirects back into the app.
- On the laptop running the backend: http://localhost:8000/whoop/login (the "default" user).

Every endpoint reads the user from the X-User-Id header (or ?user=); none = the default user.
With no WHOOP credentials in .env, every endpoint serves mock data (mode = "mock").
"""

from collections.abc import Callable
from typing import Annotated, Any
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import HTMLResponse, RedirectResponse

from app import whoop
from app.config import get_settings

router = APIRouter(prefix="/whoop", tags=["whoop"])

Days = Query(30, ge=1, le=365, description="How many days back to read")


def current_user(
    x_user_id: Annotated[str | None, Header()] = None,
    user: Annotated[str | None, Query(description="App user id (alternative to X-User-Id)")] = None,
) -> str:
    return whoop.valid_user_id(x_user_id or user)


User = Annotated[str, Depends(current_user)]


def _call(fn: Callable[..., Any], *args: Any) -> Any:
    try:
        return fn(*args)
    except whoop.WhoopNotConnectedError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    except whoop.WhoopAPIError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


def _back_to_app(return_to: str, **params: str) -> RedirectResponse:
    sep = "&" if "?" in return_to else "?"
    return RedirectResponse(f"{return_to}{sep}{urlencode(params)}", status_code=302)


@router.get("/status")
def status(user: User) -> dict:
    owner = whoop.login_owner(user)
    return {
        "mode": whoop.mode(user),
        "login_url": "/whoop/login",
        "user": user,
        # True when this user hasn't connected their own WHOOP and is borrowing the laptop's login.
        "shared": owner is not None and owner != user,
    }


@router.get("/login")
def login(user: User, return_to: str | None = None) -> RedirectResponse:
    if not get_settings().whoop_enabled:
        raise HTTPException(
            status_code=400,
            detail="Set WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET in backend/.env, then restart the backend.",
        )
    return RedirectResponse(whoop.authorization_url(user, return_to))


@router.get("/callback", response_class=HTMLResponse, response_model=None)
def callback(
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    error_description: str | None = None,
) -> str | RedirectResponse:
    pending = whoop.consume_state(state) if state else None
    return_to = pending["return_to"] if pending else None

    if error:
        if return_to:
            return _back_to_app(return_to, whoop="error", reason=error)
        detail = f"WHOOP returned an error: {error} {error_description or ''}"
        raise HTTPException(status_code=400, detail=detail)
    if not code or not pending:
        detail = "Missing or unknown OAuth state. Start again at /whoop/login."
        raise HTTPException(status_code=400, detail=detail)

    try:
        _call(whoop.exchange_code, code, pending["user"])
    except HTTPException:
        if return_to:
            return _back_to_app(return_to, whoop="error", reason="token_exchange_failed")
        raise
    if return_to:
        return _back_to_app(return_to, whoop="connected")
    return (
        "<h2>WHOOP connected.</h2>"
        "<p>You can close this tab. Check <a href='/whoop/summary'>/whoop/summary</a>.</p>"
    )


@router.delete("/connection", status_code=204)
def disconnect(user: User) -> None:
    """Forget this user's WHOOP login (e.g. to switch accounts during a demo)."""
    whoop.disconnect(user)


@router.get("/profile")
def profile(user: User) -> dict:
    return _call(whoop.get_profile, user)


@router.get("/body")
def body(user: User) -> dict:
    """Height, weight and max heart rate."""
    return _call(whoop.get_body, user)


@router.get("/workouts")
def workouts(user: User, days: int = Days, runs_only: bool = False) -> list[dict]:
    """Per-workout avg/max HR, time in each HR zone, distance, pace, strain."""
    rows = [whoop.normalize_workout(w) for w in _call(whoop.get_workouts, days, user)]
    return [r for r in rows if r["is_run"]] if runs_only else rows


@router.get("/cycles")
def cycles(user: User, days: int = Days) -> list[dict]:
    """Per physiological cycle (roughly a day): strain, avg/max HR, step count."""
    return [whoop.normalize_cycle(c) for c in _call(whoop.get_cycles, days, user)]


@router.get("/recovery")
def recovery(user: User, days: int = Days) -> list[dict]:
    """Per cycle: recovery score, resting HR, HRV."""
    return [whoop.normalize_recovery(r) for r in _call(whoop.get_recovery, days, user)]


@router.get("/summary")
def summary(user: User, days: int = Days) -> dict:
    """Max HR, resting HR, 5 HR zones, recent runs with pace. One call for the app."""
    return _call(whoop.summary, days, user)
