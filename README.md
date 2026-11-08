# BPM Coach

An iOS running coach that changes the music's tempo to keep your heart rate in a training zone. Live heart rate comes from a WHOOP band over Bluetooth; the music comes from one of your Apple Music playlists, sped up or slowed down (pitch kept) so the beat matches the target (`docs/APPLE_MUSIC.md`).

| Part | Tech | Folder |
|---|---|---|
| Mobile app (iOS) | Expo SDK 58 · React Native · TypeScript | `mobile/` |
| API | FastAPI · Python 3.11+ | `backend/` |
| AI | Claude API through `backend/app/llm.py` (mock mode without a key) | `backend/app/llm.py` |
| CI | GitHub Actions: lint + tests + typecheck on every PR | `.github/` |

```
iPhone app (Xcode build) ──HTTP──▶ FastAPI :8000 ──▶ Claude API / other APIs
```

The app never calls the AI or third-party APIs directly. Everything goes through the backend, so **API keys stay off the phone**.

---

## ▶ Run everything

The app has to be **installed on an iPhone from a Mac with Xcode**: Apple Music and the WHOOP band's Bluetooth are native features that Expo Go doesn't have. A free Apple ID is enough. Full steps, including the one-time Mac setup: `docs/APPLE_MUSIC.md`.

**Before you start:** a Mac with Xcode and [Node 22+](https://nodejs.org), an iPhone with some Apple Music playlists, and a WHOOP band.

**1. In the WHOOP app:** Device Settings → **Heart Rate Broadcast** → **Start** (band light flashes blue).

**2. Install the app** (iPhone plugged in; the first build takes a few minutes):

```bash
cd mobile
npm install
npx expo run:ios --device
```

Or open `mobile/ios/BPMCoach.xcworkspace` in Xcode, pick your iPhone and press ▶. A **Release** build (scheme → Run → Build Configuration) has the app's code built in and uses the hosted backend, so it works anywhere without the laptop. A **Debug** build loads the code from the dev server (`npx expo start`) and looks for the backend on the laptop.

**3. On the iPhone:**
1. Allow **Motion & Fitness**, **Location**, **Bluetooth** and **Apple Music** when asked.
2. **WHOOP → Connect band.** It shows **Band connected** and your heart rate.
3. Optional: **Connect account** for your own heart rate zones, then tap a zone (Z2 or Z3 for running).
4. **Music → Choose a playlist.** Wait for **Ready** (the app looks up the songs' tempos).
5. **Start workout.** If your heart rate is out of zone, after about 20 seconds you'll see something like `160 → 164 BPM` and hear the beat change.

**If something's wrong:**
| The app says | Fix |
|---|---|
| No band found | In the WHOOP app, start Heart Rate Broadcast again and keep the band close to the phone. |
| Apple Music access is off | Settings → BPM Coach → turn on Media & Apple Music. |
| Can't look up song tempos right now | No internet, or the backend is down. The hosted one sleeps when idle and takes about a minute to wake. |
| Couldn't find the tempo of any song in this playlist | Pick a playlist with better-known songs: tempos are found by title + artist. |
| Connect account shows a WHOOP error about the redirect | The Redirect URL in the WHOOP dashboard must exactly match `https://<your domain>/whoop/callback`. |

**Working on the backend?** `./dev.sh` (macOS/Linux) or `.\dev.ps1` (Windows) from the repo root does the first-time setup and starts FastAPI on port 8000 and the Expo dev server. Add `--no-whoop` / `-NoWhoop`: the laptop heart rate process it otherwise starts isn't used by the app anymore. To connect WHOOP accounts through your own backend, put `WHOOP_CLIENT_ID` and `WHOOP_CLIENT_SECRET` in `backend/.env` (ask the team; never commit them) and see the next section.

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

In the app, **WHOOP → Connect account** opens Whoop's login, then returns to the app showing **Connected** and your own HR zones. The first visit may show an ngrok "You are about to visit" page; tap **Visit Site**. Each phone gets its own anonymous ID, so every teammate can connect their own Whoop.

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

The app needs a build installed on the iPhone: Expo Go can't play Apple Music or use Bluetooth. Rebuild only when native code, native packages or `app.json` change. For JavaScript changes, keep `npx expo start` running and the Debug build reloads.

Without a paid Apple Developer account, the only way is a **Mac with Xcode** and a free Apple ID: plug in the iPhone and run `npx expo run:ios --device` in `mobile/`. Apps signed this way expire after 7 days (just run it again). With a paid account, EAS can build in the cloud from any computer:

```bash
cd mobile
npm install
npx eas-cli@latest build --profile development --platform ios   # cloud build, install on your iPhone
npx expo start                                                  # then open the dev build app
```

The iOS Simulator has no Bluetooth, GPS or Music library, so use a real iPhone.

**WHOOP:** in the WHOOP app, turn on **Heart Rate Broadcast** in your device settings, then tap **Connect band**.

#### How the BPM app fits together (`mobile/src`)
| Folder | What's there |
|---|---|
| `runtime.ts` | `isExpoGo` flag: switches Bluetooth and background GPS off in Expo Go |
| `app/` | Expo Router screens: `index` (setup), `playlists` (pick the playlist), `workout` (live), `summary` (after a run), `runs` / `run` (past runs) |
| `sources/` | `whoopBle` (live HR over Bluetooth), `pedometer` (cadence), `location` (pace + background), `route` (GPS track of the run) |
| `engine/` | `controller.ts` (pure BPM rules), `workout.ts` (start/stop + the sensor → BPM loop), `pace.ts` (running pace from GPS), `summary.ts` (run stats) |
| `audio/` | `music.ts` (what the workout loop calls), `appleMusicOutput.ts` (plays the chosen playlist: songs picked by tempo, sped up or slowed down) |
| `store/` | Zustand stores: `bio` (live biometrics), `session` (zone, playlist, target BPM, log) |

### Phone can't connect? (common on hackathon Wi-Fi)

A Debug build loads the app from the laptop and uses the laptop's backend. Venue and campus Wi-Fi often block device-to-device traffic. Fixes, in order:
1. Put your phone and laptop on the same **phone hotspot**.
2. Start Expo with `npx expo start --tunnel`, then expose the backend with `ngrok http 8000` and put the ngrok URL in `mobile/.env` as `EXPO_PUBLIC_API_URL=...` (restart Expo).
3. Install a **Release** build instead: it has the code built in and uses the hosted backend.

---

## Team workflow (3 people)

### Suggested roles
| Person | Owns | Mostly touches |
|---|---|---|
| **A: Mobile/UI** | Screens, navigation, look and feel | `mobile/src/app`, `mobile/src/components`, `mobile/src/theme.ts` |
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
- **Apple Music player (playlist, song choice, speed):** `mobile/src/audio/appleMusicOutput.ts`, native side in `mobile/modules/apple-music/`. Details in `docs/APPLE_MUSIC.md`
- **Song tempos (lookup by title + artist):** `backend/app/tempo.py`, `POST /tempo/lookup` in `routes/coach.py`
- **WHOOP account + history:** `backend/app/whoop.py`, `routes/whoop.py`. Live heart rate over Bluetooth: `mobile/src/sources/whoopBle.ts`. Setup in `docs/WHOOP.md`
- **GPS pace and routes:** `mobile/src/engine/pace.ts` (pace for the coach), `mobile/src/sources/route.ts` + `backend/app/routes/runs.py` (recorded runs, Past runs screen)
- **New endpoint:** add a router in `backend/app/routes/` (see `live.py` for a small one)
- **New screen:** add a file to `mobile/src/app/` (Expo Router)
- **BPM rules (step size, cooldown, limits):** `TEMPO_CONTROL` / `SONG_ROTATE` in `mobile/src/engine/controller.ts`
- **Colors and spacing:** `mobile/src/theme.ts`

## Deploying
The backend is hosted on Render (free plan) with a Neon Postgres database for WHOOP logins and saved runs: `https://bpm-backend-bx41.onrender.com`. Release builds of the app use it automatically. Render deploys the `render` branch, a copy of `main`; setup and updating are in `docs/DEPLOY.md`.

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
