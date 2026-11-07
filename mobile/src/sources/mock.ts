import { useBio } from "../store/bio";
import { useSession } from "../store/session";

/**
 * Simulated runner, in two independent halves:
 *  - motion: cadence entrains to the music BPM, pace follows cadence (for testing at a desk)
 *  - HR: follows whatever cadence is in the store — simulated OR real from the pedometer —
 *    with physiological lag. So in Expo Go you can go for a real run with simulated HR.
 */
const SIM_DEVICE = "Simulated HR";

let timer: ReturnType<typeof setInterval> | null = null;
let opts = { hr: false, motion: false };
let hr = 128;
let cadence = 150;

function step() {
  const bio = useBio.getState();

  if (opts.motion) {
    const bpm = useSession.getState().targetBpm;
    cadence += (bpm - cadence) * 0.08 + (Math.random() - 0.5) * 2; // runner entrains to the beat
    bio.pushCadence(cadence);
    bio.pushSpeed(Math.max(1.5, 2.9 + (cadence - 160) * 0.035)); // m/s
  }

  if (opts.hr) {
    const c = useBio.getState().cadence ?? 0;
    const hrTarget = c > 60 ? 150 + (c - 160) * 1.6 : 90; // ~150 HR at 160 spm, resting HR when stopped
    hr += (hrTarget - hr) * 0.03 + (Math.random() - 0.5) * 1.5; // HR lags
    bio.pushHr(Math.round(hr));
  }
}

export const mock = {
  start(options: { hr: boolean; motion: boolean }) {
    this.stop();
    opts = options;
    if (!opts.hr && !opts.motion) return;
    hr = 128;
    cadence = 150;
    if (opts.hr) useBio.getState().setHrStatus("connected", { device: SIM_DEVICE });
    timer = setInterval(step, 1000);
  },

  stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (useBio.getState().hrDevice === SIM_DEVICE) useBio.getState().setHrStatus("idle", { device: null });
  },
};
