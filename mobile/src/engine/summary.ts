/**
 * Run summary: collected by the workout loop (engine/workout.ts) once per tick, shown on the summary
 * screen after "End workout". Kept outside the stores while running: it changes every second and
 * nothing renders it until the run ends.
 */
export type ZoneState = -1 | 0 | 1 | null; // engine/controller.ts zoneError: +1 below, 0 in, -1 above

export type HrPoint = { t: number; bpm: number; zone: ZoneState };

export type WorkoutSummary = {
  startedAt: number;
  durationMs: number;
  /** Seconds spent below / in / above the zone (only while there was a reading). */
  belowS: number;
  inS: number;
  aboveS: number;
  avgHr: number | null;
  maxHr: number | null;
  avgCadence: number | null;
  distanceM: number;
  tempoChanges: number;
  /** ~1 point per 10 s, for the heart-rate chart. */
  hrSeries: HrPoint[];
};

const SERIES_EVERY_MS = 10_000;
const MAX_TICK_GAP_S = 5; // ignore gaps (app suspended): don't credit them to a zone or distance

let s: WorkoutSummary | null = null;
let lastAt = 0;
let hrSum = 0;
let hrCount = 0;
let cadSum = 0;
let cadCount = 0;

export const summary = {
  start(now = Date.now()) {
    s = {
      startedAt: now,
      durationMs: 0,
      belowS: 0,
      inS: 0,
      aboveS: 0,
      avgHr: null,
      maxHr: null,
      avgCadence: null,
      distanceM: 0,
      tempoChanges: 0,
      hrSeries: [],
    };
    lastAt = now;
    hrSum = hrCount = cadSum = cadCount = 0;
  },

  record(now: number, r: { hr: number | null; zone: ZoneState; cadence: number | null; speed: number | null }) {
    if (!s) return;
    const dt = (now - lastAt) / 1000;
    lastAt = now;
    if (dt > 0 && dt <= MAX_TICK_GAP_S) {
      if (r.zone === 1) s.belowS += dt;
      else if (r.zone === 0) s.inS += dt;
      else if (r.zone === -1) s.aboveS += dt;
      if (r.speed != null && r.speed > 0) s.distanceM += r.speed * dt;
    }
    if (r.hr != null) {
      hrSum += r.hr;
      hrCount++;
      s.maxHr = Math.max(s.maxHr ?? 0, r.hr);
      const last = s.hrSeries[s.hrSeries.length - 1];
      if (!last || now - last.t >= SERIES_EVERY_MS) s.hrSeries.push({ t: now, bpm: r.hr, zone: r.zone });
    }
    if (r.cadence != null && r.cadence > 0) {
      cadSum += r.cadence;
      cadCount++;
    }
  },

  tempoChanged() {
    if (s) s.tempoChanges++;
  },

  /** Finish and return the summary (null if no workout was recorded). */
  finish(now = Date.now()): WorkoutSummary | null {
    if (!s) return null;
    const out: WorkoutSummary = {
      ...s,
      durationMs: now - s.startedAt,
      avgHr: hrCount ? Math.round(hrSum / hrCount) : null,
      avgCadence: cadCount ? Math.round(cadSum / cadCount) : null,
    };
    s = null;
    return out;
  },
};
