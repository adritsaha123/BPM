import Constants from "expo-constants";
import { Platform } from "react-native";

/**
 * Where is the backend?
 * 1. EXPO_PUBLIC_API_URL in mobile/.env wins (use this for ngrok or a deployed URL).
 * 2. Otherwise, in dev we reuse the IP of the laptop running Expo, so a real
 *    phone on the same Wi-Fi reaches FastAPI on port 8000 automatically.
 */
function resolveApiUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, "");

  const host = Constants.expoConfig?.hostUri?.split(":")[0];
  if (host) return `http://${host}:8000`;

  // Android emulator reaches the host machine via 10.0.2.2
  return Platform.OS === "android" ? "http://10.0.2.2:8000" : "http://localhost:8000";
}

export const API_URL = resolveApiUrl();

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

// ---- Typed endpoints (mirror backend/app/routes) ----

export type WhoopMode = "live" | "mock" | "not_connected";
export type SpotifyMode = "live" | "mock" | "not_connected";
export type Health = { status: string; ai: "live" | "mock"; whoop?: WhoopMode; spotify?: SpotifyMode };
export type Item = { id: number; title: string; notes: string };

// ---- WHOOP (history) + live heart rate. See docs/WHOOP.md ----

export type HrZone = { zone: number; min_bpm: number; max_bpm: number };

export type WhoopWorkout = {
  id: string;
  sport: string;
  is_run: boolean;
  start: string;
  end: string;
  duration_min: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  strain: number | null;
  distance_km: number | null;
  pace_min_per_km: number | null;
  zone_minutes: Record<string, number>;
  score_state: string | null;
};

export type WhoopCycle = {
  id: number;
  start: string;
  end: string | null;
  strain: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  step_count: number | null;
};

export type WhoopSummary = {
  mode: WhoopMode;
  days: number;
  max_hr: number | null;
  resting_hr: number | null;
  hrv_ms: number | null;
  recovery_score: number | null;
  zone_method: "heart_rate_reserve" | "percent_of_max";
  hr_zones: HrZone[];
  run_count: number;
  avg_run_hr: number | null;
  avg_run_pace_min_per_km: number | null;
  steps_current_cycle: number | null;
  recent_runs: WhoopWorkout[];
};

export type LiveHr = {
  bpm: number | null;
  source: string | null;
  age_s: number | null;
  avg_bpm: number | null;
  recent: { bpm: number; ts: number }[];
};

// ---- Spotify + live BPM sync (song tempo vs heart rate). See docs/SPOTIFY.md ----

export type TempoMatch = {
  song_bpm: number;
  target_bpm: number;
  /** song_bpm, doubled or halved: whichever is closest to the target */
  effective_bpm: number;
  multiple: 0.5 | 1 | 2;
  diff_bpm: number;
  status: "in_sync" | "close" | "off";
  /** playback rate that would lock it in exactly (Spotify can't change speed: info only) */
  speed_to_match: number;
};

export type SpotifyTrack = {
  id: string;
  uri: string;
  name: string;
  artists: string[];
  album: string | null;
  image: string | null;
  duration_ms: number | null;
  tempo: number | null;
  match?: TempoMatch | null;
};

export type SpotifyPlaylist = {
  id: string; // "liked" = Liked Songs
  name: string;
  image: string | null;
  owner: string | null;
  track_count: number | null;
};

export type TargetSource = "manual" | "heart_rate" | "fallback" | null;

/** Coach mode: the music leads the heart rate toward a training zone. */
export type Coach = {
  zone: number;
  zone_min: number;
  zone_max: number;
  zones_source: "whoop" | "whoop_mock" | "default";
  /** push = music a step faster than your HR, ease = a step slower, hold = matches your HR */
  direction: "push" | "hold" | "ease";
  target_bpm: number;
};

export type HrZones = { zones: HrZone[]; source: "whoop" | "whoop_mock" | "default" };

export type NowPlaying = {
  mode: SpotifyMode;
  is_playing: boolean;
  progress_ms: number | null;
  track: SpotifyTrack | null;
  heart_rate: { bpm: number | null; avg_bpm: number | null; age_s: number | null; live: boolean };
  /** heart rate used for coaching: live, or the simulated one when there's no band */
  current_bpm: number | null;
  /** tempo the music aims for (= current_bpm unless coach mode moves it) */
  target_bpm: number | null;
  target_source: TargetSource;
  coach: Coach | null;
  match: TempoMatch | null;
};

export type MatchList = {
  target_bpm: number | null;
  target_source: TargetSource;
  coach: Coach | null;
  playlist_id: string;
  tracks: SpotifyTrack[];
  no_tempo_count: number;
};

export type SyncOptions = {
  playlistId?: string;
  targetBpm?: number;
  fallbackBpm?: number;
  /** 1-5: coach mode toward this heart rate zone */
  zone?: number | null;
  playNow?: boolean;
};

export type MatchOptions = { playlistId?: string; fallbackBpm?: number; zone?: number | null; limit?: number };

function query(params: Record<string, string | number | null | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

export const api = {
  health: () => request<Health>("/health"),
  chat: (message: string, system?: string) =>
    request<{ reply: string }>("/ai/chat", {
      method: "POST",
      body: JSON.stringify({ message, system }),
    }),
  listItems: () => request<Item[]>("/items"),
  createItem: (title: string, notes = "") =>
    request<Item>("/items", { method: "POST", body: JSON.stringify({ title, notes }) }),
  deleteItem: (id: number) => request<void>(`/items/${id}`, { method: "DELETE" }),

  whoopStatus: () => request<{ mode: WhoopMode; login_url: string }>("/whoop/status"),
  whoopSummary: (days = 30) => request<WhoopSummary>(`/whoop/summary?days=${days}`),
  whoopWorkouts: (days = 30, runsOnly = false) =>
    request<WhoopWorkout[]>(`/whoop/workouts?days=${days}&runs_only=${runsOnly}`),
  whoopCycles: (days = 30) => request<WhoopCycle[]>(`/whoop/cycles?days=${days}`),
  /** Latest live bpm from the band (poll every 1-2s). bpm is null until the BLE script runs. */
  liveHr: (windowS = 30) => request<LiveHr>(`/live/hr?window_s=${windowS}`),

  spotifyStatus: () => request<{ mode: SpotifyMode; login_url: string }>("/spotify/status"),
  spotifyPlaylists: () => request<SpotifyPlaylist[]>("/spotify/playlists"),
  spotifyPlaylistTracks: (playlistId: string) =>
    request<SpotifyTrack[]>(`/spotify/playlists/${encodeURIComponent(playlistId)}/tracks`),
  /** Heart rate zones coach mode can aim for (from WHOOP, or estimated). */
  spotifyZones: () => request<HrZones>("/spotify/zones"),
  /** Current song + tempo + heart rate + coach target + match. Poll every 1-2s.
   * fallbackBpm is only used when there's no live heart rate; zone turns on coach mode. */
  nowPlaying: (fallbackBpm?: number, zone?: number | null) =>
    request<NowPlaying>(`/spotify/now-playing${query({ fallback_bpm: fallbackBpm, zone })}`),
  /** Songs from a playlist ranked by how close their tempo is to the target. */
  spotifyMatches: ({ playlistId = "liked", fallbackBpm, zone, limit = 10 }: MatchOptions = {}) =>
    request<MatchList>(
      `/spotify/match${query({ playlist_id: playlistId, fallback_bpm: fallbackBpm, zone, limit })}`,
    ),
  /** Queue (or play now) the best-matching song for the current heart rate. */
  spotifySync: (opts: SyncOptions = {}) =>
    request<{
      action: "queued" | "playing";
      target_bpm: number;
      target_source: TargetSource;
      coach: Coach | null;
      track: SpotifyTrack;
    }>(
      "/spotify/sync",
      {
        method: "POST",
        body: JSON.stringify({
          playlist_id: opts.playlistId ?? "liked",
          target_bpm: opts.targetBpm,
          fallback_bpm: opts.fallbackBpm,
          zone: opts.zone ?? null,
          play_now: opts.playNow ?? false,
        }),
      },
    ),
  spotifyPlay: (uris?: string[]) =>
    request<void>("/spotify/play", { method: "POST", body: JSON.stringify({ uris }) }),
  spotifyPause: () => request<void>("/spotify/pause", { method: "POST" }),
  spotifyNext: () => request<void>("/spotify/next", { method: "POST" }),
  spotifyQueue: (uri: string) =>
    request<void>("/spotify/queue", { method: "POST", body: JSON.stringify({ uri }) }),
};
