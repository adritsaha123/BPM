# Starts everything for the BPM app on Windows, each in its own window:
#   1. FastAPI backend   2. Whoop -> laptop live HR relay   3. Expo (scan the QR with your iPhone)
#
# Usage (from the repo root, in PowerShell):
#   .\dev.ps1              # everything
#   .\dev.ps1 -NoWhoop     # skip the live HR relay (use "Simulated" HR in the app)
#   .\dev.ps1 -Tunnel      # Expo tunnel mode, for Wi-Fi that blocks phone <-> laptop traffic
#   .\dev.ps1 -NgrokDomain your-name.ngrok-free.app
#                          # public https backend via ngrok: enables "Connect Whoop" in the app
#                          # and works without being on the same Wi-Fi (or set $env:BPM_NGROK_DOMAIN)
#
# If PowerShell refuses to run scripts, run once:
#   Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
param(
    [switch]$NoWhoop,
    [switch]$Tunnel,
    [string]$NgrokDomain = $env:BPM_NGROK_DOMAIN
)
$ErrorActionPreference = "Stop"

$root    = $PSScriptRoot
$backend = Join-Path $root "backend"
$mobile  = Join-Path $root "mobile"
$py      = Join-Path $backend ".venv\Scripts\python.exe"

# ---- First-run setup (skipped when already done) ----
if (-not (Test-Path $py)) {
    Write-Host "Creating backend virtualenv and installing packages..." -ForegroundColor Cyan
    python -m venv (Join-Path $backend ".venv")
    & $py -m pip install -q -r (Join-Path $backend "requirements.txt") -r (Join-Path $backend "requirements-ble.txt")
}
if (-not (Test-Path (Join-Path $backend ".env"))) {
    Copy-Item (Join-Path $backend ".env.example") (Join-Path $backend ".env")
    Write-Host "Created backend\.env from .env.example. Add WHOOP_CLIENT_ID / WHOOP_CLIENT_SECRET for real Whoop data." -ForegroundColor Yellow
}
if (-not (Test-Path (Join-Path $mobile "node_modules"))) {
    Write-Host "Installing mobile packages..." -ForegroundColor Cyan
    Push-Location $mobile; npm install; Pop-Location
}

function Start-Window([string]$title, [string]$dir, [string]$command) {
    $full = "`$Host.UI.RawUI.WindowTitle = '$title'; Set-Location '$dir'; $command"
    Start-Process powershell -ArgumentList "-NoExit", "-Command", $full | Out-Null
}

# ---- 0. Optional public URL (ngrok) ----
$publicEnv = ""
$appEnv = ""
if ($NgrokDomain) {
    if (-not (Get-Command ngrok -ErrorAction SilentlyContinue)) {
        throw "ngrok not found. Install it (winget install ngrok.ngrok), run 'ngrok config add-authtoken <token>', then retry."
    }
    $publicUrl = "https://$NgrokDomain"
    # Environment variables override backend/.env and mobile/.env for these windows only.
    $publicEnv = "`$env:WHOOP_REDIRECT_URI = '$publicUrl/whoop/callback'; "
    $appEnv = "`$env:EXPO_PUBLIC_API_URL = '$publicUrl'; "
    Start-Window "BPM ngrok" $root "ngrok http 8000 --url=$NgrokDomain"
    Write-Host "Public backend: $publicUrl  (WHOOP redirect URL must be $publicUrl/whoop/callback)" -ForegroundColor Cyan
}

# ---- 1. Backend ----
Start-Window "BPM backend" $backend "$publicEnv& '$py' -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000"

# ---- 2. Whoop live HR relay (waits for the backend first) ----
if (-not $NoWhoop) {
    $wait = "while (-not (Test-NetConnection localhost -Port 8000 -InformationLevel Quiet -WarningAction SilentlyContinue)) { Start-Sleep 1 }"
    Write-Host "Whoop app -> Device Settings -> Heart Rate Broadcast -> Start, then keep the band near this laptop." -ForegroundColor Yellow
    Start-Window "BPM Whoop live HR" $backend "$wait; & '$py' scripts\whoop_live_hr.py"
}

# ---- 3. Expo ----
$expo = if ($Tunnel) { "npx expo start --tunnel" } else { "npx expo start" }
Start-Window "BPM Expo" $mobile "$appEnv$expo"

Write-Host ""
Write-Host "Started. Scan the QR code in the 'BPM Expo' window with your iPhone Camera." -ForegroundColor Green
if ($NgrokDomain) {
    Write-Host "Connect Whoop from the app's 'Whoop account' card (first visit may show an ngrok warning page: tap Visit Site)."
} else {
    Write-Host "Whoop account: open http://localhost:8000/whoop/login on this laptop, or use -NgrokDomain to connect from the app."
}
Write-Host "Close the windows (or Ctrl+C in each) to stop."
