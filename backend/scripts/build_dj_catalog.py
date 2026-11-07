"""Build the DJ-mode music catalog from Jamendo (Creative Commons music) with measured BPM.

Jamendo gives stream links and licenses but no BPM, so this downloads ~75 s of each candidate,
measures tempo and loudness (librosa), and keeps tracks that run at 140-190 BPM (half/double
time counts). Tracks whose license forbids changes (CC "ND") are skipped, because the app
time-stretches songs to the target tempo. Run on the laptop; the backend only reads the result.

Setup (once):  pip install -r requirements-catalog.txt   and  JAMENDO_CLIENT_ID=... in backend/.env
Run:           python scripts/build_dj_catalog.py                 # ~4 s per new track
               python scripts/build_dj_catalog.py --per-tag 40    # bigger catalog
Output:        app/data/dj_catalog.json (committed; contains no keys). Re-runs reuse earlier
               measurements, so only new tracks are downloaded.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402
from dotenv import dotenv_values  # noqa: E402

from app.tempo import running_tempo  # noqa: E402

API = "https://api.jamendo.com/v3.0/tracks/"
OUT = Path(__file__).resolve().parents[1] / "app" / "data" / "dj_catalog.json"
# Jamendo tags with plenty of fast tracks (checked against the API).
TAGS = ["drumnbass", "trap", "punk", "edm", "pop", "rock", "trance", "breakbeat", "techno"]
SAMPLE_START_S, SAMPLE_LEN_S = 15, 75  # skip intros; enough audio for a stable tempo


def license_short(url: str) -> str:
    """http://creativecommons.org/licenses/by-nc-sa/3.0/ -> 'CC BY-NC-SA 3.0'."""
    parts = [p for p in url.split("/") if p]
    try:
        i = parts.index("licenses")
        return f"CC {parts[i + 1].upper()} {parts[i + 2]}"
    except (ValueError, IndexError):
        return url


def allows_changes(url: str) -> bool:
    return bool(url) and "-nd" not in url and "/nd" not in url


def candidates(client_id: str, per_tag: int) -> list[dict]:
    seen: dict[str, dict] = {}
    for tag in TAGS:
        r = httpx.get(
            API,
            params={
                "client_id": client_id,
                "format": "json",
                "limit": per_tag,
                "tags": tag,
                "speed": "high+veryhigh",
                "include": "musicinfo",
                "audioformat": "mp32",
                "imagesize": 200,
                "order": "popularity_total",
            },
            timeout=30,
        )
        r.raise_for_status()
        rows = r.json().get("results", [])
        kept = [t for t in rows if allows_changes(t.get("license_ccurl", "")) and t.get("audio")]
        print(f"  {tag:10} {len(rows):3} fast tracks, {len(kept):3} allow changes")
        for t in kept:
            seen.setdefault(t["id"], {**t, "_tag": tag})
    return list(seen.values())


def measure(audio_url: str, workdir: Path) -> tuple[float, float]:
    """(tempo in BPM, RMS loudness) from a slice of the track."""
    import librosa
    import numpy as np
    import soundfile as sf

    path = workdir / "track.mp3"
    with httpx.stream("GET", audio_url, timeout=60, follow_redirects=True) as r:
        r.raise_for_status()
        with path.open("wb") as f:
            for chunk in r.iter_bytes():
                f.write(chunk)
    info = sf.info(str(path))
    start = int(min(SAMPLE_START_S, max(0, info.duration - SAMPLE_LEN_S)) * info.samplerate)
    y, sr = sf.read(str(path), dtype="float32", start=start, frames=int(SAMPLE_LEN_S * info.samplerate))
    y = y.mean(axis=1) if y.ndim > 1 else y
    y = librosa.resample(y, orig_sr=sr, target_sr=22050)
    tempo, _ = librosa.beat.beat_track(y=y, sr=22050)
    return float(np.atleast_1d(tempo)[0]), float(np.sqrt(np.mean(y**2)))


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--per-tag", type=int, default=25, help="Candidates per style tag")
    parser.add_argument("--min-bpm", type=float, default=140, help="Keep running tempo >= this")
    parser.add_argument("--max-bpm", type=float, default=190, help="Keep running tempo <= this")
    args = parser.parse_args()

    client_id = (
        dotenv_values(Path(__file__).resolve().parents[1] / ".env").get("JAMENDO_CLIENT_ID") or ""
    ).strip()
    if not client_id:
        print("Set JAMENDO_CLIENT_ID in backend/.env (devportal.jamendo.com).")
        return 1

    previous = json.loads(OUT.read_text()) if OUT.exists() else {}
    measured: dict[str, dict] = previous.get("measured", {})  # id -> {"bpm", "rms"} (kept or not)

    print("Finding candidates on Jamendo...")
    pool = candidates(client_id, args.per_tag)
    todo = [t for t in pool if t["id"] not in measured]
    print(f"{len(pool)} candidates, {len(todo)} new to analyze")

    with tempfile.TemporaryDirectory() as tmp:
        for n, t in enumerate(todo, 1):
            t0 = time.time()
            try:
                bpm, rms = measure(t["audio"], Path(tmp))
            except Exception as exc:  # one bad file shouldn't stop the run
                print(f"  [{n}/{len(todo)}] skip {t['name'][:40]}: {exc.__class__.__name__}")
                continue
            measured[t["id"]] = {"bpm": round(bpm, 1), "rms": round(rms, 4)}
            print(f"  [{n}/{len(todo)}] {bpm:6.1f} BPM  {t['name'][:40]} ({time.time() - t0:.1f}s)")

    tracks = []
    for t in pool:
        m = measured.get(t["id"])
        if not m:
            continue
        run = running_tempo(m["bpm"])
        if not args.min_bpm <= run <= args.max_bpm:
            continue
        tracks.append(
            {
                "id": f"jamendo-{t['id']}",
                "name": t["name"],
                "artist": t["artist_name"],
                "audio": t["audio"],
                "image": t.get("image") or None,
                "url": t.get("shareurl"),
                "duration_s": t.get("duration"),
                "bpm": m["bpm"],
                "running_bpm": round(run, 1),
                "rms": m["rms"],
                "license": license_short(t["license_ccurl"]),
                "license_url": t["license_ccurl"],
                "style": t["_tag"],
            }
        )

    # Energy 0-1: loudness rank within the catalog (a rough but consistent proxy).
    by_rms = sorted(tracks, key=lambda x: x["rms"])
    for i, tr in enumerate(by_rms):
        tr["energy"] = round(0.15 + 0.8 * i / max(1, len(by_rms) - 1), 2)
    tracks.sort(key=lambda x: x["running_bpm"])

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(
            {
                "source": "Jamendo (Creative Commons). Credit the artist and license when playing.",
                "generated_at": time.strftime("%Y-%m-%d"),
                "count": len(tracks),
                "tracks": tracks,
                "measured": measured,
            },
            indent=1,
        )
    )
    print(f"\nSaved {len(tracks)} tracks at {args.min_bpm:.0f}-{args.max_bpm:.0f} BPM to {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
