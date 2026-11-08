import type { Intensity } from "../api";
import { useSession } from "../store/session";
import { djOutput } from "./djOutput";
import { initAudioSession } from "./session";
import { spotifyOutput } from "./spotifyOutput";

/**
 * One interface for the workout loop, whichever music source is selected:
 *  - "dj": open-license songs streamed and time-stretched to the exact BPM, with crossfades (audio/djOutput.ts)
 *  - "spotify": real songs picked by tempo, switching song by song (audio/spotifyOutput.ts)
 */
const source = () => useSession.getState().musicSource;

export const music = {
  async start(bpm: number) {
    useSession.getState().setMusicPaused(false);
    if (source() === "spotify") return spotifyOutput.start(bpm);
    await initAudioSession();
    return djOutput.start(bpm);
  },

  setBpm(bpm: number) {
    if (source() === "spotify") spotifyOutput.setBpm(bpm);
    else djOutput.setBpm(bpm);
  },

  /** Favor high-energy songs (push) or calmer ones (ease). */
  setIntensity(intensity: Intensity) {
    if (source() === "spotify") spotifyOutput.setIntensity(intensity);
    else djOutput.setIntensity(intensity);
  },

  /** Switch to a different song at the same tempo (the heart rate is holding steady).
   *  Spotify already changes songs at the end of each one, and a mid-song cut there is abrupt on
   *  iPhone, so it's left alone. Returns whether a switch started. */
  rotate(): boolean {
    if (useSession.getState().musicPaused) return false;
    return source() === "dj" ? djOutput.rotate() : false;
  },

  /** Pause the music; the workout and coach keep running, so resume() plays at the current target.
   *  Spotify goes through the backend, so it can fail (e.g. Spotify closed): that throws. */
  async pause() {
    if (source() === "spotify") await spotifyOutput.pause();
    else djOutput.pause();
    useSession.getState().setMusicPaused(true);
  },

  async resume() {
    if (source() === "spotify") await spotifyOutput.resume();
    else djOutput.resume();
    useSession.getState().setMusicPaused(false);
  },

  stop() {
    useSession.getState().setMusicPaused(false);
    spotifyOutput.stop();
    djOutput.stop();
  },
};
