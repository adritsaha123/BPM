# WHOOP integration

Two separate pipes, because WHOOP's web API has no live data:

| What | How | Where |
|---|---|---|
| **History**: max HR, resting HR, HRV, HR zones, past runs (avg/max HR, pace, time in zones), daily steps | WHOOP Developer API v2 (OAuth) | `backend/app/whoop.py`, `/whoop/*` routes |
| **Live heart rate**, about once a second | Band's Heart Rate Broadcast over Bluetooth, read by the app on the phone | `mobile/src/sources/whoopBle.ts` |

No WHOOP credentials in `backend/.env`? Every `/whoop/*` endpoint serves **mock data** in the same shape, so the UI can be built without a band.

## 0. Connect WHOOP from the app (per user)

Each phone sends an anonymous id (`X-User-Id`), and the backend keeps a separate WHOOP login per id
(`backend/.whoop_tokens.<id>.json`, gitignored). Requests without an id use the "default" login from section 1.
Until a user connects their own WHOOP, they borrow the default (laptop) login if there is one: `/whoop/status` returns
`"shared": true` and the app offers **Connect my own Whoop**. Refreshes of a borrowed login are saved to the default token file.

Flow: app **WHOOP → Connect account** → in-app browser → `/whoop/login?user=<id>&return_to=<app url>` → WHOOP login →
`/whoop/callback` saves the tokens → redirects back to the app (`bpm://…` or Expo Go's `exp://…`; nothing else is allowed).

WHOOP has to reach the callback from the phone, so `WHOOP_REDIRECT_URI` must be a public https URL registered on the
WHOOP app. Easiest: an ngrok static domain. `dev.ps1 -NgrokDomain <domain>` / `dev.sh --ngrok <domain>` set
`WHOOP_REDIRECT_URI` and the app's `EXPO_PUBLIC_API_URL` for you. Setup steps are in the README.

`DELETE /whoop/connection` (the app's **Disconnect** button) forgets the current user's login.

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
| `GET /whoop/status` | `mode`: `live`, `mock`, or `not_connected` (for the `X-User-Id` user) |
| `DELETE /whoop/connection` | Forget the current user's WHOOP login |
| `GET /whoop/summary?days=30` | max HR, resting HR, HRV, recovery, 5 HR zones (bpm ranges), recent runs, steps |
| `GET /whoop/workouts?days=30&runs_only=true` | per workout: avg/max HR, minutes in each zone, distance, pace (min/km), strain |
| `GET /whoop/cycles?days=30` | per day-ish cycle: strain, avg/max HR, `step_count` |
| `GET /whoop/recovery?days=30` | recovery score, resting HR, HRV |
| `GET /whoop/body` | height, weight, max HR |
| `GET /live/hr?window_s=30` | latest live bpm, how many seconds old, rolling average |

Mobile: typed wrappers are in `mobile/src/api.ts` (`api.whoopStatus()`, `api.whoopSummary()`, ...).

## 3. Live heart rate from the band

1. WHOOP app → **Device Settings → Heart Rate Broadcast → Start**. The band light flashes blue.
2. In the app: **WHOOP → Connect band**. It needs the build installed from Xcode (Expo Go has no
   Bluetooth). `mobile/src/sources/whoopBle.ts` scans for the standard Bluetooth Heart Rate
   Service, prefers a device named WHOOP, and reconnects by itself if the connection drops. The
   workout treats readings older than a few seconds as stale and holds the music BPM steady until
   they're fresh again.
3. With your own WHOOP account connected, the setup screen shows your `/whoop/summary` HR zones as
   tiles; tap one to set the target zone.

The laptop script `backend/scripts/whoop_live_hr.py` (band → laptop Bluetooth → `POST /live/hr`)
is still in the repo for the backend, but the app doesn't read `/live/hr` anymore.

Any standard Bluetooth heart rate monitor works too: the app takes one when no WHOOP is found.

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
