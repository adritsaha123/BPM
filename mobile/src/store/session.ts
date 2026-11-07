import { create } from "zustand";

export type ZoneMode = "hr" | "pace";

/** For "hr": bpm. For "pace": seconds per km (min = faster, max = slower). */
export type Zone = { min: number; max: number };

export type Adjustment = { at: number; from: number; to: number; reason: string };

type SessionState = {
  status: "idle" | "running";
  mode: ZoneMode;
  hrZone: Zone;
  paceZone: Zone;
  useMock: boolean;
  startedAt: number | null;

  // Music engine output (written by engine/audio, read by UI)
  targetBpm: number;
  trackTitle: string | null;
  playbackRate: number;
  adjustments: Adjustment[];

  setMode: (m: ZoneMode) => void;
  setZone: (mode: ZoneMode, zone: Zone) => void;
  setUseMock: (v: boolean) => void;
  setRunning: (running: boolean) => void;
  setTargetBpm: (bpm: number, reason: string) => void;
  setNowPlaying: (title: string, rate: number) => void;
};

export const useSession = create<SessionState>()((set, get) => ({
  status: "idle",
  mode: "hr",
  hrZone: { min: 140, max: 155 },
  paceZone: { min: 300, max: 360 }, // 5:00–6:00 /km
  useMock: false,
  startedAt: null,

  targetBpm: 160,
  trackTitle: null,
  playbackRate: 1,
  adjustments: [],

  setMode: (mode) => set({ mode }),
  setZone: (mode, zone) => set(mode === "hr" ? { hrZone: zone } : { paceZone: zone }),
  setUseMock: (useMock) => set({ useMock }),
  setRunning: (running) =>
    set(
      running
        ? { status: "running", startedAt: Date.now(), adjustments: [] }
        : { status: "idle", startedAt: null },
    ),
  setTargetBpm: (bpm, reason) => {
    const from = get().targetBpm;
    if (bpm === from) return;
    set({
      targetBpm: bpm,
      adjustments: [{ at: Date.now(), from, to: bpm, reason }, ...get().adjustments].slice(0, 20),
    });
  },
  setNowPlaying: (trackTitle, playbackRate) => set({ trackTitle, playbackRate }),
}));
