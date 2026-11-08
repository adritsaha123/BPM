import { api, type Intensity, type NowPlaying } from "../api";
import { useSession } from "../store/session";

/**
 * Spotify as the workout's music output. The phone's controller (engine/controller.ts) still decides
 * the target BPM; this picks real songs at that tempo through the backend (/spotify/*, docs/SPOTIFY.md).
 *
 * Spotify can't change playback speed, so instead of time-stretching we:
 *  - start: play the best match for the starting BPM now
 *  - BPM change: if the current song is far off the new target, switch now (rate-limited), fading
 *    the volume down and back up where Spotify allows remote volume (desktop, speakers; usually
 *    not iPhone, where it just cuts). Otherwise the next song uses the new target, so most changes
 *    happen at the end of a song, where Spotify's own Crossfade setting blends them.
 *  - near the end of each song: queue the best match for the current target (Auto-DJ)
 *  - song energy follows the coaching direction: below the zone → high-energy songs,
 *    above it → calmer ones (setIntensity, fed by the workout loop)
 *  - pause/resume: pauses Spotify itself; while paused no songs are queued or switched, and a
 *    tempo change that needs a new song plays it on resume. Resuming from the Spotify app counts too.
 * Needs Spotify open and playing on some device; with no Spotify keys the backend's mock player is used.
 */
const POLL_MS = 3000;
const QUEUE_LEAD_MS = 20_000; // queue the next match when this much of the song is left
const SWITCH_NOW_DIFF_BPM = 10; // current song this far off the target → switch immediately
const MIN_SWITCH_GAP_MS = 45_000; // never cut songs more often than this
const START_CHECK_MS = 3000; // after starting, confirm Spotify is really playing
const FADE_STEPS = 5; // volume steps each way for a mid-song switch (each is a Spotify API call)
const FADE_STEP_MS = 300;
const FADE_FLOOR = 0.15; // fade down to this share of the volume, never to silence

let poll: ReturnType<typeof setInterval> | null = null;
let target = 160;
let lastSwitchAt = 0;
let queuedForTrackId: string | null = null;
let current: NowPlaying["track"] = null;
let intensity: Intensity = "hold";
let paused = false;
let switchOnResume = false; // the target moved far from the paused song

/** Song tempo, doubled or halved: whichever is closest to the target (85 BPM fits 170). */
export function effectiveBpm(songBpm: number, targetBpm: number): number {
  return [songBpm / 2, songBpm, songBpm * 2].reduce((best, b) =>
    Math.abs(b - targetBpm) < Math.abs(best - targetBpm) ? b : best,
  );
}

function publish(track: NowPlaying["track"]) {
  if (!track) return;
  const bpm = track.tempo ? ` · ${Math.round(effectiveBpm(track.tempo, target))} BPM` : " · tempo unknown";
  useSession.getState().setNowPlaying(`${track.name} — ${track.artists.join(", ")}${bpm}`, 1);
}

async function playBestNow() {
  lastSwitchAt = Date.now();
  const res = await api.spotifySync({ targetBpm: target, intensity, playNow: true });
  current = res.track;
  queuedForTrackId = null;
  publish(res.track);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rampVolume(from: number, to: number) {
  for (let i = 1; i <= FADE_STEPS; i++) {
    await api.spotifySetVolume(from + ((to - from) * i) / FADE_STEPS);
    await sleep(FADE_STEP_MS);
  }
}

/** Mid-song switch: fade out, change song, fade back in. Falls back to a plain cut where Spotify
 *  won't let us change the volume. The volume is always restored, even if the switch fails. */
async function switchWithFade() {
  lastSwitchAt = Date.now(); // block repeat switches while the fade runs
  const vol = await api.spotifyVolume().catch(() => null);
  const full = vol?.supported ? vol.percent : null;
  if (!full) return playBestNow();
  const low = full * FADE_FLOOR;
  try {
    await rampVolume(full, low);
    await playBestNow();
  } finally {
    await rampVolume(low, full).catch(() => api.spotifySetVolume(full).catch(() => {}));
  }
}

async function tick() {
  try {
    const np = await api.nowPlaying();
    if (paused) {
      // resumed from the Spotify app / lock screen: pick up again here too
      if (np.is_playing) {
        paused = false;
        useSession.getState().setMusicPaused(false);
      } else return;
    }
    const track = np.track;
    if (!track) return;
    if (track.id !== current?.id) queuedForTrackId = null;
    current = track;
    publish(track);

    const left = track.duration_ms != null && np.progress_ms != null ? track.duration_ms - np.progress_ms : null;
    if (np.is_playing && left != null && left < QUEUE_LEAD_MS && queuedForTrackId !== track.id) {
      queuedForTrackId = track.id;
      await api.spotifySync({ targetBpm: target, intensity, playNow: false });
    }
  } catch {
    // transient network/Spotify errors: keep polling
  }
}

export const spotifyOutput = {
  /** Throws with the backend's message if Spotify can't play (e.g. no active device, not Premium). */
  async start(bpm: number) {
    this.stop();
    target = bpm;
    intensity = "hold";
    lastSwitchAt = 0;
    await playBestNow();
    // Spotify can accept the command and still not play (e.g. iOS suspended it in the background).
    // Check, so the workout can fall back to DJ mode instead of running in silence.
    await new Promise((r) => setTimeout(r, START_CHECK_MS));
    const np = await api.nowPlaying().catch(() => null);
    if (!np?.is_playing) {
      current = null;
      throw new Error("Spotify didn't start playing. Open Spotify, play any song, come back, and start again");
    }
    poll = setInterval(tick, POLL_MS);
  },

  setBpm(bpm: number) {
    target = bpm;
    if (!current?.tempo) return;
    const off = Math.abs(effectiveBpm(current.tempo, bpm) - bpm);
    if (off >= SWITCH_NOW_DIFF_BPM && paused) {
      switchOnResume = true;
      publish(current);
    } else if (off >= SWITCH_NOW_DIFF_BPM && Date.now() - lastSwitchAt > MIN_SWITCH_GAP_MS) {
      switchWithFade().catch(() => {});
    } else {
      publish(current); // refresh the shown BPM; the next queued song uses the new target
    }
  },

  /** Where the heart rate is vs the zone; picks which song energy to favor for the next song. */
  setIntensity(next: Intensity) {
    intensity = next;
  },

  async pause() {
    await api.spotifyPause();
    paused = true;
  },

  /** Resumes the paused song, or plays a better match if the target moved far while paused. */
  async resume() {
    if (switchOnResume) await playBestNow();
    else await api.spotifyPlay();
    switchOnResume = false;
    paused = false;
  },

  stop() {
    paused = false;
    switchOnResume = false;
    if (poll) clearInterval(poll);
    poll = null;
    if (current) api.spotifyPause().catch(() => {});
    current = null;
  },
};
