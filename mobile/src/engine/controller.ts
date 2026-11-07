/**
 * Pure BPM control logic — no React, no I/O, easy to unit test.
 *
 * Idea: runners entrain their cadence (steps/min) to the music beat, and HR/pace
 * follow cadence. So we nudge music BPM in small steps and wait for the body to
 * respond (HR lags 30–60s) before nudging again.
 */
import type { Zone, ZoneMode } from "../store/session";

export type Control = { minBpm: number; maxBpm: number; step: number; cooldownMs: number; deadband: number };

/** Built-in tracks: time-stretched, so small frequent nudges are smooth. */
export const CONTROL: Control = {
  minBpm: 120,
  maxBpm: 190,
  step: 4, // bpm per adjustment
  cooldownMs: 20_000, // wait for HR to respond before nudging again
  deadband: 2, // ignore readings this close to the zone edge (bpm or sec/km)
};

/** DJ mode: songs are time-stretched like the built-in tracks (smooth), kept in running tempo. */
export const DJ_CONTROL: Control = {
  minBpm: 145,
  maxBpm: 185,
  step: 4,
  cooldownMs: 20_000,
  deadband: 2,
};

/**
 * Spotify: tempo only changes when the song does, so a 4 BPM nudge usually waits for the next song
 * and gets lost. Bigger, less frequent steps, kept in running tempo (no slow songs).
 */
export const SPOTIFY_CONTROL: Control = {
  minBpm: 150,
  maxBpm: 185,
  step: 8,
  cooldownMs: 60_000,
  deadband: 2,
};

export type ControlInput = {
  now: number;
  mode: ZoneMode;
  zone: Zone;
  hr: number | null;
  hrFresh: boolean;
  paceSecPerKm: number | null;
  currentBpm: number;
  lastChangeAt: number;
};

export type ControlDecision = { bpm: number; reason: string } | null;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** -1 = above zone (slow down), +1 = below zone (speed up), 0 = in zone, null = no data */
export function zoneError(input: ControlInput, control: Control = CONTROL): -1 | 0 | 1 | null {
  const { mode, zone } = input;
  const deadband = control.deadband;
  if (mode === "hr") {
    if (input.hr == null || !input.hrFresh) return null;
    if (input.hr < zone.min - deadband) return 1;
    if (input.hr > zone.max + deadband) return -1;
    return 0;
  }
  // pace: bigger sec/km = slower
  if (input.paceSecPerKm == null) return null;
  if (input.paceSecPerKm > zone.max + deadband) return 1;
  if (input.paceSecPerKm < zone.min - deadband) return -1;
  return 0;
}

export function decide(input: ControlInput, control: Control = CONTROL): ControlDecision {
  if (input.now - input.lastChangeAt < control.cooldownMs) return null;
  const err = zoneError(input, control);
  if (!err) return null;
  const bpm = clamp(input.currentBpm + err * control.step, control.minBpm, control.maxBpm);
  if (bpm === input.currentBpm) return null;
  const what = input.mode === "hr" ? `HR ${input.hr}` : `pace ${formatPace(input.paceSecPerKm)}`;
  return { bpm, reason: `${what} ${err > 0 ? "below" : "above"} zone` };
}

/** Starting BPM: match the runner's current cadence if we have it. */
export function initialBpm(cadence: number | null, control: Control = CONTROL): number {
  return clamp(cadence && cadence > 100 ? Math.round(cadence) : 160, control.minBpm, control.maxBpm);
}

export function formatPace(secPerKm: number | null): string {
  if (secPerKm == null) return "--:--";
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
