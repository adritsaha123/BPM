"""DJ mode: Creative Commons tracks (Jamendo) with measured BPM, picked by tempo + energy.

The catalog (app/data/dj_catalog.json) is built on the laptop by scripts/build_dj_catalog.py.
Unlike Spotify, the app plays these files itself, so it time-stretches each song to the exact
target BPM (pitch-corrected) and crossfades between songs. Stretching sounds natural up to about
±8%, so ranking prefers songs that reach the target within that.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from app import tempo

CATALOG = Path(__file__).parent / "data" / "dj_catalog.json"
MAX_STRETCH = 0.08  # beyond ±8% a time-stretched song starts to sound off
OUT_OF_STRETCH_PENALTY = 100  # rank songs that can't reach the target after all others
PUBLIC_FIELDS = (
    "id", "name", "artist", "audio", "image", "url", "duration_s",
    "bpm", "running_bpm", "energy", "license", "license_url", "style",
)  # fmt: skip


@lru_cache
def _load(path: str) -> dict:
    p = Path(path)
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {"tracks": []}


def tracks() -> list[dict]:
    return _load(str(CATALOG)).get("tracks", [])


def source_note() -> str:
    return _load(str(CATALOG)).get("source", "")


def rank(target_bpm: float, intensity: str | None = None, exclude: set[str] | None = None) -> list[dict]:
    """Catalog songs best first for this target tempo (and energy, with an intensity).

    Each result says how to play it: `playback_rate` is the time-stretch that lands the song exactly
    on the target (clamped to ±8%).
    """
    exclude = exclude or set()
    out = []
    for t in tracks():
        if t["id"] in exclude:
            continue
        m = tempo.match(t["bpm"], target_bpm)
        if not m:
            continue
        rate = target_bpm / m["effective_bpm"]
        reachable = abs(rate - 1) <= MAX_STRETCH
        score = tempo.fit_score(m, t.get("energy"), intensity)
        if not reachable:
            score += OUT_OF_STRETCH_PENALTY
        out.append(
            {
                **{k: t.get(k) for k in PUBLIC_FIELDS},
                "match": m,
                "playback_rate": round(min(max(rate, 1 - MAX_STRETCH), 1 + MAX_STRETCH), 3),
                "reachable": reachable,
                "fit_score": round(score, 2),
            }
        )
    out.sort(key=lambda t: t["fit_score"])
    return out
