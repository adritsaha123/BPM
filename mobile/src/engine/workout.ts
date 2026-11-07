import { musicPlayer } from "../audio/player";
import { location } from "../sources/location";
import { mock } from "../sources/mock";
import { pedometer } from "../sources/pedometer";
import { relayHr } from "../sources/relayHr";
import { whoopHr } from "../sources/whoopBle";
import { isHrFresh, useBio } from "../store/bio";
import { useSession } from "../store/session";
import { decide, initialBpm } from "./controller";

/**
 * The core loop, outside React so it keeps running with the screen locked:
 *   new biometric sample → controller.decide() → music BPM change → stores → UI
 * Driven by sensor events (not timers), throttled to one decision per second.
 */
const TICK_MS = 1000;

let unsubscribe: (() => void) | null = null;
let lastTick = 0;
let lastChangeAt = 0;

function tick() {
  const now = Date.now();
  if (now - lastTick < TICK_MS) return;
  lastTick = now;

  const bio = useBio.getState();
  const session = useSession.getState();
  const decision = decide({
    now,
    mode: session.mode,
    zone: session.mode === "hr" ? session.hrZone : session.paceZone,
    hr: bio.hr,
    hrFresh: isHrFresh(bio, now),
    paceSecPerKm: bio.paceSecPerKm,
    currentBpm: session.targetBpm,
    lastChangeAt,
  });
  if (!decision) return;

  lastChangeAt = now;
  session.setTargetBpm(decision.bpm, decision.reason);
  musicPlayer.setBpm(decision.bpm);
}

export async function startWorkout(): Promise<{ warnings: string[] }> {
  const warnings: string[] = [];
  const session = useSession.getState();
  useBio.getState().reset();

  mock.start({ hr: session.hrSource === "sim", motion: session.simMotion });
  // HR sources are non-blocking: the loop holds BPM steady until fresh HR arrives.
  if (session.hrSource === "laptop") relayHr.start();
  if (session.hrSource === "phone" && useBio.getState().hrStatus !== "connected") whoopHr.connect();
  if (!session.simMotion) {
    if (!(await pedometer.start())) warnings.push("Motion access denied or unavailable — no cadence.");
    if (!(await location.start())) warnings.push("Location denied — no pace.");
  }

  await musicPlayer.init();
  const bpm = initialBpm(useBio.getState().cadence);
  session.setTargetBpm(bpm, "start");
  musicPlayer.start(bpm);

  lastChangeAt = Date.now(); // give the body one cooldown period before the first nudge
  lastTick = 0;
  unsubscribe?.();
  unsubscribe = useBio.subscribe(tick);
  session.setRunning(true);
  return { warnings };
}

export async function stopWorkout() {
  unsubscribe?.();
  unsubscribe = null;
  musicPlayer.stop();
  mock.stop();
  pedometer.stop();
  await location.stop();
  useSession.getState().setRunning(false);
  // Whoop / laptop relay stay connected between workouts so the setup screen shows live status.
}
