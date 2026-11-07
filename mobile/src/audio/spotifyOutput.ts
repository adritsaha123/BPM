import { api, type Intensity, type NowPlaying } from "../api";
import { useSession } from "../store/session";

/**
 * Spotify as the workout's music output. The phone's controller (engine/controller.ts) still decides
 * the target BPM; this picks real songs at that tempo through the backend (/spotify/*, docs/SPOTIFY.md).
 *
 * Spotify can't change playback speed, so instead of time-stretching we:
 *  - start: play the best match for the starting BPM now
 *  - BPM change: if the current song is far off the new target, switch now (rate-limited);
 *    otherwise the next song will use the new target
 *  - near the end of each song: queue the best match for the current target (Auto-DJ)
 *  - song energy follows the coaching direction: below the zone → high-energy songs,
 *    above it → calmer ones (setIntensity, fed by the workout loop)
 * Needs Spotify open and playing on some device; with no Spotify keys the backend's mock player is used.
 */
const POLL_MS = 3000;
const QUEUE_LEAD_MS = 20_000; // queue the next match when this much of the song is left
const SWITCH_NOW_DIFF_BPM = 6; // current song this far off the target → switch immediately
const MIN_SWITCH_GAP_MS = 45_000; // never cut songs more often than this
const START_CHECK_MS = 3000; // after starting, confirm Spotify is really playing

let poll: ReturnType<typeof setInterval> | null = null;
let target = 160;
let lastSwitchAt = 0;
let queuedForTrackId: string | null = null;
let current: NowPlaying["track"] = null;
let intensity: Intensity = "hold";

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

async function tick() {
  try {
    const np = await api.nowPlaying();
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
    // Check, so the workout can fall back to built-in tracks instead of running in silence.
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
    if (off >= SWITCH_NOW_DIFF_BPM && Date.now() - lastSwitchAt > MIN_SWITCH_GAP_MS) {
      playBestNow().catch(() => {});
    } else {
      publish(current); // refresh the shown BPM; the next queued song uses the new target
    }
  },

  /** Where the heart rate is vs the zone; picks which song energy to favor for the next song. */
  setIntensity(next: Intensity) {
    intensity = next;
  },

  stop() {
    if (poll) clearInterval(poll);
    poll = null;
    if (current) api.spotifyPause().catch(() => {});
    current = null;
  },
};
