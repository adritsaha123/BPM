import * as SecureStore from "expo-secure-store";
import { create } from "zustand";

import type { AppleMusicPlaylist } from "../../modules/apple-music";
import type { WorkoutSummary } from "../engine/summary";

export type ZoneMode = "hr" | "pace";

/** For "hr": bpm. For "pace": seconds per km (min = faster, max = slower). */
export type Zone = { min: number; max: number };

export type Adjustment = { at: number; from: number; to: number; reason: string };

/** The Apple Music playlist the workout plays from (remembered between launches). */
export type Playlist = AppleMusicPlaylist;

const PLAYLIST_KEY = "bpm.playlist";

type SessionState = {
  status: "idle" | "running";
  mode: ZoneMode;
  hrZone: Zone;
  paceZone: Zone;
  playlist: Playlist | null;
  startedAt: number | null;

  // Music engine output (written by engine/audio, read by UI)
  targetBpm: number;
  trackTitle: string | null;
  /** file:// URI of the playing song's cover */
  trackArt: string | null;
  playbackRate: number;
  musicPaused: boolean;
  adjustments: Adjustment[];
  /** Things the runner should know during this workout, e.g. "Location access is off". */
  notices: string[];
  /** Stats of the last finished workout (summary screen). */
  lastSummary: WorkoutSummary | null;

  setMode: (m: ZoneMode) => void;
  setZone: (mode: ZoneMode, zone: Zone) => void;
  setPlaylist: (p: Playlist | null) => void;
  setRunning: (running: boolean) => void;
  setTargetBpm: (bpm: number, reason: string) => void;
  setNowPlaying: (title: string | null, rate: number, art?: string | null) => void;
  setMusicPaused: (paused: boolean) => void;
  setNotices: (notices: string[]) => void;
  addNotice: (notice: string) => void;
  setLastSummary: (summary: WorkoutSummary | null) => void;
};

export const useSession = create<SessionState>()((set, get) => ({
  status: "idle",
  mode: "hr",
  hrZone: { min: 140, max: 155 },
  paceZone: { min: 300, max: 360 }, // 5:00–6:00 /km
  playlist: null,
  startedAt: null,

  targetBpm: 160,
  trackTitle: null,
  trackArt: null,
  playbackRate: 1,
  musicPaused: false,
  adjustments: [],
  notices: [],
  lastSummary: null,

  setMode: (mode) => set({ mode }),
  setZone: (mode, zone) => set(mode === "hr" ? { hrZone: zone } : { paceZone: zone }),
  setPlaylist: (playlist) => {
    set({ playlist });
    // Not the cover: it is a file path, and that changes when the app is reinstalled.
    const saved = playlist ? JSON.stringify({ id: playlist.id, name: playlist.name, count: playlist.count }) : null;
    (saved ? SecureStore.setItemAsync(PLAYLIST_KEY, saved) : SecureStore.deleteItemAsync(PLAYLIST_KEY)).catch(() => {});
  },
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
  setNowPlaying: (trackTitle, playbackRate, art) =>
    set(art === undefined ? { trackTitle, playbackRate } : { trackTitle, playbackRate, trackArt: art }),
  setMusicPaused: (musicPaused) => set({ musicPaused }),
  setNotices: (notices) => set({ notices }),
  addNotice: (notice) => set({ notices: [...get().notices.filter((n) => n !== notice), notice] }),
  setLastSummary: (lastSummary) => set({ lastSummary }),
}));

/** The playlist picked last time, or null. */
export async function savedPlaylist(): Promise<Playlist | null> {
  try {
    const raw = await SecureStore.getItemAsync(PLAYLIST_KEY);
    const p = raw ? (JSON.parse(raw) as Partial<Playlist>) : null;
    return p?.id && p.name ? { id: p.id, name: p.name, count: p.count ?? 0 } : null;
  } catch {
    return null;
  }
}
