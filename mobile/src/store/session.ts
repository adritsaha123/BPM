import { create } from "zustand";

import { isExpoGo } from "../runtime";

export type ZoneMode = "hr" | "pace";

/** For "hr": bpm. For "pace": seconds per km (min = faster, max = slower). */
export type Zone = { min: number; max: number };

/**
 * Where live HR comes from:
 *  - "laptop": Whoop → laptop Bluetooth → backend relay (works in Expo Go)
 *  - "phone":  Whoop → phone Bluetooth (development build only)
 *  - "sim":    simulated HR that follows cadence
 */
export type HrSource = "laptop" | "phone" | "sim";

/** Where the music comes from: bundled tracks (smooth tempo shifts) or Spotify (real songs by tempo). */
export type MusicSource = "builtin" | "spotify" | "dj";

export type Adjustment = { at: number; from: number; to: number; reason: string };

type SessionState = {
  status: "idle" | "running";
  mode: ZoneMode;
  hrZone: Zone;
  paceZone: Zone;
  hrSource: HrSource;
  /** Simulated cadence + pace instead of the phone's pedometer/GPS (for testing at a desk). */
  simMotion: boolean;
  musicSource: MusicSource;
  startedAt: number | null;

  // Music engine output (written by engine/audio, read by UI)
  targetBpm: number;
  trackTitle: string | null;
  playbackRate: number;
  musicPaused: boolean;
  adjustments: Adjustment[];

  setMode: (m: ZoneMode) => void;
  setZone: (mode: ZoneMode, zone: Zone) => void;
  setHrSource: (v: HrSource) => void;
  setSimMotion: (v: boolean) => void;
  setMusicSource: (v: MusicSource) => void;
  setRunning: (running: boolean) => void;
  setTargetBpm: (bpm: number, reason: string) => void;
  setNowPlaying: (title: string, rate: number) => void;
  setMusicPaused: (paused: boolean) => void;
};

export const useSession = create<SessionState>()((set, get) => ({
  status: "idle",
  mode: "hr",
  hrZone: { min: 140, max: 155 },
  paceZone: { min: 300, max: 360 }, // 5:00–6:00 /km
  hrSource: isExpoGo ? "laptop" : "phone",
  simMotion: false,
  musicSource: "builtin",
  startedAt: null,

  targetBpm: 160,
  trackTitle: null,
  playbackRate: 1,
  musicPaused: false,
  adjustments: [],

  setMode: (mode) => set({ mode }),
  setZone: (mode, zone) => set(mode === "hr" ? { hrZone: zone } : { paceZone: zone }),
  setHrSource: (hrSource) => {
    if (hrSource === "phone" && isExpoGo) return; // phone Bluetooth needs a development build
    set({ hrSource });
  },
  setSimMotion: (simMotion) => set({ simMotion }),
  setMusicSource: (musicSource) => set({ musicSource }),
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
  setMusicPaused: (musicPaused) => set({ musicPaused }),
}));
