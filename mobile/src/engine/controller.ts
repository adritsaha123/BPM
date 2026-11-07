/**
 * Pure BPM control logic — no React, no I/O, easy to unit test.
 *
 * Idea: runners entrain their cadence (steps/min) to the music beat, and HR/pace
 * follow cadence. So we nudge music BPM in small steps and wait for the body to
 * respond (HR lags 30–60s) before nudging again.
 */
import type { Zone, ZoneMode } from "../store/session";

export const CONTROL = {
  minBpm: 120,
  maxBpm: 190,
  step: 4, // bpm per adjustment
  cooldownMs: 20_000, // wait for HR to respond before nudging again
  deadband: 2, // ignore readings this close to the zone edge (bpm or sec/km)
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
export function zoneError(input: ControlInput): -1 | 0 | 1 | null {
  const { mode, zone } = input;
  const deadband = CONTROL.deadband;
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

export function decide(input: ControlInput): ControlDecision {
  if (input.now - input.lastChangeAt < CONTROL.cooldownMs) return null;
  const err = zoneError(input);
  if (!err) return null;
  const bpm = clamp(input.currentBpm + err * CONTROL.step, CONTROL.minBpm, CONTROL.maxBpm);
  if (bpm === input.currentBpm) return null;
  const what = input.mode === "hr" ? `HR ${input.hr}` : `pace ${formatPace(input.paceSecPerKm)}`;
  return { bpm, reason: `${what} ${err > 0 ? "below" : "above"} zone` };
}

/** Starting BPM: match the runner's current cadence if we have it. */
export function initialBpm(cadence: number | null): number {
  return clamp(cadence && cadence > 100 ? Math.round(cadence) : 160, CONTROL.minBpm, CONTROL.maxBpm);
}

export function formatPace(secPerKm: number | null): string {
  if (secPerKm == null) return "--:--";
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
