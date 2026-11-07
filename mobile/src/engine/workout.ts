import { music } from "../audio/music";
import { location } from "../sources/location";
import { mock } from "../sources/mock";
import { pedometer } from "../sources/pedometer";
import { relayHr } from "../sources/relayHr";
import { whoopHr } from "../sources/whoopBle";
import { isHrFresh, useBio } from "../store/bio";
import { useSession } from "../store/session";
import { CONTROL, DJ_CONTROL, SPOTIFY_CONTROL, decide, initialBpm, zoneError } from "./controller";

/**
 * The core loop, outside React so it keeps running with the screen locked:
 *   new biometric sample → controller.decide() → music BPM change → stores → UI
 * Driven by sensor events (not timers), throttled to one decision per second.
 */
const TICK_MS = 1000;

/** Spotify switches whole songs (bigger, slower steps); DJ stretches songs smoothly; both in running tempo. */
const CONTROLS = { builtin: CONTROL, spotify: SPOTIFY_CONTROL, dj: DJ_CONTROL };
const control = () => CONTROLS[useSession.getState().musicSource];

let unsubscribe: (() => void) | null = null;
let lastTick = 0;
let lastChangeAt = 0;

function tick() {
  const now = Date.now();
  if (now - lastTick < TICK_MS) return;
  lastTick = now;

  const bio = useBio.getState();
  const session = useSession.getState();
  const input = {
    now,
    mode: session.mode,
    zone: session.mode === "hr" ? session.hrZone : session.paceZone,
    hr: bio.hr,
    hrFresh: isHrFresh(bio, now),
    paceSecPerKm: bio.paceSecPerKm,
    currentBpm: session.targetBpm,
    lastChangeAt,
  };
  // Song energy follows where we are vs the zone (Spotify picks high-energy songs to push you up).
  const err = zoneError(input, control());
  if (err != null) music.setIntensity(err > 0 ? "push" : err < 0 ? "ease" : "hold");

  const decision = decide(input, control());
  if (!decision) return;

  lastChangeAt = now;
  session.setTargetBpm(decision.bpm, decision.reason);
  music.setBpm(decision.bpm);
}

/** Backend errors look like `404 Not Found: {"detail":"..."}`; keep just the detail. */
function spotifyError(e: unknown): string {
  const m = String(e).match(/"detail":"((?:[^"\\]|\\.)*)"/);
  return m ? m[1] : String(e).replace(/^Error: /, "");
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

  const bpm = initialBpm(useBio.getState().cadence, control());
  session.setTargetBpm(bpm, "start");
  try {
    await music.start(bpm);
  } catch (e) {
    // Spotify not ready (no active device, not Premium, backend down): keep the workout going.
    const name = session.musicSource === "dj" ? "DJ mode" : "Spotify";
    warnings.push(`${name} couldn't start (${spotifyError(e)}). Using built-in tracks instead.`);
    session.setMusicSource("builtin");
    await music.start(bpm);
  }

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
  music.stop();
  mock.stop();
  pedometer.stop();
  await location.stop();
  useSession.getState().setRunning(false);
  // Whoop / laptop relay stay connected between workouts so the setup screen shows live status.
}
