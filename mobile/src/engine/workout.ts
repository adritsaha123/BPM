import { music } from "../audio/music";
import { location } from "../sources/location";
import { mock } from "../sources/mock";
import { pedometer } from "../sources/pedometer";
import { relayHr } from "../sources/relayHr";
import { whoopHr } from "../sources/whoopBle";
import { isHrFresh, useBio } from "../store/bio";
import { useSession } from "../store/session";
import {
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
import { summary } from "./summary";

/**
 * The core loop, outside React so it keeps running with the screen locked:
 *   new biometric sample → controller.decide() → music BPM change → stores → UI
 * Driven by sensor events (not timers), throttled to one decision per second.
 */
const TICK_MS = 1000;

/** Spotify switches whole songs (bigger, slower steps); DJ stretches songs smoothly; both in running tempo. */
// Apple Music re-rates songs like DJ mode does, so it uses the same small, quick tempo steps.
const CONTROLS = { spotify: SPOTIFY_CONTROL, dj: DJ_CONTROL, apple: DJ_CONTROL };
const control = () => CONTROLS[useSession.getState().musicSource];

/** Steady HR → a different song at the same tempo. Spotify already changes songs at each song's end. */
const ROTATE: Record<keyof typeof CONTROLS, RotateConfig | null> = { spotify: null, dj: DJ_ROTATE, apple: DJ_ROTATE };
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
  summary.record(now, { hr: input.hrFresh ? bio.hr : null, zone: err, cadence: bio.cadence, speed: bio.speed });

  const decision = decide(input, control());
  if (!decision) return maybeRotate(now);

  lastChangeAt = now;
  summary.tempoChanged();
  session.setTargetBpm(decision.bpm, decision.reason);
  music.setBpm(decision.bpm);
}

/** HR has held steady for a while and the song has had its turn: play a different one at this tempo. */
function maybeRotate(now: number) {
  const config = ROTATE[useSession.getState().musicSource];
  if (!config) return;
  if (!shouldRotate({ now, hrSamples: hrHistory, songStartedAt, lastBpmChangeAt: lastChangeAt }, config)) return;
  songStartedAt = now; // whether or not a switch starts, wait a full song before asking again
  music.rotate();
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
  // Music never blocks the workout: Spotify / Apple Music fall back to DJ mode, and if DJ mode
  // can't start either (backend unreachable), the run continues without music.
  try {
    await music.start(bpm);
  } catch (e) {
    if (session.musicSource !== "dj") {
      const name = session.musicSource === "apple" ? "Apple Music" : "Spotify";
      warnings.push(`${name} couldn't start (${spotifyError(e)}). Using DJ mode instead.`);
      music.stop();
      session.setMusicSource("dj");
      try {
        await music.start(bpm);
      } catch (e2) {
        warnings.push(`DJ mode couldn't start either (${spotifyError(e2)}). Running without music.`);
      }
    } else {
      warnings.push(`DJ mode couldn't start (${spotifyError(e)}). Running without music.`);
    }
  }

  lastChangeAt = Date.now(); // give the body one cooldown period before the first nudge
  hrHistory = [];
  songStartedAt = Date.now();
  lastTitle = useSession.getState().trackTitle;
  lastTick = 0;
  unsubscribe?.();
  unsubscribe = useBio.subscribe(tick);
  summary.start();
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
  useSession.getState().setLastSummary(summary.finish());
  useSession.getState().setRunning(false);
  // Whoop / laptop relay stay connected between workouts so the setup screen shows live status.
}
