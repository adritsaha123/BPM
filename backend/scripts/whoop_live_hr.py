"""Stream live heart rate from a WHOOP band into the backend, over Bluetooth.

Setup (once, on the laptop):
    1. WHOOP app -> Device Settings -> Heart Rate Broadcast -> Start (band light flashes blue)
    2. cd backend && source .venv/bin/activate && pip install -r requirements-ble.txt
Run (backend running on :8000 in another terminal):
    python scripts/whoop_live_hr.py              # read + POST to http://localhost:8000/live/hr
    python scripts/whoop_live_hr.py --no-post    # just print bpm
    python scripts/whoop_live_hr.py --name ""    # take the first heart rate monitor found

Works with any standard Bluetooth heart rate monitor, not only WHOOP.
macOS asks your terminal app for Bluetooth permission the first time; allow it.
"""

import argparse
import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402
from bleak import BleakClient, BleakScanner  # noqa: E402

from app.ble_hr import HR_MEASUREMENT_UUID, HR_SERVICE_UUID, parse_hr_measurement  # noqa: E402


async def find_device(name_hint: str, scan_s: float):
    print(f"Scanning {scan_s:.0f}s for Bluetooth heart rate monitors...")
    found = await BleakScanner.discover(timeout=scan_s, service_uuids=[HR_SERVICE_UUID], return_adv=True)
    candidates = list(found.values())
    for dev, adv in candidates:
        print(f"  found: {dev.name or adv.local_name or '(no name)'}  {dev.address}  rssi={adv.rssi}")
    hint = name_hint.lower()
    for dev, adv in candidates:
        if hint and hint in (dev.name or adv.local_name or "").lower():
            return dev
    if hint and candidates:
        print(f"No device name contains '{name_hint}', using the first one found.")
    return candidates[0][0] if candidates else None


async def stream(args: argparse.Namespace) -> int:
    device = await find_device(args.name, args.scan)
    while device is None:  # keep looking: broadcast may be switched on after this starts
        print("No heart rate monitor found yet. Is Heart Rate Broadcast on (blue light) and the band nearby?")
        print("Scanning again (Ctrl+C to stop)...")
        device = await find_device(args.name, args.scan)

    api = None if args.no_post else httpx.AsyncClient(base_url=args.api, timeout=3)
    source = device.name or "ble"
    warned = False

    async def on_hr(_sender, data: bytearray) -> None:
        nonlocal warned
        m = parse_hr_measurement(bytes(data))
        rr = f"  rr={m['rr_ms']}" if m["rr_ms"] else ""
        print(f"{time.strftime('%H:%M:%S')}  {m['bpm']:>3} bpm{rr}", flush=True)
        if api is None:
            return
        try:
            await api.post("/live/hr", json={"bpm": m["bpm"], "rr_ms": m["rr_ms"], "source": source})
            warned = False
        except httpx.HTTPError as exc:
            if not warned:
                print(f"  (can't reach backend at {args.api}: {exc.__class__.__name__}; still reading)")
                warned = True

    while True:
        disconnected = asyncio.Event()
        try:
            async with BleakClient(
                device, disconnected_callback=lambda _c, ev=disconnected: ev.set()
            ) as client:
                print(f"Connected to {source}. Streaming, Ctrl+C to stop.")
                await client.start_notify(HR_MEASUREMENT_UUID, on_hr)
                await disconnected.wait()
            print("Band disconnected. Reconnecting in 3s...")
        except Exception as exc:  # BLE drops are common; keep the demo alive
            print(f"Connection problem ({exc.__class__.__name__}: {exc}). Retrying in 3s...")
        await asyncio.sleep(3)


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--api", default="http://localhost:8000", help="Backend base URL")
    parser.add_argument("--name", default="whoop", help="Pick the device whose name contains this")
    parser.add_argument("--scan", type=float, default=15, help="Seconds per scan (repeats until found)")
    parser.add_argument("--no-post", action="store_true", help="Print only, don't send to the backend")
    try:
        return asyncio.run(stream(parser.parse_args()))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
