import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";

import { useBio } from "../store/bio";

/**
 * Pace from iPhone GPS, delivered through a background location task.
 * Background location (plus background audio) is what keeps the JS runtime —
 * and therefore the BLE listener and BPM loop — alive while the phone is locked.
 *
 * defineTask must run at module load, so this file is imported from the root layout.
 */
const TASK = "bpm-location";

TaskManager.defineTask<{ locations: Location.LocationObject[] }>(TASK, async ({ data, error }) => {
  if (error || !data) return;
  for (const loc of data.locations) {
    if (loc.coords.speed != null) useBio.getState().pushSpeed(loc.coords.speed);
  }
});

export const location = {
  async start(): Promise<boolean> {
    const fg = await Location.requestForegroundPermissionsAsync();
    if (!fg.granted) return false;
    // "Always" is needed to keep updating with the screen locked; fall back to foreground-only.
    await Location.requestBackgroundPermissionsAsync().catch(() => null);

    if (await Location.hasStartedLocationUpdatesAsync(TASK)) return true;
    await Location.startLocationUpdatesAsync(TASK, {
      accuracy: Location.Accuracy.BestForNavigation,
      activityType: Location.ActivityType.Fitness,
      distanceInterval: 0,
      timeInterval: 1000,
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
    });
    return true;
  },

  async stop() {
    if (await Location.hasStartedLocationUpdatesAsync(TASK).catch(() => false)) {
      await Location.stopLocationUpdatesAsync(TASK);
    }
  },
};
