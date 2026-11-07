"""Pull WHOOP history into JSON + CSV files under backend/data/whoop/ (gitignored).

Connect first: start the backend and open http://localhost:8000/whoop/login on this laptop.
Then, from backend/ with the venv active:
    python scripts/whoop_export.py --days 90
With no WHOOP credentials in .env it exports mock data, so the pipeline still runs.
"""

import argparse
import csv
import json
import os
import sys
from datetime import datetime
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
os.chdir(BACKEND_DIR)  # .env and the token file are resolved relative to backend/
sys.path.insert(0, str(BACKEND_DIR))

from app import whoop  # noqa: E402


def flatten(row: dict) -> dict:
    out = {}
    for key, value in row.items():
        if isinstance(value, dict):
            for sub, v in value.items():
                out[f"{key}_{sub}"] = v
        else:
            out[key] = value
    return out


def write(out_dir: Path, name: str, rows: list[dict] | dict) -> None:
    (out_dir / f"{name}.json").write_text(json.dumps(rows, indent=2))
    if isinstance(rows, list) and rows:
        flat = [flatten(r) for r in rows]
        fields = sorted(
            {k for r in flat for k in r}, key=lambda k: list(flat[0]).index(k) if k in flat[0] else 999
        )
        with open(out_dir / f"{name}.csv", "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fields)
            writer.writeheader()
            writer.writerows(flat)
    count = len(rows) if isinstance(rows, list) else 1
    print(f"  {name}: {count} record(s)")


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--days", type=int, default=90)
    args = parser.parse_args()

    mode = whoop.mode()
    if mode == "not_connected":
        print("WHOOP credentials are set but you haven't connected yet.")
        print("Start the backend and open http://localhost:8000/whoop/login, then rerun this.")
        return 1

    out_dir = BACKEND_DIR / "data" / "whoop"
    (out_dir / "raw").mkdir(parents=True, exist_ok=True)
    print(f"Exporting {args.days} days of WHOOP data ({mode} mode) to {out_dir}")

    try:
        raw_workouts = whoop.get_workouts(args.days)
        raw_cycles = whoop.get_cycles(args.days)
        raw_recovery = whoop.get_recovery(args.days)
        body = whoop.get_body()
    except (whoop.WhoopAPIError, whoop.WhoopNotConnectedError) as exc:
        print(f"WHOOP error: {exc}")
        return 1

    for name, data in [("workouts", raw_workouts), ("cycles", raw_cycles), ("recovery", raw_recovery)]:
        (out_dir / "raw" / f"{name}.json").write_text(json.dumps(data, indent=2))

    workouts = [whoop.normalize_workout(w) for w in raw_workouts]
    write(out_dir, "workouts", workouts)
    write(out_dir, "runs", [w for w in workouts if w["is_run"]])
    write(out_dir, "cycles", [whoop.normalize_cycle(c) for c in raw_cycles])
    write(out_dir, "recovery", [whoop.normalize_recovery(r) for r in raw_recovery])
    write(out_dir, "body", body)
    write(out_dir, "summary", whoop.summary(min(args.days, 30)))
    (out_dir / "exported_at.txt").write_text(datetime.now().isoformat() + f" mode={mode}\n")
    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
