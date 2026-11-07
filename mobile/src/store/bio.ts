import { create } from "zustand";

/**
 * Live biometrics. Sensors write here from OUTSIDE React via `useBio.getState().pushX()`.
 * Components must select single fields (`useBio(s => s.hr)`) so a new HR sample
 * only re-renders what shows HR.
 */

export type HrStatus = "idle" | "bluetooth-off" | "scanning" | "connecting" | "connected" | "disconnected" | "error";

type BioState = {
  // Heart rate (Whoop BLE or mock)
  hr: number | null; // smoothed bpm
  hrAt: number; // ms timestamp of last raw sample
  hrStatus: HrStatus;
  hrDevice: string | null;
  hrError: string | null;

  // Cadence (iPhone pedometer)
  cadence: number | null; // steps per minute

  // Pace (iPhone GPS)
  speed: number | null; // m/s, smoothed
  paceSecPerKm: number | null;

  pushHr: (bpm: number, at?: number) => void;
  pushCadence: (spm: number) => void;
  pushSpeed: (mps: number) => void;
  setHrStatus: (status: HrStatus, extra?: { device?: string | null; error?: string | null }) => void;
  reset: () => void;
};

// Raw HR window lives outside the store: it changes every sample and nothing renders it.
const HR_WINDOW_MS = 5_000;
let hrWindow: { t: number; v: number }[] = [];

const ema = (prev: number | null, next: number, alpha: number) => (prev == null ? next : prev + alpha * (next - prev));

const initial = {
  hr: null,
  hrAt: 0,
  hrStatus: "idle" as HrStatus,
  hrDevice: null,
  hrError: null,
  cadence: null,
  speed: null,
  paceSecPerKm: null,
};

export const useBio = create<BioState>()((set, get) => ({
  ...initial,

  pushHr: (bpm, at = Date.now()) => {
    if (bpm < 30 || bpm > 230) return; // sensor garbage
    hrWindow.push({ t: at, v: bpm });
    hrWindow = hrWindow.filter((s) => at - s.t <= HR_WINDOW_MS);
    const avg = hrWindow.reduce((a, s) => a + s.v, 0) / hrWindow.length;
    set({ hr: Math.round(avg), hrAt: at });
  },

  pushCadence: (spm) => set({ cadence: Math.round(ema(get().cadence, spm, 0.4)) }),

  pushSpeed: (mps) => {
    if (mps < 0) return; // iOS reports -1 when speed is unknown
    const speed = ema(get().speed, mps, 0.3);
    set({ speed, paceSecPerKm: speed > 0.5 ? Math.round(1000 / speed) : null });
  },

  setHrStatus: (hrStatus, extra) =>
    set({
      hrStatus,
      ...(extra?.device !== undefined ? { hrDevice: extra.device } : {}),
      hrError: extra?.error ?? null,
    }),

  reset: () => {
    hrWindow = [];
    set({ ...initial, hrStatus: get().hrStatus, hrDevice: get().hrDevice });
  },
}));

export const HR_STALE_MS = 6_000;
export const isHrFresh = (s: Pick<BioState, "hrAt">, now = Date.now()) => now - s.hrAt < HR_STALE_MS;
