import { useBio } from "../store/bio";
import { useSession } from "../store/session";

/**
 * Fake runner for demos / simulator (no Bluetooth or GPS on the iOS Simulator).
 * HR and pace drift toward values implied by the music BPM, with lag and noise,
 * so you can watch the control loop actually pull the "runner" into the zone.
 */
let timer: ReturnType<typeof setInterval> | null = null;
let hr = 128;
let cadence = 150;

export const mock = {
  start() {
    this.stop();
    hr = 128;
    cadence = 150;
    useBio.getState().setHrStatus("connected", { device: "Mock Whoop" });
    timer = setInterval(() => {
      const bpm = useSession.getState().targetBpm;
      cadence += (bpm - cadence) * 0.08 + (Math.random() - 0.5) * 2; // runner entrains to the beat
      const hrTarget = 150 + (cadence - 160) * 1.6; // ~150 HR at 160 spm
      hr += (hrTarget - hr) * 0.03 + (Math.random() - 0.5) * 1.5; // HR lags
      const speed = Math.max(1.5, 2.9 + (cadence - 160) * 0.035); // m/s

      const bio = useBio.getState();
      bio.pushHr(Math.round(hr));
      bio.pushCadence(cadence);
      bio.pushSpeed(speed);
    }, 1000);
  },

  stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (useBio.getState().hrDevice === "Mock Whoop") useBio.getState().setHrStatus("idle", { device: null });
  },
};
