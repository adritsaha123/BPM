import type * as Location from "expo-location";

import { useBio } from "../store/bio";
import { distanceM } from "../sources/route";

/**
 * Running pace from the phone's GPS, fed to the coach (engine/controller.ts, pace mode) through
 * useBio.pushSpeed.
 *
 * Each fix gives two speed estimates:
 *  - doppler: coords.speed, measured by the GPS chip. Accurate, but iOS often reports -1 (unknown),
 *    especially in the first minute and under trees/buildings.
 *  - track: distance along the last WINDOW_MS of fixes ÷ time. Always available once you've moved
 *    MIN_TRACK_M, but jumpier because each fix wobbles by a few meters.
 * Doppler is used when it's there and trustworthy; otherwise the track speed.
 *
 * Bad fixes (> MAX_ACCURACY_M) are skipped. When fixes stop (tunnel, GPS lost) the pace goes stale
 * after bio.PACE_STALE_MS, so the coach holds the tempo instead of acting on an old pace.
 */
const WINDOW_MS = 15_000;
const MIN_TRACK_M = 15; // less than this over the window: too noisy to tell walking from wobble
const MIN_TRACK_MS = 4_000;
const MAX_ACCURACY_M = 30;
const MAX_SPEED_ACCURACY = 1.5; // m/s; iOS 15+ reports how sure it is about coords.speed
const MAX_RUN_SPEED = 12; // m/s (~1:23 /km): faster than this is a GPS jump, not running

type Fix = { t: number; lat: number; lon: number };
let fixes: Fix[] = [];

/** Speed along the recent track, or null if there's too little of it. */
function trackSpeed(): number | null {
  if (fixes.length < 2) return null;
  const first = fixes[0];
  const last = fixes[fixes.length - 1];
  const dt = last.t - first.t;
  if (dt < MIN_TRACK_MS) return null;
  let m = 0;
  for (let i = 1; i < fixes.length; i++) m += distanceM(fixes[i - 1], fixes[i]);
  if (m < MIN_TRACK_M) return 0; // standing still (or walking very slowly)
  return m / (dt / 1000);
}

export const pace = {
  reset() {
    fixes = [];
  },

  /** One GPS fix from sources/location.ts. */
  add(loc: Location.LocationObject) {
    const { latitude, longitude, accuracy, speed } = loc.coords;
    if (accuracy != null && accuracy > MAX_ACCURACY_M) return;
    const last = fixes[fixes.length - 1];
    if (last && loc.timestamp <= last.t) return;

    // A jump way beyond running speed is a bad fix: drop it so it can't fake a sprint.
    if (last && distanceM(last, { lat: latitude, lon: longitude }) / ((loc.timestamp - last.t) / 1000) > MAX_RUN_SPEED) return;

    fixes.push({ t: loc.timestamp, lat: latitude, lon: longitude });
    fixes = fixes.filter((f) => loc.timestamp - f.t <= WINDOW_MS);

    const speedAcc = (loc.coords as { speedAccuracy?: number | null }).speedAccuracy;
    const doppler =
      speed != null && speed >= 0 && speed <= MAX_RUN_SPEED && (speedAcc == null || speedAcc < 0 || speedAcc <= MAX_SPEED_ACCURACY)
        ? speed
        : null;
    const mps = doppler ?? trackSpeed();
    if (mps != null) useBio.getState().pushSpeed(mps, loc.timestamp);
  },
};
