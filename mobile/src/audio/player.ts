import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from "expo-audio";

import { useSession } from "../store/session";
import { MAX_STRETCH, TRACKS, bestTrackFor, type Track } from "./tracks";

/**
 * BPM-following music engine.
 * - Small BPM changes: time-stretch the current track (pitch-corrected).
 * - Large changes: crossfade to the track whose native BPM is closest.
 * Two players (A/B) so a crossfade never has a silent gap.
 */

const FADE_MS = 1500;
const FADE_STEPS = 15;

let active: { player: AudioPlayer; track: Track } | null = null;
let fading: ReturnType<typeof setInterval> | null = null;
let fadingOut: AudioPlayer | null = null;
let volume = 1;

function makePlayer(track: Track, rate: number): AudioPlayer {
  const p = createAudioPlayer(track.source);
  p.loop = true;
  p.shouldCorrectPitch = true;
  p.setPlaybackRate(rate, "high");
  return p;
}

const rateFor = (bpm: number, track: Track) => bpm / track.bpm;
const inStretchRange = (rate: number) => Math.abs(rate - 1) <= MAX_STRETCH;

function publish() {
  if (active) useSession.getState().setNowPlaying(active.track.title, active.player.playbackRate);
}

export const musicPlayer = {
  async init() {
    await setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true, // keeps the app (and our control loop) alive with the screen locked
      interruptionMode: "duckOthers",
    });
  },

  start(bpm: number) {
    this.stop();
    const track = bestTrackFor(bpm);
    const player = makePlayer(track, clampRate(rateFor(bpm, track)));
    player.volume = volume;
    player.play();
    active = { player, track };
    publish();
  },

  setBpm(bpm: number) {
    if (!active) return this.start(bpm);
    const rate = rateFor(bpm, active.track);
    if (inStretchRange(rate) || bestTrackFor(bpm).id === active.track.id) {
      active.player.setPlaybackRate(clampRate(rate), "high");
      publish();
      return;
    }
    crossfadeTo(bestTrackFor(bpm), bpm);
  },

  setVolume(v: number) {
    volume = v;
    if (active) active.player.volume = v;
  },

  stop() {
    finishFade();
    active?.player.pause();
    active?.player.remove();
    active = null;
  },

  tracks: TRACKS,
};

function clampRate(rate: number) {
  return Math.max(1 - MAX_STRETCH * 1.5, Math.min(1 + MAX_STRETCH * 1.5, rate));
}

function crossfadeTo(track: Track, bpm: number) {
  if (!active) return;
  finishFade();
  const outgoing = active.player;
  fadingOut = outgoing;
  const incoming = makePlayer(track, clampRate(rateFor(bpm, track)));
  incoming.volume = 0;
  incoming.play();
  active = { player: incoming, track };
  publish();

  let i = 0;
  fading = setInterval(() => {
    i++;
    const t = i / FADE_STEPS;
    incoming.volume = volume * t;
    outgoing.volume = volume * (1 - t);
    if (i >= FADE_STEPS) finishFade();
  }, FADE_MS / FADE_STEPS);
}

/** Ends any in-progress crossfade immediately and frees the outgoing player. */
function finishFade() {
  if (fading) clearInterval(fading);
  fading = null;
  if (active) active.player.volume = volume;
  fadingOut?.pause();
  fadingOut?.remove();
  fadingOut = null;
}
