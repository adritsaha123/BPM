# BPM Coach

An iOS running coach that changes the music's tempo to keep your heart rate in a training zone. Live heart rate comes from a Whoop band; music is DJ mode (open-license songs locked to the exact tempo, `docs/DJ.md`) or Spotify (songs picked by tempo and energy).

| Part | Tech | Folder |
|---|---|---|
| Mobile app (iOS) | Expo SDK 58 · React Native · TypeScript | `mobile/` |
| API | FastAPI · Python 3.11+ | `backend/` |
| AI | Claude API through `backend/app/llm.py` (mock mode without a key) | `backend/app/llm.py` |
| CI | GitHub Actions: lint + tests + typecheck on every PR | `.github/` |

```
iPhone (Expo Go or dev build) ──HTTP──▶ FastAPI :8000 ──▶ Claude API / other APIs
```

The app never calls the AI or third-party APIs directly. Everything goes through the backend, so **API keys stay off the phone**.

---

## ▶ Run everything

**Before you start:** iPhone and laptop on the **same Wi-Fi** (or the phone's hotspot), **Expo Go** installed on the iPhone, Whoop band on. Needs [Node 22+](https://nodejs.org) and [Python 3.11+](https://python.org).

**1. In the Whoop app:** Device Settings → **Heart Rate Broadcast** → **Start** (band light flashes blue). Keep the band within a few meters of the laptop.

**2. One command from the repo root:**

```powershell
.\dev.ps1                 # Windows (PowerShell)
```
```bash
./dev.sh                  # macOS / Linux
```

It does first-time setup automatically (Python virtualenv, packages, `backend/.env`, `npm install`), then starts:

| Process | What it does | You should see |
|---|---|---|
| Backend | FastAPI on port 8000 | `Uvicorn running on http://0.0.0.0:8000` |
| Whoop live HR | Reads the band over Bluetooth, sends bpm to the backend | `142 bpm` about once a second |
| Expo | Serves the app | A QR code |

On Windows each one opens in its own window; on macOS/Linux they share one terminal and Ctrl+C stops all of them.
Options: `-NoWhoop` / `--no-whoop` skips the band (use **Simulated** HR in the app). `-Tunnel` / `--tunnel` helps when venue Wi-Fi blocks the phone.

**3. Connect a Whoop account** (for personal HR zones; skip it and the app uses sample zones). Put `WHOOP_CLIENT_ID` and `WHOOP_CLIENT_SECRET` in `backend/.env` (ask the team; never commit them), then either:
- **From the app (recommended):** run with a public URL, `.\dev.ps1 -NgrokDomain your-name.ngrok-free.app` (one-time setup in [Connect Whoop from the app](#connect-whoop-from-the-app-ngrok)), and tap **Connect Whoop account** on the setup screen. Each person logs in to their own Whoop.
- **From the laptop:** open **http://localhost:8000/whoop/login** in a browser on the laptop and approve. This connects one shared "default" account.

**4. On the iPhone:** scan the QR code with the **Camera** app, which opens Expo Go. Then:
1. Allow **Motion & Fitness** and **Location**.
2. Heart rate source: **Laptop relay**. The status turns **Live** with your bpm.
3. Target zone: **Heart rate**, then tap a **Whoop zone** chip (Z2 or Z3 for running).
4. Leave **Simulated running** off if you're actually moving; turn it on to test at a desk.
5. Music: **DJ** (songs locked to the exact BPM and blended like a DJ; needs the backend) or **Spotify** (real songs at the target tempo; open Spotify on the phone and play any song first. Setup: `docs/SPOTIFY.md`).
6. **Start workout.** If HR is out of zone, after about 20 seconds you'll see something like `160 → 164 BPM` and hear the beat change.

**If something's wrong:**
| The app says | Fix |
|---|---|
| Can't reach the backend | Is the backend running? Same Wi-Fi? On Windows, allow Python through the firewall on private networks. |
| Waiting for the laptop script | The Whoop HR process hasn't found the band. Restart Heart Rate Broadcast and move the band closer. |
| Stream went stale | Band out of range, or the Whoop HR process stopped. Check its output. |
| Zone chips say "sample data" | The backend has no Whoop keys: add them to `backend/.env` and restart. |
| Connect Whoop shows a WHOOP error about the redirect | The Redirect URL in the Whoop dashboard must exactly match `https://<your domain>/whoop/callback`. |

Prefer running the pieces by hand? The commands are in **Quick start** below and in `docs/WHOOP.md`.

### Connect Whoop from the app (ngrok)

The backend stays on your laptop; [ngrok](https://ngrok.com) gives it a free, permanent https address. Whoop needs that to send people back after they log in, and as a bonus the phone no longer has to be on the same Wi-Fi.

One-time setup (whoever runs the backend):
1. Sign up at ngrok.com (free). In the dashboard, copy your **authtoken** and claim your free **static domain** (looks like `your-name.ngrok-free.app`).
2. Install ngrok and add the token:
   ```powershell
   winget install ngrok.ngrok          # macOS: brew install ngrok
   ngrok config add-authtoken <your-authtoken>
   ```
3. In the [Whoop developer dashboard](https://developer-dashboard.whoop.com), open the **BPM** app and add the Redirect URL `https://your-name.ngrok-free.app/whoop/callback`.

Then every time:
```powershell
.\dev.ps1 -NgrokDomain your-name.ngrok-free.app     # macOS: ./dev.sh --ngrok your-name.ngrok-free.app
```
This starts ngrok too, points the backend's Whoop redirect and the app at the public URL, and opens the Expo QR as usual. Tip: `$env:BPM_NGROK_DOMAIN = "your-name.ngrok-free.app"` (or `export BPM_NGROK_DOMAIN=...`) saves typing it.

In the app, **Whoop account → Connect Whoop account** opens Whoop's login, then returns to the app showing **Connected** and your own HR zones. The first visit may show an ngrok "You are about to visit" page; tap **Visit Site**. Each phone gets its own anonymous ID, so every teammate can connect their own Whoop.

> Live heart rate still comes through the laptop's Bluetooth (the Whoop HR window) while you use Expo Go. Only a development build can read the band directly on the phone; see below.

---

## Quick start (everyone, before the hackathon)

**Install once:** [Node 22+](https://nodejs.org), [Python 3.11+](https://python.org), Git, an iPhone, and an Expo account (`npx eas-cli@latest login`) for development builds.

### 1. Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env               # add ANTHROPIC_API_KEY (optional: blank = mock AI)
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Check it at http://localhost:8000/docs (interactive API docs).

> `--host 0.0.0.0` is required so your phone can reach your laptop.

### 2. Mobile app (second terminal) — iOS only

**Testing with Expo Go (fastest):**

```bash
cd mobile
npm install
npx expo start      # scan the QR code with the iPhone Camera app → opens in Expo Go
```

**Live Whoop HR in Expo Go comes through the laptop** (Expo Go can't use Bluetooth itself):

```
Whoop band ──Bluetooth──▶ laptop script ──POST /live/hr──▶ FastAPI ◀──polls every 1s── app
```

Run these on the laptop, each in its own terminal (Windows shown; macOS/Linux use `source .venv/bin/activate`):

```powershell
# 1. Backend
cd backend; .venv\Scripts\activate; uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
# 2. Whoop → laptop (first: Whoop app → Device Settings → Heart Rate Broadcast → Start)
cd backend; .venv\Scripts\activate; pip install -r requirements-ble.txt; python scripts/whoop_live_hr.py
# 3. App
cd mobile; npx expo start
```

On the setup screen pick **Laptop relay**. The status turns **Live** with your bpm once readings arrive. Tap a **Whoop zone** chip to set your target. Full details: `docs/WHOOP.md`.

Limits in Expo Go:
- **The band must stay within Bluetooth range of the laptop** (a few meters). Good for a treadmill or on-stage demo; use the **Heart rate** zone there, since GPS pace is ~0 on a treadmill.
- **Keep the app open.** Background GPS isn't available, so pace only updates while the app is on screen.
- No band handy? Pick **Simulated** (HR follows your real cadence) and/or turn on **Simulated running** to test at a desk.

**Phone-only Whoop Bluetooth (no laptop) needs a development build** (rebuild only when native packages or `app.json` change).
Without a paid Apple Developer account, the only way is a **Mac with Xcode** and a free Apple ID: plug in the iPhone and run `npx expo run:ios --device` in `mobile/`. Apps signed this way expire after 7 days (just run it again). With a paid account, EAS can build in the cloud from any computer:

```bash
cd mobile
npm install
npx eas-cli@latest build --profile development --platform ios   # cloud build, install on your iPhone
npx expo start                                                  # then open the dev build app
```

On a Mac with Xcode, `npx expo run:ios --device` also works.
On the iOS Simulator (no Bluetooth or GPS), turn on **Simulated heart rate** and **Simulated running**.

**Whoop:** in the Whoop app, turn on **Heart Rate Broadcast** in your device settings, then tap **Connect Whoop**.

#### How the BPM app fits together (`mobile/src`)
| Folder | What's there |
|---|---|
| `runtime.ts` | `isExpoGo` flag: switches Bluetooth and background GPS off in Expo Go |
| `app/` | Expo Router screens: `index` (setup), `workout` (live), `summary` (after a run), `music` (Spotify screen) |
| `sources/` | `relayHr` (live HR via the laptop relay), `whoopBle` (live HR over phone Bluetooth, dev build), `pedometer` (cadence), `location` (pace + background), `mock` (simulated HR and/or running) |
| `engine/` | `controller.ts` (pure BPM rules), `workout.ts` (start/stop + the sensor → BPM loop), `summary.ts` (run stats) |
| `audio/` | `music.ts` (picks the music source), `djOutput.ts` (DJ mode: time-stretch + crossfade), `spotifyOutput.ts` (Spotify: songs picked by tempo), `session.ts` (audio session) |
| `store/` | Zustand stores: `bio` (live biometrics), `session` (zone, target BPM, log) |

DJ mode's songs come from the backend catalog (`backend/app/data/dj_catalog.json`, built by `backend/scripts/build_dj_catalog.py`; see `docs/DJ.md`).

### Phone can't connect? (common on hackathon Wi-Fi)

Venue and campus Wi-Fi often block device-to-device traffic. Fixes, in order:
1. Put your phone and laptop on the same **phone hotspot**.
2. Start Expo with `npx expo start --tunnel`, then expose the backend with `ngrok http 8000` and put the ngrok URL in `mobile/.env` as `EXPO_PUBLIC_API_URL=...` (restart Expo).
3. Fallback: turn on **Simulated heart rate** and **Simulated running** on the setup screen. The BPM loop runs fully on the phone, so it doesn't need the backend.

---

## Team workflow (3 people)

### Suggested roles
| Person | Owns | Mostly touches |
|---|---|---|
| **A: Mobile/UI** | Screens, navigation, look and feel | `mobile/src/screens`, `mobile/src/theme.ts` |
| **B: Backend/AI** | Endpoints, prompts, external APIs | `backend/app/routes`, `backend/app/llm.py` |
| **C: Integration + pitch** | Wiring screens to the API, demo data, deploy, Devpost, slides, video | `mobile/src/api.ts` |

Splitting by folder means you'll rarely edit the same file, which keeps merge conflicts low.

### Git rules
- `main` should **always run**. Never push broken code to it.
- Branch per feature: `git checkout -b alex/login-screen`
- Commit small and often. Pull often: `git pull origin main`
- Open a PR and get a quick 👍 from one teammate. CI must be green. Squash-merge.
- In the last 2 hours, **freeze `main`** and only merge bug fixes.

#### Making a PR, step by step

```bash
# 1. Start from an up-to-date main and create a branch
git checkout main
git pull
git checkout -b yourname/feature-name

# 2. Do the work, then check what changed
git status

# 3. Stage what you want to commit
#    Name paths explicitly rather than using `git add -A`, so stray files and .env don't get in
git add mobile/src README.md

# 4. Commit with a message that says what changed
git commit -m "Add Whoop reconnect indicator"

# 5. Push the branch (-u links it, so later pushes are just `git push`)
git push -u origin yourname/feature-name

# 6. Open the PR (or use the link GitHub prints after the push)
gh pr create --base main --title "Short title" --body "What + how to test"
```

**After it's open:**
- **More changes:** commit on the same branch and run `git push`. The PR updates automatically.
- **Check CI** with `gh pr checks <number>`, or look at the PR page. It typechecks `mobile/` and runs the backend tests.
- **Merge** once a teammate approves and CI is green: `gh pr merge <number> --squash --delete-branch`. Everyone then runs `git checkout main && git pull`.

> No `gh`? Install the [GitHub CLI](https://cli.github.com) and run `gh auth login` once, or open the PR from the link `git push` prints.

### Keep the API contract in sync
When you add an endpoint in `backend/app/routes/`, add a typed function for it in `mobile/src/api.ts` in the **same PR**. Register the router in `app/main.py`.

---

## Where to change things
- **AI behavior / prompts:** `backend/app/llm.py` (switch providers here, nothing else changes)
- **Spotify + live BPM sync (song tempo vs heart rate):** `backend/app/spotify.py`, `tempo.py`, `routes/spotify.py`, `mobile/src/screens/MusicScreen.tsx`. Setup in `docs/SPOTIFY.md`
- **DJ mode (open-license songs at the exact BPM, crossfades):** `backend/app/dj.py`, `routes/dj.py`, `scripts/build_dj_catalog.py`, `mobile/src/audio/djOutput.ts`. Details in `docs/DJ.md`
- **WHOOP history + live heart rate:** `backend/app/whoop.py`, `routes/whoop.py`, `routes/live.py`. Setup in `docs/WHOOP.md`
- **New endpoint:** add a router in `backend/app/routes/` (see `live.py` for a small one)
- **New screen:** add a file to `mobile/src/app/` (Expo Router)
- **BPM rules (step size, cooldown, limits):** `DJ_CONTROL` / `SPOTIFY_CONTROL` in `mobile/src/engine/controller.ts`
- **Colors and spacing:** `mobile/src/theme.ts`

## Deploying for the demo (optional)
Running on a laptop is fine for most judging. For a public URL, deploy `backend/` to Render or Railway with start command `uvicorn app.main:app --host 0.0.0.0 --port $PORT`, set `ANTHROPIC_API_KEY` there, and point `EXPO_PUBLIC_API_URL` at it.

## Commands
| | |
|---|---|
| Backend tests | `cd backend && pytest -q` |
| Backend lint | `cd backend && ruff check . --fix` |
| Mobile typecheck | `cd mobile && npm run typecheck` |
| Add an Expo package | `cd mobile && npx expo install <pkg>` (picks SDK-compatible versions) |

## Pre-hackathon checklist
- [ ] All 3 teammates added as collaborators on GitHub
- [ ] Everyone has cloned the repo and seen **Connected** on their phone
- [ ] API key(s) obtained and shared privately (never in git)
- [ ] Read the hackathon rules on pre-written code. Most allow boilerplate like this; mention it in your submission
