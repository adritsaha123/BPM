# Spotify + live BPM sync

The Spotify tab shows your **live heart rate next to the current song's tempo**, colors it
(green = in sync, amber = close, red = off), and picks songs from your library by tempo.

**Coach mode** (on by default, Zone 3) uses the music to steer you into a heart rate zone:

| Your heart rate | Music aims for | Banner |
|---|---|---|
| Below the zone | a step (8 BPM) **faster** than your heart rate, never past the zone's middle | ↑ push you up |
| In the zone | your heart rate | ✓ in your zone |
| Above the zone | a step **slower** than your heart rate, never below the zone's middle | ↓ ease you off |

Example, Zone 3 = 133–152: heart rate 120 → songs around 128; 170 → around 162; 140 → 140.
It moves one step at a time because big tempo jumps feel jarring, and it keeps re-aiming as your
heart rate changes. Music doesn't change heart rate directly: faster music tends to make you pick
up the pace, and the pace moves the heart rate. Pick **Off** to just match your heart rate.

Zones come from WHOOP (`/whoop/summary`: heart rate reserve from your max and resting HR). If WHOOP
isn't connected, they're estimated from a 190 max heart rate, and the screen says so.

| Piece | Where |
|---|---|
| Spotify sign-in, playlists, Liked Songs, now playing, play/pause/next/queue | `backend/app/spotify.py`, `/spotify/*` routes |
| Song tempo (BPM) + matching | `backend/app/tempo.py` (ReccoBeats) |
| Live heart rate | `/live/hr` (see [WHOOP.md](WHOOP.md)) |
| Screen | `mobile/src/screens/MusicScreen.tsx` |

No Spotify credentials in `backend/.env`? Everything runs on a **mock library and player** (22 fake
songs from 72 to 182 BPM that advance in real time), so the screen works without a Spotify account.

## Can we speed songs up to match the heart rate?

**Not with Spotify.** The Web API has no playback-speed control, the app never receives the audio
(Spotify plays it), and Spotify's developer terms forbid apps that alter Spotify content. So we
**pick songs that match** instead, counting half/double time (an 85 BPM song fits a heart rate of 170).

The **Apple Music** tab can: it speeds songs up or down to your heart rate. See [APPLE_MUSIC.md](APPLE_MUSIC.md).

Each match still reports `speed_to_match`: the rate the song would need to lock in exactly
(e.g. `1.04`). That is what a speed-up feature would use if we play audio we own or have licensed
(our own tracks, royalty-free music): `expo-audio` can change playback rate with pitch correction.
Keep changes within roughly ±8% or it starts to sound off.

## 1. Create the Spotify app (once)

1. Go to developer.spotify.com/dashboard → **Create app**. Check **Web API**.
2. Redirect URI: `http://127.0.0.1:8000/spotify/callback`
   (Spotify rejects `localhost`; it must be the `127.0.0.1` loopback address.)
3. **User Management**: add the Spotify account email of everyone who will sign in.
   Development mode allows **5 users**, and the app owner needs **Spotify Premium** or the app stops working.
4. Put the credentials in `backend/.env` (never commit it):

```
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8000/spotify/callback
```

## 2. Connect (on the laptop running the backend)

```bash
cd backend && source .venv/bin/activate
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Open **http://127.0.0.1:8000/spotify/login** in a browser on that laptop, sign in, approve.
Tokens are saved to `backend/.spotify_tokens.json` (gitignored) and refresh automatically.

Then open Spotify on your phone and start any song (the API controls an *active* Spotify device).
Start the live heart rate stream (`python scripts/whoop_live_hr.py`, see WHOOP.md) and open the Music tab.

## 3. Endpoints

| Endpoint | Does |
|---|---|
| `GET /spotify/status` | `mode`: `live`, `mock`, or `not_connected` |
| `GET /spotify/zones` | the 5 heart rate zones and where they came from (`whoop`, `whoop_mock`, `default`) |
| `GET /spotify/now-playing?zone=3` | current song + `tempo` + `heart_rate` + `current_bpm` + `coach` + `match`. Poll every 1-2 s |
| `GET /spotify/playlists` | Liked Songs (`id: "liked"`) then the user's playlists |
| `GET /spotify/playlists/{id}/tracks` | tracks with `tempo` |
| `GET /spotify/match?playlist_id=liked&zone=3&limit=10` | songs ranked by closeness to the target BPM |
| `POST /spotify/sync` `{playlist_id, zone, play_now}` | queue (or play now) the best song for the target |
| `POST /spotify/play` `{uris}` · `/pause` · `/next` · `/queue` `{uri}` | player controls |

**Target BPM:** `target_bpm` if given (exact override, no coaching). Otherwise start from the heart
rate: live (average of the last 10 s, if a reading arrived in the last 15 s), else `fallback_bpm`
(the app's "No band · simulate" stepper). With `zone=1..5`, coach mode then moves the target as in
the table above; the response's `coach` says `direction` (`push`/`hold`/`ease`), the zone range,
and `target_bpm`.

**Match** fields: `effective_bpm` (song tempo, doubled or halved, whichever is closest), `multiple`
(1, 2 or 0.5), `diff_bpm`, `status` (`in_sync` ≤ 3 BPM, `close` ≤ 8, else `off`), `speed_to_match`.

**Auto-DJ** (app switch): when ~20 s of the song are left, the app calls `/spotify/sync` (with the
zone) to queue the next song, skipping songs it queued recently.

## Limits worth knowing

- **Premium:** play, queue, skip and pause only work for listeners with Spotify Premium. Free accounts
  can still see now-playing, tempo and matches.
- **Development mode:** 5 allowlisted users. Opening it to everyone needs Spotify's extended quota,
  which only goes to registered businesses with 250k+ monthly users.
- **Playlists:** Spotify only returns the songs of playlists the user **owns or collaborates on**.
  Followed playlists show up without contents. Liked Songs always works.
- **Tempo coverage:** Spotify gives new apps no tempo (`/audio-features` returns 403 for apps
  created after Nov 2024). Tempo comes from **ReccoBeats** (free, no key, max 40 ids per call).
  Songs it doesn't know show "tempo unknown" and are left out of matches; the app shows how many.
- **Heart rate isn't cadence.** Running apps often match songs to steps per minute (160-180).
  We match heart rate because that's the live signal we have; cadence could come from the phone
  (`expo-sensors` Pedometer) later, and `target_bpm` already accepts any number.
