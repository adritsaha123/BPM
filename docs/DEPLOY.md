# Deploy the backend (Render + Neon, free)

Runs the backend in the cloud so the phone works on any network without your laptop hosting it.
Spotify and WHOOP logins are saved in a free Neon Postgres database, because Render's free disk is
wiped on every restart and deploy.

```
iPhone app ──https──▶ Render (FastAPI, render.yaml) ──▶ Spotify / WHOOP / ReccoBeats
                              │
                              └──▶ Neon Postgres (oauth_tokens table: one row per login)
```

Free-plan catch: Render puts the service to sleep after ~15 minutes without requests. The next
request wakes it and takes ~30-60 s. Open the app a minute before a demo.

## 1. Database (Neon)
1. Sign up at **https://neon.tech** (free) and create a project (any name, region near you).
2. Copy the **connection string** (Dashboard → Connect). It looks like
   `postgresql://user:password@ep-xxx.region.aws.neon.tech/neondb?sslmode=require`.
   Treat it like a password. The backend creates its table on first use.

## 2. Backend (Render)
The branch Render deploys must be on GitHub (default: `main`).
1. Sign up at **https://render.com** with GitHub and allow access to this repo.
2. **New → Blueprint**, pick this repo. Render reads `render.yaml` and asks for the secret values:

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | the Neon connection string |
   | `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | same as `backend/.env` |
   | `SPOTIFY_REDIRECT_URI` | `https://<service>.onrender.com/spotify/callback` |
   | `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET` | same as `backend/.env` |
   | `WHOOP_REDIRECT_URI` | `https://<service>.onrender.com/whoop/callback` |
   | `ANTHROPIC_API_KEY` | optional (blank = mock AI) |

   Don't know the service URL yet? Enter a placeholder, deploy, copy the URL from the service page
   (e.g. `https://bpm-backend-ab12.onrender.com`), then fix both redirect values under
   **Environment** and save (Render redeploys).
3. Check **https://\<service\>.onrender.com/health** shows `"status":"ok"`, `"spotify":"not_connected"` or `"live"`.

## 3. Redirect URLs on the developer dashboards
Each service only sends people back to addresses you list:
- **Spotify** (developer.spotify.com/dashboard → your app → Settings → Redirect URIs): add
  `https://<service>.onrender.com/spotify/callback`. Keep the 127.0.0.1 one for laptop use.
  Also make sure every Spotify account that will log in is under **User Management**.
- **WHOOP** (developer-dashboard.whoop.com → BPM → Redirect URLs): add
  `https://<service>.onrender.com/whoop/callback`.

## 4. Point the app at it
```powershell
setx BPM_CLOUD_URL "https://<service>.onrender.com"   # once; reopen PowerShell after
.\dev.ps1                                              # or: .\dev.ps1 -Cloud https://<service>.onrender.com
```
With a cloud URL, `dev.ps1` starts only Expo (plus the Whoop relay, which now sends heart rate to
the cloud). No local backend, no ngrok. For a standalone build, put
`EXPO_PUBLIC_API_URL=https://<service>.onrender.com` in `mobile/.env` before building.

## 5. Connect accounts in the app
On the setup screen: **Whoop account → Connect Whoop account**, and **Music → Spotify → Connect Spotify**.
Each phone gets its own logins (keyed by an anonymous per-install id).

## Notes
- Live heart rate from the laptop relay (`/live/hr`) is shared by everyone using the backend.
  Fine for one runner; a phone build reading the band itself avoids the laptop entirely.
- Logins made on the laptop (files in `backend/`) aren't copied to the cloud; connect again in the app.
- Changing code: push to the deployed branch and Render redeploys automatically.
