import type { BleManager, Device, Subscription } from "react-native-ble-plx";

import { isExpoGo } from "../runtime";
import { useBio } from "../store/bio";

/**
 * Live HR from Whoop "Broadcast Heart Rate" (Whoop app → Device settings → Heart Rate Broadcast).
 * Whoop then advertises the standard BLE Heart Rate Service, so any BLE chest strap works too.
 */
const HR_SERVICE = "0000180d-0000-1000-8000-00805f9b34fb";
const HR_MEASUREMENT = "00002a37-0000-1000-8000-00805f9b34fb";
const SCAN_TIMEOUT_MS = 20_000;
const RECONNECT_DELAY_MS = 2_000;

let manager: BleManager | null = null;
let device: Device | null = null;
let hrSub: Subscription | null = null;
let disconnectSub: Subscription | null = null;
let scanTimer: ReturnType<typeof setTimeout> | null = null;
let wantConnected = false;

const bio = () => useBio.getState();

// Loaded lazily: importing react-native-ble-plx at module level crashes Expo Go.
type BleModule = typeof import("react-native-ble-plx");
let ble: BleModule | null = null;
function getManager(): BleManager {
  ble ??= require("react-native-ble-plx") as BleModule;
  return (manager ??= new ble.BleManager());
}

/** Parse a Heart Rate Measurement (0x2A37) value. Byte 0 = flags; bit 0 → HR is uint16. */
export function parseHrMeasurement(base64: string): number | null {
  const bytes = base64ToBytes(base64);
  if (bytes.length < 2) return null;
  const is16 = (bytes[0] & 0x01) === 1;
  if (is16) return bytes.length >= 3 ? bytes[1] | (bytes[2] << 8) : null;
  return bytes[1];
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64ToBytes(b64: string): number[] {
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of b64.replace(/=+$/, "")) {
    const v = B64.indexOf(ch);
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return out;
}

async function waitForPoweredOn(m: BleManager): Promise<boolean> {
  const { State } = ble!;
  const state = await m.state();
  if (state === State.PoweredOn) return true;
  if (state === State.PoweredOff || state === State.Unauthorized || state === State.Unsupported) return false;
  // Unknown/Resetting right after launch: wait briefly for the real state.
  return new Promise((resolve) => {
    const sub = m.onStateChange((s) => {
      if (s === State.Unknown || s === State.Resetting) return;
      sub.remove();
      resolve(s === State.PoweredOn);
    }, true);
  });
}

async function connectTo(d: Device) {
  bio().setHrStatus("connecting", { device: d.name ?? d.id });
  try {
    const connected = await d.connect({ timeout: 10_000 });
    await connected.discoverAllServicesAndCharacteristics();
    device = connected;

    hrSub?.remove();
    hrSub = connected.monitorCharacteristicForService(HR_SERVICE, HR_MEASUREMENT, (err, c) => {
      if (err || !c?.value) return; // disconnect errors are handled by onDisconnected
      const hr = parseHrMeasurement(c.value);
      if (hr != null) bio().pushHr(hr);
    });

    disconnectSub?.remove();
    disconnectSub = connected.onDisconnected(() => {
      hrSub?.remove();
      hrSub = null;
      bio().setHrStatus("disconnected");
      if (wantConnected) setTimeout(() => wantConnected && connectTo(connected), RECONNECT_DELAY_MS);
    });

    bio().setHrStatus("connected", { device: connected.name ?? connected.id });
  } catch (e) {
    bio().setHrStatus("error", { error: `Connect failed: ${String(e)}` });
    if (wantConnected) setTimeout(() => wantConnected && connectTo(d), RECONNECT_DELAY_MS);
  }
}

export const whoopHr = {
  /** Scan for a Whoop (or any BLE HR strap) and stay connected, auto-reconnecting. */
  /** False in Expo Go: Bluetooth needs a development build. */
  available: !isExpoGo,

  async connect() {
    if (isExpoGo) {
      bio().setHrStatus("error", { error: "Whoop needs a development build — Expo Go can't use Bluetooth." });
      return;
    }
    wantConnected = true;
    const m = getManager();
    if (!(await waitForPoweredOn(m))) {
      bio().setHrStatus("bluetooth-off", { error: "Turn on Bluetooth and allow access in Settings." });
      return;
    }
    if (device && (await device.isConnected())) return bio().setHrStatus("connected");

    bio().setHrStatus("scanning", { device: null });
    let fallback: Device | null = null;

    const finish = (d: Device | null) => {
      if (scanTimer) clearTimeout(scanTimer);
      scanTimer = null;
      m.stopDeviceScan();
      if (d) connectTo(d);
      else
        bio().setHrStatus("error", {
          error: "No heart-rate broadcast found. In the Whoop app, turn on Heart Rate Broadcast.",
        });
    };

    scanTimer = setTimeout(() => finish(fallback), SCAN_TIMEOUT_MS);
    m.startDeviceScan([HR_SERVICE], null, (err, d) => {
      if (err) {
        if (scanTimer) clearTimeout(scanTimer);
        bio().setHrStatus("error", { error: err.message });
        return;
      }
      if (!d) return;
      // Prefer a Whoop; remember any other HR strap as a fallback.
      if ((d.name ?? d.localName ?? "").toUpperCase().includes("WHOOP")) finish(d);
      else fallback ??= d;
    });
  },

  async disconnect() {
    wantConnected = false;
    if (scanTimer) clearTimeout(scanTimer);
    manager?.stopDeviceScan();
    hrSub?.remove();
    disconnectSub?.remove();
    hrSub = disconnectSub = null;
    if (device) await device.cancelConnection().catch(() => {});
    device = null;
    bio().setHrStatus("idle", { device: null });
  },
};
