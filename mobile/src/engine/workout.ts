import { musicErrorText } from "../audio/appleMusicOutput";
import { music } from "../audio/music";
import { location } from "../sources/location";
import { pedometer } from "../sources/pedometer";
import { route, summarize } from "../sources/route";
import { whoopHr } from "../sources/whoopBle";
import { isHrFresh, isPaceFresh, useBio } from "../store/bio";
import { useSession } from "../store/session";
import { SONG_ROTATE, TEMPO_CONTROL, decide, initialBpm, shouldRotate, zoneError, type HrSample } from "./controller";
import { pace } from "./pace";
import { summary } from "./summary";

/**
 * The core loop, outside React so it keeps running with the screen locked:
 *   new biometric sample → controller.decide() → music BPM change → stores → UI
 * Driven by sensor events (not timers), throttled to one decision per second.
 */
const TICK_MS = 1000;
const HR_HISTORY_MS = 90_000;
/** Longest Start waits for the music. Past that the run starts and the music joins when it's ready. */
const MUSIC_WAIT_MS = 20_000;

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
    paceSecPerKm: isPaceFresh(bio, now) ? bio.paceSecPerKm : null, // stale = unknown: hold the tempo
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

  const err = zoneError(input, TEMPO_CONTROL);
  summary.record(now, { hr: input.hrFresh ? bio.hr : null, zone: err, cadence: bio.cadence, speed: isPaceFresh(bio, now) ? bio.speed : null });

  const decision = decide(input, TEMPO_CONTROL);
  if (!decision) return maybeRotate(now);

  lastChangeAt = now;
  summary.tempoChanged();
  session.setTargetBpm(decision.bpm, decision.reason);
  music.setBpm(decision.bpm);
}

/** HR has held steady for a while and the song has had its turn: play a different one at this tempo. */
function maybeRotate(now: number) {
  if (!shouldRotate({ now, hrSamples: hrHistory, songStartedAt, lastBpmChangeAt: lastChangeAt }, SONG_ROTATE)) return;
  songStartedAt = now; // whether or not a switch starts, wait a full song before asking again
  music.rotate();
}

const TIMED_OUT = Symbol("timed out");

/** The promise's value, or TIMED_OUT if it takes longer than `ms` (the promise keeps running). */
function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function startWorkout() {
  const session = useSession.getState();
  const notices: string[] = [];
  session.setNotices([]);
  useBio.getState().reset();

  // Heart rate doesn't block the start: the loop holds the tempo until fresh HR arrives.
  if (useBio.getState().hrStatus !== "connected") whoopHr.connect();
  pace.reset();
  route.begin(); // record the GPS track for the route map (sources/route.ts)
  if (!(await pedometer.start().catch(() => false))) {
    notices.push("Motion & Fitness access is off, so cadence isn't measured. You can turn it on in Settings.");
  }
  if (!(await location.start().catch(() => false))) {
    notices.push("Location access is off, so pace and your route aren't recorded. You can turn it on in Settings.");
  }

  const bpm = initialBpm(useBio.getState().cadence, TEMPO_CONTROL);
  session.setTargetBpm(bpm, "start");
  // The music never blocks the run: if the playlist is still loading the run starts anyway and
  // the music joins when it's ready; if it can't play at all, the run goes on without it.
  const starting = music.start(bpm);
  const noMusic = (e: unknown) => `The music couldn't start: ${musicErrorText(e)}`;
  try {
    if ((await within(starting, MUSIC_WAIT_MS)) === TIMED_OUT) {
      const loading = "Your playlist is still loading. The music starts as soon as it's ready.";
      notices.push(loading);
      const settled = (e?: unknown) => {
        const s = useSession.getState();
        if (s.status !== "running") return;
        s.setNotices(s.notices.filter((n) => n !== loading));
        if (e !== undefined) s.addNotice(noMusic(e));
      };
      starting.then(() => settled(), (e) => settled(e ?? "unknown error"));
    }
  } catch (e) {
    notices.push(noMusic(e));
  }

  lastChangeAt = Date.now(); // give the body one cooldown period before the first nudge
  hrHistory = [];
  songStartedAt = Date.now();
  lastTitle = useSession.getState().trackTitle;
  lastTick = 0;
  unsubscribe?.();
  unsubscribe = useBio.subscribe(tick);
  summary.start();
  session.setNotices(notices);
  session.setRunning(true);
}

export async function stopWorkout() {
  unsubscribe?.();
  unsubscribe = null;
  music.stop();
  pedometer.stop();
  await location.stop().catch(() => {});
  const run = route.finish(); // uploads in the background; retried later if offline
  const result = summary.finish();
  if (result && run) {
    result.runId = run.id;
    // The GPS track is a better distance than adding up speed × time.
    const km = summarize(run).distance_km;
    if (km > 0) result.distanceM = km * 1000;
  }
  useSession.getState().setLastSummary(result);
  useSession.getState().setRunning(false);
  // The WHOOP band stays connected between workouts so the setup screen shows live status.
}
