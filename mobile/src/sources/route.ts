import type * as Location from "expo-location";
import { create } from "zustand";

import { API_URL } from "../api";
import { isHrFresh, useBio } from "../store/bio";
import { getUserId } from "../userId";

/**
 * Records the phone's GPS track during a workout so the route can be shown live and rebuilt after the run.
 *
 * The phone travels with the runner (and the WHOOP band), so its GPS is the runner's route.
 * location.ts hands every fix to `route.add()`, including fixes from the background task while
 * the phone is locked (dev build). Each point also carries the heart rate at that moment.
 *
 * When the workout stops, the run is uploaded to the backend (POST /runs). Runs that fail to
 * upload (no Wi-Fi outdoors, backend down) stay queued in memory and are retried every minute
 * and at the next workout. They are lost if the app is force-closed before an upload succeeds.
 */
export type RoutePoint = {
  /** unix ms */
  t: number;
  lat: number;
  lon: number;
  alt: number | null;
  /** horizontal accuracy, meters */
  acc: number | null;
  /** m/s */
  speed: number | null;
  /** heart rate at this moment, if fresh */
  hr: number | null;
};

export type RecordedRun = { id: string; started_at: number; ended_at: number; points: RoutePoint[] };

/** Same shape as the backend's run summary (GET /runs). */
export type RunSummary = {
  id: string;
  started_at: number;
  ended_at: number;
  point_count: number;
  distance_km: number;
  duration_min: number;
  pace_min_per_km: number | null;
  avg_hr: number | null;
  max_hr: number | null;
};

export type UploadState = "uploading" | "saved" | "waiting";

/** Fixes worse than this are mostly indoor/urban-canyon noise and would draw zig-zags. */
const MAX_ACCURACY_M = 50;
const RETRY_MS = 60_000;

type RouteState = {
  /** points of the workout in progress (empty when not recording) */
  live: RoutePoint[];
  /** runs recorded since the app opened, newest first: viewable offline */
  local: RecordedRun[];
  upload: Record<string, UploadState>;
};

export const useRoute = create<RouteState>(() => ({ live: [], local: [], upload: {} }));

let current: RecordedRun | null = null;
let retryTimer: ReturnType<typeof setInterval> | null = null;

const setUpload = (id: string, state: UploadState) =>
  useRoute.setState((s) => ({ upload: { ...s.upload, [id]: state } }));

function runId(now: number): string {
  return `run-${now}-${Math.random().toString(36).slice(2, 8)}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": await getUserId(),
      "ngrok-skip-browser-warning": "1",
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function flush(): Promise<void> {
  const { local, upload } = useRoute.getState();
  const waiting = local.filter((r) => upload[r.id] !== "saved").reverse(); // oldest first
  for (const run of waiting) {
    setUpload(run.id, "uploading");
    try {
      await request("/runs", { method: "POST", body: JSON.stringify(run) });
      setUpload(run.id, "saved");
    } catch {
      setUpload(run.id, "waiting"); // still offline; try again later
      break;
    }
  }
  const left = useRoute.getState().local.some((r) => useRoute.getState().upload[r.id] !== "saved");
  if (!left && retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  } else if (left && !retryTimer) {
    retryTimer = setInterval(() => void flush(), RETRY_MS);
  }
}

/** Great-circle distance in meters. */
export function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = 6_371_000;
  const rad = Math.PI / 180;
  const p1 = a.lat * rad;
  const p2 = b.lat * rad;
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

/** Same numbers as the backend summary, computed on the phone (works offline). */
export function summarize(run: RecordedRun): RunSummary {
  const pts = run.points;
  let m = 0;
  for (let i = 1; i < pts.length; i++) m += distanceM(pts[i - 1], pts[i]);
  const durationS = pts.length > 1 ? (pts[pts.length - 1].t - pts[0].t) / 1000 : 0;
  const hrs = pts.map((p) => p.hr).filter((h): h is number => h != null);
  const km = m / 1000;
  return {
    id: run.id,
    started_at: run.started_at,
    ended_at: run.ended_at,
    point_count: pts.length,
    distance_km: Math.round(km * 1000) / 1000,
    duration_min: Math.round((durationS / 60) * 10) / 10,
    pace_min_per_km: km >= 0.05 ? Math.round((durationS / 60 / km) * 100) / 100 : null,
    avg_hr: hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : null,
    max_hr: hrs.length ? Math.max(...hrs) : null,
  };
}

/** 47.5 min → "47:30", 75 min → "1:15:00" */
export function formatDuration(min: number): string {
  const sec = Math.round(min * 60);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export const route = {
  /** Start a new route. Called when a workout starts. */
  begin() {
    const now = Date.now();
    current = { id: runId(now), started_at: now, ended_at: now, points: [] };
    useRoute.setState({ live: [] });
    void flush(); // retry anything left from an earlier run
  },

  /** One GPS fix from location.ts. Ignored when no workout is recording. */
  add(loc: Location.LocationObject) {
    if (!current) return;
    const { latitude, longitude, altitude, accuracy, speed } = loc.coords;
    if (accuracy != null && accuracy > MAX_ACCURACY_M) return;
    const last = current.points[current.points.length - 1];
    if (last && loc.timestamp <= last.t) return; // duplicate or out-of-order fix

    const bio = useBio.getState();
    current.points.push({
      t: loc.timestamp,
      lat: latitude,
      lon: longitude,
      alt: altitude ?? null,
      acc: accuracy ?? null,
      speed: speed != null && speed >= 0 ? speed : null,
      hr: isHrFresh(bio, loc.timestamp) ? bio.hr : null,
    });
    useRoute.setState({ live: current.points.slice() });
  },

  /** Stop recording and upload in the background. Returns the run (null if nothing was recorded). */
  finish(): RecordedRun | null {
    const run = current;
    current = null;
    useRoute.setState({ live: [] });
    if (!run || run.points.length < 2) return null;
    run.ended_at = Date.now();
    useRoute.setState((s) => ({ local: [run, ...s.local] }));
    void flush();
    return run;
  },

  /** A run recorded since the app opened, if it's still in memory. */
  localRun: (id: string) => useRoute.getState().local.find((r) => r.id === id) ?? null,

  /** Saved runs from the backend, newest first. */
  list: () => request<RunSummary[]>("/runs"),
  /** One saved run with all its points. */
  get: (id: string) => request<RunSummary & { points: RoutePoint[] }>(`/runs/${encodeURIComponent(id)}`),
};
