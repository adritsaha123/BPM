import { api, API_URL } from "../api";
import { useBio } from "../store/bio";

/**
 * Live Whoop HR relayed through the laptop (works in Expo Go — no Bluetooth on the phone):
 *   Whoop band ──BLE──▶ backend/scripts/whoop_live_hr.py ──POST /live/hr──▶ FastAPI ◀──GET /live/hr── this poller
 * See docs/WHOOP.md. The band must stay within Bluetooth range of the laptop.
 */
const POLL_MS = 1000;
const FRESH_S = 5; // older than this = the laptop script stopped or the band went out of range

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
let lastReadingTs: number | null = null; // laptop clock; only used to skip duplicates

const bio = () => useBio.getState();

async function poll() {
  if (inFlight) return; // slow network: don't stack requests
  inFlight = true;
  try {
    const live = await api.liveHr(10);
    const latest = live.recent[live.recent.length - 1];

    if (live.bpm == null || live.age_s == null || !latest) {
      bio().setHrStatus("scanning", {
        device: null,
        error: "Backend reached. Waiting for the laptop script: python scripts/whoop_live_hr.py",
      });
      return;
    }
    if (live.age_s > FRESH_S) {
      bio().setHrStatus("disconnected", {
        error: `Last reading ${Math.round(live.age_s)}s ago. Is the laptop script running and the band nearby?`,
      });
      return;
    }

    if (bio().hrStatus !== "connected") bio().setHrStatus("connected", { device: `Laptop relay · ${live.source ?? "HR"}` });
    if (latest.ts !== lastReadingTs) {
      lastReadingTs = latest.ts;
      // Timestamp with the phone's clock (age_s avoids laptop/phone clock skew).
      bio().pushHr(live.bpm, Date.now() - live.age_s * 1000);
    }
  } catch {
    bio().setHrStatus("error", { device: null, error: `Can't reach the backend at ${API_URL}. Is uvicorn running?` });
  } finally {
    inFlight = false;
  }
}

export const relayHr = {
  /** Idempotent: safe to call from the setup screen and again at workout start. */
  start() {
    if (timer) return;
    lastReadingTs = null;
    bio().setHrStatus("connecting", { device: null });
    poll();
    timer = setInterval(poll, POLL_MS);
  },

  stop() {
    if (timer) clearInterval(timer);
    timer = null;
    bio().setHrStatus("idle", { device: null });
  },

  get running() {
    return timer != null;
  },
};
