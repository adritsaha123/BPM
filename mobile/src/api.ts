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

export type Health = { status: string; ai: "live" | "mock" };
export type Item = { id: number; title: string; notes: string };

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
};
