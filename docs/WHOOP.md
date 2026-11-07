# WHOOP integration

Two separate pipes, because WHOOP's web API has no live data:

| What | How | Where |
|---|---|---|
| **History**: max HR, resting HR, HRV, HR zones, past runs (avg/max HR, pace, time in zones), daily steps | WHOOP Developer API v2 (OAuth) | `backend/app/whoop.py`, `/whoop/*` routes |
| **Live heart rate**, about once a second | Band's Heart Rate Broadcast over Bluetooth, read on the laptop | `backend/scripts/whoop_live_hr.py` → `POST /live/hr` → app polls `GET /live/hr` |

No WHOOP credentials in `backend/.env`? Every `/whoop/*` endpoint serves **mock data** in the same shape, so the UI can be built without a band.

## 1. Connect WHOOP (once, on the laptop running the backend)

The WHOOP app **BPM** is registered on developer-dashboard.whoop.com with redirect `http://localhost:8000/whoop/callback` and all read scopes. Its client ID and secret go in `backend/.env` (never commit it):

```
WHOOP_CLIENT_ID=...
WHOOP_CLIENT_SECRET=...
WHOOP_REDIRECT_URI=http://localhost:8000/whoop/callback
```

Then:

```bash
cd backend && source .venv/bin/activate
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Open **http://localhost:8000/whoop/login** in a browser on that laptop, sign in with the WHOOP account whose data you want, approve. You land on "WHOOP connected." Tokens are saved to `backend/.whoop_tokens.json` (gitignored) and refresh automatically.

Check: http://localhost:8000/whoop/summary

> Do the login on the laptop itself: the redirect goes to `localhost`, which a phone can't reach. Sandbox apps allow up to 10 WHOOP members.

## 2. Endpoints

| Endpoint | Returns |
|---|---|
| `GET /whoop/status` | `mode`: `live`, `mock`, or `not_connected` |
| `GET /whoop/summary?days=30` | max HR, resting HR, HRV, recovery, 5 HR zones (bpm ranges), recent runs, steps |
| `GET /whoop/workouts?days=30&runs_only=true` | per workout: avg/max HR, minutes in each zone, distance, pace (min/km), strain |
| `GET /whoop/cycles?days=30` | per day-ish cycle: strain, avg/max HR, `step_count` |
| `GET /whoop/recovery?days=30` | recovery score, resting HR, HRV |
| `GET /whoop/body` | height, weight, max HR |
| `GET /live/hr?window_s=30` | latest live bpm, how many seconds old, rolling average |

Mobile: typed wrappers are in `mobile/src/api.ts` (`api.whoopSummary()`, `api.liveHr()`, ...).

## 3. Live heart rate from the band

1. WHOOP app → **Device Settings → Heart Rate Broadcast → Start**. The band light flashes blue.
2. On the laptop (backend already running):
   ```bash
   cd backend && source .venv/bin/activate
   pip install -r requirements-ble.txt
   python scripts/whoop_live_hr.py            # add --no-post to just print
   ```
3. macOS asks your terminal for Bluetooth permission the first time. Allow it (System Settings → Privacy & Security → Bluetooth).
4. The app polls `GET /live/hr`. `age_s` tells you if the stream went stale.

Any standard Bluetooth heart rate monitor works the same way (`--name ""` takes the first one found).

If the band doesn't show up: make sure broadcast is on, the WHOOP phone app isn't hogging the connection, and the band is within a few meters.

## 4. Export history to files

```bash
cd backend && source .venv/bin/activate
python scripts/whoop_export.py --days 90
```

Writes JSON + CSV (workouts, runs, cycles, recovery, body, summary) to `backend/data/whoop/` (gitignored).

## Limits worth knowing

- The API has **no per-second heart rate and no cadence**. Live HR only comes from Broadcast; cadence has to come from the phone (e.g. `expo-sensors` Pedometer).
- Rate limit: 100 requests/minute, 10,000/day. Reads are cached for 2 minutes, so polling `/whoop/summary` is safe.
- `step_count` on cycles is a running total for the cycle, not per minute.
