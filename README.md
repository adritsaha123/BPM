# Hackathon Starter

Mobile app + Python API + AI, ready to go before the clock starts.

| Part | Tech | Folder |
|---|---|---|
| Mobile app (iOS, Android, web) | Expo SDK 58 · React Native · TypeScript | `mobile/` |
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

**3. First time only, connect your Whoop account:** put `WHOOP_CLIENT_ID` and `WHOOP_CLIENT_SECRET` in `backend/.env` (ask the team; never commit them), then open **http://localhost:8000/whoop/login** in a browser **on the laptop** and approve. http://localhost:8000/whoop/status should then say `"mode": "live"`. Skip this and the app still works, with sample Whoop zones.

**4. On the iPhone:** scan the QR code with the **Camera** app, which opens Expo Go. Then:
1. Allow **Motion & Fitness** and **Location**.
2. Heart rate source: **Laptop relay**. The status turns **Live** with your bpm.
3. Target zone: **Heart rate**, then tap a **Whoop zone** chip (Z2 or Z3 for running).
4. Leave **Simulated running** off if you're actually moving; turn it on to test at a desk.
5. **Start workout.** If HR is out of zone, after about 20 seconds you'll see something like `160 → 164 BPM` and hear the beat change.

**If something's wrong:**
| The app says | Fix |
|---|---|
| Can't reach the backend | Is the backend running? Same Wi-Fi? On Windows, allow Python through the firewall on private networks. |
| Waiting for the laptop script | The Whoop HR process hasn't found the band. Restart Heart Rate Broadcast and move the band closer. |
| Stream went stale | Band out of range, or the Whoop HR process stopped. Check its output. |
| Zone chips say "sample data" | Do step 3, then reload the app (shake the phone → Reload). |

Prefer running the pieces by hand? The commands are in **Quick start** below and in `docs/WHOOP.md`.

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

**Phone-only Whoop Bluetooth (no laptop) needs a development build** (rebuild only when native packages or `app.json` change):

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
| `app/` | Expo Router screens: `index` (setup), `workout` (live), `ai` (AI demo) |
| `sources/` | `relayHr` (live HR via the laptop relay), `whoopBle` (live HR over phone Bluetooth, dev build), `pedometer` (cadence), `location` (pace + background), `mock` (simulated HR and/or running) |
| `engine/` | `controller.ts` (pure BPM rules), `workout.ts` (start/stop + the sensor → BPM loop) |
| `audio/` | `player.ts` (time-stretch + crossfade), `tracks.ts` (track catalog with BPMs) |
| `store/` | Zustand stores: `bio` (live biometrics), `session` (zone, target BPM, log) |

Demo drum loops live in `assets/music` (`npm run gen:tracks` regenerates them). To add real songs, drop the files in that folder and add them to `audio/tracks.ts` with their BPM.

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
| **C: Integration + pitch** | Wiring screens to the API, demo data, deploy, Devpost, slides, video | `mobile/src/api.ts`, `docs/PITCH.md` |

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
When you add an endpoint in `backend/app/routes/`, add a typed function for it in `mobile/src/api.ts` in the **same PR**. Copy `routes/items.py` as a template. Register the router in `app/main.py`.

---

## Where to change things
- **AI behavior / prompts:** `backend/app/llm.py` (switch providers here, nothing else changes)
- **WHOOP history + live heart rate:** `backend/app/whoop.py`, `routes/whoop.py`, `routes/live.py`. Setup in `docs/WHOOP.md`
- **New endpoint:** copy `backend/app/routes/items.py`
- **New screen:** add a file to `mobile/src/app/` (Expo Router)
- **BPM rules (step size, cooldown, limits):** `CONTROL` in `mobile/src/engine/controller.ts`
- **Colors and spacing:** `mobile/src/theme.ts`
- **Need a real database?** Swap the in-memory dict in `items.py` for SQLite (SQLModel) or Supabase

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
- [ ] `docs/PITCH.md` skimmed so you know what to fill in
