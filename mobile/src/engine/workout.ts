import { music } from "../audio/music";
import { location } from "../sources/location";
import { mock } from "../sources/mock";
import { pedometer } from "../sources/pedometer";
import { relayHr } from "../sources/relayHr";
import { route } from "../sources/route";
import { whoopHr } from "../sources/whoopBle";
import { isHrFresh, useBio } from "../store/bio";
import { useSession } from "../store/session";
import {
  BUILTIN_ROTATE,
  CONTROL,
  DJ_CONTROL,
  DJ_ROTATE,
  SPOTIFY_CONTROL,
  decide,
  initialBpm,
  shouldRotate,
  zoneError,
  type HrSample,
  type RotateConfig,
} from "./controller";

/**
 * The core loop, outside React so it keeps running with the screen locked:
 *   new biometric sample → controller.decide() → music BPM change → stores → UI
 * Driven by sensor events (not timers), throttled to one decision per second.
 */
const TICK_MS = 1000;

/** Spotify switches whole songs (bigger, slower steps); DJ stretches songs smoothly; both in running tempo. */
const CONTROLS = { builtin: CONTROL, spotify: SPOTIFY_CONTROL, dj: DJ_CONTROL };
const control = () => CONTROLS[useSession.getState().musicSource];

/** Steady HR → a different song at the same tempo. Spotify already changes songs at each song's end. */
const ROTATE: Record<keyof typeof CONTROLS, RotateConfig | null> = { builtin: BUILTIN_ROTATE, spotify: null, dj: DJ_ROTATE };
const HR_HISTORY_MS = 90_000;

let unsubscribe: (() => void) | null = null;
let lastTick = 0;
let lastChangeAt = 0;
let hrHistory: HrSample[] = []; // ~1 sample/s of smoothed HR, for steadiness
let songStartedAt = 0;
let lastTitle: string | null = null;

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
  if (input.hrFresh && bio.hr != null) {
    hrHistory.push({ t: now, bpm: bio.hr });
    hrHistory = hrHistory.filter((s) => now - s.t <= HR_HISTORY_MS);
  }
  if (session.trackTitle !== lastTitle) {
    lastTitle = session.trackTitle; // a new song started (end of song, tempo switch, or rotation)
    songStartedAt = now;
  }

  // Song energy follows where we are vs the zone (Spotify picks high-energy songs to push you up).
  const err = zoneError(input, control());
  if (err != null) music.setIntensity(err > 0 ? "push" : err < 0 ? "ease" : "hold");

  const decision = decide(input, control());
  if (!decision) return maybeRotate(now, session.targetBpm);

  lastChangeAt = now;
  session.setTargetBpm(decision.bpm, decision.reason);
  music.setBpm(decision.bpm);
}

/** HR has held steady for a while and the song has had its turn: play a different one at this tempo. */
function maybeRotate(now: number, bpm: number) {
  const config = ROTATE[useSession.getState().musicSource];
  if (!config) return;
  if (!shouldRotate({ now, hrSamples: hrHistory, songStartedAt, lastBpmChangeAt: lastChangeAt }, config)) return;
  songStartedAt = now; // whether or not a switch starts, wait a full song before asking again
  music.rotate(bpm);
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
    route.begin(); // record the GPS track for a post-run route
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
  hrHistory = [];
  songStartedAt = Date.now();
  lastTitle = useSession.getState().trackTitle;
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
  route.finish(); // uploads in the background; retried later if offline
  useSession.getState().setRunning(false);
  // Whoop / laptop relay stay connected between workouts so the setup screen shows live status.
}
