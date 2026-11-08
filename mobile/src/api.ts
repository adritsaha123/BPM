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
export type Health = { status: string; ai: "live" | "mock"; whoop?: WhoopMode };

// ---- WHOOP: account, history and heart rate zones. See docs/WHOOP.md ----

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

// ---- Song tempos for the Apple Music player on the phone. See docs/APPLE_MUSIC.md ----

export type TempoMatch = {
  song_bpm: number;
  target_bpm: number;
  /** song_bpm, doubled or halved: whichever is closest to the target */
  effective_bpm: number;
  multiple: 0.5 | 1 | 2;
  diff_bpm: number;
  status: "in_sync" | "close" | "off";
  /** playback rate that puts the song exactly on the target */
  speed_to_match: number;
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

export const api = {
  health: () => request<Health>("/health"),

  whoopStatus: () => request<{ mode: WhoopMode; login_url: string; user: string; shared?: boolean }>("/whoop/status"),
  /** Forget this user's WHOOP login on the backend. */
  whoopDisconnect: () => request<void>("/whoop/connection", { method: "DELETE" }),
  /** Browser URL that starts WHOOP login for this user and returns to `returnTo` (an app URL). */
  whoopLoginUrl: async (returnTo: string) =>
    `${API_URL}/whoop/login?${new URLSearchParams({ user: await getUserId(), return_to: returnTo })}`,
  whoopSummary: (days = 30) => request<WhoopSummary>(`/whoop/summary?days=${days}`),

  /** Song tempos by title + artist, at most 50 songs per call. null = unknown. The first lookup
   * of a song takes a moment (the backend asks Deezer + ReccoBeats); after that it's cached. */
  tempoLookup: (tracks: TempoLookupTrack[]) =>
    request<{ tempos: Record<string, TempoInfo | null> }>("/tempo/lookup", {
      method: "POST",
      body: JSON.stringify({ tracks }),
    }),
};
