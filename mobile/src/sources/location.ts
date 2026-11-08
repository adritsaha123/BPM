import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";

import { isExpoGo } from "../runtime";
import { pace } from "../engine/pace";
import { route } from "./route";

/**
 * Pace from iPhone GPS, delivered through a background location task.
 * Background location (plus background audio) is what keeps the JS runtime —
 * and therefore the BLE listener and BPM loop — alive while the phone is locked.
 *
 * In Expo Go (no background location on iOS) we fall back to a foreground watch,
 * so keep the screen on while testing.
 *
 * defineTask must run at module load, so this file is imported from the root layout.
 */
const TASK = "bpm-location";
let foregroundSub: Location.LocationSubscription | null = null;

const onLocation = (loc: Location.LocationObject) => {
  pace.add(loc); // GPS speed or track speed -> useBio pace (engine/pace.ts)
  route.add(loc);
};

if (!isExpoGo) {
  TaskManager.defineTask<{ locations: Location.LocationObject[] }>(TASK, async ({ data, error }) => {
    if (error || !data) return;
    data.locations.forEach(onLocation);
  });
}

const OPTIONS = {
  accuracy: Location.Accuracy.BestForNavigation,
  distanceInterval: 0,
  timeInterval: 1000,
};

export const location = {
  async start(): Promise<boolean> {
    const fg = await Location.requestForegroundPermissionsAsync();
    if (!fg.granted) return false;

    if (isExpoGo) {
      foregroundSub?.remove();
      foregroundSub = await Location.watchPositionAsync(OPTIONS, onLocation);
      return true;
    }
    // "Always" is needed to keep updating with the screen locked; fall back to foreground-only.
    await Location.requestBackgroundPermissionsAsync().catch(() => null);

    if (await Location.hasStartedLocationUpdatesAsync(TASK)) return true;
    await Location.startLocationUpdatesAsync(TASK, {
      ...OPTIONS,
      activityType: Location.ActivityType.Fitness,
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
    });
    return true;
  },

  async stop() {
    foregroundSub?.remove();
    foregroundSub = null;
    if (isExpoGo) return;
    if (await Location.hasStartedLocationUpdatesAsync(TASK).catch(() => false)) {
      await Location.stopLocationUpdatesAsync(TASK);
    }
  },
};
