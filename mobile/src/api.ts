import Constants from "expo-constants";
import { Platform } from "react-native";

import { getUserId } from "./userId";

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

  whoopStatus: () => request<{ mode: WhoopMode; login_url: string; user: string; shared?: boolean }>("/whoop/status"),
  /** Forget this user's WHOOP login on the backend. */
  whoopDisconnect: () => request<void>("/whoop/connection", { method: "DELETE" }),
  /** Browser URL that starts WHOOP login for this user and returns to `returnTo` (an app URL). */
  whoopLoginUrl: async (returnTo: string) =>
    `${API_URL}/whoop/login?${new URLSearchParams({ user: await getUserId(), return_to: returnTo })}`,
  whoopSummary: (days = 30) => request<WhoopSummary>(`/whoop/summary?days=${days}`),
  whoopWorkouts: (days = 30, runsOnly = false) =>
    request<WhoopWorkout[]>(`/whoop/workouts?days=${days}&runs_only=${runsOnly}`),
  whoopCycles: (days = 30) => request<WhoopCycle[]>(`/whoop/cycles?days=${days}`),
  /** Latest live bpm from the band (poll every 1-2s). bpm is null until the BLE script runs. */
  liveHr: (windowS = 30) => request<LiveHr>(`/live/hr?window_s=${windowS}`),
};
