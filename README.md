# Hackathon Starter

Mobile app + Python API + AI, ready to go before the clock starts.

| Part | Tech | Folder |
|---|---|---|
| Mobile app (iOS, Android, web) | Expo SDK 58 · React Native · TypeScript | `mobile/` |
| API | FastAPI · Python 3.11+ | `backend/` |
| AI | Claude API through `backend/app/llm.py` (mock mode without a key) | `backend/app/llm.py` |
| CI | GitHub Actions: lint + tests + typecheck on every PR | `.github/` |

```
iPhone (dev build) ──HTTP──▶ FastAPI :8000 ──▶ Claude API / other APIs
```

The app never calls the AI or third-party APIs directly. Everything goes through the backend, so **API keys stay off the phone**.

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

The app uses Bluetooth, background GPS and audio, so **Expo Go won't work**. You need a development build once (rebuild only when native packages or `app.json` change):

```bash
cd mobile
npm install
npx eas-cli@latest build --profile development --platform ios   # cloud build, install on your iPhone
npx expo start                                                  # then open the dev build app
```

On a Mac with Xcode, `npx expo run:ios --device` also works.
On the iOS Simulator (no Bluetooth or GPS), turn on **Demo mode** on the setup screen.

**Whoop:** in the Whoop app, turn on **Heart Rate Broadcast** in your device settings, then tap **Connect Whoop**.

#### How the BPM app fits together (`mobile/src`)
| Folder | What's there |
|---|---|
| `app/` | Expo Router screens: `index` (setup), `workout` (live), `ai` (AI demo) |
| `sources/` | `whoopBle` (live HR over Bluetooth), `pedometer` (cadence), `location` (pace + background), `mock` (simulated runner) |
| `engine/` | `controller.ts` (pure BPM rules), `workout.ts` (start/stop + the sensor → BPM loop) |
| `audio/` | `player.ts` (time-stretch + crossfade), `tracks.ts` (track catalog with BPMs) |
| `store/` | Zustand stores: `bio` (live biometrics), `session` (zone, target BPM, log) |

Demo drum loops live in `assets/music` (`npm run gen:tracks` regenerates them). To add real songs, drop the files in that folder and add them to `audio/tracks.ts` with their BPM.

### Phone can't connect? (common on hackathon Wi-Fi)

Venue and campus Wi-Fi often block device-to-device traffic. Fixes, in order:
1. Put your phone and laptop on the same **phone hotspot**.
2. Start Expo with `npx expo start --tunnel`, then expose the backend with `ngrok http 8000` and put the ngrok URL in `mobile/.env` as `EXPO_PUBLIC_API_URL=...` (restart Expo).
3. Fallback: turn on **Demo mode** on the setup screen. The BPM loop runs fully on the phone, so it doesn't need the backend.

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

```bash
git checkout main && git pull
git checkout -b yourname/feature
# ...work...
git add -A && git commit -m "Add feature"
git push -u origin yourname/feature    # then open a PR on GitHub
```

### Keep the API contract in sync
When you add an endpoint in `backend/app/routes/`, add a typed function for it in `mobile/src/api.ts` in the **same PR**. Copy `routes/items.py` as a template. Register the router in `app/main.py`.

---

## Where to change things
- **AI behavior / prompts:** `backend/app/llm.py` (switch providers here, nothing else changes)
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
