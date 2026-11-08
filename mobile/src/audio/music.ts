import type { Intensity } from "../api";
import { useSession } from "../store/session";
import { appleMusicOutput } from "./appleMusicOutput";
import { djOutput } from "./djOutput";
import { initAudioSession } from "./session";
import { spotifyOutput } from "./spotifyOutput";

/**
 * One interface for the workout loop, whichever music source is selected:
 *  - "dj": open-license songs streamed and time-stretched to the exact BPM, with crossfades (audio/djOutput.ts)
 *  - "spotify": real songs picked by tempo, switching song by song (audio/spotifyOutput.ts)
 *  - "apple": your Apple Music library, sped up/slowed down to the BPM (audio/appleMusicOutput.ts, Xcode build only)
 */
const source = () => useSession.getState().musicSource;
const output = () => {
  const s = source();
  return s === "spotify" ? spotifyOutput : s === "apple" ? appleMusicOutput : djOutput;
};

export const music = {
  async start(bpm: number) {
    useSession.getState().setMusicPaused(false);
    if (source() === "dj") await initAudioSession();
    return output().start(bpm);
  },

  setBpm(bpm: number) {
    output().setBpm(bpm);
  },

  /** Favor high-energy songs (push) or calmer ones (ease). */
  setIntensity(intensity: Intensity) {
    output().setIntensity(intensity);
  },

  /** Switch to a different song at the same tempo (the heart rate is holding steady).
   *  Spotify already changes songs at the end of each one, and a mid-song cut there is abrupt on
   *  iPhone, so it's left alone. Returns whether a switch started. */
  rotate(): boolean {
    if (useSession.getState().musicPaused) return false;
    const s = source();
    return s === "dj" ? djOutput.rotate() : s === "apple" ? appleMusicOutput.rotate() : false;
  },

  /** Pause the music; the workout and coach keep running, so resume() plays at the current target.
   *  Spotify goes through the backend, so it can fail (e.g. Spotify closed): that throws. */
  async pause() {
    await output().pause();
    useSession.getState().setMusicPaused(true);
  },

  async resume() {
    await output().resume();
    useSession.getState().setMusicPaused(false);
  },

  stop() {
    useSession.getState().setMusicPaused(false);
    spotifyOutput.stop();
    djOutput.stop();
    appleMusicOutput.stop();
  },
};
