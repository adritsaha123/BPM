import Constants from "expo-constants";
import { Platform, type TurboModule, TurboModuleRegistry } from "react-native";

import { getUserId } from "./userId";

/** The hosted backend (Render, docs/DEPLOY.md). Not a secret: it's the public API address. */
export const CLOUD_API_URL = "https://bpm-backend-bx41.onrender.com";

/**
 * Where is the backend?
 * 1. EXPO_PUBLIC_API_URL in mobile/.env wins (use this for ngrok or another deployment).
 * 2. Installed builds (Release, no dev server): the hosted backend, so a phone build works
 *    on any network even if it was built without mobile/.env.
 * 3. Dev without .env: the IP of the laptop running Expo, so a phone on the same Wi-Fi reaches
 *    FastAPI on port 8000 automatically.
 */
function resolveApiUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  if (!__DEV__) return CLOUD_API_URL;

  const host = devServerHost();
  if (host) return `http://${host}:8000`;

  // Android emulator reaches the host machine via 10.0.2.2
  return Platform.OS === "android" ? "http://10.0.2.2:8000" : "http://localhost:8000";
}

interface SourceCode extends TurboModule {
  getConstants(): { scriptURL: string };
}

/**
 * IP of the laptop serving the app's JavaScript. Expo Go reports it in hostUri. Builds installed
 * from Xcode (or expo run:ios) have no hostUri, so read it from the bundle URL instead, e.g.
 * http://192.168.1.20:8081/.expo/.virtual-metro-entry.bundle?platform=ios
 */
function devServerHost(): string | undefined {
  const fromExpo = Constants.expoConfig?.hostUri?.split(":")[0];
  if (fromExpo || Platform.OS === "web") return fromExpo;
  const scriptUrl = TurboModuleRegistry.get<SourceCode>("SourceCode")?.getConstants().scriptURL;
  return scriptUrl?.match(/^https?:\/\/([^/:]+)/)?.[1];
}

export const API_URL = resolveApiUrl();

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": await getUserId(), // whose WHOOP login to use
      "ngrok-skip-browser-warning": "1", // ngrok free tunnels otherwise answer with an HTML warning page
      ...(init?.headers ?? {}),
    },
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

/** DJ mode song (Jamendo, Creative Commons): the app plays it itself, stretched to the target. */
export type DjTrack = {
  id: string;
  name: string;
  artist: string;
  /** stream URL (mp3) */
  audio: string;
  image: string | null;
  /** Jamendo page, for credit */
  url: string | null;
  duration_s: number | null;
  /** measured tempo of the recording */
  bpm: number;
  running_bpm: number;
  energy: number | null;
  /** e.g. "CC BY-SA 3.0": show it with the song (the license requires credit) */
  license: string;
  license_url: string;
  style: string;
  match: TempoMatch | null;
  /** time-stretch that lands it exactly on the target (within ±8%) */
  playback_rate: number;
  reachable: boolean;
  fit_score: number;
};

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
  /** 0-1 from ReccoBeats; null when unknown */
  energy?: number | null;
  danceability?: number | null;
  /** ranking score from /spotify/match and /sync (lower = better fit) */
  fit_score?: number;
  match?: TempoMatch | null;
};

/** push = favor fast, high-energy songs; ease = calmer songs; hold = in the zone */
export type Intensity = "push" | "hold" | "ease";

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
  intensity: Intensity | null;
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
  /** song energy to favor; defaults to the coach direction in coach mode */
  intensity?: Intensity | null;
  playNow?: boolean;
};

export type MatchOptions = { playlistId?: string; fallbackBpm?: number; zone?: number | null; limit?: number };

// ---- Coach target + tempo lookup for the Apple Music player on the phone. See docs/APPLE_MUSIC.md ----

export type CoachTarget = {
  heart_rate: NowPlaying["heart_rate"];
  /** heart rate used for coaching: live, or the simulated one when there's no band */
  current_bpm: number | null;
  /** tempo the music aims for (= current_bpm unless coach mode moves it) */
  target_bpm: number | null;
  target_source: TargetSource;
  coach: Coach | null;
};

export type TempoInfo = {
  bpm: number;
  /** library = BPM tag on the song itself */
  source: "reccobeats" | "deezer" | "library";
  /** the recording it was matched to, e.g. "Song - Artist" */
  matched?: string;
  isrc?: string | null;
};

export type TempoLookupTrack = {
  id: string;
  title: string;
  artist?: string;
  duration_s?: number | null;
  /** BPM tag already on the song (used as is when > 0) */
  library_bpm?: number | null;
};

function query(params: Record<string, string | number | null | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

export const api = {
  health: () => request<Health>("/health"),

  whoopStatus: () => request<{ mode: WhoopMode; login_url: string; user: string; shared?: boolean }>("/whoop/status"),
  /** Forget this user's WHOOP login on the backend. */
  whoopDisconnect: () => request<void>("/whoop/connection", { method: "DELETE" }),
  /** Browser URL that starts WHOOP login for this user and returns to `returnTo` (an app URL). */
  whoopLoginUrl: async (returnTo: string) =>
    `${API_URL}/whoop/login?${new URLSearchParams({ user: await getUserId(), return_to: returnTo })}`,
  whoopSummary: (days = 30) => request<WhoopSummary>(`/whoop/summary?days=${days}`),
  /** Latest live bpm from the band (poll every 1-2s). bpm is null until the BLE script runs. */
  liveHr: (windowS = 30) => request<LiveHr>(`/live/hr?window_s=${windowS}`),
  /** Send a heart rate reading to the backend (the phone build reading the band itself). */
  pushHr: (bpm: number, source: string) =>
    request<void>("/live/hr", { method: "POST", body: JSON.stringify({ bpm, source }) }),

  spotifyStatus: () =>
    request<{ mode: SpotifyMode; login_url: string; user: string; shared?: boolean }>("/spotify/status"),
  /** Browser URL that starts Spotify login for this user and returns to `returnTo` (an app URL). */
  spotifyLoginUrl: async (returnTo: string) =>
    `${API_URL}/spotify/login?${new URLSearchParams({ user: await getUserId(), return_to: returnTo })}`,
  /** Forget this user's Spotify login on the backend. */
  spotifyDisconnect: () => request<void>("/spotify/connection", { method: "DELETE" }),
  spotifyPlaylists: () => request<SpotifyPlaylist[]>("/spotify/playlists"),
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
          intensity: opts.intensity ?? null,
          play_now: opts.playNow ?? false,
        }),
      },
    ),
  /** DJ mode: catalog size. */
  djStatus: () => request<{ count: number; source: string; max_stretch: number }>("/dj/status"),
  /** DJ mode: songs ranked for a target tempo (+ energy with an intensity), best first. */
  djMatch: (opts: { targetBpm: number; intensity?: Intensity | null; exclude?: string[]; limit?: number }) =>
    request<{ target_bpm: number; intensity: Intensity | null; count: number; tracks: DjTrack[] }>(
      `/dj/match${query({
        target_bpm: opts.targetBpm,
        intensity: opts.intensity ?? undefined,
        exclude: opts.exclude?.join(",") || undefined,
        limit: opts.limit,
      })}`,
    ),
  spotifyPlay: (uris?: string[]) =>
    request<void>("/spotify/play", { method: "POST", body: JSON.stringify({ uris }) }),
  spotifyPause: () => request<void>("/spotify/pause", { method: "POST" }),
  /** Device volume; `supported` is false where Spotify refuses remote volume (usually iPhone). */
  spotifyVolume: () => request<{ percent: number | null; supported: boolean }>("/spotify/volume"),
  spotifySetVolume: (percent: number) =>
    request<void>("/spotify/volume", { method: "PUT", body: JSON.stringify({ percent: Math.round(percent) }) }),
  spotifyNext: () => request<void>("/spotify/next", { method: "POST" }),

  /** Heart rate zones coach mode can aim for (from WHOOP, or estimated). */
  coachZones: () => request<HrZones>("/coach/zones"),
  /** Current heart rate and the tempo the music should aim for. Poll every 1-2s. */
  coachTarget: (fallbackBpm?: number, zone?: number | null) =>
    request<CoachTarget>(`/coach/target${query({ fallback_bpm: fallbackBpm, zone })}`),
  /** Song tempos by title + artist, at most 50 songs per call. null = unknown. The first lookup
   * of a song takes a moment (the backend asks Deezer + ReccoBeats); after that it's cached. */
  tempoLookup: (tracks: TempoLookupTrack[]) =>
    request<{ tempos: Record<string, TempoInfo | null> }>("/tempo/lookup", {
      method: "POST",
      body: JSON.stringify({ tracks }),
    }),
};
