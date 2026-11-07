import { createAudioPlayer, type AudioPlayer } from "expo-audio";

import { api, type DjTrack, type Intensity } from "../api";
import { useSession } from "../store/session";

/**
 * DJ mode: openly licensed songs (Jamendo, Creative Commons) that the app plays itself, so unlike
 * Spotify it can lock every song to the exact target BPM:
 *  - each song is time-stretched (pitch-corrected) onto the target; BPM changes re-stretch it live
 *  - a change too big for the current song (beyond ±8%) crossfades to a better match
 *  - near the end of each song, the next pick (tempo + energy toward the zone) fades in
 * Songs come from the backend (/dj/match, built by backend/scripts/build_dj_catalog.py).
 * The licenses require credit, so "Song — Artist · CC license" is always shown.
 */
const MAX_STRETCH = 0.08; // must match the backend (app/dj.py)
const NEXT_FADE_MS = 8000; // DJ-style blend into the next song
const SWITCH_FADE_MS = 3000; // quicker blend when the tempo jumps mid-song
const FADE_STEPS = 30;
const NEXT_LEAD_S = 12; // start the next song this long before the current one ends
const POLL_MS = 1000;
const RECENT = 12; // don't repeat these many recent songs

type Deck = { player: AudioPlayer; track: DjTrack };

let deck: Deck | null = null;
let fadingOut: AudioPlayer | null = null;
let fadeTimer: ReturnType<typeof setInterval> | null = null;
let poll: ReturnType<typeof setInterval> | null = null;
let target = 160;
let intensity: Intensity = "hold";
let recent: string[] = [];
let advancing = false;

const effective = (t: DjTrack) => t.bpm * (t.match?.multiple ?? 1);
const clampRate = (r: number) => Math.min(1 + MAX_STRETCH, Math.max(1 - MAX_STRETCH, r));
const rateFor = (t: DjTrack, bpm: number) => clampRate(bpm / effective(t));

function publish() {
  if (!deck) return;
  const t = deck.track;
  useSession.getState().setNowPlaying(`${t.name} — ${t.artist} · ${t.license}`, deck.player.playbackRate);
}

async function pickNext(): Promise<DjTrack> {
  const res = await api.djMatch({ targetBpm: target, intensity, exclude: recent, limit: 1 });
  const pick = res.tracks[0];
  if (!pick) throw new Error("No DJ songs available. Build the catalog: backend/scripts/build_dj_catalog.py");
  recent = [pick.id, ...recent].slice(0, RECENT);
  return pick;
}

function load(track: DjTrack): AudioPlayer {
  const p = createAudioPlayer({ uri: track.audio });
  p.shouldCorrectPitch = true;
  p.setPlaybackRate(rateFor(track, target), "high");
  p.addListener("playbackStatusUpdate", (s) => {
    if (s.didJustFinish && deck?.player === p) advance(SWITCH_FADE_MS); // missed the lead-in: move on
  });
  return p;
}

/** Blend from the current song into `track` over `ms`. */
function crossfade(track: DjTrack, ms: number) {
  finishFade();
  const incoming = load(track);
  const outgoing = deck?.player ?? null;
  incoming.volume = outgoing ? 0 : 1;
  incoming.play();
  deck = { player: incoming, track };
  publish();
  if (!outgoing) return;

  fadingOut = outgoing;
  let i = 0;
  fadeTimer = setInterval(() => {
    i++;
    const x = i / FADE_STEPS;
    incoming.volume = x;
    outgoing.volume = 1 - x;
    if (i >= FADE_STEPS) finishFade();
  }, ms / FADE_STEPS);
}

function finishFade() {
  if (fadeTimer) clearInterval(fadeTimer);
  fadeTimer = null;
  if (deck) deck.player.volume = 1;
  fadingOut?.pause();
  fadingOut?.remove();
  fadingOut = null;
}

async function advance(ms: number) {
  if (advancing) return;
  advancing = true;
  try {
    crossfade(await pickNext(), ms);
  } catch {
    // network hiccup: keep the current song; the next poll tries again
  } finally {
    advancing = false;
  }
}

function tick() {
  const p = deck?.player;
  if (!p || fadeTimer || !p.duration) return;
  const left = (p.duration - p.currentTime) / (p.playbackRate || 1);
  if (left < NEXT_LEAD_S) advance(NEXT_FADE_MS);
}

export const djOutput = {
  /** Throws with the backend's message if no song can be found (backend down, empty catalog). */
  async start(bpm: number) {
    this.stop();
    target = bpm;
    intensity = "hold";
    crossfade(await pickNext(), 0);
    poll = setInterval(tick, POLL_MS);
  },

  setBpm(bpm: number) {
    target = bpm;
    if (!deck) return;
    const exact = bpm / effective(deck.track);
    if (Math.abs(exact - 1) <= MAX_STRETCH) {
      deck.player.setPlaybackRate(exact, "high"); // re-stretch the current song: smooth, no cut
      publish();
    } else {
      advance(SWITCH_FADE_MS); // too far for this song: blend into a better match
    }
  },

  /** Where the heart rate is vs the zone; picks which song energy to favor next. */
  setIntensity(next: Intensity) {
    intensity = next;
  },

  stop() {
    if (poll) clearInterval(poll);
    poll = null;
    finishFade();
    deck?.player.pause();
    deck?.player.remove();
    deck = null;
  },
};
