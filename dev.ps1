# Starts everything for the BPM app on Windows, each in its own window:
#   1. FastAPI backend   2. Whoop -> laptop live HR relay   3. Expo (scan the QR with your iPhone)
#
# Usage (from the repo root, in PowerShell):
#   .\dev.ps1              # everything
#   .\dev.ps1 -NoWhoop     # skip the live HR relay (use "Simulated" HR in the app)
#   .\dev.ps1 -Tunnel      # Expo tunnel mode, for Wi-Fi that blocks phone <-> laptop traffic
#
# If PowerShell refuses to run scripts, run once:
#   Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
param(
    [switch]$NoWhoop,
    [switch]$Tunnel
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

# ---- 1. Backend ----
Start-Window "BPM backend" $backend "& '$py' -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000"

# ---- 2. Whoop live HR relay (waits for the backend first) ----
if (-not $NoWhoop) {
    $wait = "while (-not (Test-NetConnection localhost -Port 8000 -InformationLevel Quiet -WarningAction SilentlyContinue)) { Start-Sleep 1 }"
    Write-Host "Whoop app -> Device Settings -> Heart Rate Broadcast -> Start, then keep the band near this laptop." -ForegroundColor Yellow
    Start-Window "BPM Whoop live HR" $backend "$wait; & '$py' scripts\whoop_live_hr.py"
}

# ---- 3. Expo ----
$expo = if ($Tunnel) { "npx expo start --tunnel" } else { "npx expo start" }
Start-Window "BPM Expo" $mobile $expo

Write-Host ""
Write-Host "Started. Scan the QR code in the 'BPM Expo' window with your iPhone Camera." -ForegroundColor Green
Write-Host "First time only: open http://localhost:8000/whoop/login on this laptop to connect your Whoop account."
Write-Host "Close the windows (or Ctrl+C in each) to stop."
