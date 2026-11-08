/**
 * Pure BPM control logic — no React, no I/O, easy to unit test.
 *
 * Idea: runners entrain their cadence (steps/min) to the music beat, and HR/pace
 * follow cadence. So we nudge music BPM in small steps and wait for the body to
 * respond (HR lags 30–60s) before nudging again.
 */
import type { Zone, ZoneMode } from "../store/session";

export type Control = { minBpm: number; maxBpm: number; step: number; cooldownMs: number; deadband: number };

/** Songs are sped up or slowed down to the target, so small frequent nudges are smooth; kept in running tempo. */
export const TEMPO_CONTROL: Control = {
  minBpm: 145,
  maxBpm: 185,
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
export function zoneError(input: ControlInput, control: Control = TEMPO_CONTROL): -1 | 0 | 1 | null {
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

export function decide(input: ControlInput, control: Control = TEMPO_CONTROL): ControlDecision {
  if (input.now - input.lastChangeAt < control.cooldownMs) return null;
  const err = zoneError(input, control);
  if (!err) return null;
  const bpm = clamp(input.currentBpm + err * control.step, control.minBpm, control.maxBpm);
  if (bpm === input.currentBpm) return null;
  const what = input.mode === "hr" ? `HR ${input.hr}` : `pace ${formatPace(input.paceSecPerKm)}`;
  return { bpm, reason: `${what} ${err > 0 ? "below" : "above"} zone` };
}

// ---- Song rotation while the heart rate holds steady ----
//
// The BPM loop above only changes tempo when HR leaves the zone, so a runner who settles in hears
// the same song for its whole length. When HR stays steady we switch to a different song
// at the same tempo: variety without changing the beat the runner is locked to.

export type RotateConfig = {
  /** HR must have been tracked over (most of) this window... */
  steadyWindowMs: number;
  /** ...and stayed within this many bpm (max - min) to count as steady. */
  steadySpreadBpm: number;
  /** Only rotate a song that has played at least this long. */
  minSongMs: number;
};

/** Songs already change at their end: only cut long ones short. */
export const SONG_ROTATE: RotateConfig = { steadyWindowMs: 60_000, steadySpreadBpm: 6, minSongMs: 150_000 };

export type HrSample = { t: number; bpm: number };

/** True when HR samples cover ≥80% of the window and stay within the allowed spread. */
export function isHrSteady(samples: HrSample[], now: number, config: RotateConfig): boolean {
  const recent = samples.filter((s) => now - s.t <= config.steadyWindowMs);
  if (recent.length < 2) return false;
  const covered = now - Math.min(...recent.map((s) => s.t));
  if (covered < config.steadyWindowMs * 0.8) return false;
  const bpms = recent.map((s) => s.bpm);
  return Math.max(...bpms) - Math.min(...bpms) <= config.steadySpreadBpm;
}

export type RotateInput = {
  now: number;
  hrSamples: HrSample[];
  songStartedAt: number;
  /** Last tempo change: while the controller is still steering, don't also swap songs. */
  lastBpmChangeAt: number;
};

export function shouldRotate(input: RotateInput, config: RotateConfig): boolean {
  if (input.now - input.songStartedAt < config.minSongMs) return false;
  if (input.now - input.lastBpmChangeAt < config.steadyWindowMs) return false;
  return isHrSteady(input.hrSamples, input.now, config);
}

/** Starting BPM: match the runner's current cadence if we have it. */
export function initialBpm(cadence: number | null, control: Control = TEMPO_CONTROL): number {
  return clamp(cadence && cadence > 100 ? Math.round(cadence) : 160, control.minBpm, control.maxBpm);
}

export function formatPace(secPerKm: number | null): string {
  if (secPerKm == null) return "--:--";
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
