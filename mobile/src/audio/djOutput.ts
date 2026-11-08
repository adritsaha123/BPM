import { createAudioPlayer, type AudioPlayer } from "expo-audio";

import { api, type DjTrack, type Intensity } from "../api";
import { useSession } from "../store/session";

/**
 * DJ mode: openly licensed songs (Jamendo, Creative Commons) that the app plays itself, so unlike
 * Spotify it can lock every song to the exact target BPM:
 *  - each song is time-stretched (pitch-corrected) onto the target; BPM changes re-stretch it live
 *  - a change too big for the current song (beyond ±8%) blends into a better match
 *  - near the end of each song, the next pick (tempo + energy toward the zone) blends in
 * Songs come from the backend (/dj/match, built by backend/scripts/build_dj_catalog.py).
 * The licenses require credit, so "Song — Artist · CC license" is always shown.
 *
 * Smooth transitions (streams take a moment to start):
 *  - the next song is loaded well before it's needed (PRELOAD_LEAD_S), silent and paused
 *  - a blend only starts once the incoming song is actually playing, not just requested
 *  - fades run every 50 ms on an equal-power curve, so the combined loudness stays even
 */
const MAX_STRETCH = 0.08; // must match the backend (app/dj.py)
const NEXT_FADE_MS = 8000; // DJ-style blend into the next song
const SWITCH_FADE_MS = 3000; // quicker blend when the tempo jumps mid-song
const FADE_TICK_MS = 50;
const PRELOAD_LEAD_S = 40; // load the next song this long before the current one ends
const NEXT_LEAD_S = 12; // start blending this long before the end
const LOAD_TIMEOUT_MS = 8000; // give up waiting for a slow stream and play it anyway
const START_TIMEOUT_MS = 4000;
const POLL_MS = 500;
const RECENT = 12; // don't repeat these many recent songs

type Deck = { player: AudioPlayer; track: DjTrack };

let deck: Deck | null = null;
let next: { deck: Deck; ready: Promise<void> } | null = null; // preloaded, paused, silent
let fadingOut: AudioPlayer | null = null;
let fadeTimer: ReturnType<typeof setInterval> | null = null;
let poll: ReturnType<typeof setInterval> | null = null;
let target = 160;
let intensity: Intensity = "hold";
let recent: string[] = [];
let busy = false; // a preload or blend is in progress
let switchWanted = false; // the tempo jumped too far for this song: blend as soon as possible
let session = 0; // bumped by stop() and pause(), so blends still in flight know to back off
let paused = false;

const effective = (t: DjTrack) => t.bpm * (t.match?.multiple ?? 1);
const clampRate = (r: number) => Math.min(1 + MAX_STRETCH, Math.max(1 - MAX_STRETCH, r));
const rateFor = (t: DjTrack, bpm: number) => clampRate(bpm / effective(t));
const reaches = (t: DjTrack, bpm: number) => Math.abs(bpm / effective(t) - 1) <= MAX_STRETCH;

function publish() {
  if (!deck) return;
  const t = deck.track;
  useSession.getState().setNowPlaying(`${t.name} — ${t.artist} · ${t.license}`, deck.player.playbackRate);
}

async function pickNext(): Promise<DjTrack> {
  const exclude = [...recent, ...(deck ? [deck.track.id] : [])];
  const res = await api.djMatch({ targetBpm: target, intensity, exclude, limit: 1 });
  const pick = res.tracks[0];
  if (!pick) throw new Error("No DJ songs available. Build the catalog: backend/scripts/build_dj_catalog.py");
  recent = [pick.id, ...recent].slice(0, RECENT);
  return pick;
}

/** Resolves when `test(status)` passes, or after `timeoutMs` (a slow stream still gets played). */
function waitFor(p: AudioPlayer, test: (s: { isLoaded: boolean; playing: boolean; isBuffering: boolean }) => boolean, timeoutMs: number) {
  return new Promise<void>((resolve) => {
    if (test(p)) return resolve();
    const done = () => {
      clearTimeout(timer);
      sub.remove();
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    const sub = p.addListener("playbackStatusUpdate", (s) => {
      if (test(s)) done();
    });
  });
}

/** Create a player for `track` and start buffering it, paused and silent. */
function prepare(track: DjTrack): { deck: Deck; ready: Promise<void> } {
  const p = createAudioPlayer({ uri: track.audio });
  p.volume = 0;
  p.shouldCorrectPitch = true;
  p.addListener("playbackStatusUpdate", (s) => {
    if (s.didJustFinish && deck?.player === p) blendToNext(SWITCH_FADE_MS); // missed the lead-in: move on
  });
  const ready = waitFor(p, (s) => s.isLoaded, LOAD_TIMEOUT_MS);
  return { deck: { player: p, track }, ready };
}

function discard(p: AudioPlayer | null | undefined) {
  p?.pause();
  p?.remove();
}

/** Start `incoming` (already loaded) and blend into it over `ms`, once it's really playing. */
async function blendInto(incoming: { deck: Deck; ready: Promise<void> }, ms: number) {
  const mine = session;
  const p = incoming.deck.player;
  await incoming.ready;
  if (mine !== session) return discard(p); // stopped while loading
  p.setPlaybackRate(rateFor(incoming.deck.track, target), "high"); // after load, so it sticks
  p.play();
  await waitFor(p, (s) => s.playing && !s.isBuffering, START_TIMEOUT_MS);
  if (mine !== session) return discard(p);

  finishFade();
  const outgoing = deck?.player ?? null;
  deck = incoming.deck;
  publish();
  if (!outgoing || ms <= 0) {
    p.volume = 1;
    discard(outgoing);
    return;
  }

  fadingOut = outgoing;
  const steps = Math.max(1, Math.round(ms / FADE_TICK_MS));
  let i = 0;
  fadeTimer = setInterval(() => {
    i++;
    const x = Math.min(1, i / steps);
    // equal-power: in² + out² = 1, so there's no dip in loudness halfway through
    p.volume = Math.sin((x * Math.PI) / 2);
    outgoing.volume = Math.cos((x * Math.PI) / 2);
    if (i >= steps) finishFade();
  }, FADE_TICK_MS);
}

function finishFade() {
  if (fadeTimer) clearInterval(fadeTimer);
  fadeTimer = null;
  if (deck) deck.player.volume = 1;
  discard(fadingOut);
  fadingOut = null;
}

/** Load the next pick ahead of time so the blend starts on a buffered stream. */
async function preloadNext() {
  if (next || busy) return;
  busy = true;
  try {
    next = prepare(await pickNext());
  } catch {
    // network hiccup: try again on the next poll
  } finally {
    busy = false;
  }
}

/** Blend into the preloaded song (or pick and load one now). */
async function blendToNext(ms: number) {
  if (busy) return;
  busy = true;
  try {
    // a preload picked for an older tempo may not reach the current one
    if (next && !reaches(next.deck.track, target)) {
      discard(next.deck.player);
      next = null;
    }
    const incoming = next ?? prepare(await pickNext());
    next = null;
    switchWanted = false;
    await blendInto(incoming, ms);
  } catch {
    // keep the current song; the next poll tries again
  } finally {
    busy = false;
  }
}

function tick() {
  const p = deck?.player;
  if (!p || fadeTimer || paused) return;
  if (switchWanted) return void blendToNext(SWITCH_FADE_MS);
  if (!p.duration) return;
  const left = (p.duration - p.currentTime) / (p.playbackRate || 1);
  if (left < NEXT_LEAD_S) blendToNext(NEXT_FADE_MS);
  else if (left < PRELOAD_LEAD_S) preloadNext();
}

export const djOutput = {
  /** Throws with the backend's message if no song can be found (backend down, empty catalog). */
  async start(bpm: number) {
    this.stop();
    target = bpm;
    intensity = "hold";
    await blendInto(prepare(await pickNext()), 0);
    poll = setInterval(tick, POLL_MS);
  },

  setBpm(bpm: number) {
    target = bpm;
    if (!deck) return;
    const exact = bpm / effective(deck.track);
    if (Math.abs(exact - 1) <= MAX_STRETCH) {
      deck.player.setPlaybackRate(exact, "high"); // re-stretch the current song: smooth, no cut
      publish();
      return;
    }
    // Too far for this song: blend into a better match (now, or as soon as a preload finishes).
    switchWanted = true;
    if (!paused) blendToNext(SWITCH_FADE_MS); // while paused: switch on resume
  },

  /** Same tempo, different song: blend into the next pick now instead of waiting for this one to end. */
  rotate(): boolean {
    if (!deck || paused || busy || fadeTimer) return false;
    blendToNext(NEXT_FADE_MS);
    return true;
  },

  /** Pause the music; the coach keeps tracking BPM, and resume() plays at the new tempo. */
  pause() {
    if (paused) return;
    paused = true;
    session++; // cancel a blend in flight (it drops its incoming song)
    busy = false;
    finishFade();
    deck?.player.pause();
  },

  resume() {
    if (!paused) return;
    paused = false;
    deck?.player.play(); // a pending tempo switch happens on the next poll
  },

  /** Where the heart rate is vs the zone; picks which song energy to favor next. */
  setIntensity(nextIntensity: Intensity) {
    intensity = nextIntensity;
  },

  stop() {
    session++;
    switchWanted = false;
    paused = false;
    if (poll) clearInterval(poll);
    poll = null;
    finishFade();
    discard(next?.deck.player);
    next = null;
    discard(deck?.player);
    deck = null;
    busy = false;
  },
};
