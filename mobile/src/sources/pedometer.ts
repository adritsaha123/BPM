import { Pedometer } from "expo-sensors";

import { useBio } from "../store/bio";

/**
 * Cadence (steps/min) from the iPhone's motion coprocessor.
 * watchStepCount reports cumulative steps since subscribing; we derive SPM
 * from the step delta over a sliding window.
 */
const WINDOW_MS = 10_000;

let sub: { remove(): void } | null = null;
let samples: { t: number; steps: number }[] = [];

export const pedometer = {
  async start() {
    if (!(await Pedometer.isAvailableAsync())) return false;
    const perm = await Pedometer.requestPermissionsAsync();
    if (!perm.granted) return false;

    samples = [{ t: Date.now(), steps: 0 }];
    sub?.remove();
    sub = Pedometer.watchStepCount(({ steps }) => {
      const now = Date.now();
      samples.push({ t: now, steps });
      samples = samples.filter((s) => now - s.t <= WINDOW_MS);
      const first = samples[0];
      const dtMin = (now - first.t) / 60_000;
      if (dtMin > 0.05) useBio.getState().pushCadence((steps - first.steps) / dtMin);
    });
    return true;
  },

  stop() {
    sub?.remove();
    sub = null;
    samples = [];
  },
};
